import type { Draft, ExpenseEntry, Env, LineEvent } from "./types";
import { EXTERNAL_API_TIMEOUT_MS } from "./constants";
import { fetchWithTimeout, withTimeout } from "./utils";

interface LineMessage {
  type: "text" | "flex";
  text?: string;
  altText?: string;
  contents?: unknown;
}

export interface DailyExpenseSummary {
  date: string;
  total: number;
  count: number;
}

export interface TodayExpenseSummary {
  date: string;
  total: number;
  count: number;
}

async function lineRequest(env: Env, path: string, body: unknown): Promise<void> {
  // Keep all LINE Messaging API calls behind one timeout and error handler.
  const response = await fetchWithTimeout(`https://api.line.me${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, EXTERNAL_API_TIMEOUT_MS, "LINE API timeout");
  if (!response.ok) throw new Error(`LINE API error ${response.status}: ${await withTimeout(response.text(), EXTERNAL_API_TIMEOUT_MS, "LINE API error response timeout")}`);
}

export async function reply(env: Env, replyToken: string, messages: LineMessage[]): Promise<void> {
  await lineRequest(env, "/v2/bot/message/reply", { replyToken, messages: messages.slice(0, 5) });
}

export async function getMessageContent(env: Env, messageId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  const response = await fetchWithTimeout(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  }, EXTERNAL_API_TIMEOUT_MS, "LINE content API timeout");
  if (!response.ok) throw new Error(`LINE content API error ${response.status}`);
  return { bytes: await withTimeout(response.arrayBuffer(), EXTERNAL_API_TIMEOUT_MS, "LINE content response timeout"), mimeType: response.headers.get("content-type") || "image/jpeg" };
}

function amount(value: number | null): string {
  return value === null ? "待補充" : Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "");
}

function entryLine(entry: ExpenseEntry, index: number): unknown {
  return {
    type: "box",
    layout: "vertical",
    margin: index === 0 ? "none" : "md",
    contents: [
      { type: "text", text: `${index + 1}. ${entry.item || "（未填品名）"}`, size: "sm", weight: "bold", wrap: true },
      { type: "text", text: `NT$ ${amount(entry.amount)} · ${entry.category || "（未分類）"} · ${entry.date || "（未填日期）"}`, size: "xs", color: "#666666", wrap: true },
    ],
  };
}

export function draftFlex(draft: Draft): LineMessage {
  // The same draft card is used for both incomplete drafts and drafts ready
  // for confirmation; only the confirmation button state changes.
  const total = draft.entries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
  const canConfirm = draft.status === "pending_confirmation";
  return {
    type: "flex",
    altText: `待確認記帳：${draft.entries.length} 筆，共 NT$ ${amount(total)}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: canConfirm ? "待確認記帳" : "記帳資料待補充", weight: "bold", size: "lg" },
          ...draft.entries.map(entryLine),
          { type: "separator", margin: "md" },
          { type: "text", text: `共 ${draft.entries.length} 筆｜總金額 NT$ ${amount(total)}`, weight: "bold", margin: "md", wrap: true },
          ...(draft.missing_info.length > 0 ? [{ type: "text", text: `待補充：${draft.missing_info.join("、")}`, color: "#B45309", size: "sm", wrap: true }] : []),
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: canConfirm ? "#16A34A" : "#A3A3A3", action: { type: "postback", label: "確認寫入", data: `action=confirm_draft&draft_id=${encodeURIComponent(draft.draft_id)}`, displayText: "確認寫入" } },
          { type: "button", style: "secondary", action: { type: "postback", label: "取消", data: `action=cancel_draft&draft_id=${encodeURIComponent(draft.draft_id)}`, displayText: "取消" } },
        ],
      },
    },
  };
}

export function completedFlex(entries: ExpenseEntry[], batchId: string): LineMessage {
  const total = entries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
  return {
    type: "flex",
    altText: `記帳成功：${entries.length} 筆，共 NT$ ${amount(total)}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "記帳成功", weight: "bold", size: "lg", color: "#15803D" },
          ...entries.map(entryLine),
          { type: "separator", margin: "md" },
          { type: "text", text: `共 ${entries.length} 筆｜總金額 NT$ ${amount(total)}`, weight: "bold", margin: "md" },
          { type: "text", text: `批次：${batchId}`, size: "xs", color: "#888888", wrap: true },
        ],
      },
    },
  };
}

export function todayFlex(result: TodayExpenseSummary): LineMessage {
  return {
    type: "flex",
    altText: `今日開銷：共 NT$ ${amount(result.total)}，${result.count} 筆`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "今日開銷", weight: "bold", size: "lg", color: "#166534" },
          { type: "text", text: result.date, size: "xs", color: "#737373" },
          { type: "text", text: `NT$ ${amount(result.total)}`, size: "3xl", weight: "bold", color: "#111827", margin: "sm" },
          {
            type: "box",
            layout: "horizontal",
            alignItems: "center",
            spacing: "sm",
            margin: "md",
            contents: [
              { type: "box", layout: "vertical", cornerRadius: "4px", height: "10px", flex: 1, backgroundColor: result.total > 0 ? "#22C55E" : "#E5E7EB", contents: [{ type: "filler" }] },
            ],
          },
          { type: "separator", margin: "md" },
          { type: "text", text: `${result.count} 筆支出`, size: "sm", color: result.count > 0 ? "#404040" : "#A3A3A3" },
        ],
      },
    },
  };
}

export function periodExpenseFlex(results: DailyExpenseSummary[]): LineMessage {
  // The bar chart uses the largest daily total as its 100% reference point.
  const total = results.reduce((sum, row) => sum + row.total, 0);
  const max = Math.max(...results.map((row) => row.total), 1);
  const dayLabel = `${results.length} 天`;
  return {
    type: "flex",
    altText: `期間開銷（${dayLabel}）：共 NT$ ${amount(total)}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "期間開銷", weight: "bold", size: "lg", color: "#166534" },
          { type: "text", text: `${results[0]?.date || ""} ～ ${results.at(-1)?.date || ""}`, size: "xs", color: "#737373" },
          { type: "text", text: `${dayLabel}合計 NT$ ${amount(total)}`, size: "xl", weight: "bold", color: "#111827", margin: "sm" },
          { type: "separator", margin: "md" },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            margin: "md",
            contents: results.map((row) => {
              const barWidth = row.total > 0 ? Math.max(4, Math.round((row.total / max) * 100)) : 0;
              const emptyWidth = Math.max(1, 100 - barWidth);
              return {
                type: "box",
                layout: "horizontal",
                alignItems: "center",
                spacing: "sm",
                contents: [
                  { type: "text", text: row.date.slice(5), size: "xs", color: "#525252", flex: 0 },
                  {
                    type: "box",
                    layout: "horizontal",
                    cornerRadius: "4px",
                    height: "8px",
                    flex: 1,
                    contents: [
                      { type: "box", layout: "vertical", flex: Math.max(1, barWidth), backgroundColor: row.total > 0 ? "#22C55E" : "#E5E7EB", contents: [{ type: "filler" }] },
                      { type: "box", layout: "vertical", flex: emptyWidth, backgroundColor: "#E5E7EB", contents: [{ type: "filler" }] },
                    ],
                  },
                  { type: "text", text: `NT$ ${amount(row.total)}`, size: "xs", weight: "bold", align: "end", flex: 0 },
                ],
              };
            }),
          },
          { type: "separator", margin: "md" },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: results.map((row) => ({
              type: "text",
              text: `${row.date}｜${row.count} 筆｜NT$ ${amount(row.total)}`,
              size: "sm",
              color: row.total > 0 ? "#404040" : "#A3A3A3",
            })),
          },
        ],
      },
    },
  };
}

export function lastThreeDaysFlex(results: DailyExpenseSummary[]): LineMessage {
  return periodExpenseFlex(results);
}

export function eventUserId(event: LineEvent): string | null {
  return typeof event.source?.userId === "string" ? event.source.userId : null;
}
