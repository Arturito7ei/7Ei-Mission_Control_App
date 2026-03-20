import { dbClient } from './client'

export async function setupDatabase() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS organisations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, logo_url TEXT,
      owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT, name TEXT NOT NULL,
      description TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT, name TEXT NOT NULL,
      role TEXT NOT NULL, personality TEXT, cv TEXT, terms_of_reference TEXT,
      llm_provider TEXT NOT NULL DEFAULT 'anthropic',
      llm_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
      skills TEXT DEFAULT '[]', status TEXT NOT NULL DEFAULT 'idle',
      avatar_emoji TEXT DEFAULT '🤖', agent_type TEXT NOT NULL DEFAULT 'standard',
      advisor_persona TEXT, memory_long_term TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT,
      title TEXT NOT NULL, input TEXT, output TEXT, status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium', kanban_column TEXT DEFAULT 'todo',
      llm_model TEXT, tokens_used INTEGER, cost_usd REAL, duration_ms INTEGER,
      assigned_to TEXT, due_at INTEGER, created_at INTEGER NOT NULL, completed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, domain TEXT NOT NULL,
      content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'github', github_path TEXT,
      org_id TEXT, last_synced_at INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
      mime_type TEXT, external_id TEXT, external_url TEXT, parent_id TEXT,
      content TEXT, backend TEXT NOT NULL DEFAULT 'google_drive', created_at INTEGER NOT NULL)`,
  ]
  for (const sql of statements) {
    await dbClient.execute(sql)
  }
  console.log('✅ Database ready')
}
