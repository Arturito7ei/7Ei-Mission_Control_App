# Sprint 3 Execution Plan — Google Drive + Agent Task Routing

**Sprint Goal:** An org can connect Google Drive, upload documents, agents can read Drive content in chat, and Arturito can assign tasks to specialist agents that auto-execute and report results — completing the core value loop.

**Duration:** 2 weeks  
**Prerequisite:** All 114 tests passing (Sprint 1–2 complete)

---

## Task Breakdown

| # | Work Order | Task | Effort | Dependencies |
|---|---|---|---|---|
| 1 | DRIVE-001 | Google OAuth backend (token exchange + refresh + storage) | M | None |
| 2 | DRIVE-003 | Upload + view .md files in-app (backend endpoint) | S | None |
| 3 | KB-TAB-001 | Show Knowledge tab in mobile app + upload modal | S | DRIVE-003 |
| 4 | DRIVE-002 | Agent reads Drive docs during chat (RAG bridge) | L | DRIVE-001 |
| 5 | TASK-001 | Agent task auto-execution (assign → execute → report) | M | None |
| 6 | ROUTE-001 | Arturito task routing (orchestrator creates + assigns + executes) | M | TASK-001 |

**Critical path:** DRIVE-001 → DRIVE-002 (Google must be connected before agents can read Drive)  
**Parallel track:** DRIVE-003 + KB-TAB-001 + TASK-001 can run in parallel with DRIVE-001

---

## Work Order WO-DRIVE-001 — Google OAuth Backend

**Goal:** Backend can initiate Google OAuth, exchange codes for tokens, store and refresh tokens per-org.

### Files to create/modify

1. **Create** `backend/src/services/google-auth.ts`
2. **Modify** `backend/src/db/schema.ts` — add `oauthTokens` table
3. **Create** `backend/src/db/migrations/0003_oauth_tokens.sql`
4. **Modify** `backend/src/routes/all.ts` — add `authRoutes()` function
5. **Modify** `backend/src/index.ts` — register `authRoutes`
6. **Create** tests in `backend/src/tests/google-auth.test.ts`

### Exact implementation

**`backend/src/services/google-auth.ts`:**
```typescript
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'

export function buildAuthUrl(orgId: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${process.env.PUBLIC_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: orgId,
  })
  return `${GOOGLE_AUTH_URL}?${params}`
}

export async function exchangeCode(code: string): Promise<{
  accessToken: string; refreshToken: string; expiresAt: Date
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${process.env.PUBLIC_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`)
  const data = await res.json() as any
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string; expiresAt: Date
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`)
  const data = await res.json() as any
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  }
}

export async function ensureFreshToken(token: {
  accessToken: string; refreshToken: string | null; expiresAt: Date | null
}): Promise<{ accessToken: string; expiresAt: Date }> {
  if (token.expiresAt && token.expiresAt > new Date(Date.now() + 60000)) {
    return { accessToken: token.accessToken, expiresAt: token.expiresAt }
  }
  if (!token.refreshToken) throw new Error('Token expired and no refresh token')
  return refreshAccessToken(token.refreshToken)
}

export async function searchDriveFiles(
  accessToken: string, query: string, maxResults: number
): Promise<Array<{ id: string; name: string; snippet: string }>> {
  const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=${maxResults}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return []
  const data = await res.json() as any
  const results: Array<{ id: string; name: string; snippet: string }> = []
  for (const file of (data.files ?? []).slice(0, maxResults)) {
    try {
      const exportUrl = file.mimeType?.includes('google-apps')
        ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`
        : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
      const contentRes = await fetch(exportUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (contentRes.ok) {
        const text = await contentRes.text()
        results.push({ id: file.id, name: file.name, snippet: text.slice(0, 500) })
      }
    } catch { /* skip unreadable files */ }
  }
  return results
}
```

**`backend/src/db/schema.ts`** — add after `webhooks` table:
```typescript
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
```

**`backend/src/db/migrations/0003_oauth_tokens.sql`:**
```sql
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  scopes TEXT,
  created_at INTEGER NOT NULL
);
```

**`backend/src/routes/all.ts`** — add `authRoutes()`:
```typescript
import { buildAuthUrl, exchangeCode } from '../services/google-auth'

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/auth/google', async (req) => {
    const { orgId } = req.params as any
    return { url: buildAuthUrl(orgId) }
  })

  app.get('/api/auth/google/callback', async (req, reply) => {
    const { code, state: orgId } = req.query as any
    if (!code || !orgId) return reply.code(400).send({ error: 'Missing code or state' })
    const tokens = await exchangeCode(code)
    // Upsert — replace existing token for this org+provider
    const existing = await db.query.oauthTokens.findFirst({
      where: and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google'))
    })
    if (existing) {
      await db.update(schema.oauthTokens).set({
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      }).where(eq(schema.oauthTokens.id, existing.id))
    } else {
      await db.insert(schema.oauthTokens).values({
        id: randomUUID(), orgId, provider: 'google',
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt, scopes: 'drive.readonly drive.file',
        createdAt: new Date(),
      })
    }
    // Redirect to app (deep link or web)
    reply.redirect(`${process.env.ALLOWED_ORIGINS?.split(',')[0] ?? '/'}/knowledge?connected=google`)
  })

  app.get('/api/orgs/:orgId/auth/google/status', async (req) => {
    const { orgId } = req.params as any
    const token = await db.query.oauthTokens.findFirst({
      where: and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google'))
    })
    return { connected: !!token, expiresAt: token?.expiresAt ?? null }
  })
}
```

### Tests
```typescript
test('[DRIVE-001] buildAuthUrl returns valid Google OAuth URL', () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id'
  process.env.PUBLIC_URL = 'https://api.7ei.ai'
  const url = buildAuthUrl('org-123')
  assert.ok(url.includes('accounts.google.com'))
  assert.ok(url.includes('test-client-id'))
  assert.ok(url.includes('state=org-123'))
})

test('[DRIVE-001] ensureFreshToken returns existing token if not expired', async () => {
  const token = { accessToken: 'valid', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 3600000) }
  const result = await ensureFreshToken(token)
  assert.strictEqual(result.accessToken, 'valid')
})
```

### Accept criteria
- `GET /api/orgs/:orgId/auth/google` returns `{ url }` that opens Google consent
- Callback stores tokens in `oauth_tokens` table
- `GET /api/orgs/:orgId/auth/google/status` returns `{ connected: true }` after OAuth
- `ensureFreshToken()` refreshes expired tokens automatically

---

## Work Order WO-DRIVE-003 — Upload + View .md Files

**Goal:** Users can upload markdown files via API, content is stored and auto-embedded for RAG.

### Files to modify

1. **Modify** `backend/src/routes/all.ts` — add to `knowledgeRoutes()`
2. **Create** tests in `backend/src/tests/knowledge-upload.test.ts`

### Exact implementation

**`backend/src/routes/all.ts`** — add inside `knowledgeRoutes()`:
```typescript
import { upsertDocument } from '../services/vector-search'

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

  // Fire-and-forget RAG embedding
  if (process.env.PINECONE_API_KEY) {
    upsertDocument({ id: item.id, orgId, text: content, name, type: 'document' })
      .catch(err => console.warn('Embed failed (non-critical):', err))
  }

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

### Tests
```typescript
test('[DRIVE-003] Upload endpoint returns item with content', async () => {
  // POST /api/orgs/:orgId/knowledge/upload with { name: 'test.md', content: '# Hello' }
  // Assert 201, response has item.id, item.name, item.backend === 'upload'
})

test('[DRIVE-003] Content endpoint returns stored content', async () => {
  // GET /api/knowledge/:itemId/content
  // Assert response.content === '# Hello'
})

test('[DRIVE-003] Upload without name returns 400', async () => {
  // POST with { content: 'no name' } → 400
})
```

### Accept criteria
- `POST /api/orgs/:orgId/knowledge/upload` with `{ name, content }` → 201 with item
- `GET /api/knowledge/:itemId/content` → returns stored content
- Item appears in `GET /api/orgs/:orgId/knowledge` list
- RAG embedding fires (when Pinecone configured)

---

## Work Order WO-KB-TAB-001 — Knowledge Tab Visible + Upload Modal

**Goal:** Knowledge tab appears in bottom bar. User can upload .md content via a modal.

### Files to modify

1. **Modify** `app/app/(tabs)/_layout.tsx` — unhide knowledge tab
2. **Modify** `app/app/(tabs)/knowledge.tsx` — add upload button + modal
3. **Modify** `app/lib/api.ts` — add `api.knowledge.upload()` method

### Exact implementation

**`app/app/(tabs)/_layout.tsx`** — change line:
```typescript
// FROM:
<Tabs.Screen name="knowledge" options={{ href: null }} />
// TO:
<Tabs.Screen name="knowledge" options={{ title: 'KB', tabBarIcon: ({ focused }) => <TabIcon emoji="📚" focused={focused} /> }} />
```

**`app/app/(tabs)/knowledge.tsx`** — add upload modal state + UI:
```typescript
const [showUpload, setShowUpload] = useState(false)
const [uploadName, setUploadName] = useState('')
const [uploadContent, setUploadContent] = useState('')
const [uploading, setUploading] = useState(false)

const handleUpload = async () => {
  if (!uploadName.trim() || !uploadContent.trim() || !currentOrg) return
  setUploading(true)
  try {
    await api.knowledge.upload(currentOrg.id, { name: uploadName.trim(), content: uploadContent.trim() })
    setShowUpload(false); setUploadName(''); setUploadContent('')
    await load()
  } catch (e: any) { Alert.alert('Upload failed', e.message) }
  finally { setUploading(false) }
}
```

Add `<Modal>` with name TextInput + content TextInput (multiline) + Upload button.

**`app/lib/api.ts`** — add to knowledge namespace:
```typescript
upload: (orgId: string, body: { name: string; content: string }) =>
  post(`/api/orgs/${orgId}/knowledge/upload`, body),
```

### Accept criteria
- Knowledge tab visible as 6th tab with 📚 icon
- "Upload .md" button opens modal
- Modal has name + content fields
- Upload stores content and item appears in list

---

## Work Order WO-DRIVE-002 — Agent Reads Drive Docs in Chat

**Goal:** When Google is connected, agents fetch relevant Drive documents and include them in the system prompt.

### Files to modify

1. **Modify** `backend/src/services/agent-executor.ts` — add Drive context fetch
2. **Modify** `backend/src/services/agent-executor.ts` — extend `buildSystemPrompt()` signature

### Exact implementation

**`agent-executor.ts`** — in `executeAgentTask()`, after the memory block and before `buildSystemPrompt()` call (around line ~30):
```typescript
import { ensureFreshToken, searchDriveFiles } from './google-auth'

// Inside executeAgentTask, after agent + org lookup:
let driveContext = ''
try {
  const oauthToken = await db.query.oauthTokens.findFirst({
    where: and(eq(schema.oauthTokens.orgId, agent.orgId), eq(schema.oauthTokens.provider, 'google'))
  })
  if (oauthToken?.refreshToken) {
    const fresh = await ensureFreshToken(oauthToken)
    // Update stored token if refreshed
    if (fresh.accessToken !== oauthToken.accessToken) {
      await db.update(schema.oauthTokens)
        .set({ accessToken: fresh.accessToken, expiresAt: fresh.expiresAt })
        .where(eq(schema.oauthTokens.id, oauthToken.id))
    }
    const driveResults = await searchDriveFiles(fresh.accessToken, input, 3)
    if (driveResults.length > 0) {
      driveContext = '=== GOOGLE DRIVE DOCUMENTS ===\n' +
        driveResults.map(r => `[${r.name}]: ${r.snippet}`).join('\n') +
        '\n=== END DRIVE DOCS ==='
    }
  }
} catch (err) {
  console.warn('Drive context fetch failed (non-critical):', err)
}
```

**`buildSystemPrompt()`** — extend signature:
```typescript
function buildSystemPrompt(
  agent: typeof schema.agents.$inferSelect,
  memoryBlock: string,
  isOrchestrator: boolean,
  driveContext?: string,
): string {
  // ... existing lines ...
  if (driveContext) lines.push('', driveContext, '')
  // ... rest unchanged ...
}
```

### Tests
```typescript
test('[DRIVE-002] executeAgentTask works without Google connected', async () => {
  // Execute task for agent with no oauth_tokens row
  // Assert no error, output returned normally
})

test('[DRIVE-002] buildSystemPrompt includes Drive context when provided', () => {
  const prompt = buildSystemPrompt(mockAgent, '', false, '=== DRIVE ===\ntest\n=== END ===')
  assert.ok(prompt.includes('GOOGLE DRIVE DOCUMENTS') || prompt.includes('DRIVE'))
})
```

### Accept criteria
- Agent works normally when Google is NOT connected (no error, no Drive block)
- When Google IS connected, system prompt includes Drive document snippets
- Token auto-refreshes if expired
- Failure is non-critical (logged, chat continues)

---

## Work Order WO-TASK-001 — Agent Task Auto-Execution

**Goal:** A task assigned to an agent can be executed via API call. Returns 202 immediately, executes async.

### Files to modify

1. **Modify** `backend/src/routes/all.ts` — add to `taskRoutes()`
2. **Create** tests in `backend/src/tests/task-execute.test.ts`

### Exact implementation

**`backend/src/routes/all.ts`** — add inside `taskRoutes()`:
```typescript
app.post('/api/tasks/:taskId/execute', async (req, reply) => {
  const { taskId } = req.params as any
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
  if (!task) return reply.code(404).send({ error: 'Task not found' })
  if (!task.agentId) return reply.code(400).send({ error: 'Task has no assigned agent' })
  if (task.status === 'done') return reply.code(400).send({ error: 'Task already completed' })

  reply.code(202)

  // Fire-and-forget
  executeAgentTask({
    agentId: task.agentId,
    taskId: task.id,
    input: task.input ?? task.title,
  }).catch(err => console.warn('Task execution failed:', err))

  return { taskId, status: 'executing' }
})
```

### Tests
```typescript
test('[TASK-001] Execute returns 202 for valid task', async () => {
  // Create task with agentId → POST /api/tasks/:id/execute → assert 202
})

test('[TASK-001] Execute returns 404 for missing task', async () => {
  // POST /api/tasks/nonexistent/execute → assert 404
})

test('[TASK-001] Execute returns 400 for task without agent', async () => {
  // Create task without agentId → execute → assert 400
})

test('[TASK-001] Execute returns 400 for completed task', async () => {
  // Create task with status='done' → execute → assert 400
})
```

### Accept criteria
- `POST /api/tasks/:taskId/execute` → 202 + `{ taskId, status: 'executing' }`
- Task status changes to `in_progress` then `done`
- Task output populated after execution
- Handles missing task (404), no agent (400), already done (400)

---

## Work Order WO-ROUTE-001 — Arturito Task Routing

**Goal:** Arturito's system prompt includes available agents. Delegated tasks track parent. Webhook fires on delegation complete.

### Files to modify

1. **Modify** `backend/src/db/schema.ts` — add `parentTaskId` to tasks
2. **Create** `backend/src/db/migrations/0004_parent_task_id.sql`
3. **Modify** `backend/src/services/agent-executor.ts` — inject available agents into orchestrator prompt
4. **Modify** `backend/src/services/orchestrator.ts` — pass `parentTaskId` to sub-tasks
5. **Create** tests in `backend/src/tests/routing.test.ts`

### Exact implementation

**`backend/src/db/schema.ts`** — add to tasks table:
```typescript
parentTaskId: text('parent_task_id'),
```

**`backend/src/db/migrations/0004_parent_task_id.sql`:**
```sql
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
```

**`backend/src/services/agent-executor.ts`** — in `buildSystemPrompt()`, extend the orchestrator block:
```typescript
if (isOrchestrator) {
  // Fetch available agents for delegation context
  const orgAgents = await db.select({ name: schema.agents.name, role: schema.agents.role })
    .from(schema.agents)
    .where(eq(schema.agents.orgId, agent.orgId))
  const otherAgents = orgAgents.filter(a => a.name !== agent.name)

  if (otherAgents.length > 0) {
    lines.push('', 'Available agents you can delegate to:')
    otherAgents.forEach(a => lines.push(`• ${a.name} — ${a.role}`))
  }

  lines.push(
    '', 'Orchestration: include [DELEGATE: AgentName | task description] in your response.',
    'Example: [DELEGATE: Dev | Write a TypeScript function to validate email addresses]',
    'Results are synthesised automatically. Delegate to max 3 agents per response.',
  )
}
```

Note: `buildSystemPrompt()` must become `async` since it now queries the DB. Update its signature and all callsites.

**`backend/src/services/orchestrator.ts`** — in `executeDelegations()`, update task insert:
```typescript
await db.insert(schema.tasks).values({
  id: taskId,
  orgId,
  agentId: agent.id,
  parentTaskId: parentTaskId ?? null,  // NEW: link to parent
  title: directive.task.slice(0, 120),
  input: directive.task,
  status: 'pending',
  priority: 'medium',
  createdAt: new Date(),
})
```

Also update the function signature to accept `parentTaskId`:
```typescript
export async function executeDelegations(
  orgId: string,
  orchestratorAgentId: string,
  directives: DelegateDirective[],
  parentTaskId?: string,
): Promise<OrchestrationResult[]> {
```

After each delegation completes, fire webhook:
```typescript
await fireWebhook('delegation.complete', orgId, {
  parentTaskId,
  delegatedTo: agent.name,
  taskId,
  outputPreview: result.output.slice(0, 200),
})
```

### Tests
```typescript
test('[ROUTE-001] buildSystemPrompt includes available agents for orchestrator', async () => {
  // Create org with Arturito + Dev agent
  // Call buildSystemPrompt with isOrchestrator=true
  // Assert prompt includes 'Dev' and 'Head of Development'
})

test('[ROUTE-001] Delegated task has parentTaskId set', async () => {
  // Execute delegation with parentTaskId
  // Query sub-task from DB → assert parentTaskId matches
})

test('[ROUTE-001] parseDelegateDirectives handles multiple delegates', () => {
  const input = '[DELEGATE: Dev | Write code] and [DELEGATE: Maya | Write copy]'
  const dirs = parseDelegateDirectives(input)
  assert.strictEqual(dirs.length, 2)
  assert.strictEqual(dirs[0].targetName, 'Dev')
  assert.strictEqual(dirs[1].targetName, 'Maya')
})
```

### Accept criteria
- Orchestrator system prompt lists available agents by name + role
- Delegated sub-tasks have `parentTaskId` linking to the parent task
- `delegation.complete` webhook fires with parent reference
- All 114+ existing tests still pass

---

## Execution Order

```
Week 1:
  Day 1-2:  WO-DRIVE-001 (Google OAuth — heaviest lift)
  Day 2-3:  WO-DRIVE-003 (Upload .md — can start Day 2)
  Day 3:    WO-KB-TAB-001 (KB tab — depends on DRIVE-003)
  Day 4-5:  WO-TASK-001 (Task auto-execute — independent)

Week 2:
  Day 1-2:  WO-DRIVE-002 (Agent reads Drive — depends on DRIVE-001)
  Day 3-4:  WO-ROUTE-001 (Arturito routing — depends on TASK-001)
  Day 5:    Integration testing + bug fixes
```

**Definition of Done:** User connects Google Drive → uploads a .md file → asks Arturito a question → Arturito references the document → Arturito delegates a follow-up task to Dev → Dev auto-executes → result posted back.

---

*Sprint 3 Execution Plan — 7Ei Mission Control · March 2026*
