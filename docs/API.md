# 7Ei Mission Control — API Reference

> **Machine-readable source of truth:** `GET /api/openapi.json` (OpenAPI 3.1) — generated live from the Fastify route table + Zod validators, so it never drifts. Fetch with `7ei-mc openapi` or `curl -s https://7ei-backend.fly.dev/api/openapi.json`. This hand-written doc is a curated narrative overview; when the two disagree, the endpoint wins.
>
> Version 1.4.0.

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

## Arturita — Command Center

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/orgs/:orgId/arturita/converse` | Yes | Conversational front door — answers directly, or delegates to the agent flow |
| POST | `/api/orgs/:orgId/arturita/attachments/extract` | Yes | Extract plain text from a document attached to a turn (multipart) |
| GET | `/api/orgs/:orgId/arturita/llm-status` | Yes | Cloud-LLM reachability probe (real 1-token ping) |

### Attaching a document to a turn (CC-ATT)

Two steps, so the JSON `/converse` contract (and its `deferAnswer` local-streaming
path) stays intact:

1. **`POST /arturita/attachments/extract`** — multipart, one `file` part. The text is
   extracted with the same `officeparser` path the knowledge ingest uses
   (`services/document-ingest.ts` → `extractText`) and returned. The document is
   **never stored, embedded, or logged**; the buffer is discarded with the response.

   ```jsonc
   // 200
   { "attachment": { "name": "Q3.pdf", "text": "…", "truncated": false },
     "bytes": 24576, "chars": 1840, "truncated": false }
   ```

   **Readable types:** `csv, docx, json, log, markdown, md, odp, ods, odt, pdf, pptx,
   tsv, txt, xlsx`. **Size cap:** 10 MB. **Text cap:** 40,000 chars per turn — longer
   documents are clipped, `truncated: true` is returned, and the operator is told.

   Failures are clean JSON with a `code`, never a 500: `415 unsupported_type`,
   `413 too_large`, `422 empty` / `unreadable` (corrupt, encrypted, or a scan with no
   text layer), `400` (no file).

2. **`POST /arturita/converse`** with the returned text as `attachment`:

   ```jsonc
   { "message": "what was Q3 revenue?",
     "attachment": { "name": "Q3.pdf", "text": "…", "truncated": false } }
   ```

   The text is injected into **that turn only**, after the operator's message, fenced
   as `=== ATTACHED DOCUMENT <nonce>: <name> === … === END ATTACHED DOCUMENT <nonce>: <name> ===`.
   It is not added to `history`, so it doesn't re-enter (and re-bill) later turns. The
   server re-clips over-budget text — the client is not the enforcer.

   **The fence nonce is a boundary, not decoration.** With a fixed marker, a document
   containing the literal closing fence would end its own block early, and the rest of
   its text would read to the model as the *operator* speaking. The nonce is 8 random
   bytes drawn **after** the text is in hand (re-drawn on collision), so no document can
   predict it; the filename is sanitized (no newlines, no `===` runs, ≤120 chars) before
   interpolation. Containment is bounded anyway — routing reads the operator's message
   only, and this text never enters history — so the worst case was always a misleading
   single-turn reply, never an action.

Both routes sit in the Clerk-secured scope behind `requireOrgMembership`, so a
non-member of `:orgId` is refused identically to `/converse` itself. Routing
(`answer` vs `delegate`) reads the **operator's message only** — a document's contents
can never steer a turn into execute-mode. Delegated turns don't carry the attachment
(it lives for one turn); the acknowledgement says so.

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
| POST | `/api/agent-invites/:token/join` | **No** (the invite token is the bearer) | **Epic ONB / ONB3 — the join request.** Public, profile-gated (`publicJoinEnabled`: `packaged` open · `hosted` only with `MC_ENABLE_REMOTE_ONBOARDING` — **closed in production today**), per-IP rate limited (10/min). Body `{ agentName, adapterType, capabilities[], agentDefaultsPayload }` — **strictly typed; an unknown key is refused. There is no free-text field.** Creates **no agent and no credential**: it files a board-approval item and returns `{ requestId, status, claimPath }`. Unknown/expired/revoked/exhausted/lost-race → **one flat 404**. |
| GET | `/api/orgs/:orgId/agent-join-requests` | Yes (owner) | List join requests (`?status=`). Self-declared, unverified data; never a secret value or a token. |
| POST | `/api/orgs/:orgId/agent-join-requests/:requestId/approve` | Yes (owner) | **The board-approval gate.** Creates the agent **contained** (`low_trust_review` regardless of runtime, explicit capabilities) and **mints NO token** (`api_token_hash` is `NULL`; the one-time claim is ONB4). Also decidable from the Inbox card via `POST /api/approvals/:id/decide` — the same path. A second decision is a 409. |
| POST | `/api/orgs/:orgId/agent-join-requests/:requestId/reject` | Yes (owner) | Nothing is minted; the secrets the joining agent supplied are deleted. |
| GET | `/api/orgs/:orgId/audit-log` | Yes (owner) | Query audit logs. `?action=X&limit=N`. **The trail is LIVE (audit H-1 enabled):** records sensitive writes (POST/PUT/PATCH/DELETE) + the onboarding/invite/join/approval surfaces; the read-only GET flood is skipped (`shouldAudit`). Every row is path-redacted + body-sanitized. Retention: rows older than `MC_AUDIT_RETENTION_DAYS` (default 90) are pruned daily. |
| GET | `/api/orgs/:orgId/traces` | Yes (owner) | Recent telemetry spans **for that org**. Was `GET /api/traces` (removed): one process-wide span buffer served to any authenticated caller is a cross-tenant metadata leak. Spans with no `org.id` (today: every `llm.call` span) are attributable to no org and are returned to nobody. |
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
