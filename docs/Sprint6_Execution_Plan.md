# Sprint 6 — Get It Running

**Sprint goal:** Deploy backend to Fly.io, build the mobile app with EAS, test end-to-end onboarding on a real device. Fix whatever breaks.

**Sprint dates:** March 26 – April 2, 2026

---

## Task Table

| # | Area | Task ID | Task Name | Implementation Notes | Acceptance Criteria |
|---|------|---------|-----------|---------------------|-------------------|
| 1 | Infra | DEPLOY-003 | Verify FLY_API_TOKEN and trigger deploy | Check GitHub repo Settings → Secrets for `FLY_API_TOKEN`. If missing, print instructions to set it. If present, verify deploy.yml workflow ran after Sprint 5 merge. If it failed, diagnose from Actions logs. If it hasn't run, trigger manually with `gh workflow run deploy.yml`. | Backend responds at https://7ei-backend.fly.dev/api/health with `{ status: 'ok' }`. |
| 2 | Infra | DEPLOY-004 | Verify Fly.io secrets | Run `flyctl secrets list` (or check via Fly dashboard). Ensure all required env vars are set: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLERK_SECRET_KEY`, `PUBLIC_URL`, `ALLOWED_ORIGINS`, `NODE_ENV=production`. Add any missing ones. | `flyctl secrets list` shows all required secrets. Backend doesn't crash on boot due to missing env vars. |
| 3 | Infra | DEPLOY-005 | Verify Turso DB accessible from Fly.io | After backend deploys, hit `POST /api/orgs` from curl to verify the DB connection works. If Turso is unreachable, check the DATABASE_URL region and auth token. | A test org can be created via curl against the live backend. |
| 4 | App | EAS-002 | Run EAS build for iOS | Run `cd app && npx eas build --profile development --platform ios`. If eas.json or app.json has issues, fix them. Ensure bundle identifier is `ai.7ei.missioncontrol`. If Apple Developer account isn't configured, document what's needed. | EAS build completes (or clear documentation of what credentials are needed). |
| 5 | App | EAS-003 | Run EAS build for Android | Run `cd app && npx eas build --profile development --platform android`. Fix any build errors. | APK or AAB available for install. |
| 6 | App | APP-005 | Verify API URL reaches Fly.io backend | After installing the dev build, open the app. Check that the onboarding screen loads and API calls reach the backend (not localhost). If there's a network error, check CORS config in backend and API URL in app. | App onboarding screen loads. No network errors in console. |
| 7 | QA | E2E-001 | Walk through full onboarding on device | On the real device: (1) Open app → Arturito greeting appears, (2) Enter org name, mission, culture, (3) Pick cloud provider + LLM, (4) Optionally pick first agent role, (5) Org creates → navigates to Arturito chat, (6) Send "hello" → Arturito responds with persona. Log any bugs found. | Full onboarding completes. Arturito responds to first message. |
| 8 | QA | E2E-002 | Test agent creation on device | From the Agents tab: create a new agent with full profile (name, emoji, role, persona, TOR, expertise). Verify it appears in the list. Open chat with the new agent. | Agent created with all fields. Agent responds in chat. |
| 9 | QA | E2E-003 | Test scheduled tasks on device | From the Scheduled tab: create a scheduled task (assign to an agent, set cron to every hour). Verify it appears in the list. Toggle it off/on. Delete it. | CRUD works from the app. |
| 10 | QA | E2E-004 | Test org switching on device | Create a second org. Switch between orgs using the org switcher. Verify each org shows its own agents and data. | Org switcher works. Data is isolated per org. |
| 11 | Fix | FIX-005 | Fix bugs found during device testing | Collect all bugs from E2E-001 through E2E-004. Fix them. Re-test. | All bugs found during testing are fixed. |

---

## Work Orders (for Claude Code)

### WO-1: Deploy backend to Fly.io (DEPLOY-003, DEPLOY-004, DEPLOY-005)

Read CLAUDE.md. Check if the GitHub Actions deploy workflow has run after the Sprint 5 merge — look at `.github/workflows/deploy.yml` to understand the trigger. If deploy hasn't run or failed, diagnose why. Verify all required Fly.io secrets are documented in CLAUDE.md. Create a simple smoke test script `backend/scripts/smoke-test.sh` that curls the health endpoint and POST /api/orgs to verify the backend is live and DB is connected. If fly.toml health check path is `/health` but the endpoint is `/api/health`, fix it. Commit and push.

### WO-2: Fix EAS build issues (EAS-002, EAS-003, APP-005)

Read CLAUDE.md and `app/eas.json` and `app/app.json`. Verify: (a) bundle identifier is `ai.7ei.missioncontrol`, (b) EAS project is linked (`eas init` if needed), (c) API URL config points at `https://7ei-backend.fly.dev`, (d) CORS on backend allows the app's origin. Fix any issues found. Check that the Expo app doesn't reference localhost anywhere in production config. Run `npx expo doctor` to check for config issues. Commit and push.

### WO-3: Fix device testing bugs (FIX-005)

This work order runs AFTER manual device testing. Fix all bugs found during E2E-001 through E2E-004. Run tests. Create PR.

---

## Manual Steps (Arturito does these)

These steps require your Mac, Apple Developer account, or physical device:

1. **Set FLY_API_TOKEN** — if not already set as a GitHub secret, get it from `flyctl auth token` and add it at github.com/Arturito7ei/7Ei-Mission_Control_App/settings/secrets/actions
2. **Set Fly.io secrets** — run `flyctl secrets set DATABASE_URL=... DATABASE_AUTH_TOKEN=... ANTHROPIC_API_KEY=... CLERK_SECRET_KEY=... PUBLIC_URL=https://7ei-backend.fly.dev ALLOWED_ORIGINS=* NODE_ENV=production` (or use the Fly.io dashboard)
3. **Run EAS build** — `cd app && npx eas build --profile development --platform ios` (needs Apple Developer account: $99/yr if not already enrolled)
4. **Install on device** — scan QR code from EAS build or install via TestFlight
5. **Test onboarding** — walk through E2E-001 to E2E-004, note any bugs
6. **Report bugs back to me** — I'll plan WO-3 fixes

---

## Dependency Order

```
WO-1 (deploy backend) — do first, everything depends on live backend
  Manual: set secrets, verify deploy
WO-2 (EAS build fixes) — can run in parallel with WO-1
  Manual: run eas build, install on device
  Manual: test E2E-001 through E2E-004
WO-3 (bug fixes) — runs after device testing
```

---

*Sprint 6 plan prepared by Cowork — March 26, 2026*
