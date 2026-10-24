export const CATEGORIES = [
  "食物 🍽️",
  "飲品 🧃",
  "咖啡 ☕️",
  "交通 🚌",
  "消費 👜",
  "娛樂 🎳",
  "居家 🏡",
  "3C 📱",
  "醫藥 🏥",
  "房租 🏠",
  "其他 🏷️",
] as const;

export type Category = (typeof CATEGORIES)[number];

// Keep category validation centralized so Gemini output and Sheet input use the
// exact same allowed labels.
export function isCategory(value: string): value is Category {
  return CATEGORIES.includes(value as Category);
}
export type Intent =
  | "record"
  | "query_expense_range"
  | "clarification_response"
  | "cancel_pending"
  | "unknown";
export type ParseStatus =
  | "ready"
  | "needs_clarification"
  | "query"
  | "cancelled"
  | "unknown";
export type DraftStatus =
  | "needs_clarification"
  | "pending_confirmation"
  | "committing"
  | "completed"
  | "cancelled"
  | "failed";

export interface ExpenseEntry {
  amount: number | null;
  amount_expression: string | null;
  item: string;
  category: Category | null;
  date: string | null;
}

export interface AiParseResult {
  intent: Intent;
  status: ParseStatus;
  entries: ExpenseEntry[];
  // Gemini fills these fields for query_expense_range and returns null for
  // recording or draft-edit intents.
  start_date: string | null;
  end_date: string | null;
  missing_info: string[];
  question: string | null;
}

export interface Draft {
  draft_id: string;
  line_user_id: string;
  status: DraftStatus;
  entries: ExpenseEntry[];
  missing_info: string[];
  last_question: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface Env {
  // These fields are supplied by Wrangler bindings or encrypted Worker secrets.
  DB: D1Database;
  DRAFTS: KVNamespace;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GEMINI_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_SHEET_ID: string;
  GOOGLE_SHEET_GID: string;
  GEMINI_MODEL?: string;
  DRAFT_TTL_SECONDS?: string;
}

export interface LineEvent {
  type: "message" | "postback" | "follow" | "unfollow" | string;
  webhookEventId?: string;
  replyToken?: string;
  mode?: string;
  timestamp?: number;
  source?: { type?: string; userId?: string; [key: string]: unknown };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    [key: string]: unknown;
  };
  postback?: {
    data?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LineWebhookBody {
  destination?: string;
  events?: LineEvent[];
}

export interface SheetAppendResult {
  spreadsheetId: string;
  tableRange?: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}
