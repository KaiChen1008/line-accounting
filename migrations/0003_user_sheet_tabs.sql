CREATE TABLE IF NOT EXISTS user_sheet_tabs (
  line_user_id TEXT PRIMARY KEY,
  sheet_id INTEGER NOT NULL UNIQUE,
  sheet_title TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet_tab_provisioning (
  line_user_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
);
