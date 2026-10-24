import { DEFAULT_DRAFT_TTL_SECONDS } from "./constants";
import type { Draft, Env } from "./types";
import { isExpired, makeId, nowIso } from "./utils";

function pendingKey(userId: string): string {
  return `pending:${userId}`;
}

function draftKey(draftId: string): string {
  return `draft:${draftId}`;
}

export async function loadPendingDraft(
  env: Env,
  userId: string,
): Promise<Draft | null> {
  // Keep one pointer per user for fast lookup, while also storing drafts by
  // ID so old postback buttons can still be validated safely.
  const draft = await loadDraft(
    env,
    await env.DRAFTS.get(pendingKey(userId), "json"),
  );
  if (!draft) return null;
  if (isExpired(draft.expires_at)) {
    await markDraftCancelled(env, draft);
    return null;
  }
  return draft;
}

export async function loadDraftById(
  env: Env,
  userId: string,
  draftId: string,
): Promise<Draft | null> {
  const raw = await env.DRAFTS.get(draftKey(draftId), "json");
  const draft = await loadDraft(env, raw);
  if (!draft || draft.line_user_id !== userId || isExpired(draft.expires_at))
    return null;
  return draft;
}

async function loadDraft(env: Env, raw: unknown): Promise<Draft | null> {
  if (!raw || typeof raw !== "object") return null;
  const draft = raw as Draft;
  if (
    typeof draft.draft_id !== "string" ||
    typeof draft.line_user_id !== "string"
  )
    return null;
  return draft;
}

export async function saveDraft(env: Env, draft: Draft): Promise<void> {
  // Both keys share the same TTL and payload so reads from either path stay
  // consistent until the draft expires.
  const ttl = Math.max(
    60,
    Math.floor((Date.parse(draft.expires_at) - Date.now()) / 1000),
  );
  await Promise.all([
    env.DRAFTS.put(pendingKey(draft.line_user_id), JSON.stringify(draft), {
      expirationTtl: ttl,
    }),
    env.DRAFTS.put(draftKey(draft.draft_id), JSON.stringify(draft), {
      expirationTtl: ttl,
    }),
  ]);
}

export async function createOrUpdateDraft(
  env: Env,
  userId: string,
  values: Pick<Draft, "entries" | "missing_info" | "last_question" | "status">,
  existing?: Draft | null,
): Promise<Draft> {
  const now = nowIso();
  const ttl = Number(env.DRAFT_TTL_SECONDS || DEFAULT_DRAFT_TTL_SECONDS);
  const draft: Draft = {
    draft_id: existing?.draft_id || makeId("draft"),
    line_user_id: userId,
    status: values.status,
    entries: values.entries,
    missing_info: values.missing_info,
    last_question: values.last_question,
    created_at: existing?.created_at || now,
    updated_at: now,
    expires_at:
      existing?.expires_at || new Date(Date.now() + ttl * 1000).toISOString(),
  };
  await saveDraft(env, draft);
  return draft;
}

export async function markDraftCancelled(
  env: Env,
  draft: Draft,
): Promise<void> {
  const cancelled: Draft = {
    ...draft,
    status: "cancelled",
    updated_at: nowIso(),
  };
  await env.DRAFTS.put(draftKey(draft.draft_id), JSON.stringify(cancelled), {
    expirationTtl: 60 * 60,
  });
  await env.DRAFTS.delete(pendingKey(draft.line_user_id));
}

export async function markDraftStatus(
  env: Env,
  draft: Draft,
  status: Draft["status"],
): Promise<Draft> {
  const updated = { ...draft, status, updated_at: nowIso() };
  await saveDraft(env, updated);
  return updated;
}
