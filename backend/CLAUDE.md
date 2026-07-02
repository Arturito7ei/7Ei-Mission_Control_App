# backend/ — Fastify + Drizzle + Turso (Fly app `7ei-backend`, fra)

Loads on top of the root CLAUDE.md when working in `backend/`.

## Verify

```bash
npm test          # node --test via tsx — all tests must pass (415 as of 2026-07-02; count grows, zero failures is the invariant)
npm run evals     # orchestration evals — 11/11
npm run typecheck # tsc --noEmit
# smoke: npm run smoke:openclaw / smoke:openclaw:llm / smoke:cursor
```

## Critical files

| File | What it does |
|---|---|
| `src/routes/all.ts` | Main API routes: orgs, agents, tasks, projects, costs, skills (oversized — split pending, see docs) |
| `src/routes/agent-api.ts` | External-agent API: claim/result/heartbeat/secrets (used by adapters + CLI) |
| `src/routes/connectors.ts` | Connectors: Jira, GitHub, Gmail, GCal, GDrive, Hugging Face, Obsidian vault |
| `src/services/agent-executor.ts` | Core LLM execution loop: `executeAgentTask()` + `buildSystemPrompt()` |
| `src/services/orchestrator.ts` | Agent-to-agent delegation + synthesis |
| `src/services/llm-router.ts` | Unified streaming: Anthropic / OpenAI / Gemini. `streamLLM()` + `calcCost()` |
| `src/services/governance.ts` / `governance2.ts` | Execution policies, permissions, config rollback, HMAC run-tokens |
| `src/services/secrets.ts` | AES-256-GCM secret store (feeds `GET /api/agent/secrets`) |
| `src/services/vector-search.ts` | Pinecone RAG: `embedText()` / `upsertDocument()` / `searchKnowledge()` |
| `src/db/schema.ts` | Drizzle schema — source of truth for DB shape (26 tables) |
| `src/db/setup.ts` | Idempotent ALTER migrations — THE migration convention |
| `src/tests/boot.test.ts` | Guards route collisions (a duplicate route took prod down 2026-07-01) |

## Auth model

- Web → backend: Clerk JWT (stateless), enforced on protected routes.
- External agents → `agent-api.ts`: long-lived agent token (hashed in DB), rotate via `POST /api/agents/:id/rotate-token`.

## DO NOT

- Do NOT rename existing DB columns — Turso can't without data migration. New columns = idempotent ALTER in `src/db/setup.ts`.
- Do NOT remove the `orgId` filter from `searchKnowledge()` — critical data isolation.
- Do NOT `await` Pinecone upserts inside HTTP handlers — fire-and-forget with `.catch()`.
- Do NOT use `process.env` inside `agent-executor.ts` — pass values as parameters.
- Do NOT import `vector-search.ts` from `llm-router.ts` — dependency direction: `agent-executor → vector-search`.
- Do NOT import from `src/routes/` inside `src/services/` — services stay pure helpers (known violation: push notifications; don't add more).
- Do NOT register the same route path twice — `boot.test.ts` fails.
- Do NOT change existing function signatures without checking every callsite.

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

// Single record: db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
// List: db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId))
// Fire-and-forget: upsertDocument({ ... }).catch(err => console.warn('Non-critical:', err))
// Errors: if (!agent) return reply.code(404).send({ error: 'Agent not found' })
```

## Testing

Every new function gets a unit test in `src/tests/` (Node built-in runner via tsx, no external frameworks):

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('[TASK-ID] description', async () => { assert.strictEqual(actual, expected) })
```

## Environment

Fly secrets: `ANTHROPIC_API_KEY, CLERK_SECRET_KEY, DATABASE_URL, DATABASE_AUTH_TOKEN, PUBLIC_URL, ALLOWED_ORIGINS, NODE_ENV, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET` (optional: `OPENAI_API_KEY, GEMINI_API_KEY, PINECONE_*, REDIS_URL`).
App-level encrypted store (Cockpit → Secrets): `MC_LLM_API_KEY`, `GITHUB_VAULT_TOKEN`.

## Cloud provider values (org `deployConfig`)

`aws` Bedrock Frankfurt · `aws_ch` Bedrock Zurich · `gcp` Vertex europe-west1 · `gcp_ch` Vertex Zurich · `azure` OpenAI Switzerland North · `oracle` OCI EU. `*_ch`/azure = Swiss nDSG, rest = EU GDPR.
