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
  telegramBotToken: text('telegram_bot_token'),
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
  persona: text('persona'),
  expertise: text('expertise'),
  advisorIds: text('advisor_ids'),
  // External / bring-your-own runtime (MCA-EXT). runtime='internal' → driven by
  // agent-executor + llm-router; anything else (openclaw, cursor, claude_code,
  // custom) is a self-hosted runtime that polls the agent API.
  runtime: text('runtime').notNull().default('internal'),
  externalEndpoint: text('external_endpoint'),       // optional push callback URL
  apiTokenHash: text('api_token_hash'),              // sha256 of the agent token
  permissions: text('permissions'),                  // MCA-GOV2 S4.2: JSON capability list (null = allow all)
  lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp' }),
  heartbeatStatus: text('heartbeat_status').default('unknown'), // green|amber|stale|unknown
  contactChannel: text('contact_channel'),           // telegram chat id / email for pings
  // Org chart & hierarchy (MCA-PC A1)
  reportsTo: text('reports_to'),                      // manager agent id
  title: text('title'),                              // job title (e.g. "Head of Engineering")
  jobDescription: text('job_description'),
  // Heartbeat engine (MCA-PC C1)
  heartbeatEverySec: integer('heartbeat_every_sec'),  // wake cadence; null = no auto-wake
  nextWakeAt: integer('next_wake_at', { mode: 'timestamp' }),
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
  parentTaskId: text('parent_task_id'),
  inboxState: text('inbox_state').default('none'),   // none|needs_attention|blocked|awaiting_review|done (MCA-PC A3)
  goalId: text('goal_id'),                            // links task to a goal (MCA-PC B1)
  workspaceId: text('workspace_id'),                  // execution workspace (MCA-PC D1)
  branch: text('branch'),                             // operator branch
  lockToken: text('lock_token'),                      // MCA-EXEC S1.1: atomic checkout lock owner
  lockedAt: integer('locked_at', { mode: 'timestamp' }),
  blockedBy: text('blocked_by'),                      // MCA-EXEC S1.4: JSON array of blocker task ids
  labels: text('labels'),                             // MCA-WORK S3.2: JSON array of label strings
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

// MCA-WORK S3.1: attachments + work products on a task. kind = link | file | work_product.
// Agent work-products commit to the shared vault; url points at the vault path (or an external link).
export const taskAttachments = sqliteTable('task_attachments', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  taskId: text('task_id').notNull(),
  kind: text('kind').notNull().default('link'),       // link | file | work_product
  name: text('name').notNull(),
  url: text('url'),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  sha: text('sha'),
  createdByAgentId: text('created_by_agent_id'),
  createdByUser: text('created_by_user'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// MCA-GOV2 S4.1: immutable snapshots of config mutations, for audit + rollback.
export const configRevisions = sqliteTable('config_revisions', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  entity: text('entity').notNull(),                   // agent | goal | ...
  entityId: text('entity_id').notNull(),
  before: text('before'),                             // JSON snapshot prior to the change
  after: text('after'),                               // JSON snapshot after the change
  actor: text('actor'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// MCA-GOV2 S4.1: execution policies — which actions require human approval.
export const executionPolicies = sqliteTable('execution_policies', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  action: text('action').notNull(),                   // e.g. agent.hire | connector.connect | memory.write
  requiresApproval: integer('requires_approval').default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// MCA-GOV2 S4.4: plugin job queue — the scheduling surface for out-of-process plugin work.
export const pluginJobs = sqliteTable('plugin_jobs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  pluginId: text('plugin_id'),
  type: text('type').notNull(),
  payload: text('payload'),
  status: text('status').notNull().default('queued'), // queued | running | done | failed
  result: text('result'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// MCA-EXEC S1.2: one row per agent execution — structured logs, cost, and
// sessionState that persists across heartbeats so runs resume instead of restart.
export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  agentId: text('agent_id').notNull(),
  taskId: text('task_id'),
  status: text('status').notNull().default('running'),  // running|done|failed|orphaned
  sessionState: text('session_state'),                  // opaque resume blob (JSON string)
  logs: text('logs'),                                   // JSON array of { t, msg }
  tokensUsed: integer('tokens_used'),
  costUsd: real('cost_usd'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
})

// MCA-EXEC S1.4: threaded discussion on a task (ticket comments).
export const taskComments = sqliteTable('task_comments', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  taskId: text('task_id').notNull(),
  authorAgentId: text('author_agent_id'),
  authorUser: text('author_user'),
  kind: text('kind').notNull().default('user'),       // MCA-83 W1: user | agent | system_notice
  body: text('body').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  manifest: text('manifest', { mode: 'json' }).$type<Record<string, unknown>>(),
  enabled: integer('enabled', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  projectId: text('project_id'),
  name: text('name').notNull(),
  repoUrl: text('repo_url'),
  baseBranch: text('base_branch').default('main'),
  previewUrl: text('preview_url'),
  runtimeStatus: text('runtime_status'),              // MCA-WORK S3.3: stopped | starting | running
  devUrl: text('dev_url'),                             // running dev-server URL reported by the agent
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  scope: text('scope').notNull(),                     // company | agent
  scopeId: text('scope_id'),                          // agent id for agent scope
  key: text('key').notNull(),
  valueEncrypted: text('value_encrypted').notNull(),  // AES-256-GCM
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const budgetPolicies = sqliteTable('budget_policies', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  scope: text('scope').notNull(),                     // company | agent | project | goal
  scopeId: text('scope_id'),                          // null for company scope
  limitUsd: real('limit_usd').notNull(),
  warnPct: real('warn_pct').default(0.8),
  hardStop: integer('hard_stop', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  type: text('type').notNull(),                       // spend | hire | external_action | ...
  summary: text('summary').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
  status: text('status').notNull().default('pending'), // pending | approved | rejected | revision_requested (MCA-84 V2 tri-state)
  requestedByAgentId: text('requested_by_agent_id'),
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at', { mode: 'timestamp' }),
  decisionNote: text('decision_note'),                // MCA-84 V2: reviewer note — required for revision_requested (the comment loop)
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  parentGoalId: text('parent_goal_id'),
  title: text('title').notNull(),
  description: text('description'),
  metric: text('metric'),                             // success metric, e.g. "$1M MRR"
  status: text('status').notNull().default('active'), // active|done|paused|dropped
  ownerAgentId: text('owner_agent_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const inboxDismissals = sqliteTable('inbox_dismissals', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  taskId: text('task_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// MCA-84 V2: board read receipts — one row per (user, task); seenAt is bumped
// each time the user opens the task. A task reads "unread" when its last
// activity (createdAt/completedAt) is newer than seenAt, or no row exists.
export const taskReads = sqliteTable('task_reads', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  taskId: text('task_id').notNull(),
  seenAt: integer('seen_at', { mode: 'timestamp' }).notNull(),
})

// MCA-83 W4: task watchdogs — declarative checks attached to a task, evaluated on
// the scheduler tick, results posted in-thread as system-notice comments. Edge-
// triggered (`state` = ok|triggered): a notice fires only when a check flips
// state, so long-running tasks don't spam the thread. "Stop babysitting."
export const taskWatchdogs = sqliteTable('task_watchdogs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  taskId: text('task_id').notNull(),
  kind: text('kind').notNull(),                       // runtime | cost | no_activity | status
  threshold: text('threshold').notNull(),             // minutes | usd | status value (serialized)
  state: text('state').notNull().default('ok'),       // ok | triggered
  lastMessage: text('last_message'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdByUser: text('created_by_user'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastEvaluatedAt: integer('last_evaluated_at', { mode: 'timestamp' }),
  triggeredAt: integer('triggered_at', { mode: 'timestamp' }),
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
  input: text('input').notNull(),
  cronExpression: text('cron_expression').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
  // Routines+ (MCA-PC C3): trigger sources beyond cron
  triggerType: text('trigger_type').default('cron'),  // cron | webhook | api
  webhookToken: text('webhook_token'),               // for webhook/api triggers
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp' }),
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

export const oauthTokens = sqliteTable('oauth_tokens', {
  id:           text('id').primaryKey(),
  orgId:        text('org_id').notNull(),
  provider:     text('provider').notNull(),
  accessToken:  text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt:    integer('expires_at', { mode: 'timestamp' }),
  scopes:       text('scopes'),
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const orgMembers = sqliteTable('org_members', {
  id:              text('id').primaryKey(),
  orgId:           text('org_id').notNull(),
  userId:          text('user_id').notNull(),
  role:            text('role').notNull().default('member'),
  telegramChatId:  text('telegram_chat_id'),
  createdAt:       integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const auditLogs = sqliteTable('audit_logs', {
  id:         text('id').primaryKey(),
  orgId:      text('org_id'),
  userId:     text('user_id'),
  action:     text('action').notNull(),
  method:     text('method').notNull(),
  path:       text('path').notNull(),
  statusCode: integer('status_code'),
  durationMs: integer('duration_ms'),
  metadata:   text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt:  integer('created_at', { mode: 'timestamp' }).notNull(),
})
