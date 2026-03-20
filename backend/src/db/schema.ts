import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const organisations = sqliteTable('organisations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  logoUrl: text('logo_url'),
  ownerId: text('owner_id').notNull(), // Clerk user ID
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const departments = sqliteTable('departments', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id),
  departmentId: text('department_id').references(() => departments.id),
  name: text('name').notNull(),
  role: text('role').notNull(),
  personality: text('personality'),
  llmProvider: text('llm_provider').notNull().default('anthropic'),
  llmModel: text('llm_model').notNull().default('claude-sonnet-4-20250514'),
  skills: text('skills', { mode: 'json' }).$type<string[]>().default([]),
  status: text('status').notNull().default('idle'), // idle | active | paused | stopped
  avatarUrl: text('avatar_url'),
  memoryLongTerm: text('memory_long_term', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  orgId: text('org_id').notNull().references(() => organisations.id),
  projectId: text('project_id'),
  title: text('title').notNull(),
  input: text('input'),
  output: text('output'),
  status: text('status').notNull().default('pending'), // pending | in_progress | done | blocked | failed
  llmModel: text('llm_model'),
  tokensUsed: integer('tokens_used'),
  costUsd: real('cost_usd'),
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id),
  departmentId: text('department_id').references(() => departments.id),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
