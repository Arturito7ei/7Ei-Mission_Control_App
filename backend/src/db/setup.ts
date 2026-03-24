import { dbClient } from './client'

export async function setupDatabase() {
  // Run all statements from migration 0001
  const statements = [
    `CREATE TABLE IF NOT EXISTS organisations (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, logo_url TEXT, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL, personality TEXT, cv TEXT, terms_of_reference TEXT, llm_provider TEXT NOT NULL DEFAULT 'anthropic', llm_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514', skills TEXT DEFAULT '[]', status TEXT NOT NULL DEFAULT 'idle', avatar_emoji TEXT DEFAULT '🤖', agent_type TEXT NOT NULL DEFAULT 'standard', advisor_persona TEXT, memory_long_term TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT, title TEXT NOT NULL, input TEXT, output TEXT, status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium', kanban_column TEXT DEFAULT 'todo', llm_model TEXT, tokens_used INTEGER, cost_usd REAL, duration_ms INTEGER, assigned_to TEXT, due_at INTEGER, parent_task_id TEXT, created_at INTEGER NOT NULL, completed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, domain TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'github', github_path TEXT, org_id TEXT, last_synced_at INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS knowledge_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, mime_type TEXT, external_id TEXT, external_url TEXT, parent_id TEXT, content TEXT, backend TEXT NOT NULL DEFAULT 'google_drive', created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL, input TEXT, cron TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC', enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, next_run_at INTEGER, run_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT, events TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, last_triggered_at INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS oauth_tokens (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, provider TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, scopes TEXT, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_agents_org     ON agents(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_org      ON tasks(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_agent    ON tasks(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_org  ON knowledge_items(org_id)`,
  ]
  for (const sql of statements) {
    await dbClient.execute(sql)
  }

  // Idempotent column additions for existing DBs
  const alterStatements = [
    `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`,
  ]
  for (const sql of alterStatements) {
    try { await dbClient.execute(sql) } catch { /* column already exists */ }
  }

  console.log('✅ Database ready')
}
