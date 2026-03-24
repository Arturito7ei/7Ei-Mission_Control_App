# 7Ei Mission Control — Claude Code Technical Requirements

> **Read this file first.** It is the authoritative guide for all implementation work on this repo.
> Sprints 1–2 (Phase 0–2) are **complete**. Phase 3 tasks are below. Run tests after every task. Never skip tasks.

---

## Quick orientation

```
Monorepo (npm workspaces)
├── backend/   Node.js 22 · TypeScript · Fastify · Drizzle ORM · Turso
├── app/       React Native (Expo SDK 51) — iOS + Android
└── web/       Next.js 15 App Router — Vercel
```

**Backend live at:** https://7ei-backend.fly.dev  
**Test command:** `cd backend && npm install && node --test --experimental-strip-types src/tests/*.test.ts`  
**CI:** All three GitHub Actions workflows (ci.yml / test.yml / deploy.yml) are green — keep them green.

---

## Critical files to know before touching anything

| File | What it does |
|---|---|
| `backend/src/routes/all.ts` | All main API routes: orgs, agents, tasks, projects, costs, skills, knowledge |
| `backend/src/services/agent-executor.ts` | Core LLM execution loop. `executeAgentTask()` + `buildSystemPrompt()` |
| `backend/src/services/orchestrator.ts` | Agent-to-agent delegation: `parseDelegateDirectives()` + `executeDelegations()` + `buildSynthesisPrompt()` |
| `backend/src/services/llm-router.ts` | Unified streaming: Anthropic / OpenAI / Gemini. `streamLLM()` + `calcCost()` |
| `backend/src/services/vector-search.ts` | Pinecone: `embedText()` / `upsertDocument()` / `searchKnowledge()` |
| `backend/src/services/memory.ts` | Agent long-term memory: `getMemory()` / `bulkSetMemory()` / `compressMemoryIfNeeded()` |
| `backend/src/services/outbound-webhooks.ts` | Webhook parsing + execution: `parseAgentWebhooks()` / `fireWebhook()` |
| `backend/src/middleware/ratelimit.ts` | Budget enforcement: `checkDailyBudget()` / `recordUsage()` / `acquireTaskSlot()` |
| `backend/src/db/schema.ts` | Drizzle ORM schema. Source of truth for DB shape. |
| `backend/src/db/migrations/` | SQL migration files. Run in order. |
| `app/app/(tabs)/_layout.tsx` | Tab bar: Home, Agents, Tasks, Comms, Costs (knowledge tab hidden via `href: null`) |
| `app/app/(tabs)/knowledge.tsx` | Knowledge screen with semantic search (exists but hidden from tab bar) |
| `app/app/onboarding/index.tsx` | Arturito onboarding wizard |
| `app/app/org/create.tsx` | Org creation screen (pre-fills from onboarding config) |
| `app/store/index.ts` | Zustand store with OnboardingConfig type |

---

## Current state: what is DONE

### Sprint 1 (Phase 0–2) — All 10 tasks complete

| Task | Description | Status |
|---|---|---|
| DB-001 | Onboarding columns on `organisations` table | ✅ |
| ORG-001 | Persist onboarding fields in `POST /api/orgs` | ✅ |
| ORG-002 | Auto-create Arturito + first agent on org creation | ✅ |
| APP-001 | Pass full onboarding config to `POST /api/orgs` | ✅ |
| APP-002 | Navigate to Arturito chat after org creation | ✅ |
| AG-002 | Inject org knowledge into `buildSystemPrompt()` | ✅ |
| AG-003 | Wire RAG retrieval into every agent chat call | ✅ |
| KB-001 | `POST /api/orgs/:orgId/knowledge/embed` endpoint | ✅ |
| AG-004 | `POST /api/orgs/:orgId/agents/propose` endpoint | ✅ |
| LLM-001 | Per-org API key override in `llm-router.ts` | ✅ |

### Sprint 2 — All 5 work orders complete

| Work Order | Description | Status |
|---|---|---|
| FIX-001 | Test fixes + stabilisation | ✅ |
| COST-001 | Cost centre with agent/day/project grouping, budget enforcement | ✅ |
| AGENT-001 | Multi-agent templates + Silver Board advisors + orchestrator delegation | ✅ |
| SKILL-001 | Skill library sync from GitHub, assign to agents, in-app browse | ✅ |
| BUDGET-001 | Budget alerts (80% warning, 100% hard stop) + daily rate limiting | ✅ |

### Test suite: 114 pass, 0 fail

### Key capabilities now working

- Onboarding persistence (mission, culture, deployMode, cloudProvider, preferredLlm)
- Arturito auto-creation with org context seeded into TOR
- Org context injection into `buildSystemPrompt()` (mission + culture)
- RAG retrieval via Pinecone in every agent chat call
- Knowledge embedding with chunking (`chunkText()` with overlap)
- Agent proposal via LLM (`/agents/propose`)
- Per-org API key override (org `deployConfig` → LLM router)
- Cost tracking per agent/project/day with budget alerts
- Multi-agent orchestration: `[DELEGATE: AgentName | task]` protocol
- Silver Board advisors with persona embodiment
- Skill library sync from `Arturito7ei/skill-library`
- Outbound webhooks: `[WEBHOOK: url | payload]` protocol
- Agent long-term memory: `[REMEMBER: key = value]` protocol
- Task Kanban: todo → in_progress → blocked → done
- WebSocket streaming for real-time chat

---

## DO NOT DO (read before writing code)

- **Do NOT rename existing DB columns** — Turso doesn't support it without data migration
- **Do NOT change existing function signatures** without checking every callsite first
- **Do NOT remove `orgId` filter from `searchKnowledge()`** — critical data isolation
- **Do NOT `await` Pinecone upserts inside HTTP handlers** — always fire-and-forget with `.catch()`
- **Do NOT use `process.env` inside `agent-executor.ts`** — pass values as parameters
- **Do NOT add npm packages** without checking if built-in or existing dep covers the need
- **Do NOT touch `.github/workflows/`** unless a task explicitly requires it
- **Do NOT import `vector-search.ts` from `llm-router.ts`** — keep dependency direction: `agent-executor → vector-search`

---

## Coding patterns (match exactly)

```typescript
// Route pattern
app.post('/api/orgs/:orgId/something', async (req, reply) => {
  const { orgId } = req.params as any
  const body = SomeZodSchema.parse(req.body)
  const item = { id: randomUUID(), orgId, ...body, createdAt: new Date() }
  await db.insert(schema.tableName).values(item)
  reply.code(201)
  return { item }
})

// DB single record lookup
const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })

// DB list query
const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId))

// Fire-and-forget async (for Pinecone, webhooks)
upsertDocument({ ... }).catch(err => console.warn('Non-critical:', err))

// Error responses
if (!agent) return reply.code(404).send({ error: 'Agent not found' })
```

---

## PHASE 3 — Google Drive Integration + Agent Task Routing

**Sprint goal:** An org can connect Google Drive, upload/view documents in-app, agents can read Drive content during chat, and Arturito can assign tasks to specialist agents that auto-execute and report results.

---

### DRIVE-001 — Google OAuth backend (token exchange + refresh)

**Files:** Create `backend/src/services/google-auth.ts` + add routes to `backend/src/routes/all.ts`

**Step 1:** Create `backend/src/services/google-auth.ts`:
```typescript
// Google OAuth 2.0 helper
// Scopes: https://www.googleapis.com/auth/drive.readonly
//         https://www.googleapis.com/auth/drive.file

export function buildAuthUrl(orgId: string): string {
  // Build Google OAuth consent URL with state=orgId
  // redirect_uri = process.env.PUBLIC_URL + '/api/auth/google/callback'
  // scope = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  // POST https://oauth2.googleapis.com/token
  // Return access_token, refresh_token, expiry
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  // POST https://oauth2.googleapis.com/token with grant_type=refresh_token
}
```

**Step 2:** Add `oauthTokens` table to `backend/src/db/schema.ts`:
```typescript
export const oauthTokens = sqliteTable('oauth_tokens', {
  id:           text('id').primaryKey(),
  orgId:        text('org_id').notNull(),
  provider:     text('provider').notNull(),         // 'google'
  accessToken:  text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt:    integer('expires_at', { mode: 'timestamp' }),
  scopes:       text('scopes'),
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull(),
})
```

**Step 3:** Add routes in `all.ts` (new `authRoutes()` function):
```typescript
app.get('/api/orgs/:orgId/auth/google', async (req, reply) => {
  // Return { url: buildAuthUrl(orgId) }
})

app.get('/api/auth/google/callback', async (req, reply) => {
  // Exchange code, store tokens in oauthTokens table, redirect to app
})

app.get('/api/orgs/:orgId/auth/google/status', async (req, reply) => {
  // Return { connected: boolean, expiresAt }
})
```

**Env vars required:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

**Accept:** OAuth flow completes. Token stored in DB. `/status` returns `{ connected: true }`. Token auto-refreshes when expired.

---

### DRIVE-002 — Agent reads Drive docs during chat (RAG bridge)

**File:** `backend/src/services/agent-executor.ts` — `executeAgentTask()`

After the existing RAG search block (around line ~35 in `executeAgentTask`), add a Google Drive document fetch step:

```typescript
// After RAG retrieval, also fetch relevant Drive docs if Google is connected
let driveContext = ''
const oauthToken = await db.query.oauthTokens.findFirst({
  where: and(eq(schema.oauthTokens.orgId, agent.orgId), eq(schema.oauthTokens.provider, 'google'))
})
if (oauthToken) {
  try {
    const token = await ensureFreshToken(oauthToken)  // from google-auth.ts
    // Search Drive for files matching the user's input (use Drive API search)
    const driveResults = await searchDriveFiles(token.accessToken, input, 3)
    if (driveResults.length > 0) {
      driveContext = '=== GOOGLE DRIVE DOCUMENTS ===\n' +
        driveResults.map(r => `[${r.name}]: ${r.snippet}`).join('\n') +
        '\n=== END DRIVE DOCS ==='
    }
  } catch (err) {
    console.warn('Drive context fetch failed (non-critical):', err)
  }
}
```

Then pass `driveContext` into `buildSystemPrompt()`:
```typescript
const systemPrompt = buildSystemPrompt(agent, memoryBlock, isOrchestrator, org, ragContext, driveContext)
```

Add `searchDriveFiles()` helper to `google-auth.ts`:
```typescript
export async function searchDriveFiles(accessToken: string, query: string, maxResults: number) {
  // GET https://www.googleapis.com/drive/v3/files?q=fullText contains '...'
  // For each result, fetch first 500 chars of content via export/download
  // Return [{ name, snippet }]
}
```

**Accept:** Agent references Drive document content in responses when Google is connected. Works normally without Google connected.

---

### DRIVE-003 — Upload + view .md files in-app

**File:** `backend/src/routes/all.ts` — `knowledgeRoutes()`

Add upload endpoint:
```typescript
app.post('/api/orgs/:orgId/knowledge/upload', async (req, reply) => {
  const { orgId } = req.params as any
  const { name, content, mimeType = 'text/markdown' } = req.body as any
  if (!name || !content) return reply.code(400).send({ error: 'name and content required' })

  const item = {
    id: randomUUID(), orgId, name, type: 'document',
    mimeType, externalId: null, externalUrl: null,
    parentId: null, content,
    backend: 'upload',
    createdAt: new Date(),
  }
  await db.insert(schema.knowledgeItems).values(item)

  // Also embed for RAG (fire-and-forget)
  upsertDocument({ id: item.id, orgId, text: content, name, type: 'document' })
    .catch(err => console.warn('Embed failed:', err))

  reply.code(201)
  return { item }
})

app.get('/api/knowledge/:itemId/content', async (req, reply) => {
  const { itemId } = req.params as any
  const item = await db.query.knowledgeItems.findFirst({ where: eq(schema.knowledgeItems.id, itemId) })
  if (!item) return reply.code(404).send({ error: 'Not found' })
  return { content: item.content, name: item.name, mimeType: item.mimeType }
})
```

**Accept:** Upload a .md file → appears in knowledge list → can read content back → appears in RAG search results.

---

### KB-TAB-001 — Show Knowledge tab in mobile app

**File:** `app/app/(tabs)/_layout.tsx`

Change the knowledge tab from hidden to visible:
```typescript
// BEFORE:
<Tabs.Screen name="knowledge" options={{ href: null }} />

// AFTER:
<Tabs.Screen name="knowledge" options={{ title: 'KB', tabBarIcon: ({ focused }) => <TabIcon emoji="📚" focused={focused} /> }} />
```

**File:** `app/app/(tabs)/knowledge.tsx`

Add an upload button to the header that opens a text input modal for pasting .md content:
```typescript
// Add to ListHeaderComponent — an "Upload .md" button
<TouchableOpacity
  style={[styles.uploadBtn, { backgroundColor: theme.accent }]}
  onPress={() => setShowUploadModal(true)}
>
  <Text style={{ color: '#fff', fontWeight: '600' }}>+ Upload .md</Text>
</TouchableOpacity>
```

Add a modal with `name` + `content` fields that calls `POST /api/orgs/:orgId/knowledge/upload`.

**Accept:** Knowledge tab visible in bottom bar. User can upload .md content. Files appear in the list and are searchable.

---

### TASK-001 — Agent task auto-execution (assign → execute → report)

**File:** `backend/src/routes/all.ts` — `taskRoutes()`

Add an execution endpoint:
```typescript
app.post('/api/tasks/:taskId/execute', async (req, reply) => {
  const { taskId } = req.params as any
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
  if (!task) return reply.code(404).send({ error: 'Task not found' })
  if (!task.agentId) return reply.code(400).send({ error: 'Task has no assigned agent' })
  if (task.status === 'done') return reply.code(400).send({ error: 'Task already completed' })

  // Execute asynchronously — return immediately with 202
  reply.code(202)

  // Fire-and-forget execution
  executeAgentTask({
    agentId: task.agentId,
    taskId: task.id,
    input: task.input ?? task.title,
  }).catch(err => console.warn('Task execution failed:', err))

  return { taskId, status: 'executing' }
})
```

**Accept:** `POST /api/tasks/:taskId/execute` → returns 202 → task moves to `in_progress` → agent executes → task moves to `done` with output.

---

### ROUTE-001 — Arturito task routing (orchestrator creates + assigns + executes)

**File:** `backend/src/services/orchestrator.ts` — extend `executeDelegations()`

Currently `executeDelegations()` calls `executeAgentTask()` synchronously for each delegation. Extend it to also create a proper task entry with the parent reference:

```typescript
// In executeDelegations(), after the existing task insert, add parentTaskId tracking:
// Add to tasks insert: parentTaskId field (requires schema update below)

// After task completes, fire webhook with result summary:
await fireWebhook('delegation.complete', orgId, {
  parentTaskId,
  delegatedTo: agent.name,
  taskId,
  outputPreview: result.output.slice(0, 200),
})
```

**File:** `backend/src/db/schema.ts` — Add `parentTaskId` to tasks table:
```typescript
parentTaskId: text('parent_task_id'),
```

**Migration:** `0003_parent_task_id.sql`:
```sql
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
```

**File:** `backend/src/services/agent-executor.ts` — Update `buildSystemPrompt()`:

For the orchestrator, include available agents in the system prompt so Arturito knows who to delegate to:
```typescript
if (isOrchestrator) {
  const orgAgents = await db.select({ name: schema.agents.name, role: schema.agents.role })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, agent.orgId), ne(schema.agents.id, agent.id)))
  if (orgAgents.length > 0) {
    lines.push('', 'Available agents for delegation:')
    orgAgents.forEach(a => lines.push(`• ${a.name} — ${a.role}`))
  }
}
```

**Accept:** Arturito lists available agents in system prompt. Delegated tasks have `parentTaskId` set. Webhook fires on delegation complete.

---

## Testing requirements

- Every new function needs at least one unit test in `backend/src/tests/`
- Use Node.js built-in test runner — no external frameworks
- All 114 existing tests must pass after every task

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('[TASK-ID] description', async () => {
  // arrange, act, assert
  assert.strictEqual(actual, expected)
})
```

Required tests per Phase 3 task:
- **DRIVE-001:** `buildAuthUrl()` returns valid URL; `exchangeCode()` stores tokens; `/status` returns connected=true
- **DRIVE-002:** Agent works without Google connected; `searchDriveFiles()` returns results when connected
- **DRIVE-003:** Upload returns item with content; `/content` endpoint returns stored content; RAG embed fires
- **KB-TAB-001:** (Manual test) Knowledge tab visible in app; upload modal works
- **TASK-001:** `/execute` returns 202; task status moves to `done` after execution
- **ROUTE-001:** `parentTaskId` set on delegated tasks; orchestrator system prompt includes available agents

---

## Environment variables (Fly.io secrets)

```bash
flyctl secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  CLERK_SECRET_KEY=sk_live_... \
  DATABASE_URL=libsql://... \
  DATABASE_AUTH_TOKEN=... \
  PUBLIC_URL=https://api.7ei.ai \
  ALLOWED_ORIGINS=https://app.7ei.ai,https://7ei.ai \
  NODE_ENV=production

# Optional but needed for full functionality:
# OPENAI_API_KEY, GEMINI_API_KEY, PINECONE_API_KEY,
# PINECONE_PROJECT_ID, PINECONE_ENVIRONMENT, REDIS_URL

# Phase 3 additions:
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
```

---

## Cloud provider values reference

| Value | Provider | Region | Data residency |
|---|---|---|---|
| `aws` | AWS Bedrock | eu-central-1 Frankfurt | EU / GDPR |
| `aws_ch` | AWS Bedrock | eu-central-2 Zurich | 🇨🇭 Swiss nDSG |
| `gcp` | Google Vertex AI | europe-west1 | EU / GDPR |
| `gcp_ch` | Google Vertex AI | europe-west6 Zurich | 🇨🇭 Swiss nDSG |
| `azure` | Azure OpenAI | Switzerland North | 🇨🇭 Swiss nDSG |
| `oracle` | Oracle Cloud | EU regions | EU / GDPR |

---

*Last updated: March 2026 · 7Ei Mission Control v1.1 — Sprint 3*
