import { commitDraft, queryExpenseRange } from "./accounting";
import {
  createOrUpdateDraft,
  loadDraftById,
  loadPendingDraft,
  markDraftCancelled,
  markDraftStatus,
} from "./drafts";
import { parseWithGemini } from "./gemini";
import {
  completedFlex,
  draftFlex,
  eventUserId,
  getMessageContent,
  periodExpenseFlex,
  reply,
  todayFlex,
} from "./line";
import { ensureUserSheet } from "./google-sheets";
import {
  normalizeExpenseDateRange,
  type ExpenseDateRange,
} from "./expense-query";
import type {
  AiParseResult,
  Draft,
  Env,
  LineEvent,
  LineWebhookBody,
} from "./types";
import {
  constantTimeEqual,
  hmacSha256Base64,
  nowIso,
  taipeiDate,
} from "./utils";
import { validateAndNormalizeResult } from "./validation";

// The Worker only accepts signed LINE webhooks and performs the actual event
// processing in the background so LINE receives a quick acknowledgement.
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    const signature = request.headers.get("x-line-signature");
    if (!signature) {
      return new Response("Invalid signature", { status: 401 });
    }

    const bodyText = await request.text();
    const expected = await hmacSha256Base64(env.LINE_CHANNEL_SECRET, bodyText);
    if (!constantTimeEqual(expected, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: LineWebhookBody;
    try {
      body = JSON.parse(bodyText) as LineWebhookBody;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    ctx.waitUntil(
      Promise.all((body.events || []).map((event) => processEvent(event, env))),
    );
    return new Response("OK");
  },
};

async function processEvent(event: LineEvent, env: Env): Promise<void> {
  const eventId = event.webhookEventId;
  if (!eventId) {
    await reportEventFailure(
      event,
      env,
      eventId,
      new Error("Missing webhook event ID"),
    );
    return;
  }

  try {
    // Claim the event before handling it. LINE may retry the same webhook, so
    // this prevents duplicate replies and duplicate writes.
    if (!(await claimWebhookEvent(env, eventId))) return;
  } catch (error) {
    await reportEventFailure(event, env, eventId, error);
    return;
  }

  try {
    await handleEvent(event, env);
  } catch (error) {
    await reportEventFailure(event, env, eventId, error);
    return;
  }

  try {
    await updateWebhookEvent(env, eventId, "completed");
  } catch (error) {
    await reportEventFailure(event, env, eventId, error);
  }
}

async function reportEventFailure(
  event: LineEvent,
  env: Env,
  eventId: string | undefined,
  error: unknown,
): Promise<void> {
  const detail = publicErrorMessage(error);
  console.error("webhook_event_failed", {
    eventId,
    error: detail,
  });

  if (eventId) {
    try {
      await updateWebhookEvent(env, eventId, "failed", detail);
    } catch (updateError) {
      console.error("webhook_event_status_update_failed", {
        eventId,
        error: publicErrorMessage(updateError),
      });
    }
  }

  const token = event.replyToken;
  if (!token) return;

  try {
    await reply(env, token, [
      {
        type: "text",
        text: `系統處理失敗。\n錯誤：${detail}\n尚未完成正式記帳，請稍後重試。`,
      },
    ]);
  } catch {
    console.error("webhook_error_reply_failed", { eventId });
  }
}

function publicErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || "unknown error");
  return message
    .replace(
      /(authorization|bearer|token|api[_-]?key|secret|private[_-]?key)\s*[:=]\s*[^\s,}]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 300);
}

async function claimWebhookEvent(env: Env, eventId: string): Promise<boolean> {
  const now = nowIso();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_events (webhook_event_id,status,created_at,updated_at) VALUES (?1,'processing',?2,?2)",
  )
    .bind(eventId, now)
    .run();
  if (result.meta.changes === 1) return true;

  const staleBefore = new Date(Date.now() - 30_000).toISOString();
  const reclaimed = await env.DB.prepare(
    "UPDATE webhook_events SET status='processing', updated_at=?2, error_message=NULL WHERE webhook_event_id=?1 AND status='processing' AND updated_at < ?3",
  )
    .bind(eventId, now, staleBefore)
    .run();
  return reclaimed.meta.changes === 1;
}

async function updateWebhookEvent(
  env: Env,
  eventId: string,
  status: "completed" | "failed",
  errorMessage?: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE webhook_events SET status=?2, updated_at=?3, error_message=?4 WHERE webhook_event_id=?1",
  )
    .bind(eventId, status, nowIso(), errorMessage || null)
    .run();
}

async function handleEvent(event: LineEvent, env: Env): Promise<void> {
  const userId = eventUserId(event);
  if (!userId || !event.replyToken) return;

  if (event.type === "postback") {
    await handlePostback(event, env, userId);
    return;
  }
  if (event.type === "follow") {
    await ensureUserSheet(env, userId);
    return;
  }
  if (event.type !== "message") return;

  const messageType = event.message?.type;
  const pending = await loadPendingDraft(env, userId);
  // A pending draft must be resolved before accepting another receipt image;
  // otherwise two receipts could be merged into one ambiguous draft.
  if (pending && messageType === "image") {
    await reply(env, event.replyToken, [
      {
        type: "text",
        text: "目前有一筆待確認草稿。請先按「確認寫入」或「取消」，再傳送新的收據照片。",
      },
    ]);
    return;
  }

  if (messageType === "image") {
    const messageId =
      typeof event.message?.id === "string" ? event.message.id : null;
    if (!messageId) throw new Error("收據照片缺少 message id");
    const image = await getMessageContent(env, messageId);
    const parsed = await parseWithGemini(
      env,
      { imageBytes: image.bytes, imageMimeType: image.mimeType },
      taipeiDate(),
    );
    await createDraftFromAi(env, userId, event.replyToken, parsed, null);
    return;
  }

  const messageText =
    typeof event.message?.text === "string" ? event.message.text.trim() : "";
  if (!messageText) return;
  await handleText(env, userId, event.replyToken, messageText, pending);
}

async function handleText(
  env: Env,
  userId: string,
  replyToken: string,
  messageText: string,
  pending: Draft | null,
): Promise<void> {
  if (pending && /^(取消|取消草稿|不要記了|算了)$/.test(messageText)) {
    await markDraftCancelled(env, pending);
    await reply(env, replyToken, [
      { type: "text", text: "已取消這筆待確認草稿。" },
    ]);
    return;
  }
  if (pending && /^(確認|確認寫入|記帳|寫入)$/.test(messageText)) {
    await reply(env, replyToken, [
      {
        type: "text",
        text: "請按草稿下方的「確認寫入」按鈕，文字訊息不會直接寫入。",
      },
    ]);
    return;
  }

  const currentDate = taipeiDate();
  // Once a draft exists, only an explicit edit is allowed to reach Gemini.
  // This protects an unfinished draft from being replaced by a new expense.
  if (
    pending &&
    pending.status === "pending_confirmation" &&
    !looksLikeEdit(messageText)
  ) {
    await reply(env, replyToken, [
      {
        type: "text",
        text: "目前有一筆待確認草稿。請輸入明確的修改指令，或按「確認寫入／取消」；新的支出請稍後再傳。",
      },
    ]);
    return;
  }

  const parsed = await parseWithGemini(
    env,
    { text: messageText },
    currentDate,
    pending,
  );
  if (parsed.intent === "query_expense_range") {
    if (pending) {
      await reply(env, replyToken, [
        {
          type: "text",
          text: "目前有一筆待確認草稿。請先完成或取消草稿，再查詢開銷。",
        },
      ]);
      return;
    }
    // The AI has already interpreted the user's natural-language date range;
    // the backend only validates the normalized result before querying D1.
    const query = normalizeExpenseDateRange(parsed.start_date, parsed.end_date);
    if (query.error) {
      await reply(env, replyToken, [
        { type: "text", text: parsed.question || query.error },
      ]);
      return;
    }
    if (query.range) await replyQuery(env, userId, replyToken, query.range);
    return;
  }
  if (
    pending &&
    parsed.intent === "record" &&
    !looksLikeEdit(messageText) &&
    pending.status !== "needs_clarification"
  ) {
    await reply(env, replyToken, [
      {
        type: "text",
        text: "這看起來是新的支出，但目前仍有待確認草稿。請先完成或取消目前草稿。",
      },
    ]);
    return;
  }
  await createDraftFromAi(env, userId, replyToken, parsed, pending);
}

function looksLikeEdit(value: string): boolean {
  return /(第[一二三四五六七八九十\d]+筆|最後一筆|這筆|上一筆|改|修改|換成|設為|分類|品名|金額|日期|昨天|前天)/.test(
    value,
  );
}

async function replyQuery(
  env: Env,
  userId: string,
  replyToken: string,
  range: ExpenseDateRange,
): Promise<void> {
  // D1 returns one row for every requested date, including zero-spend days,
  // so the Flex message can display a continuous timeline.
  const results = await queryExpenseRange(
    env,
    userId,
    range.startDate,
    range.endDate,
  );
  if (range.days === 1) {
    const result = results[0] || { date: range.startDate, total: 0, count: 0 };
    await reply(env, replyToken, [todayFlex(result)]);
    return;
  }
  await reply(env, replyToken, [periodExpenseFlex(results)]);
}

function formatMoney(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "");
}

async function createDraftFromAi(
  env: Env,
  userId: string,
  replyToken: string,
  result: AiParseResult,
  existing: Draft | null,
): Promise<void> {
  if (result.intent === "cancel_pending") {
    if (existing) await markDraftCancelled(env, existing);
    await reply(env, replyToken, [
      { type: "text", text: "已取消待確認草稿。" },
    ]);
    return;
  }
  if (
    result.intent !== "record" &&
    result.intent !== "clarification_response"
  ) {
    await reply(env, replyToken, [
      {
        type: "text",
        text: "我目前只支援記帳、修改待確認草稿，以及查詢自訂期限開銷（最多 31 天）。",
      },
    ]);
    return;
  }

  // Validation is intentionally performed after Gemini. The model extracts
  // information; this function enforces the application rules before saving it.
  const checked = validateAndNormalizeResult(result, taipeiDate());
  const status =
    checked.missingInfo.length === 0
      ? "pending_confirmation"
      : "needs_clarification";
  const draft = await createOrUpdateDraft(
    env,
    userId,
    {
      entries: checked.entries,
      missing_info: checked.missingInfo,
      last_question: checked.question,
      status,
    },
    existing,
  );
  if (status === "needs_clarification") {
    const suffix =
      checked.question || `請補充：${checked.missingInfo.join("、")}`;
    await reply(env, replyToken, [
      { type: "text", text: `尚未完成正式記帳。${suffix}` },
      ...(draft.entries.length > 0 ? [draftFlex(draft)] : []),
    ]);
    return;
  }
  await reply(env, replyToken, [draftFlex(draft)]);
}

async function handlePostback(
  event: LineEvent,
  env: Env,
  userId: string,
): Promise<void> {
  const token = event.replyToken;
  if (!token) return;
  const data =
    typeof event.postback?.data === "string"
      ? new URLSearchParams(event.postback.data)
      : null;
  const action = data?.get("action");
  const draftId = data?.get("draft_id");
  if (!action || !draftId) {
    await reply(env, token, [{ type: "text", text: "無效的草稿操作。" }]);
    return;
  }
  const draft = await loadDraftById(env, userId, draftId);
  if (!draft) {
    await reply(env, token, [
      { type: "text", text: "這筆草稿不存在或已過期，請重新傳送支出資料。" },
    ]);
    return;
  }
  if (action === "cancel_draft") {
    if (draft.status === "completed" || draft.status === "committing") {
      await reply(env, token, [
        { type: "text", text: "這筆草稿已完成或正在處理，無法取消。" },
      ]);
      return;
    }
    await markDraftCancelled(env, draft);
    await reply(env, token, [
      { type: "text", text: "已取消這筆待確認草稿，尚未寫入正式資料。" },
    ]);
    return;
  }
  if (action !== "confirm_draft") {
    await reply(env, token, [{ type: "text", text: "不支援的草稿操作。" }]);
    return;
  }
  if (draft.status === "completed") {
    await reply(env, token, [
      { type: "text", text: "這筆草稿已完成，舊按鈕不會再次記帳。" },
    ]);
    return;
  }
  if (draft.status !== "pending_confirmation" && draft.status !== "failed") {
    await reply(env, token, [
      {
        type: "text",
        text: "這筆草稿尚未具備完整資料，請先補充缺少內容；尚未正式記帳。",
      },
    ]);
    return;
  }
  const checked = validateAndNormalizeResult({
    intent: "record",
    status: "ready",
    entries: draft.entries,
    start_date: null,
    end_date: null,
    missing_info: [],
    question: null,
  });
  if (
    checked.missingInfo.length > 0 ||
    checked.entries.some(
      (entry) =>
        entry.amount === null || !entry.category || !entry.date || !entry.item,
    )
  ) {
    await reply(env, token, [
      {
        type: "text",
        text: "草稿資料驗證未通過，尚未正式記帳，請重新修改或建立草稿。",
      },
    ]);
    return;
  }
  const result = await commitDraft(env, { ...draft, entries: checked.entries });
  if (result.kind === "completed") {
    await markDraftStatus(env, draft, "completed");
    await env.DRAFTS.delete(`pending:${userId}`);
    await reply(env, token, [
      completedFlex(result.entries, result.batchId || "unknown"),
    ]);
  } else {
    await markDraftStatus(env, draft, "failed");
    await reply(env, token, [
      {
        type: "text",
        text: `${result.message || "正式記帳尚未完成。"}\n尚未回覆記帳成功，請依提示處理。`,
      },
    ]);
  }
}
