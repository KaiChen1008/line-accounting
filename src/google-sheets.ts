import { type Env, type ExpenseEntry, type SheetAppendResult } from "./types";
import { EXTERNAL_API_TIMEOUT_MS } from "./constants";
import {
  base64UrlEncode,
  fetchWithTimeout,
  nowIso,
  withTimeout,
} from "./utils";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  // Workers do not have a Google SDK here, so authenticate with a short-lived
  // service-account JWT and cache the resulting access token in memory.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000)
    return cachedToken.value;
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: account.token_uri || "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const keyData = account.private_key
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(keyData),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = base64UrlEncode(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  const assertion = `${header}.${payload}.${signature}`;
  const response = await fetchWithTimeout(
    account.token_uri || "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(assertion)}`,
    },
    EXTERNAL_API_TIMEOUT_MS,
    "Google OAuth timeout",
  );
  if (!response.ok) throw new Error(`Google OAuth error ${response.status}`);
  const token = await withTimeout(
    response.json() as Promise<{ access_token: string; expires_in: number }>,
    EXTERNAL_API_TIMEOUT_MS,
    "Google OAuth response timeout",
  );
  cachedToken = {
    value: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  return token.access_token;
}

function base64ToBytes(value: string): ArrayBuffer {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const output = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(output);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return output;
}

async function sheetsRequest(
  env: Env,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  // Centralize authorization and timeouts for every Sheets API request.
  const token = await accessToken(env);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  return fetchWithTimeout(
    url,
    { ...init, headers },
    EXTERNAL_API_TIMEOUT_MS,
    "Google Sheets API timeout",
  );
}

export interface SheetTab {
  sheetId: number;
  title: string;
}

interface SpreadsheetMetadata {
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
}

async function spreadsheetSheets(env: Env): Promise<SheetTab[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}?fields=sheets.properties`;
  const response = await sheetsRequest(env, url);
  if (!response.ok)
    throw new Error(`Google Sheets metadata error ${response.status}`);
  const payload = await withTimeout(
    response.json() as Promise<SpreadsheetMetadata>,
    EXTERNAL_API_TIMEOUT_MS,
    "Google Sheets metadata timeout",
  );
  return (payload.sheets || []).flatMap((item) => {
    const sheetId = item.properties?.sheetId;
    const title = item.properties?.title;
    return typeof sheetId === "number" && typeof title === "string"
      ? [{ sheetId, title }]
      : [];
  });
}

async function defaultSheet(env: Env): Promise<SheetTab> {
  const gid = Number(env.GOOGLE_SHEET_GID || "2099277495");
  const sheet = (await spreadsheetSheets(env)).find(
    (item) => item.sheetId === gid,
  );
  if (!sheet) throw new Error(`找不到 gid=${gid} 對應的工作表`);
  return sheet;
}

export async function resolveSheetTitle(env: Env): Promise<string> {
  return (await defaultSheet(env)).title;
}

export class SheetWriteError extends Error {
  constructor(
    message: string,
    public readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = "SheetWriteError";
  }
}

export async function appendExpenses(
  env: Env,
  lineUserId: string,
  entries: ExpenseEntry[],
): Promise<SheetAppendResult> {
  // Each user writes to a dedicated tab. The five columns match the sheet
  // header: expense date, amount, item, category, and record date.
  const sheet = await ensureUserSheet(env, lineUserId);
  const title = sheet.title;
  const range = `${title}!A:E`;
  const values = entries.map((entry) => [
    entry.date,
    entry.amount,
    entry.item,
    entry.category,
    entry.date,
  ]);
  let response: Response;
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&includeValuesInResponse=false`;
    response = await sheetsRequest(env, url, {
      method: "POST",
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    });
  } catch (error) {
    throw new SheetWriteError(
      error instanceof Error ? error.message : "Google Sheets 請求失敗",
      true,
    );
  }
  if (!response.ok) {
    throw new SheetWriteError(
      `Google Sheets append error ${response.status}: ${await response.text()}`,
      response.status >= 500,
    );
  }
  return await withTimeout(
    response.json() as Promise<SheetAppendResult>,
    EXTERNAL_API_TIMEOUT_MS,
    "Google Sheets response timeout",
  );
}

export async function ensureUserSheet(
  env: Env,
  lineUserId: string,
): Promise<SheetTab> {
  // Provisioning is guarded by a D1 claim so concurrent LINE events cannot
  // create duplicate tabs for the same user.
  const existing = await userSheetMapping(env, lineUserId);
  if (existing) return existing;

  const now = nowIso();
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO sheet_tab_provisioning (line_user_id,updated_at) VALUES (?1,?2)",
  )
    .bind(lineUserId, now)
    .run();
  if (!claim.meta.changes) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const mapped = await userSheetMapping(env, lineUserId);
      if (mapped) return mapped;
      await delay(200);
    }
    const reclaimed = await env.DB.prepare(
      "DELETE FROM sheet_tab_provisioning WHERE line_user_id=?1 AND updated_at < ?2",
    )
      .bind(lineUserId, new Date(Date.now() - 3_000).toISOString())
      .run();
    if (reclaimed.meta.changes) return ensureUserSheet(env, lineUserId);
    throw new Error("Google Sheet 分頁正在建立中，請稍後重試");
  }

  try {
    const hasExistingData = await env.DB.prepare(
      "SELECT 1 AS found FROM commit_batches WHERE line_user_id=?1 LIMIT 1",
    )
      .bind(lineUserId)
      .first<{ found: number }>();
    if (hasExistingData) {
      // Existing users keep the configured default tab for backward
      // compatibility; new users receive a private tab.
      const existingDefault = await defaultSheet(env);
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO user_sheet_tabs (line_user_id,sheet_id,sheet_title,created_at) VALUES (?1,?2,?3,?4)",
      )
        .bind(lineUserId, existingDefault.sheetId, existingDefault.title, now)
        .run();
      const mapped = await userSheetMapping(env, lineUserId);
      if (mapped) return mapped;
      if (!inserted.meta.changes)
        throw new Error("目前分頁已被其他使用者綁定，無法保留既有使用者的分頁");
    }

    const title = `user_${await shortUserHash(lineUserId)}`;
    const created = await createSheetTab(env, title);
    await writeSheetHeader(env, created.title);
    await env.DB.prepare(
      "INSERT INTO user_sheet_tabs (line_user_id,sheet_id,sheet_title,created_at) VALUES (?1,?2,?3,?4)",
    )
      .bind(lineUserId, created.sheetId, created.title, now)
      .run();
    return created;
  } finally {
    await env.DB.prepare(
      "DELETE FROM sheet_tab_provisioning WHERE line_user_id=?1",
    )
      .bind(lineUserId)
      .run();
  }
}

async function userSheetMapping(
  env: Env,
  lineUserId: string,
): Promise<SheetTab | null> {
  return env.DB.prepare(
    "SELECT sheet_id AS sheetId, sheet_title AS title FROM user_sheet_tabs WHERE line_user_id=?1",
  )
    .bind(lineUserId)
    .first<SheetTab>();
}

async function createSheetTab(env: Env, title: string): Promise<SheetTab> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}:batchUpdate`;
  const response = await sheetsRequest(env, url, {
    method: "POST",
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });
  if (!response.ok)
    throw new Error(
      `Google Sheets 建立分頁失敗 ${response.status}: ${await response.text()}`,
    );
  const payload = await withTimeout(
    response.json() as Promise<{
      replies?: Array<{
        addSheet?: { properties?: { sheetId?: number; title?: string } };
      }>;
    }>,
    EXTERNAL_API_TIMEOUT_MS,
    "Google Sheets 建立分頁回應 timeout",
  );
  const properties = payload.replies?.[0]?.addSheet?.properties;
  if (
    typeof properties?.sheetId !== "number" ||
    typeof properties.title !== "string"
  ) {
    throw new Error("Google Sheets 建立分頁回應格式錯誤");
  }
  return { sheetId: properties.sheetId, title: properties.title };
}

async function writeSheetHeader(env: Env, title: string): Promise<void> {
  const range = `${title}!A1:E1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const response = await sheetsRequest(env, url, {
    method: "PUT",
    body: JSON.stringify({
      range,
      majorDimension: "ROWS",
      values: [["日期", "金額", "品項", "分類", "記錄日期"]],
    }),
  });
  if (!response.ok)
    throw new Error(
      `Google Sheets 標題列建立失敗 ${response.status}: ${await response.text()}`,
    );
  await withTimeout(
    response.json(),
    EXTERNAL_API_TIMEOUT_MS,
    "Google Sheets 標題列回應 timeout",
  );
}

async function shortUserHash(lineUserId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(lineUserId),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function sheetRows(
  entries: ExpenseEntry[],
): Array<[string | null, number | null, string, string | null, string | null]> {
  return entries.map((entry) => [
    entry.date,
    entry.amount,
    entry.item,
    entry.category,
    entry.date,
  ]);
}

export function writeTimestamp(): string {
  return nowIso();
}
