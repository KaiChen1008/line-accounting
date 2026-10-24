ALTER TABLE expense_records ADD COLUMN source_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_records_source_key
  ON expense_records (source_key)
  WHERE source_key IS NOT NULL;
