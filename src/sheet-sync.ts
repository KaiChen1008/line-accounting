import { readExpenseRows } from "./google-sheets";
import { MAX_QUERY_DAYS } from "./expense-query";
import type { Env } from "./types";
import { addDays, nowIso, taipeiDate } from "./utils";

export interface SheetSyncResult {
  startDate: string;
  endDate: string;
  sheetTitle: string;
  scannedRows: number;
  syncedRows: number;
  invalidRows: Array<{ rowNumber: number; reason: string }>;
}

export function parseSyncDays(input: string): 3 | 5 | null {
  const normalized = input.replace(/[\u3000\s]/g, "");
  if (!/^同步(?:最近|過去)?(?:三|五|3|5)天/.test(normalized)) return null;
  const match = normalized.match(/^同步(?:最近|過去)?(三|五|3|5)天/);
  if (!match) return null;
  return match[1] === "三" || match[1] === "3" ? 3 : 5;
}

export async function syncRecentSheetExpenses(
  env: Env,
  lineUserId: string,
  endDate = taipeiDate(),
  days = 5,
): Promise<SheetSyncResult> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_QUERY_DAYS) throw new Error(`同步期限最多 ${MAX_QUERY_DAYS} 天`);
  const startDate = addDays(endDate, -(days - 1));
  const dates = new Set(Array.from({ length: days }, (_, offset) => addDays(startDate, offset)));
  const sheet = await readExpenseRows(env, lineUserId, dates);
  let syncedRows = 0;

  for (const row of sheet.rows) {
    const sourceKey = sheetSourceKey(sheet.sheetId, row.rowNumber);
    const batchId = `sheet-sync-${sheet.sheetId}-${row.rowNumber}`;
    const draftId = `sheet-import:${sourceKey}`;
    const now = nowIso();

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO commit_batches (draft_id,batch_id,line_user_id,status,sheet_status,sheet_response_json,created_at,updated_at,completed_at,error_message) VALUES (?1,?2,?3,'completed','written',?4,?5,?5,?5,NULL) ON CONFLICT(draft_id) DO UPDATE SET line_user_id=excluded.line_user_id,status='completed',sheet_status='written',sheet_response_json=excluded.sheet_response_json,updated_at=excluded.updated_at,completed_at=excluded.completed_at,error_message=NULL",
      ).bind(
        draftId,
        batchId,
        lineUserId,
        JSON.stringify({ source: "google_sheet_sync", sheet_title: sheet.title, row_number: row.rowNumber }),
        now,
      ),
      env.DB.prepare(
        "INSERT INTO expense_records (id,batch_id,source_index,line_user_id,expense_date,amount,item,category,created_at,sheet_status,sheet_written_at,sheet_updated_range,source_key) VALUES (lower(hex(randomblob(16))),?1,0,?2,?3,?4,?5,?6,?7,'written',?7,?8,?9) ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO UPDATE SET batch_id=excluded.batch_id,line_user_id=excluded.line_user_id,expense_date=excluded.expense_date,amount=excluded.amount,item=excluded.item,category=excluded.category,sheet_status='written',sheet_written_at=excluded.sheet_written_at,sheet_updated_range=excluded.sheet_updated_range",
      ).bind(
        batchId,
        lineUserId,
        row.date,
        row.amount,
        row.item,
        row.category,
        now,
        `${sheet.title}!A${row.rowNumber}:E${row.rowNumber}`,
        sourceKey,
      ),
    ]);
    syncedRows += 1;
  }

  return {
    startDate,
    endDate,
    sheetTitle: sheet.title,
    scannedRows: sheet.rows.length + sheet.invalidRows.length,
    syncedRows,
    invalidRows: sheet.invalidRows,
  };
}

export function sheetSourceKey(sheetId: number, rowNumber: number): string {
  return `sheet:${sheetId}:${rowNumber}`;
}

export function formatSheetSyncResult(result: SheetSyncResult): string {
  const invalid = result.invalidRows.length > 0 ? `\n略過 ${result.invalidRows.length} 列格式不正確資料。` : "";
  return `已同步 ${result.startDate}～${result.endDate} 的 Google Sheet 開銷。\n寫入／更新：${result.syncedRows} 筆${invalid}`;
}
