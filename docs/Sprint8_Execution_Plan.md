# Sprint 8 — Observe, Secure & Ship to Device

**Sprint goal:** Fix the last device-testing blocker (expo-router module resolution), add OpenTelemetry tracing, automated security scanning in CI, API documentation, and rate limiting hardening. When Arturito is back at his desk on Saturday March 30, the app loads in Expo Go on first try.

**Sprint dates:** March 28 – April 4, 2026

**Predecessor:** Sprint 7 merged (PR #79). 230+ tests pass. Audit logging, RBAC, push notifications, app polish all shipped. Expo-router `internal/routing` module error still blocks device testing.

---

## Priority Stack

| # | Theme | Rationale |
|---|-------|-----------|
| P0 | Fix expo-router for Expo Go | Blocking ALL device testing. Must be resolved before anything else matters. |
| P1 | OpenTelemetry tracing | Auditor recommendation. Request spans, DB query timing, LLM call duration. Essential for production observability. |
| P2 | Security scanning CI | Auditor recommendation. `npm audit` + dependency vulnerability checks on every PR. |
| P3 | API documentation | Auto-generate from routes. Needed for onboarding developers and client demos. |
| P4 | Rate limiting hardening | Per-IP throttle on public endpoints. Per-org limits on chat endpoints. |
| P5 | CLAUDE.md update | Bring the canonical reference file up to date with Sprints 3–8 state. |

---

## Task Table

| # | Area | Task ID | Task Name | Acceptance Criteria |
|---|------|---------|-----------|-------------------|
| 1 | App | EXPO-001 | Fix expo-router module resolution for Expo Go | `npx expo start --clear` launches Metro. Scanning QR from Expo Go (SDK 54) loads the app. No `Cannot find module 'expo-router/internal/routing'` error. |
| 2 | App | EXPO-002 | Verify full onboarding flow in Expo Go | App loads → onboarding wizard renders → org creation screen works (even if backend is offline, no crash). All 8 tabs visible. |
| 3 | Backend | OTEL-001 | OpenTelemetry SDK setup + request tracing | Every HTTP request gets a trace span with: method, path, status, durationMs, orgId. Spans exported to console (structured JSON) in dev, ready for Jaeger/OTLP in production. |
| 4 | Backend | OTEL-002 | DB query + LLM call tracing | Drizzle queries get child spans (table, operation, duration). LLM streaming calls get spans (model, tokens, cost, duration). Visible in trace output. |
| 5 | CI | SEC-001 | npm audit in CI pipeline | New GitHub Actions workflow `security.yml`: runs `npm audit --audit-level=high` on every PR. Fails the check if high/critical vulns found. |
| 6 | CI | SEC-002 | Dependency license + outdated check | `security.yml` also runs `npx license-checker --failOn 'GPL'` and `npm outdated` (informational, doesn't fail). Results posted as PR comment. |
| 7 | Backend | DOCS-001 | Auto-generated API documentation | Generate route documentation from the Fastify routes. Create `docs/API.md` listing every endpoint: method, path, auth required, request body schema, response shape. Keep it maintainable by generating from route definitions. |
| 8 | Backend | RATE-001 | Per-IP rate limiting on public endpoints | `/api/health`, `/api/auth/*` get per-IP rate limit (100 req/min). Return 429 with `Retry-After` header when exceeded. |
| 9 | Backend | RATE-002 | Per-org rate limiting on chat endpoints | `POST /api/orgs/:orgId/agents/:agentId/chat` gets per-org rate limit (60 req/min default, configurable via org settings). Return 429 when exceeded. |
| 10 | Docs | META-001 | Update CLAUDE.md to current state | Reflect Sprints 3–8: all tables, all endpoints, all services, test count, coding patterns. Remove stale Phase 3 task specs (already implemented). Add Sprint 8 features. |
| 11 | QA | TEST-005 | Sprint 8 test coverage | Tests for: OTEL span creation, rate limiter (IP + org), API doc generation, security audit pass. 20+ new tests. All existing tests pass. Target: 250+. |

---

## Work Orders (for Claude Code)

Execute in order: WO-1 → WO-2 → WO-3 → WO-4 → WO-5 → WO-6

### WO-1: Fix expo-router for Expo Go (EXPO-001, EXPO-002)

This is the #1 priority. The app has failed to load in Expo Go across 3 attempts due to `Cannot find module 'expo-router/internal/routing'`.

Debug thoroughly:
1. `cd app && cat node_modules/expo-router/package.json` — get exact installed version
2. `ls node_modules/expo-router/internal/` — see what paths actually exist
3. `cat node_modules/expo/cli/build/src/start/server/type-generation/routes.ts` — find the import that's failing
4. The root cause is likely a version mismatch: expo-router 6.x may not be compatible with the installed expo CLI version. SDK 54 may require expo-router 4.x, not 6.x. Check Expo's compatibility table.
5. Run `npx expo install --fix` to let Expo auto-resolve compatible versions
6. If expo-router needs downgrading, update app.json and _layout.tsx for any API changes
7. After fixing, run `npx expo start --clear` and verify Metro starts AND the iOS bundle compiles (`npx expo export --platform ios`)
8. Check there are no import errors, no missing module errors

This WO is not done until `npx expo export --platform ios` succeeds cleanly. Commit.

### WO-2: OpenTelemetry tracing (OTEL-001, OTEL-002)

Install `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`.

Create `backend/src/services/telemetry.ts`:
- Initialize NodeSDK with a ConsoleSpanExporter for dev (switch to OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set)
- Register a Fastify `onRequest`/`onResponse` hook that creates a span per request: `http.method`, `http.route`, `http.status_code`, `http.duration_ms`, `org.id`
- Wrap `streamLLM()` calls in `llm.call` spans: `llm.model`, `llm.input_tokens`, `llm.output_tokens`, `llm.cost`, `llm.duration_ms`
- Wrap DB queries in `db.query` spans (use Drizzle's `.execute()` wrapper or monkey-patch): `db.table`, `db.operation`, `db.duration_ms`

Register telemetry in `backend/src/index.ts` — must be imported FIRST before any other module (OpenTelemetry requirement). Run tests. Commit.

### WO-3: Security scanning CI (SEC-001, SEC-002)

Create `.github/workflows/security.yml`:
```yaml
name: Security Scan
on: [pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd backend && npm ci && npm audit --audit-level=high
      - run: cd app && npm ci && npm audit --audit-level=high
  license-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd backend && npm ci && npx license-checker --failOn 'GPL-2.0;GPL-3.0'
  outdated:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd backend && npm ci && npm outdated || true
      - run: cd app && npm ci && npm outdated || true
```

Run tests. Commit.

### WO-4: API documentation + rate limiting (DOCS-001, RATE-001, RATE-002)

**API docs:** Create `backend/scripts/generate-api-docs.ts` that reads `backend/src/routes/all.ts`, extracts all `app.get/post/patch/delete` calls, and generates `docs/API.md` with: method, path, auth required (based on whether RBAC middleware is applied), request body fields (from Zod schemas), response shape. Run the script and commit the generated docs.

**Per-IP rate limiting:** Create or extend `backend/src/middleware/ratelimit.ts`. Add `perIpRateLimit(maxPerMinute)` that tracks request counts by IP using an in-memory Map with 1-minute sliding window. Apply to `/api/health`, `/api/auth/*` with limit 100/min. Return 429 with `Retry-After` header.

**Per-org rate limiting:** Add `perOrgRateLimit(maxPerMinute)` that tracks by orgId. Apply to `POST /api/orgs/:orgId/agents/:agentId/chat` with limit 60/min default. Return 429 with `Retry-After`.

Run tests. Commit.

### WO-5: Update CLAUDE.md + tests + PR (META-001, TEST-005)

**CLAUDE.md update:** Rewrite the "Current state: what is DONE" section to reflect Sprints 1–8. Update the test count. Add all new tables (audit_logs, etc.), all new services (telemetry, push-notifications, audit-log), all new middleware (rbac, rate-limit). Remove the Phase 3 task specifications (DRIVE-001 through ROUTE-001) since they're implemented — replace with a "Phase 3: Complete" summary. Add Sprint 8 features. Update version to 1.4.0.

**Tests:** Create `backend/src/tests/sprint8.test.ts`:
- OTEL: telemetry module exports initTelemetry function
- Rate limiter: IP limit returns 429 after threshold, org limit returns 429 after threshold, different IPs have separate counters
- API docs: generated doc contains all expected endpoints
- Security: `npm audit --audit-level=high` passes for backend

Run full test suite. Target: 250+ tests, 0 failures. Create PR to main titled "Sprint 8: Observe, Secure & Ship to Device". Reference all issues.

### WO-6: Verify app builds clean (post-WO-1 gate)

After WO-1, verify again:
1. `cd app && npx expo start --clear` — Metro starts without errors
2. `npx expo export --platform ios` — bundle compiles (4+ MB, 1200+ modules)
3. No `Cannot find module` errors anywhere in the output

If WO-1 fix didn't hold after subsequent WOs introduced changes, fix it here. This is the gate — the app MUST bundle cleanly before the PR is created. Commit.

---

## Dependency Order

```
WO-1 (expo-router fix) ── no deps, do FIRST
WO-2 (OpenTelemetry) ── no deps, parallel with WO-1
WO-3 (security CI) ── no deps, parallel
WO-4 (API docs + rate limiting) ── no deps, parallel
WO-5 (CLAUDE.md + tests + PR) ── after all above
WO-6 (verify app builds) ── after WO-1 and WO-5
```

**Recommended execution:** WO-1 → (WO-2, WO-3, WO-4 parallel) → WO-5 → WO-6

---

## Manual Steps (Arturito does these Saturday March 30)

1. `cd ~/Desktop/7Ei-Mission_Control_App && git stash && git pull && cd app && rm -rf node_modules && npm install && npx expo start --clear`
2. Scan QR code from Expo Go on iPhone
3. Walk through onboarding, test agent chat, check all tabs
4. Report any bugs — I'll plan a fix round

---

## Claude Code Prompt

```
Read docs/Sprint8_Execution_Plan.md and CLAUDE.md. Execute work orders WO-1 through WO-6 in dependency order. WO-1 (expo-router fix) is the #1 priority — debug thoroughly and ensure npx expo export --platform ios succeeds. For each WO: implement, write tests, run the full test suite (cd backend && npm install && node --test --experimental-strip-types src/tests/*.test.ts), fix any failures, then commit to a branch named claude/sprint8-observe-secure. After all WOs complete, create a PR to main titled "Sprint 8: Observe, Secure & Ship to Device". Reference all GitHub issues in the PR body.
```

---

*Sprint 8 plan prepared by Cowork — March 28, 2026*
