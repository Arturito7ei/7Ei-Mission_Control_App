-- Sprint 4 WO1 — SCHEMA-001: Rebuild scheduled_tasks with cronExpression column
-- Drops old table (had cron/timezone/runCount), recreates with the canonical schema.

DROP TABLE IF EXISTS scheduled_tasks;

CREATE TABLE scheduled_tasks (
  id              TEXT    PRIMARY KEY,
  org_id          TEXT    NOT NULL,
  agent_id        TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  input           TEXT    NOT NULL,
  cron_expression TEXT    NOT NULL,
  enabled         INTEGER DEFAULT 1,
  last_run_at     INTEGER,
  next_run_at     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_next ON scheduled_tasks(next_run_at) WHERE enabled = 1;
