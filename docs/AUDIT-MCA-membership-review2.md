# Independent RE-AUDIT — Membership record-route fix (PR #264, AUDIT-MCA HIGH-1 close)

_Auditor: independent review agent (did NOT build the change) · 2026-07-15 · reviewing commit `b7edf6b` on `main`._

## Verdict: **PASS**

PR #264 closes AUDIT-MCA **HIGH-1** correctly and completely. The membership surface is now
**truly complete**: every Clerk-secured route either resolves an org and enforces baseline
membership, or is on a short, individually-justified EXEMPT allowlist. I confirmed this **in
both directions** — no cross-tenant record hole remains, and no legitimate member/owner flow is
broken — by three independent methods (a boot-mirror diff, a red-proof of the leak-guard, and a
route-param sweep done outside the test), not by trusting the PR's own tests.

No HIGH or MEDIUM cross-tenant hole remains in the secured record surface. The four builder flags
are ruled on below; the sharpest one (skills fail-open) is **safe as built**. I applied **no code
changes** — the fix is clean and there is no unambiguous, risk-free LOW/NIT to change (the residual
items are pre-existing, out-of-scope, or product calls that each need their own build→audit cycle).

---

## What I verified (method)

| Check | Result |
|---|---|
| **Boot mirror** — does the leak-guard boot register the exact secured plugin set of `index.ts`? | **IDENTICAL, 29/29** (automated set-diff, below) |
| **Leak-guard has teeth** — red-proof: disable the prefix branch → guard goes RED | **RED on 4 tests** (sweep, behavioural, record-403, skills); restore → GREEN |
| **Every covered route enumerated** — red list from the disabled fix | **26 record routes**, matching the HIGH-1 inventory exactly |
| **Independent param sweep** — every record-identifier param lands in a gated tier | **Confirmed** (no ungated top-level record route outside the map) |
| **Fail-closed** — missing/foreign record → 403 (unit + behavioural) | ✔ |
| **Member/owner not broken** — non-403 on the same record routes | ✔ (test 12) |
| **Full invariant** | **1263 backend tests · 11/11 evals · typecheck clean · tree clean** |

### 1. Completeness — the crux: the boot now mirrors `index.ts` exactly

The HIGH-1 blind spot was structural: the original leak-guard boot **did not register
`webhookRoutes`**, so the sweep could not see the webhook leak. The re-audit's first duty is to
prove that class of blind spot is gone. I extracted the `secured.register(...)` set from both
`src/index.ts` and `src/tests/membership-scoping.test.ts` and diffed them:

```
diff index.ts-secured  membership-scoping-boot   →  IDENTICAL   (29 plugins each)
```

All 29 secured plugins match: `orgRoutes, agentRoutes, agentDetailRoutes, taskRoutes,
projectRoutes, costRoutes, knowledgeRoutes, multiOrgRoutes, scheduledRoutes, credentialRoutes,
connectorRoutes, jiraRoutes, jiraEventRoutes, commsRoutes, notificationRoutes, memoryRoutes,
webhookRoutes, usageRoutes, skillRoutes, arturita{,Wallet,Voice,Converse,Pipeline,CustomModel}Routes,
customModelRoutes, agentInviteRoutes, auditLogQueryRoutes, telemetryQueryRoutes`.
`webhookRoutes` is present (the fix). Because the guard enumerates the real live route table of a
boot that is now byte-for-byte the secured surface, a route present in production cannot be absent
from the sweep.

The public-scope plugins (`commsWebhookRoutes, jiraWebhookRoutes, arturitaPublicRoutes, modelRoutes,
adapterRegistryRoutes, agentInviteDocRoutes, agentJoinRoutes, telegramWebhookRoutes, agentApiRoutes,
routineTriggerRoutes, authRoutes, telemetryPlugin`) are registered **outside** the Clerk scope and
carry their own auth (agent token / inbound-webhook / OAuth / static). They are not membership-gated
by design and are correctly **not** in the secured boot. The test's `agentApp` deliberately omits the
`recordRoute` hook, so agent-API routes do not pollute `collectedRoutes()` — the enumerated surface is
exactly the clerk-tagged secured routes. Confirmed clean.

### 2. The leak-guard actually bites (red-proof)

Disabling the prefix tier (`if (false && routeUrl)`) in `resolveRequestOrg` turned **four** tests red:

```
not ok  leak-guard: EVERY secured route resolves an org OR is exempt
not ok  behavioural sweep: every NON-EXEMPT secured route 403s a NON-MEMBER
not ok  HIGH-1: a NON-MEMBER is refused (403) on EVERY top-level record route
not ok  skills: a GLOBAL skill stands down; a per-ORG skill is gated
```

The first test's failure output enumerated exactly the **26** now-covered record routes
(`/api/secrets/:id`, `/api/knowledge/:itemId/content`, `/api/policies/:id`,
`/api/revisions/:id/rollback`, `/api/webhooks/:id{,/test}`, `/api/projects/:projectId{,/board}`,
`/api/goals/:goalId`, `/api/budgets/:id`, `/api/plugins/:id`, `/api/workspaces/:id`,
`/api/attachments/:id`, `/api/watchdogs/:id`, `/api/scheduled/:id`, `/api/skills/:skillId`, …) —
matching the HIGH-1 inventory one-for-one. Restoring the branch returns all green. The guard is not
a tautology: it fails precisely when the hole is open.

**The self-test** (`/api/rogue-widgets/:id` → `scoped:false`, not exempt → reported) proves the
guard flags any *new* unmapped record route. Combined with the identical boot, this is what makes the
"can't reopen" claim real.

### 3. The EXEMPT allowlist is short and every entry is justified

16 routes, each genuinely org-agnostic or self-authorizing in-handler — not a dumping ground:

| Route | Why exempt (verified) |
|---|---|
| `GET/POST /api/orgs`, `POST /api/orgs/import`, `GET /api/orgs/switch/list` | create / self-list — no existing org to be a member of (no `:orgId`) |
| `GET /api/users/:userId/orgs` | self-only (`callerId !== :userId → 403` in-handler) — prior audit ✔ |
| `POST /api/approvals/:id/decide` | derives org from the approval row + enforces type-role in-handler (ONB3 H-1) ✔ |
| `GET /api/agent-templates`, `GET /api/scheduled/{presets,preview}`, `GET /api/webhooks/events` | static catalogues, no record |
| `GET/POST /api/skills`, `POST /api/skills/{sync,obsidian-sync}` | the shared **global** skill library (see flag rulings) |
| `POST/DELETE /api/notifications/register` | in-memory device push tokens, user-scoped (see flag 3) |

Because the guard passes with **only** these 16 exempt, these are provably the *complete* set of
`scoped:false` secured routes — any other would fail the sweep.

### 4. Fail-closed correctness of the new map

- **Missing / foreign record → 403.** `resolveRequestOrg` returns `{scoped:true, orgId:null}` for a
  non-existent id, and `enforceOrgRole` turns a null org into 403 (never open, never 500). Proven by
  unit test (`secrets: undefined → {scoped:true, orgId:null}`) and behaviourally (`GET
  /api/skills/does-not-exist → 403`).
- **Prefix disambiguation is sound.** The 14 prefixes are disjoint top-level segments; the generic
  `:id` is resolved by `routeUrl` prefix, not param name, so one table's id cannot resolve against
  another's. A prefix match with the id param **absent** (`/api/scheduled/presets`,
  `/api/webhooks/events`) correctly falls through to `scoped:false` → must be exempt (and is).
- **Precedence unchanged.** `:orgId` > `:agentId` > `:taskId` > prefix map. A present `:orgId` with a
  bogus value still yields no-membership/no-owner → 403. Backward compatible: no `routeUrl` arg → the
  prefix tier is skipped, so existing 2-arg callers are unaffected (unit-tested).
- **Independent param sweep.** Every record-identifier param in the route files
  (`:deptId, :fileId, :intentId, :sessionId, :threadId, :key, :provider, :inviteId, :issueKey`)
  lives under an `/api/orgs/:orgId/*` path (tier 1) or `:agentId` (tier 2) — e.g.
  `/api/agents/:agentId/memory/:key`, `/api/orgs/:orgId/knowledge/file/:fileId`. The only bare
  `:provider` route (`/api/models/:provider`) is in the **public** scope. So no ungated secured
  top-level record route exists outside the prefix map — verified independently of the test.

### 5. No legitimate flow broken

- **Member / owner → non-403** on the record routes (reads + a non-destructive PATCH across
  projects/goals/plugins/watchdogs/scheduled/webhooks/knowledge/skills), test 12 ✔.
- **Operator grandfather intact** — `enforceOrgRole` is unchanged by this PR; an org's `ownerId` is
  still honoured as an implicit owner with no `org_members` row. No lock-out.
- **`agent-api` + public onboarding provably unaffected** — both are registered outside the secured
  scope, are not in the secured boot, and were not touched by the diff (`git show` = `rbac.ts` +
  tests + docs only). The agent-token API authenticates by token in its own scope.

---

## Rulings on the four builder flags

**(1) Skills fail-open for a null `orgId` — SAFE, intended.** A skill row's `orgId` is `null` for a
shared **global-library** skill and non-null only when a caller explicitly set `body.orgId` on
`POST /api/skills`. I confirmed the only three skill writers (`POST /api/skills`, `sync`,
`obsidian-sync`) all use `null` for library skills, and **no path strips a real org's id to null** —
so `orgId=null` genuinely means "global," never "another org's private skill mislabeled." Standing the
gate down for a null-org skill (rather than 403-ing everyone out of the shared library) is correct; a
*missing* skill still fails closed (403). Unit- and behaviourally-tested. ✔

**(2) `GET/POST /api/skills` all-org / global-library exempt — ACCEPTABLE under the shared-library
design, but flagged as an inconsistency (product call, LOW).** `GET /api/skills` returns the whole
`skills` table unfiltered, and the agent skill-picker (`agent-detail.ts:182,200`,
`db.select().from(schema.skills)` with **no org filter**) loads the whole library too, matching by
name. **The entire skills subsystem treats the library as one flat global namespace** — `orgId` on a
skill is a tag, not an enforced isolation boundary anywhere except #264's new singular-route gate. So
exempting the collection routes is consistent with how skills are actually consumed, and #264
regresses nothing (before it, *all* skill routes were ungated). **Residual inconsistency:** the new
per-org gating on `GET/PATCH/DELETE /api/skills/:skillId` protects one door while `GET /api/skills`
and the agent picker still expose the same per-org skill's name+content to any member of any org. If
per-org skills are ever meant to be tenant-private, that decision must also filter the collection read
and the picker load by `orgId IS NULL OR orgId = <caller org>`; if the library is meant to be global
(the dominant signal), the singular-route gate is merely cosmetic. **This is a data-model decision, not
a fix the auditor should make** — flagged, not a HIGH (no secret/credential/tenant-record of the
HIGH-1 class leaks; skill definitions only).

**(3) `POST/DELETE /api/notifications/register` take `userId` from the body with no self-check —
ACCEPTABLE for this fix; pre-existing LOW residual.** The tokens live in an in-memory `Map` in
`services/push` — no org data, no DB. The only abuse is an authenticated user registering their device
under another user's `userId` to receive that user's task-title pushes (or unregistering to mildly
deny them). It is user-scoped, not a cross-tenant *org* leak, and unchanged by #264. A
`userId === auth.userId` self-check is the right hardening, but it is a behavioural change (could
affect the mobile registration contract) that belongs in its own change, not this audit. Correctly
EXEMPT for the membership-gate concern.

**(4) L-2 object-scoping out of scope — CONFIRMED separate.** For routes carrying both `:orgId` and a
record id (`/api/orgs/:orgId/agents/:agentId/...`), the gate verifies membership of the *path* org but
not that the record belongs to that org. That is object-level authorization, a distinct concern from
the membership gate this PR implements, and is not introduced or worsened here. **Residual risk noted:**
a member of org A could still read/act on a record from org B if a handler fetches it by bare id
inside an org-A path and doesn't re-check ownership. Genuinely a separate future pass.

---

## Verified clean

- Boot mirrors `index.ts` (29/29 identical) — the HIGH-1 blind spot (missing `webhookRoutes`) is closed.
- Leak-guard fails when the fix is disabled (red-proof) and enumerates exactly the 26 HIGH-1 routes.
- Self-test proves the guard flags any new unmapped record route.
- Fail-closed: missing/foreign record → 403 (unit + behavioural); no 500, no open.
- Prefix disambiguation cannot mis-resolve one table's id against another; precedence unchanged.
- Member/owner non-403 on the record routes; operator grandfather path untouched.
- `agent-api` + public onboarding outside the secured scope, untouched by the diff.
- Diff touches only `rbac.ts`, the two test files, and docs — **no secret in tree or in the diff/history**.
- **1263 backend tests · 11/11 evals · typecheck clean · working tree clean.**

## Findings by severity

- **HIGH:** none.
- **MEDIUM:** none in the secured record surface.
- **LOW / product-call (no code change applied):**
  - **L-1 skills-library consistency** (flag 2) — decide whether per-org skills are tenant-private; if
    so, filter `GET /api/skills` and the agent skill-picker load by org. `backend/src/routes/skills.ts:11`,
    `backend/src/routes/agent-detail.ts:182,200`.
  - **L-2 push-token self-check** (flag 3) — add `userId === auth.userId` to
    `POST/DELETE /api/notifications/register`. `backend/src/routes/notifications.ts:11,20`. Pre-existing.
  - **L-3 object-scoping** (flag 4) — record-belongs-to-path-org checks on `:orgId`+id routes. Separate pass.

## What I fixed

**Nothing in code.** The fix is correct and complete; the three residual items are each a product
decision or a pre-existing out-of-scope concern whose remediation is a behavioural change that must go
through its own build→independent-audit cycle (auditor self-approval of a behavioural change is exactly
what the prior audit declined to do for the HIGH-1 fix itself). This audit ships **documentation only**,
so the invariant is unchanged and `main` stays green.

## Verify

```
cd backend && npm test        # 1263 pass, 0 fail
              npm run evals    # 11/11
              npm run typecheck # clean
```
