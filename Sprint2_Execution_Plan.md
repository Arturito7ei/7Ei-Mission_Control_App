# Sprint 2 Execution Plan — 7Ei Mission Control App

**Sprint:** 2 of 8
**Duration:** 2 weeks (Mar 24 – Apr 6, 2026)
**Repo:** `Arturito7Ei/7Ei-Mission_Control_App` (monorepo: `backend/`, `app/`, `web/`)
**Baseline:** 86 tests pass (2 pre-existing failures), CI green

---

## Sprint Goal

**Ship cost visibility, multi-agent creation (Silver Board advisors), and a working skill library — turning the single-agent demo into a multi-agent org with observability.**

---

## Priority Stack

| # | Theme | Rationale |
|---|-------|-----------|
| P0 | Fix 2 pre-existing test failures | Tech debt cleanup — green baseline before new work |
| P1 | Cost Centre dashboard (app) | Backend already tracks `tokensUsed`/`costUsd` on tasks + has `GET /api/orgs/:orgId/costs`. App tab `costs.tsx` exists but needs wiring to real data |
| P2 | Multi-agent creation + Silver Board | `AGENT_TEMPLATES` dict exists with 7 templates. `/agents/propose` endpoint exists. App needs "Add Agent" flow + Silver Board advisor creation |
| P3 | Skill Library (browse + assign) | Backend `POST /api/skills/sync` already fetches from `Arturito7ei/skill-library`. App has `app/app/skills/` dir. Needs UI + assign-to-agent flow |
| P4 | Budget alerts (backend) | `ratelimit.ts` has `checkDailyBudget()` — needs persistent thresholds per org and notification hook |

---

## Task Breakdown

| Task ID | Area | Files | Description | Effort | Depends On |
|---------|------|-------|-------------|--------|------------|
| FIX-001 | backend | `backend/src/tests/*.test.ts` | Investigate + fix 2 pre-existing test failures | 2h | — |
| COST-001 | backend | `backend/src/routes/all.ts` (costRoutes) | Add `GET /api/orgs/:orgId/costs/summary` — lightweight totals for dashboard header (today/7d/30d) | 2h | — |
| COST-002 | backend | `backend/src/db/schema.ts`, `backend/src/routes/all.ts` | Add `budgetMonthlyUsd` column to `organisations` table + `PATCH /api/orgs/:orgId/budget` endpoint | 2h | — |
| COST-003 | app | `app/app/(tabs)/costs.tsx`, `app/lib/api.ts` | Wire Costs tab to `GET /api/orgs/:orgId/costs` (by-agent + by-day views), show real data | 4h | COST-001 |
| COST-004 | app | `app/app/(tabs)/costs.tsx` | Add budget progress bar and threshold alert banner (80%/100%) to Costs tab | 2h | COST-002, COST-003 |
| COST-005 | backend | `backend/src/tests/cost-routes.test.ts` | Tests for cost summary endpoint + budget PATCH | 2h | COST-001, COST-002 |
| AG-010 | app | `app/app/agents/create.tsx` (new) | "Add Agent" screen — pick from `AGENT_TEMPLATES` or create custom. Posts to `POST /api/orgs/:orgId/agents` | 4h | — |
| AG-011 | app | `app/app/agents/create.tsx` | Silver Board advisor flow — when template=advisor, show persona text input + "Ask AI to suggest" via `/agents/propose` | 3h | AG-010 |
| AG-012 | app | `app/app/(tabs)/agents.tsx` | Add "+" FAB to agents tab, link to create screen. Show agent type badge (standard vs advisor) | 2h | AG-010 |
| AG-013 | backend | `backend/src/routes/all.ts` | Add `GET /api/orgs/:orgId/agents/advisors` — filtered query returning only `agentType='advisor'` agents | 1h | — |
| AG-014 | app | `app/app/agents/board.tsx` (new) | Silver Board screen — grid of advisor cards, tap to chat. Access from agents tab section header | 3h | AG-013 |
| AG-015 | backend | `backend/src/tests/agent-routes.test.ts` (new) | Tests for agent creation with templates, advisor filtering | 2h | AG-013 |
| SK-001 | app | `app/app/skills/index.tsx` (new) | Skill Library browser — calls `GET /api/skills`, shows skill cards grouped by domain | 3h | — |
| SK-002 | app | `app/app/skills/index.tsx` | "Sync from GitHub" button — calls `POST /api/skills/sync`, shows sync count toast | 1h | SK-001 |
| SK-003 | app | `app/app/skills/[id].tsx` (new) | Skill detail view — shows name, description, full SKILL.md content, "Assign to Agent" button | 2h | SK-001 |
| SK-004 | app | `app/app/skills/[id].tsx`, `app/lib/api.ts` | "Assign to Agent" bottom sheet — pick from org agents, calls `POST /api/agents/:agentId/skills` | 2h | SK-003 |
| SK-005 | backend | `backend/src/tests/skill-routes.test.ts` (new) | Tests for skill CRUD, sync, and agent-skill assignment | 2h | — |
| INT-001 | app | `app/app/(tabs)/_layout.tsx` | Verify all tab icons + labels are correct for current tab set (agents, tasks, knowledge, costs, comms) | 1h | — |

**Total estimated effort: ~40 hours (~5 days of focused work per engineer)**

---

## Work Orders for Claude Code

### WO1 — Fix Pre-Existing Test Failures

**Model:** `Opus` — diagnostic work requiring root-cause analysis across multiple files.

**Goal:** Get from 86 pass / 2 fail → 88 pass / 0 fail.

```
CONTEXT:
- Test runner: Node.js built-in (node --test)
- Test files: backend/src/tests/llm-router.test.ts, memory.test.ts, orchestrator.test.ts, outbound-webhooks.test.ts, scheduler.test.ts
- 86 pass, 2 fail — the failures existed before Sprint 1

INSTRUCTIONS:
1. cd backend && npm test
2. Identify which 2 tests are failing and capture the full error output
3. Read the failing test files and the source files they import
4. Fix the root cause — possibilities include:
   - Import path mismatch after file moves in Sprint 1
   - Missing mock for a new dependency (e.g., db import, Pinecone client)
   - Schema change that a test didn't account for (check schema.ts for new columns)
   - Async timing issue in test setup/teardown
5. Run full test suite after fix: npm test
6. Verify: 88 pass, 0 fail (or 86+N for any new tests added in Sprint 1)

CONSTRAINT: Do NOT change function signatures or rename exports. Fix tests to match current code, not the other way around.
```

---

### WO2 — Cost Centre Backend Enhancements

**Model:** `Sonnet` — well-specified CRUD endpoints following existing patterns.

**Goal:** Add lightweight cost summary endpoint + per-org budget column.

```
CONTEXT:
- Existing: costRoutes() in backend/src/routes/all.ts has GET /api/orgs/:orgId/costs
  which already supports groupBy=agent|day and period=7d|30d|90d
- Schema: tasks table has tokensUsed (integer), costUsd (real), llmModel (text)
- Schema: organisations table does NOT yet have a budget column
- Rate limiter: backend/src/middleware/ratelimit.ts has checkDailyBudget() with hardcoded 2000 token limit

TASK 1 — Add cost summary endpoint:
File: backend/src/routes/all.ts, inside costRoutes()

Add GET /api/orgs/:orgId/costs/summary that returns:
{
  today: { cost: number, tokens: number, tasks: number },
  week:  { cost: number, tokens: number, tasks: number },
  month: { cost: number, tokens: number, tasks: number },
  budget: { monthlyLimitUsd: number | null, usedThisMonth: number, percentUsed: number }
}

Pattern: follow existing costRoutes() query style using db.select().from(schema.tasks).where(and(...))
Calculate each period using gte(schema.tasks.createdAt, sinceDate).
Read budget from organisations table (after TASK 2 adds the column).

TASK 2 — Add budgetMonthlyUsd column to organisations:
File: backend/src/db/schema.ts

Add to organisations table:
  budgetMonthlyUsd: real('budget_monthly_usd')

File: backend/src/routes/all.ts, inside orgRoutes()

The existing PATCH /api/orgs/:orgId already accepts arbitrary body fields and passes them
to db.update(), so budgetMonthlyUsd will work automatically. No route changes needed,
but verify the PATCH endpoint works with Zod validation — may need to extend OrgSchema.

TASK 3 — Tests:
File: backend/src/tests/cost-routes.test.ts (NEW)

Write tests for:
- GET /api/orgs/:orgId/costs/summary returns correct shape
- Cost totals are 0 for a fresh org
- Budget percentage is null when no budget set
- Budget percentage computes correctly when budget is set

Use same test patterns as existing test files (import { describe, it } from 'node:test').
Mock db calls if existing tests do, or use in-memory db if that's the pattern.

CONSTRAINT: All 88+ existing tests must still pass.
```

---

### WO3 — Multi-Agent Creation + Silver Board

**Model:** `Sonnet` — UI implementation with clear specs. Escalate to `Opus` if the template → form pre-fill logic gets tangled.

**Goal:** Users can create agents from templates and set up Silver Board advisors.

```
CONTEXT:
- AGENT_TEMPLATES in backend/src/routes/all.ts has 7 templates:
  arturito, head_dev, head_marketing, head_ops, head_finance, head_rd, advisor
- POST /api/orgs/:orgId/agents already accepts full AgentSchema including:
  agentType ('standard' | 'advisor'), advisorPersona (string)
- GET /api/agent-templates returns { templates: AGENT_TEMPLATES }
- App tabs: app/app/(tabs)/agents.tsx exists — shows agent list
- App dir: app/app/agents/ exists (for agent detail/chat screens)
- Components available: Button, Card, GlassCard, AgentAvatar, StatusBadge, EmptyState
- API client: app/lib/api.ts — follow existing fetch wrapper pattern

TASK 1 — Backend: Advisor filter endpoint:
File: backend/src/routes/all.ts, inside agentRoutes()

Add:
app.get('/api/orgs/:orgId/agents/advisors', async (req) => {
  const { orgId } = req.params as any
  return { agents: await db.select().from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.agentType, 'advisor'))) }
})

TASK 2 — App: Create Agent screen:
File: app/app/agents/create.tsx (NEW)

Screen flow:
1. Header: "Add Team Member"
2. Two sections: "From Template" (grid of AGENT_TEMPLATES cards) and "Custom Agent" (form)
3. Template cards show: avatarEmoji, name, role. Tap → pre-fills form below
4. Form fields: name, role, personality, llmProvider (picker: anthropic/openai/google),
   llmModel (picker filtered by provider — use MODEL_CATALOGUE from llm-router.ts),
   avatarEmoji (text input)
5. If template === 'advisor': show additional "Advisor Persona" textarea
   (e.g., "Warren Buffett — value investing philosophy, folksy wisdom")
6. Submit → POST /api/orgs/:orgId/agents → navigate back to agents tab

Fetch templates from GET /api/agent-templates.
Use existing app/lib/api.ts pattern for API calls.
Use existing components: Button, Card, GlassCard.

TASK 3 — App: Agents tab FAB:
File: app/app/(tabs)/agents.tsx

Add a "+" FloatingActionButton (absolute positioned, bottom-right) that navigates
to /agents/create. Use router.push('/agents/create').

Add a "Silver Board" section header above advisor agents (if any exist).
Filter agents list: standard agents first, then advisors grouped under "Silver Board" header.

TASK 4 — App: Silver Board screen:
File: app/app/agents/board.tsx (NEW)

Simple grid screen showing only advisor agents (from GET /api/orgs/:orgId/agents/advisors).
Each card shows: avatarEmoji, name, advisorPersona snippet, tap → navigate to chat.
Empty state if no advisors: "Add your first advisor" → link to create screen with advisor template.

TASK 5 — Tests:
File: backend/src/tests/agent-routes.test.ts (NEW)

Test:
- POST /api/orgs/:orgId/agents with agentType='advisor' persists advisorPersona
- GET /api/orgs/:orgId/agents/advisors returns only advisors
- GET /api/agent-templates returns all 7 templates

CONSTRAINT: Do not modify AGENT_TEMPLATES dict or AgentSchema. Add routes AFTER existing ones in agentRoutes().
```

---

### WO4 — Skill Library UI

**Model:** `Sonnet` — straightforward list/detail/action UI with clear API endpoints.

**Goal:** Users can browse skills synced from GitHub, view details, and assign to agents.

```
CONTEXT:
- Backend: POST /api/skills/sync fetches from Arturito7ei/skill-library GitHub repo
  Reads each dir's SKILL.md, extracts name (# heading) and description (> blockquote)
  Upserts into skills table with source='github', githubPath=dir.path
- Backend: GET /api/skills returns all skills
- Backend: POST /api/agents/:agentId/skills accepts { skillId } — adds skill.name to agent.skills JSON array
- Schema: skills table has: id, name, description, domain, content, source, githubPath, orgId, lastSyncedAt
- App dir: app/app/skills/ exists (empty or placeholder)
- App API: app/lib/api.ts — follow existing patterns

TASK 1 — App: Skill Library index screen:
File: app/app/skills/index.tsx (NEW or replace placeholder)

Screen:
1. Header: "Skill Library" with sync button (icon: refresh)
2. Sync button → POST /api/skills/sync → show toast "Synced N skills"
3. FlatList of skill cards: name, description, domain badge, source badge (github/custom)
4. Tap card → navigate to /skills/[id]
5. Search/filter by name (local filter on fetched list)

Fetch: GET /api/skills on mount + after sync.

TASK 2 — App: Skill detail screen:
File: app/app/skills/[id].tsx (NEW)

Screen:
1. Header: skill name
2. Description, domain, source info
3. Full SKILL.md content rendered as text (scrollable)
4. "Assign to Agent" button at bottom

TASK 3 — App: Assign skill to agent:
File: app/app/skills/[id].tsx

"Assign to Agent" button opens a bottom sheet / modal:
1. Fetch org agents: GET /api/orgs/:orgId/agents
2. Show agent list (avatar + name)
3. Tap agent → POST /api/agents/:agentId/skills { skillId: skill.id }
4. Show success toast, dismiss modal

TASK 4 — Tests:
File: backend/src/tests/skill-routes.test.ts (NEW)

Test:
- GET /api/skills returns array
- POST /api/skills creates a skill
- POST /api/agents/:agentId/skills adds skill name to agent.skills array
- POST /api/skills/sync (mock GitHub fetch) returns { synced: N }

CONSTRAINT: Do not modify the SKILL_LIBRARY_REPO constant or the sync logic.
The sync already works — just needs UI in front of it.
```

---

### WO5 — Budget Alerts (Backend)

**Model:** `Opus` — touches the execution pipeline (agent-executor.ts) and rate limiter. Needs careful reasoning about where to hook in without breaking the flow.

**Goal:** When an agent chat pushes cost past 80% or 100% of monthly budget, include a warning.

```
CONTEXT:
- agent-executor.ts: executeAgentTask() already calls recordUsage(agent.orgId, tokensUsed, costUsd)
- ratelimit.ts: checkDailyBudget() returns { allowed, remaining: { cost, tokens } }
- tasks table: costUsd is written on every task completion
- organisations table: will have budgetMonthlyUsd after WO2

TASK:
File: backend/src/middleware/ratelimit.ts

Add function: checkMonthlyBudget(orgId: string): { allowed: boolean, percentUsed: number, remaining: number }
1. Query organisations table for budgetMonthlyUsd
2. If null, return { allowed: true, percentUsed: 0, remaining: Infinity }
3. Sum costUsd from tasks table WHERE orgId AND createdAt >= first of current month
4. Calculate percentUsed and remaining
5. Return { allowed: percentUsed < 100, percentUsed, remaining }

File: backend/src/services/agent-executor.ts

In executeAgentTask(), after recordUsage() call, add:
const budgetCheck = await checkMonthlyBudget(agent.orgId)
Include budgetCheck in the ExecuteResult interface:
  budgetWarning?: { percentUsed: number, remaining: number } // only if > 80%

File: backend/src/routes/all.ts

In the POST /api/agents/:agentId/chat response, include budgetWarning from result if present.
In the WebSocket stream 'done' event, include budgetWarning if present.

CONSTRAINT: Do not change the checkDailyBudget signature. Add checkMonthlyBudget as a NEW function.
```

---

## Definition of Done

- [ ] 0 test failures (pre-existing fixed + all new tests pass)
- [ ] Cost Centre tab shows real token/cost data from API, grouped by agent and by day
- [ ] User can create a new agent from a template (7 templates available)
- [ ] User can create a Silver Board advisor with a custom persona
- [ ] Silver Board screen shows advisor grid, tap-to-chat works
- [ ] Skill Library shows synced skills from GitHub, user can assign a skill to an agent
- [ ] Budget progress bar shows on Costs tab when budget is set
- [ ] CI green on `main`

---

## Risk Register

| Risk | Mitigation |
|------|------------|
| GitHub API rate limit during skill sync (unauthenticated: 60 req/hr) | Backend already checks for GITHUB_TOKEN env var and uses it if set. Ensure token is in Fly.dev secrets. |
| New DB column (budgetMonthlyUsd) needs migration on Turso | Drizzle push should handle this. Test with `npx drizzle-kit push` before deploy. |
| App screens reference orgId but user may not have selected an org | App store should have currentOrgId — verify all new screens read from store. Follow pattern in existing tabs. |
| Advisor persona prompt could be very long → large system prompt | Cap advisorPersona at 500 chars in AgentSchema Zod validation. |

---

## Sprint Ceremonies

- **Kickoff:** Day 1 — review this plan, assign WOs
- **Mid-sprint check:** Day 5 — WO1-WO2 should be done, WO3 in progress
- **Demo day:** Day 10 — full demo of all shipped features
- **Retro:** Day 10 — what worked, what didn't, carry-forward items

---

## Carry-Forward to Sprint 3

Items deferred from this sprint to keep scope tight:
- Google Drive OAuth integration (moved to Sprint 3 — needs OAuth consent screen + token storage)
- Obsidian vault connection via MCP
- Knowledge Base tab wiring to real Drive data
- CSV export of task/cost logs
- Persistent budget alert notifications (email/push)
