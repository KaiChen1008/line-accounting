CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS commit_batches (
  draft_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE,
  line_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committing', 'completed', 'failed')),
  sheet_status TEXT NOT NULL CHECK (sheet_status IN ('pending', 'written', 'unknown', 'failed')),
  sheet_response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS expense_records (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES commit_batches(batch_id),
  source_index INTEGER NOT NULL,
  line_user_id TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  amount REAL NOT NULL,
  item TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sheet_status TEXT NOT NULL CHECK (sheet_status IN ('pending', 'written', 'unknown', 'failed')),
  sheet_written_at TEXT,
  sheet_updated_range TEXT,
  UNIQUE (batch_id, source_index)
);

CREATE INDEX IF NOT EXISTS idx_expense_records_query
  ON expense_records (line_user_id, expense_date, sheet_status);

CREATE INDEX IF NOT EXISTS idx_commit_batches_status
  ON commit_batches (line_user_id, status, updated_at);
