import { dbClient } from './client'

export async function setupDatabase() {
  // Run all statements from migration 0001
  const statements = [
    `CREATE TABLE IF NOT EXISTS organisations (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, logo_url TEXT, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL, personality TEXT, cv TEXT, terms_of_reference TEXT, llm_provider TEXT NOT NULL DEFAULT 'anthropic', llm_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514', skills TEXT DEFAULT '[]', status TEXT NOT NULL DEFAULT 'idle', avatar_emoji TEXT DEFAULT '🤖', agent_type TEXT NOT NULL DEFAULT 'standard', advisor_persona TEXT, memory_long_term TEXT, persona TEXT, expertise TEXT, advisor_ids TEXT, runtime TEXT NOT NULL DEFAULT 'internal', external_endpoint TEXT, api_token_hash TEXT, last_heartbeat_at INTEGER, heartbeat_status TEXT DEFAULT 'unknown', contact_channel TEXT, reports_to TEXT, title TEXT, job_description TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT, title TEXT NOT NULL, input TEXT, output TEXT, status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium', kanban_column TEXT DEFAULT 'todo', llm_model TEXT, tokens_used INTEGER, cost_usd REAL, duration_ms INTEGER, assigned_to TEXT, due_at INTEGER, parent_task_id TEXT, created_at INTEGER NOT NULL, completed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, domain TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'github', github_path TEXT, org_id TEXT, last_synced_at INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS knowledge_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, mime_type TEXT, external_id TEXT, external_url TEXT, parent_id TEXT, content TEXT, backend TEXT NOT NULL DEFAULT 'google_drive', created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL, input TEXT NOT NULL, cron_expression TEXT NOT NULL, enabled INTEGER DEFAULT 1, last_run_at INTEGER, next_run_at INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS org_members (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL)`,
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
    // Sprint 1-2: onboarding columns on organisations
    `ALTER TABLE organisations ADD COLUMN mission TEXT`,
    `ALTER TABLE organisations ADD COLUMN culture TEXT`,
    `ALTER TABLE organisations ADD COLUMN deploy_mode TEXT`,
    `ALTER TABLE organisations ADD COLUMN cloud_provider TEXT`,
    `ALTER TABLE organisations ADD COLUMN preferred_llm TEXT`,
    `ALTER TABLE organisations ADD COLUMN deploy_config TEXT DEFAULT '{}'`,
    `ALTER TABLE organisations ADD COLUMN budget_monthly_usd REAL`,
    // Sprint 4: agent profile fields
    `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`,
    `ALTER TABLE agents ADD COLUMN persona TEXT`,
    `ALTER TABLE agents ADD COLUMN expertise TEXT`,
    `ALTER TABLE agents ADD COLUMN advisor_ids TEXT`,
    // Telegram integration
    `ALTER TABLE org_members ADD COLUMN telegram_chat_id TEXT`,
    `ALTER TABLE organisations ADD COLUMN telegram_bot_token TEXT`,
    // MCA-EXT: external / bring-your-own-runtime agents
    `ALTER TABLE agents ADD COLUMN runtime TEXT NOT NULL DEFAULT 'internal'`,
    `ALTER TABLE agents ADD COLUMN external_endpoint TEXT`,
    `ALTER TABLE agents ADD COLUMN api_token_hash TEXT`,
    `ALTER TABLE agents ADD COLUMN last_heartbeat_at INTEGER`,
    `ALTER TABLE agents ADD COLUMN heartbeat_status TEXT DEFAULT 'unknown'`,
    `ALTER TABLE agents ADD COLUMN contact_channel TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(api_token_hash)`,
    // MCA-PC A1: org chart & hierarchy
    `ALTER TABLE agents ADD COLUMN reports_to TEXT`,
    `ALTER TABLE agents ADD COLUMN title TEXT`,
    `ALTER TABLE agents ADD COLUMN job_description TEXT`,
    // MCA-PC C1: heartbeat engine
    `ALTER TABLE agents ADD COLUMN heartbeat_every_sec INTEGER`,
    `ALTER TABLE agents ADD COLUMN next_wake_at INTEGER`,
    // MCA-PC A3: unified inbox
    `ALTER TABLE tasks ADD COLUMN inbox_state TEXT DEFAULT 'none'`,
    `CREATE TABLE IF NOT EXISTS inbox_dismissals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_inbox_dismissals ON inbox_dismissals(org_id, user_id)`,
    // MCA-PC B1: goals & goal alignment
    `ALTER TABLE tasks ADD COLUMN goal_id TEXT`,
    `CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_goal_id TEXT, title TEXT NOT NULL, description TEXT, metric TEXT, status TEXT NOT NULL DEFAULT 'active', owner_agent_id TEXT, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_goals_org ON goals(org_id)`,
    // MCA-PC B2: approvals & governance
    `CREATE TABLE IF NOT EXISTS approval_requests (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending', requested_by_agent_id TEXT, decided_by TEXT, decided_at INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_approvals_org ON approval_requests(org_id, status)`,
    // MCA-PC D2: plugin registry
    `CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT, enabled INTEGER DEFAULT 0, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_plugins_org ON plugins(org_id)`,
    // MCA-PC D1: workspaces & operator branches
    `ALTER TABLE tasks ADD COLUMN workspace_id TEXT`,
    `ALTER TABLE tasks ADD COLUMN branch TEXT`,
    `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, repo_url TEXT, base_branch TEXT DEFAULT 'main', preview_url TEXT, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id)`,
    // MCA-PC D4: scoped secret store
    `CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, key TEXT NOT NULL, value_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_secrets_org ON secrets(org_id)`,
    // MCA-PC C3: routines+ triggers
    `ALTER TABLE scheduled_tasks ADD COLUMN trigger_type TEXT DEFAULT 'cron'`,
    `ALTER TABLE scheduled_tasks ADD COLUMN webhook_token TEXT`,
    `ALTER TABLE scheduled_tasks ADD COLUMN last_triggered_at INTEGER`,
    // MCA-PC C2: scoped budget policies
    `CREATE TABLE IF NOT EXISTS budget_policies (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, limit_usd REAL NOT NULL, warn_pct REAL DEFAULT 0.8, hard_stop INTEGER DEFAULT 1, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_budget_policies_org ON budget_policies(org_id)`,
    // MCA-EXEC (Phase 1): atomic checkout, run telemetry, task deps + comments
    `ALTER TABLE tasks ADD COLUMN lock_token TEXT`,
    `ALTER TABLE tasks ADD COLUMN locked_at INTEGER`,
    `ALTER TABLE tasks ADD COLUMN blocked_by TEXT`,
    `CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL DEFAULT 'running', session_state TEXT, logs TEXT, tokens_used INTEGER, cost_usd REAL, started_at INTEGER NOT NULL, updated_at INTEGER, ended_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, status)`,
    `CREATE TABLE IF NOT EXISTS task_comments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, task_id TEXT NOT NULL, author_agent_id TEXT, author_user TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id)`,
    // MCA-WORK (Phase 3): attachments/work-products, labels, workspace runtime
    `ALTER TABLE tasks ADD COLUMN labels TEXT`,
    `ALTER TABLE workspaces ADD COLUMN runtime_status TEXT`,
    `ALTER TABLE workspaces ADD COLUMN dev_url TEXT`,
    `CREATE TABLE IF NOT EXISTS task_attachments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'link', name TEXT NOT NULL, url TEXT, content_type TEXT, size_bytes INTEGER, sha TEXT, created_by_agent_id TEXT, created_by_user TEXT, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id)`,
  ]
  for (const sql of alterStatements) {
    try { await dbClient.execute(sql) } catch { /* column already exists */ }
  }

  // Sprint 7: audit_logs table
  try {
    await dbClient.execute(`CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, action TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status_code INTEGER, duration_ms INTEGER, metadata TEXT, created_at INTEGER NOT NULL)`)
    await dbClient.execute(`CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(org_id)`)
    await dbClient.execute(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`)
  } catch { /* already exists */ }

  console.log('✅ Database ready')
}
