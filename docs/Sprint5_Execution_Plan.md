# Sprint 5 — Deploy & Stabilize

**Sprint goal:** Fix all blockers from the Sprint 4 audit, get the backend deployed and running on Fly.io, set up EAS builds for mobile testing, and make the onboarding flow work end-to-end on a real device.

**Sprint dates:** March 26 – April 8, 2026

---

## Task Table

| # | Area | Task ID | Task Name | Files / Modules | Implementation Notes | Acceptance Criteria |
|---|------|---------|-----------|-----------------|---------------------|-------------------|
| 1 | Backend | FIX-002 | Fix Fastify version conflict | `backend/package.json` | Fastify 5.x is installed but `@fastify/cors` requires Fastify 4.x. Either downgrade Fastify to 4.x or upgrade `@fastify/cors` to a version compatible with Fastify 5. Check all `@fastify/*` plugins for compatibility. Server must start locally without errors. | `cd backend && node --experimental-strip-types src/index.ts` starts without version mismatch errors. |
| 2 | Backend | FIX-003 | Add firstAgentRole to Zod schema | `backend/src/routes/all.ts` | In `orgRoutes()`, the `OrgSchema` Zod definition (around line 24-33) is missing `firstAgentRole`. Add `firstAgentRole: z.string().optional()` to the schema. Then read it from the validated `body` instead of `req.body`. | POST /api/orgs with `firstAgentRole: 'marketing'` creates both Arturito and the specialist agent. Without it, only Arturito is created. |
| 3 | Backend | FIX-004 | Fix N+1 advisorIds validation | `backend/src/routes/all.ts` | In PATCH `/api/agents/:agentId`, replace the loop that queries each advisorId individually with a single `SELECT id FROM agents WHERE id IN (...) AND orgId = ?` query. Compare result count with input count. | PATCH with 5 advisorIds makes 1 DB query, not 5. Invalid IDs still return 400. |
| 4 | Infra | DEPLOY-001 | Align Dockerfile Node version | `backend/Dockerfile` | Change `FROM node:20-alpine` to `FROM node:22-alpine` to match local dev and CLAUDE.md spec. Verify the multi-stage build still works. | Dockerfile uses node:22-alpine. `docker build` succeeds. |
| 5 | Infra | DEPLOY-002 | Verify and fix Fly.io deployment | `backend/fly.toml`, `.github/workflows/deploy.yml` | Check that `fly.toml` exists and has correct config (app name, region fra, internal port 8080 or whatever index.ts binds to). Check deploy.yml triggers on push to main and uses `FLY_API_TOKEN` secret. If fly.toml is missing, create it. Verify the health check endpoint exists. | `fly deploy` succeeds. Backend responds at https://7ei-backend.fly.dev. Health check passes. |
| 6 | Backend | HEALTH-001 | Add /api/health endpoint | `backend/src/routes/all.ts` | Add `GET /api/health` that returns `{ status: 'ok', version: '1.2.0', timestamp: new Date().toISOString() }`. No auth required. This is used by Fly.io health checks and monitoring. | GET /api/health returns 200 with status 'ok'. |
| 7 | Backend | ARTURITO-001 | Give Arturito default persona + expertise | `backend/src/routes/all.ts` | In the `POST /api/orgs` handler where Arturito is auto-created, set `persona` and `expertise` fields: persona = "You are Arturito, the AI Chief of Staff. You are professional, warm, and action-oriented. You speak clearly and concisely. You always have a plan." expertise = "Organization management, task delegation, strategic planning, team coordination, onboarding new agents". | New Arturito agents have persona and expertise set. buildSystemPrompt() includes them in the prompt. |
| 8 | Frontend | APP-003 | Fix duplicate style definitions | `app/app/` (multiple files) | Search for duplicate `styles.required` definitions across the mobile app. Remove the redundant ones, keeping the first definition. | No duplicate style keys in any file. App renders without style warnings. |
| 9 | Infra | EAS-001 | Configure EAS Build for dev testing | `app/eas.json`, `app/app.json` | Create `eas.json` with a `development` profile that builds a dev client (not production). Configure `app.json` with the correct bundle identifiers (ai.7ei.missioncontrol). Set the API URL to point at `https://7ei-backend.fly.dev`. | `eas build --profile development --platform ios` succeeds. Dev client can be installed on device. |
| 10 | Frontend | APP-004 | Point mobile app at live backend | `app/` (API config file) | Find where the API base URL is configured (likely in a constants file, env config, or store). Set it to `https://7ei-backend.fly.dev` for production/dev builds. Ensure the onboarding flow can reach the backend. | App makes API calls to the Fly.io backend, not localhost. |
| 11 | Testing/QA | TEST-002 | End-to-end onboarding test | `backend/src/tests/e2e-onboarding.test.ts` (new) | Write an integration test that simulates the full onboarding: (1) POST /api/orgs with all fields → (2) verify org has mission/culture → (3) verify Arturito agent exists with persona → (4) verify orgMembers row exists → (5) verify first specialist agent if firstAgentRole provided → (6) POST /api/orgs/:orgId/agents/:arturitoId/chat with "hello" → verify response is not empty. | Test passes. Full onboarding path verified programmatically. |
| 12 | Testing/QA | TEST-003 | Fix pre-existing test failures | `backend/src/tests/*.test.ts` | The 8 pre-existing test failures are all `ERR_MODULE_NOT_FOUND` due to missing `.ts` extensions in test imports (Node 22 + experimental strip types requires explicit extensions). Find and fix all affected imports. | All tests pass. Zero failures. |

---

## Work Orders (for Claude Code)

Execute in order: WO-1 → WO-2 → WO-3 → WO-4 → WO-5

### WO-1: Fix all backend bugs (FIX-002, FIX-003, FIX-004, HEALTH-001, ARTURITO-001)

Fix the Fastify version conflict: check `backend/package.json` for `fastify` and `@fastify/cors` versions. Either downgrade fastify to 4.x or upgrade `@fastify/cors` to be compatible with fastify 5.x. Check ALL `@fastify/*` deps for compatibility. Then in `backend/src/routes/all.ts` orgRoutes(), add `firstAgentRole: z.string().optional()` to the OrgSchema Zod definition and read it from validated body. Then fix the N+1 advisorIds query in PATCH /api/agents/:agentId — replace the individual ID lookups with a single IN query. Add `GET /api/health` endpoint returning `{ status: 'ok', version: '1.2.0', timestamp }` with no auth. Finally, in POST /api/orgs where Arturito is auto-created, set persona="You are Arturito, the AI Chief of Staff. You are professional, warm, and action-oriented. You speak clearly and concisely. You always have a plan." and expertise="Organization management, task delegation, strategic planning, team coordination, onboarding new agents". Run tests. Commit.

### WO-2: Fix test failures + add e2e onboarding test (TEST-002, TEST-003, APP-003)

Fix the 8 pre-existing `ERR_MODULE_NOT_FOUND` test failures — these are caused by missing `.ts` extensions in import paths within test files (Node 22 with --experimental-strip-types requires explicit extensions). Search all files in `backend/src/tests/` for imports without `.ts` extensions and add them. Also fix any duplicate style definitions in the mobile app (search for duplicate `styles.required` across `app/app/`). Then create `backend/src/tests/e2e-onboarding.test.ts` with an integration test: POST /api/orgs with all onboarding fields → verify org, Arturito agent (with persona), orgMembers, first specialist agent. Run full test suite — target: ALL tests pass, ZERO failures. Commit.

### WO-3: Dockerfile + Fly.io deploy config (DEPLOY-001, DEPLOY-002)

Change `backend/Dockerfile` from `node:20-alpine` to `node:22-alpine`. Verify the multi-stage build still works with `docker build`. Check that `backend/fly.toml` exists with correct config: app name `7ei-backend`, primary region `fra` (Frankfurt), internal port matching what index.ts binds to, health check pointing at `/api/health`. If fly.toml is missing, create it. Check `.github/workflows/deploy.yml` triggers on push to main and uses `FLY_API_TOKEN`. Commit.

### WO-4: EAS build config + API URL (EAS-001, APP-004)

Create `app/eas.json` with development and production profiles. Set bundle identifier to `ai.7ei.missioncontrol`. Find where the API base URL is configured in the app (constants, env, or store) and set it to `https://7ei-backend.fly.dev` for all non-localhost builds. If there's no config mechanism, create one using Expo's `Constants.expoConfig.extra` or an env file. Commit.

### WO-5: Final verification + PR

Run the full test suite one last time. Verify the server starts locally. Create a single PR to main titled "Sprint 5: Deploy & Stabilize" with body listing all fixes. Reference issues.

---

## Dependency Order

```
WO-1 (backend fixes) — no deps
WO-2 (test fixes + e2e) — depends on WO-1 (health endpoint, Arturito persona)
WO-3 (deploy config) — depends on WO-1 (health endpoint)
WO-4 (EAS + API URL) — no deps on WO-1/2/3
WO-5 (verify + PR) — depends on all above
```

**Recommended execution:** WO-1 → WO-2 → WO-3 → WO-4 → WO-5

---

*Sprint 5 plan prepared by Cowork — March 26, 2026*
