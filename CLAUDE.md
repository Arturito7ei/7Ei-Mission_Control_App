# 7Ei Mission Control — Claude Code Technical Requirements

> **Read this file first**, then `HANDOFF.md` (fresh-session kickoff + verification), `STATUS.md` (what's shipped), and `GO-LIVE.md` (pending user-only console actions). Verify claims against the repo before acting on them.

---

## Quick orientation

```
Monorepo (npm workspaces)
├── backend/   Node.js 22 · TypeScript · Fastify · Drizzle ORM · Turso/libSQL — Fly app `7ei-backend` (fra)
├── web/       Next.js 15 App Router — Vercel (app.7ei.ai), Clerk auth — PRIMARY UI
├── app/       React Native (Expo) — legacy/maintenance; web dashboard is the active frontend
├── adapters/  External BYO-agent runtimes: openclaw/, mac-mini/, cursor/, presets/
├── cli/       `7ei-mc` zero-dep Node CLI over the agent API
├── evals/     Orchestration eval harness (11 scenarios)
└── docs/      ADRs, API.md, DEPLOY.md, sprint plans
```

**Backend live at:** https://7ei-backend.fly.dev (`/api/health` → 200, `db: connected`)

## Verify / test commands

```bash
cd backend && npm test          # node --test via tsx — 415 tests, 0 fail (as of 2026-07-02)
cd backend && npm run evals     # orchestration evals — 11/11
cd web && npm run build         # Next.js production build
cd backend && npm run typecheck # tsc --noEmit
# smoke: npm run smoke:openclaw / smoke:openclaw:llm / smoke:cursor
```

Run backend tests + evals after every task. Keep GitHub Actions green.

## Current state (2026-07-02)

Everything below is **shipped** (see `STATUS.md` for the epic table, vault `07-Agents/STATUS-Mission-Control-2026-07-02.md` for the full write-up):

- Sprints 1–3 (onboarding, RAG, orchestration, costs/budgets, skills, Google Drive/Gmail/Calendar OAuth, task routing).
- Paperclip gap-bridge 5/5 phases: MCA-47 (execution core), MCA-52 (adapters + CLI), MCA-56 (attachments/work-products/timeline), MCA-60 (policies, permissions, HMAC run-tokens, plugin jobs), MCA-65 (evals, PWA, self-host Docker).
- UI epic MCA-69: design tokens (`web/app/dashboard/tokens.ts`), task drawer, governance panel, a11y/responsive.
- Go-live hardening (PR #147): adapter pulls `MC_LLM_API_KEY` from the encrypted secret store at boot; `adapters/mac-mini/setup.sh` one-command installer; `GO-LIVE.md` runbook.

**Pending (user-only console actions — see `GO-LIVE.md`):** Clerk production instance, Google sensitive scopes + test user, rotate NVIDIA key + vault PAT, move OpenClaw adapter to the Mac mini. Prod currently runs with `pinecone: false`, `redis: false` (check `/api/health`).

## Critical files

| File | What it does |
|---|---|
| `backend/src/routes/all.ts` | Main API routes: orgs, agents, tasks, projects, costs, skills |
| `backend/src/routes/agent-api.ts` | External-agent API: claim/result/heartbeat/secrets (used by adapters) |
| `backend/src/routes/connectors.ts` | Connectors: Jira, GitHub, Gmail, GCal, GDrive, Hugging Face, Obsidian vault |
| `backend/src/services/agent-executor.ts` | Core LLM execution loop: `executeAgentTask()` + `buildSystemPrompt()` |
| `backend/src/services/orchestrator.ts` | Agent-to-agent delegation + synthesis |
| `backend/src/services/llm-router.ts` | Unified streaming: Anthropic / OpenAI / Gemini. `streamLLM()` + `calcCost()` |
| `backend/src/services/governance.ts` / `governance2.ts` | Execution policies, permissions, config rollback, run-tokens |
| `backend/src/services/runs.ts` / `telemetry.ts` | Run records + telemetry |
| `backend/src/services/secrets.ts` | Encrypted secret store (feeds `GET /api/agent/secrets`) |
| `backend/src/services/vector-search.ts` | Pinecone RAG: `embedText()` / `upsertDocument()` / `searchKnowledge()` |
| `backend/src/db/schema.ts` | Drizzle schema — source of truth for DB shape |
| `backend/src/db/setup.ts` | Idempotent ALTER migrations (the migration convention) |
| `backend/src/tests/boot.test.ts` | Boot test — guards route collisions (a duplicate route caused the 2026-07-01 incident) |
| `web/app/dashboard/` | Dashboard panels: Cockpit, Connectors, Governance, Memory, TaskDrawer, `tokens.ts` |
| `adapters/openclaw/mc_adapter.py` | External runtime adapter (stdlib-only poll loop; secrets from store at boot) |
| `adapters/mac-mini/setup.sh` | One-command adapter install + launchd keep-alive |
| `evals/orchestration.ts` | Eval harness run by `npm run evals` |

## Conventions

- One PR per story, squash-merged with `--admin` (merge auto-deploys Fly + Vercel).
- Migrations: idempotent ALTERs in `backend/src/db/setup.ts` — never rename existing columns.
- Services are pure helpers, tested with Node's built-in `node --test` runner (via tsx) — no external test frameworks.
- Update `STATUS.md` at each shipped story; mirror milestones to the vault (`/Users/artutito/7Ei-MC_TARCO`, repo `Arturito7ei/7Ei-MC_TARCO`, content under `vault/`).
- Jira: Atlassian Rovo OAuth, cloudId `5dadc567-085a-4cd8-99a3-c0bd9886fee9`, projects MCA + OS.

## DO NOT DO

- Do NOT rename existing DB columns — Turso doesn't support it without data migration.
- Do NOT change existing function signatures without checking every callsite.
- Do NOT remove the `orgId` filter from `searchKnowledge()` — critical data isolation.
- Do NOT `await` Pinecone upserts inside HTTP handlers — fire-and-forget with `.catch()`.
- Do NOT use `process.env` inside `agent-executor.ts` — pass values as parameters.
- Do NOT add npm packages without checking if a built-in or existing dep covers the need.
- Do NOT touch `.github/workflows/` unless a task explicitly requires it.
- Do NOT import `vector-search.ts` from `llm-router.ts` — dependency direction: `agent-executor → vector-search`.
- Do NOT register the same route path twice — `boot.test.ts` will fail (this took prod down on 2026-07-01).
- Do NOT paste live secrets into chat, code, or docs — set them via Cockpit → Secrets or Fly secrets.

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

// Fire-and-forget async (Pinecone, webhooks)
upsertDocument({ ... }).catch(err => console.warn('Non-critical:', err))

// Error responses
if (!agent) return reply.code(404).send({ error: 'Agent not found' })
```

## Testing requirements

- Every new function gets at least one unit test in `backend/src/tests/` (Node built-in runner).
- All existing tests must pass after every task (`npm test` — 415 as of 2026-07-02; count grows, zero failures is the invariant).

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('[TASK-ID] description', async () => {
  assert.strictEqual(actual, expected)
})
```

## Environment variables (Fly.io secrets)

```bash
ANTHROPIC_API_KEY, CLERK_SECRET_KEY, DATABASE_URL, DATABASE_AUTH_TOKEN,
PUBLIC_URL, ALLOWED_ORIGINS, NODE_ENV,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
# Optional: OPENAI_API_KEY, GEMINI_API_KEY, PINECONE_API_KEY,
# PINECONE_PROJECT_ID, PINECONE_ENVIRONMENT, REDIS_URL
```

App-level (encrypted secret store, Cockpit → Secrets): `MC_LLM_API_KEY` (adapter LLM brain), `GITHUB_VAULT_TOKEN` (vault writes).

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

*Last updated: 2026-07-02 · replaces the stale March-2026 version (which still listed Phase 3 as pending and 114 tests).*
