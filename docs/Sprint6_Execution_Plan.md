# Sprint 6 — Ship & Wire

**Sprint goal:** Get the backend live on Fly.io, build the mobile app for real-device testing, then wire the remaining app screens to real API data: Costs tab, agent-to-agent chat routing, CSV exports, and Google Drive OAuth connect button.

**Sprint dates:** March 26 – April 9, 2026

**Predecessor:** Sprint 5 merged (PR #44). 197 tests pass. Server starts cleanly. Fastify 5 plugins aligned. Health endpoint live. EAS config in place.

---

## Task Table

| # | Area | Task ID | Task Name | Acceptance Criteria |
|---|------|---------|-----------|-------------------|
| 1 | Infra | DEPLOY-003 | Verify deploy workflow ran after Sprint 5 merge | `deploy.yml` triggered. Backend responds at https://7ei-backend.fly.dev/api/health with `{ status: 'ok' }`. |
| 2 | Infra | DEPLOY-004 | Verify Fly.io secrets are set | `flyctl secrets list` shows DATABASE_URL, DATABASE_AUTH_TOKEN, ANTHROPIC_API_KEY, PUBLIC_URL, ALLOWED_ORIGINS, NODE_ENV. Backend boots without env var crashes. |
| 3 | Infra | DEPLOY-005 | Smoke test: create org on live backend | `POST /api/orgs` via curl against Fly.io returns 201. DB connection works. |
| 4 | App | EAS-002 | Fix EAS build for iOS | `eas build --profile development --platform ios` completes or clear docs on what Apple credentials are needed. |
| 5 | App | EAS-003 | Fix EAS build for Android | APK/AAB available for install. |
| 6 | App | APP-005 | Verify app reaches Fly.io backend | Onboarding screen loads. No localhost references in production config. |
| 7 | Backend | COST-003 | Cost summary endpoint with filters | `GET /api/orgs/:orgId/costs/summary?groupBy=agent&period=7d` returns grouped cost data with totals. |
| 8 | App | COST-004 | Wire Costs tab to real API data | Costs tab shows real spend per agent/project/day from the API. Pull-to-refresh works. |
| 9 | Backend | CHAT-001 | Agent-to-agent chat routing in app | App can send a message to any agent (not just Arturito). Agent picker/switcher in chat screen. Response streams back correctly. |
| 10 | Backend | EXPORT-001 | CSV export of task logs | `GET /api/orgs/:orgId/tasks/export?format=csv` returns downloadable CSV with id, title, status, agentId, createdAt, completedAt. |
| 11 | Backend | EXPORT-002 | CSV export of cost logs | `GET /api/orgs/:orgId/costs/export?format=csv` returns downloadable CSV with date, agentId, model, tokens, cost. |
| 12 | App | DRIVE-004 | Google Drive connect button in app | Settings screen has "Connect Google Drive" button. Tapping opens OAuth consent URL. After auth callback, status shows "Connected". |
| 13 | QA | E2E-001 | Full onboarding test on device | Onboarding completes. Arturito responds to first message on real device. |
| 14 | QA | E2E-002 | Agent creation + chat on device | New agent created from template. Chat works with non-Arturito agent. |
| 15 | Fix | FIX-005 | Fix bugs found during device testing | All bugs from device testing fixed and re-tested. |

---

## Work Orders (for Claude Code)

Execute in order: WO-1 → WO-2 → WO-3 → WO-4 → WO-5 → WO-6 → WO-7

### WO-1: Deploy backend to Fly.io (DEPLOY-003, DEPLOY-004, DEPLOY-005)

Read CLAUDE.md. Check if `.github/workflows/deploy.yml` triggered after the Sprint 5 merge to main. Look at the workflow trigger — if it's `push to main`, it should have run automatically. If it failed, read the Actions log and diagnose. Create `backend/scripts/smoke-test.sh` that curls `https://7ei-backend.fly.dev/api/health` and `POST /api/orgs` with test data. Verify `fly.toml` health check path matches `/api/health` (fix if it points at `/health`). Document any missing Fly.io secrets in the output. Run tests. Commit.

### WO-2: Fix EAS build issues (EAS-002, EAS-003, APP-005)

Read CLAUDE.md, `app/eas.json`, `app/app.json`. Verify: (a) bundle identifier is `ai.7ei.missioncontrol`, (b) EAS project is linked, (c) API URL in all profiles points at `https://7ei-backend.fly.dev` not localhost, (d) CORS on backend allows the app origin. Run `npx expo doctor` to check for config issues. Search the entire `app/` directory for any hardcoded `localhost` or `127.0.0.1` references and replace with the Fly.io URL (guarded by `__DEV__` check where appropriate). Commit.

### WO-3: Wire Costs tab to real API data (COST-003, COST-004)

**Backend:** Add `GET /api/orgs/:orgId/costs/summary` endpoint in `backend/src/routes/all.ts`. Accept query params: `groupBy` (agent | project | day), `period` (7d | 30d | all), `startDate`, `endDate`. Query the costs table grouped accordingly. Return `{ groups: [{ key, label, totalCost, totalTokens, count }], grandTotal }`.

**App:** In `app/app/(tabs)/costs.tsx`, replace any placeholder/mock data with a fetch to `GET /api/orgs/:orgId/costs/summary?groupBy=agent&period=7d`. Show a summary card at top with total spend, then a FlatList of per-agent or per-project breakdowns. Add a period picker (7d / 30d / All). Add pull-to-refresh.

Write tests for the summary endpoint (group by agent, group by day, empty results). Run full suite. Commit.

### WO-4: Agent-to-agent chat routing (CHAT-001)

**App:** In the Agents tab, each agent card should have a "Chat" button that navigates to a chat screen scoped to that agent. If the chat screen currently only works with Arturito (hardcoded agentId), make it accept an `agentId` route param. In `app/app/agent/[agentId]/chat.tsx` (create if needed), fetch agent details and use the existing chat API `POST /api/orgs/:orgId/agents/:agentId/chat`. The chat screen should show the agent's name and emoji in the header.

**Backend:** Verify `POST /api/orgs/:orgId/agents/:agentId/chat` works for any agent, not just the orchestrator. If there's any orchestrator-only guard, make it work for all agents (orchestrator features like delegation still only apply when `isOrchestrator` is true). Write a test: chat with a non-orchestrator agent returns a response. Commit.

### WO-5: CSV export endpoints (EXPORT-001, EXPORT-002)

**Tasks export:** Add `GET /api/orgs/:orgId/tasks/export` in `all.ts`. Accept `format=csv` query param. Query all tasks for the org. Return CSV with headers: `id,title,status,agentId,agentName,createdAt,completedAt`. Set `Content-Type: text/csv` and `Content-Disposition: attachment; filename=tasks-export.csv`.

**Costs export:** Add `GET /api/orgs/:orgId/costs/export`. Same pattern. Headers: `date,agentId,agentName,model,inputTokens,outputTokens,cost`. 

No external CSV library — build the CSV string with proper escaping (quote fields containing commas). Write tests for both endpoints (verify CSV headers, row count matches DB). Commit.

### WO-6: Google Drive OAuth connect button (DRIVE-004)

**App:** In the settings/credentials screen, add a "Connect Google Drive" section. When tapped, call `GET /api/orgs/:orgId/auth/google` (already exists from Phase 3 in CLAUDE.md) to get the OAuth consent URL, then open it in the device browser via `Linking.openURL()`. Add a status indicator that calls `GET /api/orgs/:orgId/auth/google/status` and shows "Connected" or "Not connected". If the backend endpoints don't exist yet, create them per the DRIVE-001 spec in CLAUDE.md (buildAuthUrl, exchangeCode, token storage in oauthTokens table).

Write tests for the auth URL generation and status endpoint. Commit.

### WO-7: Final verification + PR

Run the full test suite. Verify server starts. Create a single PR to main titled "Sprint 6: Ship & Wire" with body listing all work completed. Reference all issues.

---

## Manual Steps (Arturito does these)

1. **Set FLY_API_TOKEN** as GitHub secret if not already done
2. **Set Fly.io secrets** via `flyctl secrets set` or dashboard
3. **Run EAS builds** — needs Apple Developer account for iOS
4. **Install on device** and run through E2E-001/002
5. **Report bugs** for WO-7 fixes

---

## Dependency Order

```
WO-1 (deploy) ─────────────────────────────────────────┐
WO-2 (EAS fixes) ── parallel with WO-1                 │
WO-3 (costs wiring) ── after WO-1 (needs live backend) │
WO-4 (chat routing) ── after WO-1                      │
WO-5 (CSV export) ── after WO-1                        ├── WO-7 (PR)
WO-6 (Drive OAuth) ── after WO-1                       │
Manual device testing ── after WO-2                     │
```

**Recommended execution:** WO-1 → WO-2 → (WO-3, WO-4, WO-5, WO-6 in parallel) → WO-7

---

## Claude Code Prompt

Paste this into Claude Code to execute the sprint:

```
Read docs/Sprint6_Execution_Plan.md and CLAUDE.md. Execute work orders WO-1 through WO-7 in dependency order. For each WO: implement, write tests, run the full test suite (cd backend && npm install && node --test --experimental-strip-types src/tests/*.test.ts), fix any failures, then commit to a branch named claude/sprint6-ship-wire. After all WOs complete, create a PR to main titled "Sprint 6: Ship & Wire". Reference all GitHub issues in the PR body.
```

---

*Sprint 6 plan prepared by Cowork — March 26, 2026*
