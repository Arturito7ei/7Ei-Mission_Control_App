# Sprint 7 — Harden, Observe & Demo-Ready

**Sprint goal:** Harden the platform for client demos and early beta users. Add observability (audit logging, request tracing), push notifications, RBAC foundations, and polish the mobile app for a smooth demo experience.

**Sprint dates:** March 27 – April 10, 2026

**Predecessor:** Sprints 1–6 complete. 212 tests pass. Backend starts cleanly on Fastify 5. App bundles on Expo SDK 54. Auditor report: "Ready for demos & client showcases."

---

## Priority Stack

| # | Theme | Rationale |
|---|-------|-----------|
| P0 | Audit logging + request tracing | Auditor recommendation. Critical for enterprise clients — every API call logged with userId, orgId, action, timestamp |
| P1 | Push notifications | Backend already registers tokens (`expo-notifications`), but no push sends. Agents should notify on task completion, budget alerts, scheduled task results |
| P2 | RBAC foundations | `orgMembers` table exists with `role` field. Need middleware to enforce owner/member permissions on sensitive endpoints |
| P3 | App polish for demo | Fix any remaining UI rough edges. Loading states, error boundaries, empty states. Smooth onboarding-to-chat flow |
| P4 | Health dashboard | Expand `/api/health` with DB connectivity check, scheduler status, connected services count |

---

## Task Table

| # | Area | Task ID | Task Name | Files | Acceptance Criteria |
|---|------|---------|-----------|-------|-------------------|
| 1 | Backend | AUDIT-001 | Request audit logging middleware | `backend/src/middleware/audit-log.ts` (new), `backend/src/db/schema.ts`, `backend/src/index.ts` | Every API request logged: userId, orgId, method, path, status, durationMs, timestamp. New `audit_logs` table. Queryable via `GET /api/orgs/:orgId/audit-log` |
| 2 | Backend | AUDIT-002 | Sensitive action logging | `backend/src/middleware/audit-log.ts` | Enhanced logging for: org create/delete, agent create/delete, credential add/remove, budget change. Includes request body summary (no secrets) |
| 3 | Backend | NOTIF-001 | Push notification service | `backend/src/services/push-notifications.ts` (new) | `sendPushNotification(userId, title, body, data)` using Expo Push API. Batch support. Error handling for expired tokens |
| 4 | Backend | NOTIF-002 | Wire notifications to events | `backend/src/services/agent-executor.ts`, `backend/src/services/scheduler.ts` | Task completion → push to org owner. Budget warning (>80%) → push. Scheduled task result → push. Agent delegation complete → push |
| 5 | Backend | RBAC-001 | Role-based access middleware | `backend/src/middleware/rbac.ts` (new) | `requireRole('owner')` middleware. Check `orgMembers` table. Owner can: delete org, manage credentials, change budget. Member can: chat, view tasks, create agents |
| 6 | Backend | RBAC-002 | Apply RBAC to sensitive endpoints | `backend/src/routes/all.ts` | DELETE /api/orgs/:orgId → owner only. POST/DELETE /api/orgs/:orgId/credentials → owner only. PATCH /api/orgs/:orgId (budget) → owner only |
| 7 | Backend | HEALTH-002 | Enhanced health endpoint | `backend/src/index.ts` | `GET /api/health` returns: DB connectivity, scheduler running, services connected (Pinecone, Redis, Google OAuth count), last deploy timestamp, uptime |
| 8 | App | DEMO-001 | Loading states + skeletons | `app/app/(tabs)/*.tsx` | All tabs show skeleton loading while data fetches. No blank screens. Pull-to-refresh on every list |
| 9 | App | DEMO-002 | Error boundary + offline state | `app/components/ErrorBoundary.tsx`, new `app/components/OfflineBar.tsx` | Global error boundary catches crashes. Offline bar appears when no network. Retry button on failed requests |
| 10 | App | DEMO-003 | Notification handling in-app | `app/app/_layout.tsx` | Receive push notifications. Tap notification → navigate to relevant screen (agent chat, task detail). Badge count on app icon |
| 11 | QA | TEST-004 | Sprint 7 test coverage | `backend/src/tests/sprint7.test.ts` | Tests for audit log, RBAC middleware, push notification service, health endpoint. 20+ new tests. All existing tests pass |

---

## Work Orders (for Claude Code)

Execute in order: WO-1 → WO-2 → WO-3 → WO-4 → WO-5

### WO-1: Audit logging (AUDIT-001, AUDIT-002)

Add an `auditLogs` table to `backend/src/db/schema.ts`: `id` (text PK), `orgId` (text), `userId` (text), `action` (text — e.g. 'org.create', 'agent.delete', 'credential.add'), `method` (text), `path` (text), `statusCode` (integer), `durationMs` (integer), `metadata` (text, JSON — request body summary, no secrets), `createdAt` (timestamp). Create migration `0009_audit_logs.sql`.

Create `backend/src/middleware/audit-log.ts`: export `auditLogPlugin(app)` that registers a Fastify `onResponse` hook. For every request, insert into `auditLogs` with userId from `req.auth?.userId`, orgId extracted from route params, method, path, status code, and duration. For sensitive actions (POST/DELETE on orgs, credentials, agents), also capture a sanitized summary of the request body (strip any field containing 'key', 'token', 'secret', 'password').

Add `GET /api/orgs/:orgId/audit-log` endpoint returning the last 100 audit entries for the org, ordered by `createdAt DESC`. Accept `?limit=N` and `?action=X` query filters.

Register `auditLogPlugin` in `backend/src/index.ts` after auth middleware. Run tests. Commit.

### WO-2: Push notifications (NOTIF-001, NOTIF-002)

Create `backend/src/services/push-notifications.ts`. The app already registers push tokens via `POST /api/notifications/register` (stores userId + expoPushToken). Implement `sendPushNotification({ userId, title, body, data })` that:
1. Looks up the user's push token from the DB (or in-memory cache)
2. POSTs to `https://exp.host/--/api/v2/push/send` with the Expo push message format
3. Handles errors (invalid tokens → remove from DB)

Wire notifications into existing flows:
- In `agent-executor.ts`: after task completion, send push "Task completed: {title}" to org owner
- In `agent-executor.ts`: if `budgetWarning` is set, send push "Budget alert: {percentUsed}% used"
- In `scheduler.ts`: after scheduled task runs, send push "Scheduled task ran: {title}"

Add `GET /api/orgs/:orgId/notifications` to list recent notifications (already exists — verify it works). Run tests. Commit.

### WO-3: RBAC foundations (RBAC-001, RBAC-002)

Create `backend/src/middleware/rbac.ts`. Export `requireOrgRole(role: 'owner' | 'member')` that returns a Fastify preHandler hook:
1. Extract `orgId` from `req.params`
2. Extract `userId` from `req.auth?.userId`
3. Query `orgMembers WHERE orgId AND userId`
4. If no row → 403 `{ error: 'Not a member of this org' }`
5. If row exists but role insufficient (e.g. need 'owner' but user is 'member') → 403 `{ error: 'Insufficient permissions' }`

Apply `requireOrgRole('owner')` to:
- `DELETE /api/orgs/:orgId`
- `POST /api/orgs/:orgId/credentials`
- `DELETE /api/orgs/:orgId/credentials/:provider`
- `PATCH /api/orgs/:orgId` (when body includes `budgetMonthlyUsd`)

Apply `requireOrgRole('member')` to all other org-scoped endpoints as a baseline access check.

Note: Skip RBAC for unauthenticated endpoints (health, ready) and for the `POST /api/orgs` create endpoint (user creates their own org). Run tests. Commit.

### WO-4: App polish + notifications (DEMO-001, DEMO-002, DEMO-003)

**Loading states:** Add `ActivityIndicator` loading spinners to all tabs that fetch data on mount (agents, tasks, costs, scheduled, knowledge). Show spinner centered until data loads. Ensure pull-to-refresh is wired on every FlatList.

**Offline bar:** Create `app/components/OfflineBar.tsx` — uses `NetInfo` or a simple `fetch` check. Shows a red bar at top "No internet connection" when offline. Auto-hides when back online.

**Notification handling:** In `app/app/_layout.tsx`, the notification registration already exists. Add `Notifications.addNotificationResponseReceivedListener` to handle taps on notifications. Extract `agentId` or `taskId` from notification data and navigate to the appropriate screen using `router.push()`.

**Error boundary:** Verify the existing `ErrorBoundary.tsx` catches render errors and shows a "Something went wrong" screen with a "Retry" button. If it doesn't exist, create one wrapping `<Slot />` in the root layout.

Run backend tests. Commit.

### WO-5: Enhanced health + tests + PR (HEALTH-002, TEST-004)

**Health endpoint:** Expand `GET /api/health` to return:
```json
{
  "status": "ok",
  "version": "1.3.0",
  "timestamp": "...",
  "uptime": 12345,
  "db": "connected" | "error",
  "scheduler": "running" | "stopped",
  "services": {
    "pinecone": true | false,
    "redis": true | false,
    "googleOAuth": 2
  },
  "features": [...]
}
```

Check DB with a simple `SELECT 1` query. Check scheduler status from the exported `schedulerTimer`. Count Google OAuth connections from `oauthTokens` table. Check Pinecone/Redis by env var presence.

**Tests:** Create `backend/src/tests/sprint7.test.ts` with 20+ tests covering:
- Audit log table schema has all columns
- Sanitize function strips secret fields
- RBAC role check logic (owner passes, member blocked for owner-only, unknown user blocked)
- Push notification message format
- Health endpoint response shape
- Audit log query with filters

Run full test suite. Target: all tests pass, 0 failures. Create PR to main titled "Sprint 7: Harden, Observe & Demo-Ready". Reference GitHub issues.

---

## Dependency Order

```
WO-1 (audit logging) ── no deps
WO-2 (notifications) ── no deps (parallel with WO-1)
WO-3 (RBAC) ── after WO-1 (audit logs capture RBAC rejections)
WO-4 (app polish) ── after WO-2 (notification handling)
WO-5 (health + tests + PR) ── after all
```

**Recommended execution:** WO-1 → WO-2 → WO-3 → WO-4 → WO-5

---

## GitHub Issues to Create

- #67: AUDIT-001 — Request audit logging middleware + table
- #68: AUDIT-002 — Sensitive action logging with sanitized body
- #69: NOTIF-001 — Push notification service via Expo Push API
- #70: NOTIF-002 — Wire notifications to task/budget/scheduler events
- #71: RBAC-001 — Role-based access middleware
- #72: RBAC-002 — Apply RBAC to sensitive endpoints
- #73: HEALTH-002 — Enhanced health endpoint with DB/scheduler/services status
- #74: DEMO-001 — Loading states + skeleton screens
- #75: DEMO-002 — Error boundary + offline state bar
- #76: DEMO-003 — In-app notification handling + deep link navigation
- #77: TEST-004 — Sprint 7 test coverage (20+ new tests)

---

## Definition of Done

- [ ] Every API request is audit logged with userId, orgId, action, duration
- [ ] Sensitive actions log sanitized request body (no secrets)
- [ ] Push notifications fire on: task complete, budget warning, scheduled task
- [ ] Owner-only endpoints reject member users with 403
- [ ] All tabs show loading state, pull-to-refresh works everywhere
- [ ] Offline bar appears when no network
- [ ] Notification tap navigates to correct screen
- [ ] Health endpoint shows DB, scheduler, and services status
- [ ] 230+ tests pass, 0 failures

---

*Sprint 7 plan prepared by Claude Code — March 27, 2026*
