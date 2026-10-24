interface Env {
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
