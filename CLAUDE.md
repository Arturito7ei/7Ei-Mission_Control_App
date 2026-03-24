# 7Ei Mission Control — Claude Code Technical Requirements

> **Read this file first.** It is the authoritative guide for all implementation work on this repo.
> Work through tasks in Phase 0 → 1 → 2 order. Run tests after every task. Never skip tasks.

---

## Skill / Plugin Routing

Claude Code has installed skills that should be activated **automatically** based on user intent.
Pick the **most specific** skill first. If multiple match, chain them (e.g., code-review → playwright → vercel).

### Intent → Skill mapping

| User intent (trigger phrases) | Skill | Anti-triggers (do NOT use) |
|---|---|---|
| "review code", "check this PR", "security audit", "lint my changes" | **code-review** | General questions about code style |
| "run e2e tests", "write playwright test", "browser test", "test this flow" | **playwright** | Unit tests (use Node.js test runner) |
| "deploy to vercel", "preview deploy", "check build logs", "vercel status" | **vercel** | Fly.io deploys (use existing CI) |
| "deploy to aws", "set up ecs", "create rds", "aws infrastructure" | **deploy-on-aws** | Serverless-only tasks |
| "lambda function", "serverless", "api gateway", "sam deploy", "sst" | **aws-serverless** | Full ECS/EC2 workloads |
| "migrate to aws", "move from fly", "move from heroku", "migration plan" | **migration-to-aws** | Already on AWS |
| "design this screen", "figma to code", "ui component", "responsive layout" | **frontend-design** | Backend-only API work |
| "jira ticket", "create issue", "sprint status", "confluence page" | **atlassian** | GitHub Issues (use MCP github tools) |
| "create a skill", "new plugin", "add a hook", "extend claude" | **skill-creator** | Using existing skills |
| "run autonomously", "ralph loop", "keep going until done", "loop this" | **ralph-loop** | Single-step tasks |
| Complex multi-file tasks, parallel work, deep research | **superpowers** | Simple single-file edits |

### Precedence rules

1. **Most specific wins** — "deploy lambda" → `aws-serverless`, not `deploy-on-aws`.
2. **Project-native first** — Reuse existing patterns in this repo before generating new architecture.
3. **Review before deploy** — When feasible, run `code-review` + `playwright` before any deploy skill.
4. **Chain when needed** — E.g., `frontend-design` → `playwright` → `code-review` → `vercel` for a full UI feature.
5. **Fallback** — If no skill matches, work directly with tools. Don't force a skill.

### Skill activation

- Skills in `~/.claude/skills/` are loaded automatically.
- Ralph loop is a Stop hook — activate via `~/.claude/ralph-loop-ctl.sh start "prompt"`.
- Vercel and Atlassian use MCP tools (prefixed `mcp__`).

---

## Preflight checklist (before any implementation)

- [ ] Read the relevant files before editing (never edit blind)
- [ ] Check if the task is already covered by an existing Phase 0/1/2 task below
- [ ] Verify the change doesn't conflict with "DO NOT DO" rules
- [ ] Identify which skill(s) apply — consult the mapping table above
- [ ] For DB changes: check `schema.ts` and existing migrations first
- [ ] For API changes: check existing routes in `all.ts` for pattern consistency

## Post-change validation checklist

- [ ] Run tests: `cd backend && npm install && node --test --experimental-strip-types src/tests/*.test.ts`
- [ ] Verify CI workflows still pass (don't break ci.yml / test.yml / deploy.yml)
- [ ] Run `code-review` skill on your own diff for security + quality
- [ ] For UI changes: verify on both mobile (Expo) and web (Next.js) if applicable
- [ ] For API changes: test with curl or the test suite — confirm request/response shape
- [ ] Commit with descriptive message, push to the designated feature branch

---

## Safety rules

- **Never** perform destructive git operations (force push, reset --hard, branch -D) without explicit user confirmation.
- **Never** expose secrets, tokens, or API keys in code, logs, or commits. Use env vars or Secrets Manager.
- **Never** skip tests or disable CI checks to make a deploy work.
- **Never** modify `.github/workflows/` unless the task explicitly requires it.
- **Never** deploy to production without user saying "deploy to production" — previews are OK.
- **Ask** concise clarification only when genuinely blocked by ambiguity. Don't ask if you can infer.

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
| `backend/src/services/llm-router.ts` | Unified streaming: Anthropic / OpenAI / Gemini |
| `backend/src/services/vector-search.ts` | Pinecone: `embedText()` / `upsertDocument()` / `searchKnowledge()` |
| `backend/src/db/schema.ts` | Drizzle ORM schema. Source of truth for DB shape. |
| `backend/src/db/migrations/` | SQL migration files. Run in order. |
| `app/app/onboarding/index.tsx` | ✅ Arturito onboarding wizard (just built) |
| `app/app/org/create.tsx` | ✅ Org creation screen (pre-fills from onboarding config) |
| `app/store/index.ts` | ✅ Zustand store with OnboardingConfig type |

---

## Current state: what is MISSING

These are the gaps. Every task below addresses one gap.

1. **`organisations` table missing columns** — `mission`, `culture`, `deployMode`, `cloudProvider`, `preferredLlm`, `deployConfig`
2. **`POST /api/orgs` discards onboarding fields** — schema collects them, route throws them away
3. **Arturito is not auto-created when an org is created** — must happen immediately, seeded with mission+culture
4. **`buildSystemPrompt()` does not inject org context** — mission/culture never reach the LLM
5. **`searchKnowledge()` is never called in the chat flow** — RAG is implemented but not wired
6. **No `/knowledge/embed` endpoint** — cannot upload text to Pinecone from the app
7. **`app/org/create.tsx` does not pass onboarding fields to the API** — form collects them, `api.orgs.create()` ignores them
8. **After org creation, app navigates to `/(tabs)` instead of Arturito's chat**

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

## PHASE 0 — Tasks (do these first, in order)

### DB-001 — Add onboarding columns to organisations table

**Files:** `backend/src/db/schema.ts` + create `backend/src/db/migrations/0002_onboarding_columns.sql`

Add to `organisations` table in schema.ts (after `createdAt`):
```typescript
mission:       text('mission'),
culture:       text('culture'),
deployMode:    text('deploy_mode'),
cloudProvider: text('cloud_provider'),
preferredLlm:  text('preferred_llm'),
deployConfig:  text('deploy_config', { mode: 'json' }).$type<Record<string, string>>().default({}),
```

Create migration SQL:
```sql
-- 0002_onboarding_columns.sql
ALTER TABLE organisations ADD COLUMN mission TEXT;
ALTER TABLE organisations ADD COLUMN culture TEXT;
ALTER TABLE organisations ADD COLUMN deploy_mode TEXT;
ALTER TABLE organisations ADD COLUMN cloud_provider TEXT;
ALTER TABLE organisations ADD COLUMN preferred_llm TEXT;
ALTER TABLE organisations ADD COLUMN deploy_config TEXT DEFAULT '{}';
```

**Accept:** All columns nullable. Existing tests still pass. `npx drizzle-kit push` succeeds.

---

### ORG-001 — Persist onboarding fields in POST /api/orgs

**File:** `backend/src/routes/all.ts` — `orgRoutes()`

Extend `OrgSchema` with:
```typescript
mission:       z.string().optional(),
culture:       z.string().optional(),
deployMode:    z.enum(['cloud', 'local']).optional(),
cloudProvider: z.enum(['aws', 'aws_ch', 'gcp', 'gcp_ch', 'azure', 'oracle']).optional(),
preferredLlm:  z.enum(['claude', 'gpt4o', 'gemini']).optional(),
```

Add to the `org` object in the POST handler:
```typescript
mission:       body.mission       ?? null,
culture:       body.culture       ?? null,
deployMode:    body.deployMode    ?? null,
cloudProvider: body.cloudProvider ?? null,
preferredLlm:  body.preferredLlm  ?? null,
deployConfig:  {},
```

**Accept:** `POST /api/orgs` with `{ name, mission, culture }` → `GET /api/orgs/:id` returns those fields.

---

### ORG-002 — Auto-create Arturito + first agent on org creation

**File:** `backend/src/routes/all.ts` — POST /api/orgs handler  
**Import at top:** `import { upsertDocument } from '../services/vector-search'`

After `db.insert(organisations)`, add:

```typescript
// 1. Embed org knowledge into Pinecone (fire-and-forget)
if (body.mission || body.culture) {
  const knowledgeText = [
    body.mission ? `Mission & Vision: ${body.mission}` : '',
    body.culture  ? `Culture & Principles: ${body.culture}` : '',
  ].filter(Boolean).join('\n\n')
  upsertDocument({
    id: `${org.id}_onboarding`,
    orgId: org.id,
    text: knowledgeText,
    name: 'Onboarding — Mission & Culture',
    type: 'onboarding',
  }).catch(err => console.warn('Pinecone upsert failed (non-critical):', err))
}

// 2. Auto-create Arturito
const arturitoId = randomUUID()
const arturitoTOR = [
  `You are Arturito, Chief of Staff at ${body.name}.`,
  body.mission ? `Organisation mission: ${body.mission}` : '',
  body.culture  ? `Culture: ${body.culture}` : '',
  'You orchestrate all agents, route tasks, and maintain strategic oversight.',
  'When asked to create agents, propose a full profile (name, role, TOR) using org context.',
].filter(Boolean).join('\n')

await db.insert(schema.agents).values({
  id: arturitoId,
  orgId: org.id,
  departmentId: null,
  name: 'Arturito',
  role: 'Chief of Staff & Agent Orchestrator',
  personality: 'Direct, strategic. Routes tasks efficiently. Speaks in first person.',
  cv: null,
  termsOfReference: arturitoTOR,
  llmProvider: body.preferredLlm === 'gpt4o' ? 'openai'
             : body.preferredLlm === 'gemini' ? 'google'
             : 'anthropic',
  llmModel: body.preferredLlm === 'gpt4o' ? 'gpt-4o'
          : body.preferredLlm === 'gemini' ? 'gemini-2.0-flash'
          : 'claude-sonnet-4-20250514',
  skills: [],
  status: 'idle',
  avatarEmoji: '🎯',
  agentType: 'standard',
  advisorPersona: null,
  memoryLongTerm: null,
  createdAt: new Date(),
})

// 3. First specialist agent (if selected)
const FIRST_AGENT_TEMPLATES: Record<string, { name: string; role: string; emoji: string }> = {
  marketing:   { name: 'Maya', role: 'Head of Marketing',   emoji: '📣' },
  engineering: { name: 'Dev',  role: 'Head of Engineering', emoji: '💻' },
  finance:     { name: 'CFO',  role: 'Head of Finance',     emoji: '📊' },
  operations:  { name: 'Ops',  role: 'Head of Operations',  emoji: '⚙️' },
}
const firstRole = (req.body as any).firstAgentRole
if (firstRole && FIRST_AGENT_TEMPLATES[firstRole]) {
  const tmpl = FIRST_AGENT_TEMPLATES[firstRole]
  await db.insert(schema.agents).values({
    id: randomUUID(), orgId: org.id, departmentId: null,
    name: tmpl.name, role: tmpl.role,
    personality: null, cv: null,
    termsOfReference: `You are ${tmpl.name}, ${tmpl.role} at ${body.name}.`,
    llmProvider: 'anthropic',
    llmModel: 'claude-sonnet-4-20250514',
    skills: [], status: 'idle',
    avatarEmoji: tmpl.emoji, agentType: 'standard',
    advisorPersona: null, memoryLongTerm: null,
    createdAt: new Date(),
  })
}

// 4. Return org + arturitoId
reply.code(201)
return { org, arturitoId }
```

**Accept:** `POST /api/orgs` returns `{ org, arturitoId }`. Arturito agent exists immediately. `firstAgentRole='marketing'` creates a second agent.

---

### APP-001 — Pass full onboarding config to POST /api/orgs

**File:** `app/app/org/create.tsx` — `handleCreate()`

Find the `api.orgs.create()` call. Add:
```typescript
const { org, arturitoId } = await api.orgs.create({
  name: name.trim(),
  description: description || undefined,
  mission:        onboardingConfig?.mission        || undefined,
  culture:        onboardingConfig?.culture        || undefined,
  deployMode:     onboardingConfig?.deployMode     || undefined,
  cloudProvider:  onboardingConfig?.cloudProvider  || undefined,
  preferredLlm:   onboardingConfig?.preferredLlm   || undefined,
  firstAgentRole: onboardingConfig?.firstAgentRole || undefined,
})
```

Also update the `api.orgs.create` type in `app/lib/api.ts` to accept these fields if it is typed.

**Accept:** After creation, `GET /api/orgs/:id` returns mission and culture correctly.

---

### APP-002 — Navigate to Arturito chat after org creation

**File:** `app/app/org/create.tsx` — success path in `handleCreate()`

Replace `router.replace('/(tabs)')` with:
```typescript
setOrgs([...orgs, org])
setCurrentOrg(org)
if (arturitoId) {
  router.replace(`/agents/${arturitoId}?firstTime=true`)
} else {
  router.replace('/(tabs)')
}
```

**File:** `app/app/agents/[id].tsx` — add first-time welcome trigger:
```typescript
const { id: agentId, firstTime } = useLocalSearchParams<{ id: string; firstTime?: string }>()

useEffect(() => {
  if (firstTime === 'true' && messages.length === 0) {
    sendMessage('Hello Arturito, I just set up our organisation. Please introduce yourself and tell me what you can help me with today.')
  }
}, [firstTime])
```

**Accept:** After org creation, app opens on Arturito chat screen. Arturito sends a greeting (LLM-generated, not hardcoded).

---

## PHASE 1 — Tasks (after Phase 0 is complete and tested)

### AG-002 — Inject org knowledge into buildSystemPrompt()

**File:** `backend/src/services/agent-executor.ts`

**Step 1:** After agent lookup, add org lookup:
```typescript
const org = await db.query.organisations.findFirst({
  where: eq(schema.organisations.id, agent.orgId)
})
```

**Step 2:** Extend `buildSystemPrompt` signature to accept `org` parameter:
```typescript
function buildSystemPrompt(
  agent: typeof schema.agents.$inferSelect,
  memoryBlock: string,
  isOrchestrator: boolean,
  org?: typeof schema.organisations.$inferSelect | null,
  ragContext?: string,
): string {
  const lines: string[] = []
  
  // ADD AT THE VERY TOP — before agent identity:
  if (org?.mission || org?.culture) {
    lines.push('=== ORGANISATION CONTEXT ===')
    if (org.mission) lines.push(`Mission & Vision: ${org.mission}`)
    if (org.culture)  lines.push(`Culture & Principles: ${org.culture}`)
    lines.push('=== END ORGANISATION CONTEXT ===', '')
  }
  if (ragContext) {
    lines.push(ragContext, '')
  }
  
  // ... rest of existing function unchanged ...
}
```

**Accept:** Arturito answers questions about 'our mission' correctly when mission is set. Null mission = no context block.

---

### AG-003 — Wire RAG retrieval into every agent chat call

**File:** `backend/src/services/agent-executor.ts`  
**Import:** `import { searchKnowledge } from './vector-search'`

After org lookup, before `buildSystemPrompt`:
```typescript
let ragContext = ''
if (process.env.PINECONE_API_KEY) {
  try {
    const results = await searchKnowledge(input, agent.orgId, 5)
    if (results.length > 0) {
      ragContext = '=== RELEVANT KNOWLEDGE ===\n' +
        results.map(r => `[${r.name}] (relevance: ${r.score.toFixed(2)})`).join('\n') +
        '\n=== END RELEVANT KNOWLEDGE ==='
    }
  } catch (err) {
    console.warn('RAG retrieval failed (non-critical):', err)
    // Never throw — agent still works without RAG
  }
}
```

**Accept:** Agent works normally when `PINECONE_API_KEY` is not set. When set and docs are embedded, context appears in responses.

---

### KB-001 — Add POST /api/orgs/:orgId/knowledge/embed endpoint

**File:** `backend/src/routes/all.ts` — `knowledgeRoutes()`

Add this endpoint and helper function:
```typescript
function chunkText(text: string, wordsPerChunk: number, overlapWords: number): string[] {
  const words = text.split(/\s+/)
  const chunks: string[] = []
  const step = wordsPerChunk - overlapWords
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '))
    if (i + wordsPerChunk >= words.length) break
  }
  return chunks.length > 0 ? chunks : [text]
}

app.post('/api/orgs/:orgId/knowledge/embed', async (req, reply) => {
  const { orgId } = req.params as any
  const { name, text, type = 'document' } = req.body as any
  if (!name || !text) return reply.code(400).send({ error: 'name and text are required' })

  const chunks = chunkText(text, 500, 50)
  const itemId = randomUUID()

  await db.insert(schema.knowledgeItems).values({
    id: itemId, orgId, name, type,
    mimeType: 'text/plain',
    externalId: null, externalUrl: null,
    parentId: null, content: text.slice(0, 2000),
    backend: 'text',
    createdAt: new Date(),
  })

  // Fire-and-forget embedding
  const embedPromises = chunks.map((chunk, i) =>
    upsertDocument({
      id: `${itemId}_chunk_${i}`,
      orgId, text: chunk,
      name: chunks.length > 1 ? `${name} (part ${i + 1})` : name,
      type,
    }).catch(err => console.warn('Embed chunk failed:', err))
  )
  Promise.all(embedPromises).catch(() => {})

  reply.code(201)
  return { item: { id: itemId, name, type, chunkCount: chunks.length } }
})
```

**Accept:** POST with 1000-word text returns `chunkCount: 2`. Knowledge item appears in GET list.

---

## PHASE 2 — Tasks (after Phase 1 is complete and tested)

### AG-004 — POST /api/orgs/:orgId/agents/propose

**File:** `backend/src/routes/all.ts` — `agentRoutes()`  
**Import at top if missing:** `import { streamLLM } from '../services/llm-router'`

```typescript
app.post('/api/orgs/:orgId/agents/propose', async (req, reply) => {
  const { orgId } = req.params as any
  const { role } = req.body as any
  if (!role) return reply.code(400).send({ error: 'role is required' })

  const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
  if (!org) return reply.code(404).send({ error: 'Org not found' })

  const prompt = [
    `You are proposing an agent profile for the role: ${role}`,
    org.mission ? `Organisation mission: ${org.mission}` : '',
    org.culture  ? `Culture: ${org.culture}` : '',
    '',
    'Return a JSON object with exactly these keys:',
    '{ "name": string, "role": string, "termsOfReference": string, "cv": string, "avatarEmoji": string }',
    'Return ONLY the JSON object. No preamble, no markdown.',
  ].filter(Boolean).join('\n')

  let fullOutput = ''
  await streamLLM({
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    system: 'You are an expert org designer. Output valid JSON only.',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
    onToken: (t) => { fullOutput += t },
  })

  try {
    const json = JSON.parse(fullOutput.replace(/```json|```/g, '').trim())
    return { proposal: json }
  } catch {
    return reply.code(500).send({ error: 'LLM returned invalid JSON', raw: fullOutput })
  }
})
```

**Accept:** Returns valid JSON with all 5 keys. Handles LLM parse failure with 500 + raw output.

---

### LLM-001 — Per-org API key override in llm-router.ts

**File:** `backend/src/services/llm-router.ts`

Add `orgApiKey?: string` to `LLMStreamOpts`. Use it in all three stream functions:
```typescript
// streamAnthropic: apiKey: opts.orgApiKey ?? process.env.ANTHROPIC_API_KEY
// streamOpenAI:    const apiKey = opts.orgApiKey ?? process.env.OPENAI_API_KEY
// streamGemini:    const apiKey = opts.orgApiKey ?? process.env.GEMINI_API_KEY
```

In `agent-executor.ts`, after org lookup:
```typescript
const orgApiKey = org?.deployConfig?.[`${provider}_api_key`] as string | undefined
// Then pass orgApiKey to streamLLM()
```

**Accept:** If `deployConfig.anthropic_api_key` is set on the org, it is used. If not, env var is used. No change to existing behaviour when orgApiKey is undefined.

---

## Testing requirements

- Every new function needs at least one unit test in `backend/src/tests/`
- Use Node.js built-in test runner — no external frameworks
- All 55 existing tests must pass after every task

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('[TASK-ID] description', async () => {
  // arrange, act, assert
  assert.strictEqual(actual, expected)
})
```

Required tests per task:
- **DB-001:** `chunkText()` returns correct count and overlap
- **ORG-001:** POST /api/orgs persists mission+culture; works without optional fields
- **ORG-002:** Returns `arturitoId`; Arturito agent exists after create; `firstAgentRole` creates 2nd agent
- **AG-002:** `buildSystemPrompt()` includes org block when mission set; absent when null
- **AG-003:** `executeAgentTask()` completes normally without `PINECONE_API_KEY`
- **KB-001:** `chunkText()` chunks correctly with overlap; endpoint returns `chunkCount`
- **AG-004:** Returns valid JSON with 5 keys; handles parse failure gracefully
- **LLM-001:** Uses `orgApiKey` when present; falls back to env when undefined

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

*Last updated: March 2026 · 7Ei Mission Control v1.0*
