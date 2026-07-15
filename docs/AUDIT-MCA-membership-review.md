# Independent audit — Multi-tenant membership hardening (PR #262, the R-4 fix)

_Auditor: independent review agent (did NOT build the change) · 2026-07-15 · reviewing commit `145a6dc` on `main`._

## Verdict: **NEEDS-FIXES**

The change is well-built for the surface it covers — the `/api/orgs/:orgId/*` bulk and the
`:agentId`/`:taskId` record tail are now consistently membership-gated, the grandfather path is
correct, the exempt set is right, and the fixed holes (`duplicate`, `users/:userId/orgs`,
`transfer`/`clone` target, `PATCH /api/orgs/:orgId` ownerId-strip) are all complete. The 18 new
tests pass; the existing suite stays green.

**But the central claim — "membership enforced _surface-wide_… a new org route can't be added
ungated" — is not met.** The gate derives a request's org from only three params
(`:orgId`, `:agentId`, `:taskId`). **~25 other org-scoped record routes carry a different param**
(`:projectId`, `:goalId`, `:itemId`, `:skillId`, and the generic `:id` used by secrets, budgets,
plugins, workspaces, watchdogs, attachments, scheduled tasks, webhooks, policies, revisions). For
those, `resolveRequestOrg` returns `{ scoped: false }`, the gate **stands down**, and the handler
mutates/reads by id with **no org check** — the exact cross-tenant class this PR set out to close,
still open. The PR's own leak-guard cannot see it because its sweep filters to `/api/orgs/:orgId/*`.

I **behaviourally proved** this (throwaway test booting the real secured scope, real gate, real DB):
an authenticated user with **no membership of the target org** got:

```
DELETE /api/projects/proj-1        -> 204   (deleted another org's project)
GET    /api/knowledge/know-1/content-> 200   (read another org's CONFIDENTIAL document body)
DELETE /api/knowledge/know-1       -> 204   (deleted another org's knowledge item)
DELETE /api/secrets/sec-1          -> 204   (deleted another org's stored secret)
POST   /api/webhooks/wh-1/test     -> 200   (fired another org's webhook — outbound HTTP)
GET    /api/projects/proj-1/board  -> 200   (read another org's task board)
PATCH  /api/projects/proj-1        -> !=403 (reached handler; 200 with a valid body)
PATCH  /api/webhooks/:id           -> !=403 (reached handler)
```

---

## HIGH-1 — ~25 org-scoped top-level record routes are still cross-tenant open (scope gate stands down, no in-handler check)

**Root cause** — `resolveRequestOrg` (`backend/src/middleware/rbac.ts:98‑113`) only knows three
params:

```ts
if (p.orgId  !== undefined) return { scoped: true, orgId: p.orgId ?? null }
if (p.agentId!== undefined) { ... agents.orgId ... }
if (p.taskId !== undefined) { ... tasks.orgId ... }
return { scoped: false }          // ← everything else → gate stands down (rbac.ts:138)
```

Any secured-scope route whose org lives in a record addressed by a **different** param name lands
in `scoped:false`. The gate returns without a check and the handler runs unauthorised.

**The ungated org-scoped routes** (all in the `secured` scope; all tables confirmed to carry
`orgId`; none self-enforce):

| Route | file:line | Impact |
|---|---|---|
| `DELETE /api/secrets/:id` | tasks.ts:239 | **Cross-tenant secret deletion** (integrity/availability of the encrypted store) |
| `GET /api/knowledge/:itemId/content` | knowledge.ts:125 | **Cross-tenant confidential-document READ** (data confidentiality breach) |
| `DELETE /api/knowledge/:itemId` | knowledge.ts:90 | Cross-tenant knowledge delete (+ Pinecone removal) |
| `DELETE /api/policies/:id` | agents.ts:215 | **Delete another org's execution/approval policy** (removes a security control) |
| `POST /api/revisions/:id/rollback` | agents.ts:225 | **Roll another org's agent** back to a prior config snapshot (writes `agents`) |
| `POST /api/webhooks/:id/test` | webhooks.ts:65 | Fire another org's webhook — outbound HTTP to its stored URL (SSRF-adjacent) |
| `PATCH \| DELETE /api/webhooks/:id` | webhooks.ts:44,58 | Edit/delete another org's webhook (incl. its secret) |
| `PATCH \| DELETE /api/projects/:projectId` | projects.ts:20,24 | Edit/delete another org's project |
| `GET /api/projects/:projectId/board` | projects.ts:28 | Read another org's task board |
| `PATCH \| DELETE /api/goals/:goalId` | tasks.ts:116,121 | Edit/delete another org's goal |
| `DELETE /api/budgets/:id` | tasks.ts:218 | Delete another org's budget policy (cost guardrail) |
| `PATCH \| DELETE /api/plugins/:id` | tasks.ts:259,265 | Enable/disable/delete another org's plugin |
| `PATCH \| DELETE /api/workspaces/:id` | tasks.ts:284,294 | Edit/delete another org's workspace |
| `DELETE /api/attachments/:id` | tasks.ts:612 | Delete another org's task attachment |
| `PATCH \| DELETE /api/watchdogs/:id` | tasks.ts:698,706 | Edit/delete another org's watchdog |
| `PATCH \| DELETE /api/scheduled/:id` | scheduled.ts:52,68 | Edit/delete another org's scheduled task/routine |
| `GET \| PATCH \| DELETE /api/skills/:skillId` | skills.ts:18,24,28 | Edit/delete skills; a per-org custom skill (`orgId != null`) is cross-tenant mutable (global library skills are shared, lower) |

This is the **same severity and same exploit shape** the PR's own doc describes for the `:orgId`
swap ("any logged-in user could act on any org's resources"), merely reached through a different
param. Several of these are worse than the examples the PR did fix — a cross-tenant *secret delete*,
a *confidential knowledge read*, and deletion of an *approval policy* (a security control).

**Why the leak-guard didn't catch it** — `tests/membership-scoping.test.ts` sweeps only
`collectedRoutes().filter(r => /^\/api\/orgs\/:orgId(\/|$)/.test(r.url))`. That regex **structurally
excludes** every route in the table above (none begins `/api/orgs/:orgId/`). The suite's
"surface-wide sweep" is in fact an "orgId-path sweep," so it proves coverage of the routes that were
never the gap here and reports green while the gap stands. The doc's route inventory names only the
`:agentId`/`:taskId` "record-derived tail" and misses this whole class.

### Required fix (must go through the normal build → independent-audit cycle — not applied here)

Because `:id` is a **generic** param shared by ~10 tables, a correct resolver cannot key off
`req.params` alone — it must map the **URL prefix** to the owning table. Concretely, extend
`resolveRequestOrg` to also branch on `req.routeOptions.url` (or the matched route pattern), e.g.
`/api/projects/:projectId → projects.orgId`, `/api/secrets/:id → secrets.orgId`,
`/api/knowledge/:itemId → knowledgeItems.orgId`, … one entry per table above, each failing closed
(`orgId: null → 403`) exactly like the `:agentId`/`:taskId` tail. Then **widen the leak-guard**:
replace the `/api/orgs/:orgId/*` filter with a positive allowlist of the genuinely org-agnostic
routes and assert a non-member 403 on **every other** secured route — so the sweep would have failed
on these and cannot silently miss the next one. (I did not add a red test now: with the hole open it
would break `main`; it belongs with the fix.)

I deliberately did **not** implement this in the audit: it is a behavioural change to the security
gate touching ~25 routes and needs its own independent review, not auditor self-approval.

---

## Verified clean (correct as built)

- **Grandfather (ownerId-implies-owner)** — `enforceOrgRole` (rbac.ts:42‑56) falls back to
  `organisations.ownerId` only when there is no `org_members` row, matches `=== userId`, and **fails
  closed** on a missing org (`org && …`) or non-match. Never grants a non-owner. The extra org lookup
  runs only on the rowless path. Driven by the legacy-owner test. ✔
- **Grandfather is not spoofable** — the only writers of `organisations.ownerId` are org-create
  (orgs.ts:58) and `duplicate` (multi-org.ts:91), both setting it to the **caller**; the bundle
  import (tasks.ts:431) likewise. `PATCH /api/orgs/:orgId` now strips `ownerId`/`id` (orgs.ts:153),
  so a member cannot rewrite themselves to owner. No route lets a non-owner set an arbitrary owner on
  an existing org. ✔
- **`POST /api/orgs/:orgId/duplicate`** — carries `:orgId`, so the scope gate now requires
  **source-org membership** before the ownership-reassigning copy; the prior "fork any org into your
  ownership" hole is closed. ✔
- **`GET /api/users/:userId/orgs`** — now self-only (`callerId !== userId → 403`, multi-org.ts). ✔
- **`transfer` / `clone` target org** — `enforceOrgRole(targetOrgId, 'member')` added
  (multi-org.ts); the gate already covered the source via `:agentId`. ✔
- **`:agentId` / `:taskId` record tail** — derived, membership-checked, **fail-closed on a missing
  row** (proven: `GET /api/agents/does-not-exist → 403`). ✔
- **`resolveRequestOrg` precedence** — `:orgId` wins over the record derivation; a present `:orgId`
  with a bogus value yields no membership + no owner match → 403 (fail-closed). ✔
- **OPTIONS skip** — safe: preflight carries no session and no body; the skip only bypasses the
  membership check, not the Clerk `onRequest` (which also skips OPTIONS). No real OPTIONS handler
  does work. ✔
- **Exempt set** — all registered **outside** the `secured` scope, so the hook never rides them:
  agent-token API `/api/agent/*` (own token auth, separate scope — proven 200 valid / 401 bad),
  public onboarding (invite doc / join / claim), `arturita/panic` (in-handler session token),
  `auth/google` (OAuth), health/ready/openapi. Correct and tight. ✔
- **`POST /api/approvals/:id/decide`** — correctly lands in `scoped:false` and self-enforces
  membership + type-mapped role in-handler (ONB3 H-1); no double-check, no lost type-role. ✔
- **Record-derivation cost** — one extra bounded `findFirst` on the bare `:agentId`/`:taskId`
  routes; the `/api/orgs/:orgId/*` bulk pays none. ✔

## Observations (LOW / informational — no fix applied)

- **L-1 (doc accuracy)** — `docs/AUDIT-MCA-membership.md`, `STATUS.md`, `HANDOFF.md`, and
  `GO-LIVE.md` state membership is enforced "surface-wide" / "a new org route can't be added
  ungated." Given HIGH-1 that is inaccurate; the guarantee currently holds only for
  `/api/orgs/:orgId/*` plus the `:agentId`/`:taskId` tail. Update once HIGH-1 lands.
- **L-2 (object-scoping, pre-existing, out of this PR's scope)** — for routes that carry both
  `:orgId` and a record id (e.g. `/api/orgs/:orgId/agents/:agentId/...`), the gate checks membership
  of the **path** org but does not verify the record belongs to that org; a handler that fetches the
  record by id alone could still serve a record from another org to one of that org's members. This
  is a separate object-level-authorization concern, not a membership gap, and not introduced by
  #262 — flagged for a future pass.

## Test / green status

- `membership-scoping.test.ts` + `rbac-membership.test.ts`: **18 pass, 0 fail** (baseline confirmed).
- The HIGH-1 proof was a throwaway probe (booting the real secured scope) — **removed**; no test
  artefact left in the tree.
- This audit ships **documentation only** (no code change), so the invariant is unchanged and `main`
  stays green. The HIGH-1 code fix is explicitly deferred to the build agent + a follow-up audit.

## What must change (summary for the operator)

1. Extend `resolveRequestOrg` to derive org for the ~25 top-level record routes above (URL-prefix →
   table), fail-closed like the existing tail.
2. Widen `membership-scoping.test.ts` from an `/api/orgs/:orgId/*` filter to an allowlist-negation
   sweep over **all** secured routes, so this class can't silently reappear.
3. Re-audit that fix independently before merge; then correct the "surface-wide" wording (L-1).
