# Sprint 4 — Execution Plan

**Sprint goal:** Make the app feel complete for a first beta — rich agent creation, scheduled tasks, org switching, and credential management. After this sprint, a user can onboard, create fully-configured agents, schedule recurring work, and manage multiple orgs from the phone.

**Sprint dates:** March 26 – April 8, 2026

---

## Phase 0 Task Table

| # | Area | Task ID | Task Name | Files / Modules | Implementation Notes | Acceptance Criteria |
|---|------|---------|-----------|-----------------|---------------------|-------------------|
| 1 | DB | SCHEMA-001 | Add scheduled_tasks table | `backend/src/db/schema.ts`, `backend/src/db/migrations/0004_scheduled_tasks.sql` | New table: `id`, `orgId`, `agentId`, `title`, `input` (prompt text), `cronExpression`, `enabled` (boolean), `lastRunAt`, `nextRunAt`, `createdAt`. Index on `orgId + enabled + nextRunAt`. | Migration runs clean. Table exists with all columns. |
| 2 | Backend API | SCHED-001 | Scheduled tasks CRUD endpoints | `backend/src/routes/all.ts` | Add `scheduledTaskRoutes()`: `POST /api/orgs/:orgId/scheduled-tasks` (create), `GET /api/orgs/:orgId/scheduled-tasks` (list), `PATCH /api/scheduled-tasks/:taskId` (update/enable/disable), `DELETE /api/scheduled-tasks/:taskId`. Validate cron with a lightweight parser (no new deps — use regex). | CRUD works. Invalid cron rejected with 400. List returns only org-scoped tasks. |
| 3 | Backend API | SCHED-002 | Scheduled task executor (cron runner) | `backend/src/services/scheduler.ts` (new) | On server boot, start a 60-second interval that queries `scheduled_tasks WHERE enabled = true AND nextRunAt <= now()`. For each hit: call `executeAgentTask()` with the task's `agentId` + `input`, update `lastRunAt`, compute `nextRunAt` from cron expression. Fire-and-forget execution. Cap at 5 concurrent executions per tick. | Scheduled task runs at correct time. `lastRunAt` updates. Task output stored. |
| 4 | Frontend | SCHED-003 | Scheduled tasks screen in mobile app | `app/app/(tabs)/scheduled.tsx` (new), `app/app/(tabs)/_layout.tsx` | New tab "Scheduled" with clock icon. List view of scheduled tasks showing title, agent name, cron schedule (human-readable), enabled toggle, last run time. "+" button opens create modal with fields: title, agent picker, prompt input, cron preset picker (hourly/daily/weekly/custom). | Tab visible. Can create, view, toggle, and delete scheduled tasks. |
| 5 | DB | SCHEMA-002 | Add agent profile fields to schema | `backend/src/db/schema.ts`, `backend/src/db/migrations/0005_agent_profile_fields.sql` | Add nullable columns to `agents` table: `persona` (text), `expertise` (text), `advisorIds` (text — JSON array). | Migration runs. Existing agents unaffected (nullable). |
| 6 | Backend API | AGENT-002 | Agent profile update endpoint | `backend/src/routes/all.ts` | Add `PATCH /api/agents/:agentId` — accepts partial updates to: `name`, `role`, `persona`, `expertise`, `termsOfReference`, `cv`, `avatarEmoji`, `advisorIds`. Validate `advisorIds` are valid agent IDs in same org. | PATCH returns updated agent. Invalid advisorIds rejected. Partial update works. |
| 7 | Frontend | AGENT-003 | Rich agent creation/edit screen | `app/app/agents/create.tsx` (new or extend), `app/app/agents/[id].tsx` | Replace minimal agent creation with full form: name, emoji picker, role, persona, TOR, CV/expertise, Silver Board advisor selector. | Can create agent with all fields. Can edit existing agent. |
| 8 | LLM Logic | AGENT-004 | Inject persona + expertise into system prompt | `backend/src/services/agent-executor.ts` | In `buildSystemPrompt()`, add persona and expertise sections if present. | Agent with persona responds in-character. Agent without persona unchanged. |
| 9 | DB | SCHEMA-003 | Support multiple orgs per user | `backend/src/db/schema.ts`, `backend/src/db/migrations/0006_org_members.sql` | New table `org_members`: `id`, `orgId`, `userId`, `role` (owner/member), `createdAt`. Migrate existing orgs. | Migration runs. Every existing org has one owner member row. |
| 10 | Backend API | ORG-003 | Org switching — list user's orgs | `backend/src/routes/all.ts` | Add `GET /api/users/:userId/orgs`. Modify org endpoints to check membership. | User sees all orgs they belong to. Cannot access orgs they're not a member of. |
| 11 | Frontend | ORG-004 | Org switcher in mobile app | `app/store/index.ts`, `app/app/(tabs)/_layout.tsx`, `app/components/OrgSwitcher.tsx` (new) | Add `currentOrgId` to Zustand store. Org switcher in header. | Can switch between orgs. All screens reflect the selected org. |
| 12 | Backend API | KEYS-001 | Cloud credential management endpoints | `backend/src/routes/all.ts` | Add credential CRUD. Store in `deployConfig` JSON. Never return full keys. | Can add/list/delete API keys. Full keys never returned via API. |
| 13 | Frontend | KEYS-002 | API key management screen | `app/app/settings/credentials.tsx` (new) | Settings screen with masked keys. Add/delete key flows. | Can manage API keys from the app. |
| 14 | Testing/QA | TEST-001 | Test coverage for Sprint 4 | `backend/src/tests/sprint4.test.ts` (new) | Tests for all new endpoints and helpers. Minimum 20 new tests. | All tests green. No regressions. |

---

## Work Orders (for Claude Code)

Execute in this order: WO-1 → WO-2 + WO-3 + WO-5 (parallel) → WO-4 → WO-6 → WO-7

### WO-1: Database schema + migrations (SCHEMA-001, SCHEMA-002, SCHEMA-003)

Open `backend/src/db/schema.ts`. Add a `scheduledTasks` table after the existing `tasks` table with columns: `id` (text, primary key), `orgId` (text, not null), `agentId` (text, not null), `title` (text, not null), `input` (text, not null), `cronExpression` (text, not null), `enabled` (integer with mode boolean, default true), `lastRunAt` (integer with mode timestamp), `nextRunAt` (integer with mode timestamp), `createdAt` (integer with mode timestamp, not null). Then add three nullable columns to the existing `agents` table: `persona` (text), `expertise` (text), `advisorIds` (text). Then create a new `orgMembers` table with columns: `id` (text, primary key), `orgId` (text, not null), `userId` (text, not null), `role` (text, not null, default 'member'), `createdAt` (integer with mode timestamp, not null). Create three migration files: `backend/src/db/migrations/0004_scheduled_tasks.sql` with the CREATE TABLE statement, `0005_agent_profile_fields.sql` with three ALTER TABLE ADD COLUMN statements, and `0006_org_members.sql` with the CREATE TABLE plus an INSERT INTO org_members SELECT that migrates existing org owners. Run all existing tests after to verify no regressions.

### WO-2: Scheduled tasks — CRUD + executor (SCHED-001, SCHED-002)

In `backend/src/routes/all.ts`, add a new `scheduledTaskRoutes(app)` function and register it in the main routes. Add four endpoints: `POST /api/orgs/:orgId/scheduled-tasks` (validates cron via regex, computes `nextRunAt` from cron, inserts into `scheduledTasks`), `GET /api/orgs/:orgId/scheduled-tasks` (list all for org), `PATCH /api/scheduled-tasks/:taskId` (update title/input/cron/enabled, recompute nextRunAt), `DELETE /api/scheduled-tasks/:taskId`. Then create `backend/src/services/scheduler.ts`: export a `startScheduler()` function that sets a 60-second setInterval. Each tick: query `scheduledTasks WHERE enabled = 1 AND nextRunAt <= new Date()`, limit 5. For each: call `executeAgentTask({ agentId: task.agentId, input: '[SCHEDULED TASK] ' + task.input })` with `.catch()` (fire-and-forget), update `lastRunAt = now()`, compute `nextRunAt` from cron. Import and call `startScheduler()` in the server boot file. Write a helper `computeNextRun(cronExpression: string, after: Date): Date` that parses the 5-field cron and returns the next matching minute. Run tests.

### WO-3: Rich agent profiles — backend + prompt (AGENT-002, AGENT-004)

In `backend/src/routes/all.ts` inside `agentRoutes()`, add `PATCH /api/agents/:agentId`. Accept a JSON body with optional fields: `name`, `role`, `persona`, `expertise`, `termsOfReference`, `cv`, `avatarEmoji`, `advisorIds`. If `advisorIds` is provided, validate each ID exists in the agents table with the same orgId. Use `db.update(schema.agents).set(updates).where(eq(schema.agents.id, agentId))`. Return the updated agent. Then in `backend/src/services/agent-executor.ts`, find `buildSystemPrompt()`. After the line that adds org mission/culture context, add: if `agent.persona` is truthy, push `'\nYOUR PERSONALITY AND STYLE:\n' + agent.persona`; if `agent.expertise` is truthy, push `'\nYOUR AREAS OF EXPERTISE:\n' + agent.expertise`. Run tests.

### WO-4: Multi-org support — backend (SCHEMA-003, ORG-003)

After running migration 0006 (from WO-1), add routes in `backend/src/routes/all.ts`: `GET /api/users/:userId/orgs` that joins `orgMembers` with `organisations` where `orgMembers.userId = userId`, returns the org list with the user's role. Then review every existing route that reads `orgId` from params — add a membership check: query `orgMembers WHERE orgId = orgId AND userId = authenticatedUserId`. If no row, return 403. This replaces the current implicit ownership model. Also modify `POST /api/orgs` to insert an `orgMembers` row with `role: 'owner'` after creating the org. Run all tests — update any test that creates an org to also expect the membership row.

### WO-5: Cloud credential management (KEYS-001)

In `backend/src/routes/all.ts`, add credential routes. `POST /api/orgs/:orgId/credentials` accepts `{ provider: 'anthropic'|'openai'|'gemini', apiKey: string }`. Read the org's current `deployConfig` (JSON text column), parse it, add `{provider}_api_key: apiKey`, stringify, update org. `GET /api/orgs/:orgId/credentials` returns an array of `{ provider, maskedKey }` where maskedKey shows first 7 and last 4 chars (e.g. `sk-ant-...xyzw`). `DELETE /api/orgs/:orgId/credentials/:provider` removes the key from deployConfig. Verify that `llm-router.ts` already reads from org deployConfig for the key override (it should from LLM-001). Run tests.

### WO-6: Mobile app — scheduled tasks tab + agent form + org switcher (SCHED-003, AGENT-003, ORG-004, KEYS-002)

In `app/app/(tabs)/_layout.tsx`, add a new tab "Scheduled" with a clock emoji, positioned after Tasks. Create `app/app/(tabs)/scheduled.tsx` with a FlatList showing scheduled tasks fetched from `GET /api/orgs/:orgId/scheduled-tasks`. Each row shows title, agent name, human-readable schedule, enabled toggle (calls PATCH), and a delete button. Add a "+" FAB that opens a modal with fields: title, agent picker, prompt, schedule preset picker. Then update the agent creation flow with full form: name, emoji picker, role, persona, TOR, CV/expertise, advisor selector. Then create `app/components/OrgSwitcher.tsx` dropdown in header. Finally, create `app/app/settings/credentials.tsx` with credential management UI. Run the app to verify navigation works.

### WO-7: Test coverage (TEST-001)

Create `backend/src/tests/sprint4.test.ts`. Write tests for: (1) `computeNextRun()` with various cron patterns, (2) scheduled task CRUD, (3) agent PATCH, (4) org membership, (5) credential masking. Target: 20+ new tests. Run full suite to verify 0 regressions.

---

## GitHub Issues

All 14 issues created: #22–#35, labeled `sprint-4`.

## LLM Prompt Templates

### Agent persona injection (AGENT-004)
```
YOUR PERSONALITY AND STYLE:
{agent.persona}

Always respond in a way that reflects this personality.
```

### Scheduled task wrapper
```
[SCHEDULED TASK] This task was triggered automatically by a schedule ({cronExpression}).
Original instruction: {task.input}

Execute this task and provide a clear, actionable result.
```

---

*Sprint 4 plan prepared by Cowork — March 25, 2026*
