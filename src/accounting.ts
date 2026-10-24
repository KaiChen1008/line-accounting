import type { D1Database } from "@cloudflare/workers-types";
import { appendExpenses, type SheetWriteError } from "./google-sheets";
import { MAX_QUERY_DAYS } from "./expense-query";
import type { Draft, Env, ExpenseEntry } from "./types";
import { addDays, makeId, nowIso } from "./utils";

interface BatchRow {
  draft_id: string;
  batch_id: string;
  line_user_id: string;
  status: "committing" | "completed" | "failed";
  sheet_status: "pending" | "written" | "unknown" | "failed";
  sheet_response_json: string | null;
  error_message: string | null;
}

export interface CommitResult {
  kind: "completed" | "in_progress" | "failed" | "unknown";
  batchId?: string;
  entries: ExpenseEntry[];
  message?: string;
}

export async function commitDraft(env: Env, draft: Draft): Promise<CommitResult> {
  // The batch row is the idempotency record for a draft. It lets repeated
  // button clicks return the original result instead of appending again.
  const existing = await env.DB.prepare("SELECT * FROM commit_batches WHERE draft_id = ?1").bind(draft.draft_id).first<BatchRow>();
  if (existing?.status === "completed") {
    return { kind: "completed", batchId: existing.batch_id, entries: await readBatchEntries(env.DB, existing.batch_id) };
  }
  if (existing?.status === "committing") {
    return { kind: "in_progress", batchId: existing.batch_id, entries: draft.entries, message: "這筆記帳正在處理或核對中，請稍候，不要重複按確認。" };
  }
  if (existing?.sheet_status === "unknown") {
    return { kind: "unknown", batchId: existing.batch_id, entries: await readBatchEntries(env.DB, existing.batch_id), message: "上次試算表回應不明確，資料可能已寫入；請先完成核對，系統不會直接重試以免重複記帳。" };
  }

  const batchId = existing?.batch_id || makeId("batch");
  const now = nowIso();
  if (existing) {
    const claimed = await env.DB.prepare("UPDATE commit_batches SET status='committing', sheet_status='pending', updated_at=?2, error_message=NULL WHERE draft_id=?1 AND status='failed' AND sheet_status='failed'")
      .bind(draft.draft_id, now).run();
    if (!claimed.meta.changes) {
      const winner = await env.DB.prepare("SELECT * FROM commit_batches WHERE draft_id=?1").bind(draft.draft_id).first<BatchRow>();
      if (winner?.status === "completed") return { kind: "completed", batchId: winner.batch_id, entries: await readBatchEntries(env.DB, winner.batch_id) };
      if (winner?.sheet_status === "unknown") return { kind: "unknown", batchId: winner.batch_id, entries: await readBatchEntries(env.DB, winner.batch_id), message: "這筆記帳需要先核對試算表狀態，系統不會盲目重試。" };
      return { kind: "in_progress", batchId: winner?.batch_id, entries: draft.entries, message: "這筆記帳正在處理，請稍候，不要重複按確認。" };
    }
  } else {
    const inserted = await env.DB.prepare("INSERT INTO commit_batches (draft_id,batch_id,line_user_id,status,sheet_status,created_at,updated_at) VALUES (?1,?2,?3,'committing','pending',?4,?4) ON CONFLICT(draft_id) DO NOTHING")
      .bind(draft.draft_id, batchId, draft.line_user_id, now).run();
    if (!inserted.meta.changes) {
      const winner = await env.DB.prepare("SELECT * FROM commit_batches WHERE draft_id=?1").bind(draft.draft_id).first<BatchRow>();
      if (winner?.status === "completed") return { kind: "completed", batchId: winner.batch_id, entries: await readBatchEntries(env.DB, winner.batch_id) };
      return { kind: "in_progress", batchId: winner?.batch_id, entries: draft.entries, message: "這筆記帳正在處理，請稍候，不要重複按確認。" };
    }
  }

  try {
    // Save the D1 rows first, then append the same entries to Google Sheets.
    // Finalization below records whether both sides completed successfully.
    await insertExpenseRecords(env.DB, batchId, draft);
    const sheetResult = await appendExpenses(env, draft.line_user_id, draft.entries);
    const completedAt = nowIso();
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE expense_records SET sheet_status='written', sheet_written_at=?2, sheet_updated_range=?3 WHERE batch_id=?1")
          .bind(batchId, completedAt, sheetResult.updatedRange || null),
        env.DB.prepare("UPDATE commit_batches SET status='completed', sheet_status='written', sheet_response_json=?2, updated_at=?3, completed_at=?3, error_message=NULL WHERE batch_id=?1")
          .bind(batchId, JSON.stringify(sheetResult), completedAt),
      ]);
    } catch (finalizeError) {
      // The append succeeded but D1 finalization did not. Treat this as ambiguous:
      // retrying append could duplicate rows in the five-column sheet.
      await markUnknownAfterSheetSuccess(env, batchId, finalizeError);
      return { kind: "unknown", batchId, entries: draft.entries, message: "試算表已回應成功，但 D1 尚未完成核對；系統不會直接再次追加，請先核對狀態。" };
    }
    return { kind: "completed", batchId, entries: draft.entries };
  } catch (error) {
    const ambiguous = isAmbiguous(error);
    const status = ambiguous ? "unknown" : "failed";
    const message = error instanceof Error ? error.message : "正式記帳失敗";
    await env.DB.batch([
      env.DB.prepare("UPDATE expense_records SET sheet_status=?2 WHERE batch_id=?1")
        .bind(batchId, status),
      env.DB.prepare("UPDATE commit_batches SET status='failed', sheet_status=?2, updated_at=?3, error_message=?4 WHERE batch_id=?1")
        .bind(batchId, status, nowIso(), message),
    ]);
    return {
      kind: ambiguous ? "unknown" : "failed",
      batchId,
      entries: draft.entries,
      message: ambiguous
        ? "試算表回應不明確，可能已寫入；系統已保留核對狀態，不會盲目重複追加。"
        : "正式記帳尚未完成，資料已保留，可以稍後重新按確認重試。",
    };
  }
}

async function markUnknownAfterSheetSuccess(env: Env, batchId: string, error: unknown): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE expense_records SET sheet_status='unknown' WHERE batch_id=?1").bind(batchId),
      env.DB.prepare("UPDATE commit_batches SET status='failed', sheet_status='unknown', updated_at=?2, error_message=?3 WHERE batch_id=?1")
        .bind(batchId, nowIso(), error instanceof Error ? error.message : "D1 finalization failed"),
    ]);
  } catch {
    // The original D1 error is still observable through the request log/runtime logs.
  }
}

function isAmbiguous(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "ambiguous" in error && (error as SheetWriteError).ambiguous);
}

async function insertExpenseRecords(db: D1Database, batchId: string, draft: Draft): Promise<void> {
  const createdAt = nowIso();
  const statements = draft.entries.map((entry, index) => db.prepare("INSERT OR IGNORE INTO expense_records (id,batch_id,source_index,line_user_id,expense_date,amount,item,category,created_at,sheet_status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending')")
    .bind(makeId("expense"), batchId, index, draft.line_user_id, entry.date, entry.amount, entry.item, entry.category, createdAt));
  await db.batch(statements);
}

async function readBatchEntries(db: D1Database, batchId: string): Promise<ExpenseEntry[]> {
  const result = await db.prepare("SELECT amount,item,category,expense_date FROM expense_records WHERE batch_id=?1 ORDER BY source_index")
    .bind(batchId).all<{ amount: number; item: string; category: ExpenseEntry["category"]; expense_date: string }>();
  return result.results.map((row) => ({ amount: row.amount, amount_expression: null, item: row.item, category: row.category, date: row.expense_date }));
}

export async function queryToday(env: Env, userId: string, date: string): Promise<{ total: number; count: number }> {
  const [result] = await queryExpenseRange(env, userId, date, date);
  return { total: result?.total || 0, count: result?.count || 0 };
}

export async function queryLastThreeDays(env: Env, userId: string, dates: string[]): Promise<Array<{ date: string; total: number; count: number }>> {
  if (dates.length === 0) return [];
  return queryExpenseRange(env, userId, dates[0], dates[dates.length - 1]);
}

export async function queryExpenseRange(env: Env, userId: string, startDate: string, endDate: string): Promise<Array<{ date: string; total: number; count: number }>> {
  // The limit is enforced here as a second line of defense after parsing the
  // user's message, so callers cannot accidentally run an unbounded query.
  const days = dateDistance(startDate, endDate) + 1;
  if (days < 1 || days > MAX_QUERY_DAYS) throw new Error(`查詢期限最多 ${MAX_QUERY_DAYS} 天`);

  const rows = await env.DB.prepare("SELECT expense_date AS date, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM expense_records e JOIN commit_batches b ON b.batch_id=e.batch_id WHERE e.line_user_id=?1 AND e.expense_date BETWEEN ?2 AND ?3 AND e.sheet_status='written' AND b.status='completed' GROUP BY expense_date")
    .bind(userId, startDate, endDate).all<{ date: string; total: number; count: number }>();
  const byDate = new Map(rows.results.map((row) => [row.date, { date: row.date, total: Number(row.total), count: Number(row.count) }]));
  const results: Array<{ date: string; total: number; count: number }> = [];
  // Fill missing dates with zeroes to keep the response shape predictable.
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(startDate, offset);
    results.push(byDate.get(date) || { date, total: 0, count: 0 });
  }
  return results;
}

function dateDistance(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}
