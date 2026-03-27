-- 0009_audit_logs.sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER,
  duration_ms INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
