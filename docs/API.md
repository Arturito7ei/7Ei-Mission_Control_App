# 7Ei Mission Control — API Reference

> Auto-generated from route definitions. Version 1.4.0.

## Health & Readiness

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check (Fly.io) |
| GET | `/api/health` | No | Enhanced health: DB, scheduler, services, uptime |
| GET | `/ready` | No | Readiness probe |

## Organisations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs` | Yes | List orgs for authenticated user |
| POST | `/api/orgs` | Yes | Create org (+ Arturito + orgMember). Body: `{ name, description?, mission?, culture?, deployMode?, cloudProvider?, preferredLlm?, firstAgentRole? }` |
| GET | `/api/orgs/:orgId` | Yes | Get org by ID |
| PATCH | `/api/orgs/:orgId` | Yes | Update org fields |
| DELETE | `/api/orgs/:orgId` | Owner | Delete org (RBAC: owner only) |

## Agents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/agent-templates` | No | List 7 agent templates |
| GET | `/api/orgs/:orgId/agents` | Yes | List all agents in org |
| POST | `/api/orgs/:orgId/agents` | Yes | Create agent. Body: `{ name, role, personality?, cv?, termsOfReference?, llmProvider?, llmModel?, avatarEmoji?, agentType?, advisorPersona? }` |
| GET | `/api/orgs/:orgId/agents/advisors` | Yes | List advisor agents only |
| POST | `/api/orgs/:orgId/agents/propose` | Yes | LLM-generated agent profile. Body: `{ role }` → Returns `{ proposal: { name, role, termsOfReference, cv, avatarEmoji } }` |
| GET | `/api/agents/:agentId` | Yes | Get agent by ID |
| PATCH | `/api/agents/:agentId` | Yes | Update agent. Validates `advisorIds` in same org |
| PATCH | `/api/agents/:agentId/status` | Yes | Set agent status |
| DELETE | `/api/agents/:agentId` | Yes | Delete agent |
| GET | `/api/agents/:agentId/messages` | Yes | List agent messages |
| POST | `/api/agents/:agentId/skills` | Yes | Assign skill to agent. Body: `{ skillId }` |
| POST | `/api/agents/:agentId/chat` | Yes | Chat with agent. Body: `{ input, history? }` → Returns `{ output, taskId, tokensUsed, costUsd, budgetWarning? }` |
| WS | `/api/agents/:agentId/stream` | Yes | WebSocket streaming chat |

## Tasks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId/tasks` | Yes | List tasks. Query: `?agentId=&status=&projectId=` |
| POST | `/api/orgs/:orgId/tasks` | Yes | Create task |
| GET | `/api/orgs/:orgId/tasks/export` | Yes | CSV export: id, title, status, agentId, agentName, dates |
| GET | `/api/tasks/:taskId` | Yes | Get task by ID |
| PATCH | `/api/tasks/:taskId` | Yes | Update task |
| PATCH | `/api/tasks/:taskId/move` | Yes | Move task on Kanban. Body: `{ column }` |
| DELETE | `/api/tasks/:taskId` | Yes | Delete task |
| POST | `/api/tasks/:taskId/execute` | Yes | Execute task with assigned agent |

## Projects

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId/projects` | Yes | List projects |
| POST | `/api/orgs/:orgId/projects` | Yes | Create project |
| PATCH | `/api/projects/:projectId` | Yes | Update project |
| DELETE | `/api/projects/:projectId` | Yes | Delete project |
| GET | `/api/projects/:projectId/board` | Yes | Kanban board (todo, in_progress, blocked, done) |

## Costs

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId/costs` | Yes | Cost data. Query: `?groupBy=agent|day&period=7d|30d|90d` |
| GET | `/api/orgs/:orgId/costs/summary` | Yes | Summary: today, week, month totals + budget % |
| GET | `/api/orgs/:orgId/costs/export` | Yes | CSV export: date, agentId, agentName, model, tokens, cost |

## Skills

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/skills` | No | List all skills |
| POST | `/api/skills` | Yes | Create custom skill |
| GET | `/api/skills/:skillId` | No | Get skill by ID |
| PATCH | `/api/skills/:skillId` | Yes | Update skill |
| DELETE | `/api/skills/:skillId` | Yes | Delete skill |
| POST | `/api/skills/sync` | Yes | Sync from GitHub (`Arturito7ei/skill-library`) |

## Knowledge

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId/knowledge` | Yes | List knowledge items |
| POST | `/api/orgs/:orgId/knowledge` | Yes | Save knowledge item |
| POST | `/api/orgs/:orgId/knowledge/embed` | Yes | Embed text with chunking (Pinecone) |
| GET | `/api/orgs/:orgId/knowledge/browse` | Yes | Browse Google Drive folder |
| GET | `/api/orgs/:orgId/knowledge/file/:fileId` | Yes | Read Google Drive file |
| DELETE | `/api/knowledge/:itemId` | Yes | Delete knowledge item |

## Scheduled Tasks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/scheduled/presets` | No | Common cron presets |
| GET | `/api/orgs/:orgId/scheduled` | Yes | List scheduled tasks |
| POST | `/api/orgs/:orgId/scheduled` | Yes | Create scheduled task. Body: `{ agentId, title, input?, cronExpression }` |
| PATCH | `/api/scheduled/:id` | Yes | Update scheduled task |
| DELETE | `/api/scheduled/:id` | Yes | Delete scheduled task |
| GET | `/api/scheduled/preview` | No | Preview next cron fire time |

## Credentials

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/orgs/:orgId/credentials` | Owner | Add API key. Body: `{ provider, apiKey }` |
| GET | `/api/orgs/:orgId/credentials` | Yes | List credentials (masked keys) |
| DELETE | `/api/orgs/:orgId/credentials/:provider` | Owner | Remove API key |

## Auth & OAuth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId/auth/google` | Yes | Get Google OAuth consent URL |
| GET | `/api/auth/google/callback` | No | OAuth callback (exchanges code for tokens) |
| GET | `/api/orgs/:orgId/auth/google/status` | Yes | Google Drive connection status |

## Multi-Org

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/users/:userId/orgs` | Yes | List orgs for user (via orgMembers) |
| GET | `/api/orgs/switch/list` | Yes | Enriched org list for switcher |
| POST | `/api/agents/:agentId/transfer` | Yes | Transfer agent to another org |
| POST | `/api/agents/:agentId/clone` | Yes | Clone agent to another org |
| POST | `/api/orgs/:orgId/duplicate` | Yes | Duplicate entire org |

## Audit & Observability

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId/audit-log` | Yes | Query audit logs. `?action=X&limit=N` |
| GET | `/api/traces` | Yes | Recent telemetry spans |
| GET | `/api/orgs/:orgId/usage` | Yes | Current usage stats |
| GET | `/api/orgs/:orgId/limits` | Yes | Rate limit configuration |

## Notifications

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/notifications/register` | Yes | Register Expo push token |
| DELETE | `/api/notifications/register` | Yes | Unregister push token |
| GET | `/api/orgs/:orgId/notifications` | Yes | Recent notifications |

## Models

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/models` | No | Model catalogue (Anthropic, OpenAI, Google) |
