import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const organisations = sqliteTable('organisations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  logoUrl: text('logo_url'),
  ownerId: text('owner_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  mission: text('mission'),
  culture: text('culture'),
  deployMode: text('deploy_mode'),
  cloudProvider: text('cloud_provider'),
  preferredLlm: text('preferred_llm'),
  deployConfig: text('deploy_config', { mode: 'json' }).$type<Record<string, string>>().default({}),
  budgetMonthlyUsd: real('budget_monthly_usd'),
})

export const departments = sqliteTable('departments', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  departmentId: text('department_id'),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  departmentId: text('department_id'),
  name: text('name').notNull(),
  role: text('role').notNull(),
  personality: text('personality'),
  cv: text('cv'),
  termsOfReference: text('terms_of_reference'),
  llmProvider: text('llm_provider').notNull().default('anthropic'),
  llmModel: text('llm_model').notNull().default('claude-sonnet-4-20250514'),
  skills: text('skills', { mode: 'json' }).$type<string[]>().default([]),
  status: text('status').notNull().default('idle'),
  avatarEmoji: text('avatar_emoji').default('🤖'),
  agentType: text('agent_type').notNull().default('standard'),
  advisorPersona: text('advisor_persona'),
  memoryLongTerm: text('memory_long_term', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  taskId: text('task_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  orgId: text('org_id').notNull(),
  projectId: text('project_id'),
  title: text('title').notNull(),
  input: text('input'),
  output: text('output'),
  status: text('status').notNull().default('pending'),
  priority: text('priority').notNull().default('medium'),
  kanbanColumn: text('kanban_column').default('todo'),
  llmModel: text('llm_model'),
  tokensUsed: integer('tokens_used'),
  costUsd: real('cost_usd'),
  durationMs: integer('duration_ms'),
  assignedTo: text('assigned_to'),
  dueAt: integer('due_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  domain: text('domain').notNull(),
  content: text('content').notNull(),
  source: text('source').notNull().default('github'),
  githubPath: text('github_path'),
  orgId: text('org_id'),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const knowledgeItems = sqliteTable('knowledge_items', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  mimeType: text('mime_type'),
  externalId: text('external_id'),
  externalUrl: text('external_url'),
  parentId: text('parent_id'),
  content: text('content'),
  backend: text('backend').notNull().default('google_drive'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  agentId: text('agent_id').notNull(),
  title: text('title').notNull(),
  input: text('input'),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: integer('enabled').notNull().default(1),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
  runCount: integer('run_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secret: text('secret'),
  events: text('events', { mode: 'json' }).$type<string[]>().default([]),
  enabled: integer('enabled').notNull().default(1),
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
