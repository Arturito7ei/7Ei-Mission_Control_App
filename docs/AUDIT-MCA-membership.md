# Multi-tenant membership hardening — the R-4 fix (surface-wide org membership)

_Author: build agent · 2026-07-15 · STOPPED for the independent audit._

## The gap (what the ONB2/ONB3 audits kept surfacing)

The whole `/api/orgs/:orgId/*` surface was **Clerk-authenticated but not
membership-checked**. Any logged-in user could act on **any** org's resources by
supplying a different `:orgId`. Concretely, of ~159 org-scoped routes, only ~35
carried a `requireOrgRole(...)` preHandler; the other ~124 were authenticated but
membership-**blind**. Two structural reasons let this hide:

- **R-4:** `requireOrgRole` **silently no-ops** on any path without an `:orgId`
  param (`middleware/rbac.ts` — it `return`s early). So even where it was applied
  it could skip; and most routes did not apply it at all.
- The **MCA-85 leak guard** only checks that tenant routes are *Clerk-authed*
  (`auth !== 'none'`). It cannot see whether **membership** is enforced — a route
  table has no such column. So a Clerk-authed, membership-blind route passed it.

Exploit shape (same class as AUDIT-ONB3 H-1, now generalised): user A, a member of
org X only, calls `GET /api/orgs/Y/secrets` (or `PATCH /api/orgs/Y`, or
`POST /api/orgs/Y/duplicate`, …) and is served / mutates org Y's data.

Notable pre-fix leaks found in the inventory:
- `GET /api/orgs/:orgId`, `PATCH /api/orgs/:orgId`, `GET|POST|DELETE …/departments*` — read/write any org.
- `POST /api/orgs/:orgId/duplicate` — **reassigned ownership to the caller** (`ownerId = caller`); any user could fork any org into their own ownership.
- `GET /api/agents/:agentId`, `PATCH /api/agents/:agentId`, `…/rotate-token`, `POST /api/agents/:agentId/transfer|clone` — act on any org's agent (record-derived org, no `:orgId`).
- `GET /api/tasks/:taskId/*`, `PATCH /api/tasks/:taskId/*` — any org's tasks.
- `GET /api/users/:userId/orgs` — enumerate **another** user's org memberships.

## The fix — ONE shared mechanism

A single scope-level `preHandler` on the whole Clerk-secured scope. It cannot be
forgotten per-route, and a **new** org route is covered the moment it registers.

`middleware/rbac.ts`:

- **`enforceOrgRole(...)`** — the pre-existing single source of truth (used by the
  ONB3 decide route). Extended with a **grandfather**: an org's `organisations.ownerId`
  is treated as an implicit **owner**, even with no `org_members` row (see below).
- **`resolveRequestOrg(params, db)`** — resolves the org a request targets:
  1. `:orgId` path param wins (the `/api/orgs/:orgId/*` bulk) — no DB read.
  2. else derive from the record the path carries: `:agentId` → `agents.orgId`,
     `:taskId` → `tasks.orgId` (the R-4 record-derived tail).
  3. else `{ scoped: false }` — no org context (user-/global-scoped route).
  A record that resolves to **no row** returns `{ scoped: true, orgId: null }` →
  `enforceOrgRole` turns that into a **403** (fail closed — never a silent skip).
- **`requireOrgMembership(req, reply)`** — the scope preHandler. Skips `OPTIONS`
  (CORS preflight carries no session); 401 if unauthenticated; resolves the org;
  if scoped, enforces **baseline `member`**; if not scoped, stands down.

`index.ts` — wired once: `secured.addHook('preHandler', requireOrgMembership)`
immediately after the Clerk `onRequest` hook, before every route registration.
Stricter per-route gates (`requireOrgRole('owner')`) still layer on top unchanged:
the member check runs first, then the owner check.

`multi-org.ts` — the two routes the scope hook cannot fully cover on its own:
- `GET /api/users/:userId/orgs` — carries a `:userId`, not an org → made **self-only**
  (caller must equal `:userId`).
- `POST /api/agents/:agentId/transfer|clone` — the hook covers the **source** org
  (via `:agentId`); the **target** org (`body.targetOrgId`) is now also membership-checked
  so a member of A can't inject/clone an agent into an org B they don't belong to.

## Grandfathering (don't break the operator)

Membership is stored in `org_members`. Org creation inserts the owner's row
(`orgs.ts:62`), but **nothing backfilled** orgs created before that code existed, and
`enforceOrgRole` previously checked `org_members` only. Enforcing membership
surface-wide would therefore **lock a rowless owner out of their own org**.

Fix: `enforceOrgRole` now, when there is no `org_members` row, falls back to the
org's `ownerId` column (the durable ownership source of truth) and treats a match as
**owner**. The org lookup runs **only** when there's no membership row (the common
member path stays a single query) and **never grants** access to a non-owner. Result:
every existing org owner — including the operator's — keeps full access with zero
migration; only a genuine non-member/wrong-org request newly 403s. Driven test:
`membership-scoping.test.ts` → "GRANDFATHER: a legacy org OWNER with no org_members row".

Because `ownerId` is now role-determinant, the general `PATCH /api/orgs/:orgId` (which
writes an unvalidated body) now **strips `ownerId`/`id`** from the update — otherwise a
plain member could rewrite themselves to owner (member→owner escalation). Ownership
transfer, if ever needed, is a dedicated owner-gated route, not this general edit.

## The exempt set (and why)

- **Agent-token API (`/api/agent/*`)** — authenticates by **agent run-token**, not
  Clerk. It lives in a **separate** registration scope; the membership hook never
  rides it. Proven: `membership-scoping.test.ts` drives `GET /api/agent/me` with a
  valid token → 200, bad token → 401.
- **Public onboarding** — `GET /api/agent-invites/:token/onboarding[.txt]`,
  `POST /api/agent-invites/:token/join`, `POST /api/agent-join-requests/:id/claim-api-key`.
  Token-addressed (the invite/claim secret is the bearer), profile-gated, mint-nothing
  (join) / mint-once-on-approval (claim). Registered public; the hook never rides them.
  Model unchanged (ONB1–ONB4).
- **`POST /api/orgs/:orgId/arturita/panic`** — public, owner-authed **in-handler** via
  a fresh Arturita command-session token (minting one needs Clerk). Registered in the
  public scope; the hook never rides it. (In the MCA-85 allowlist.)
- **`GET /api/orgs/:orgId/auth/google[/status]`** — the Google OAuth handshake,
  registered public (no session to present mid-redirect). Pre-existing public
  exemption (MCA-85 allowlist); **not changed** by this work.
- **Health/ready/openapi/llms.txt** — public, non-tenant.

## The leak-guard (so a future route can't be added ungated)

`tests/membership-scoping.test.ts` is **behavioural**, not a route-table tag:

1. **Surface-wide sweep** — enumerate **every** `/api/orgs/:orgId/*` route the secured
   scope registers (>80) and drive a **non-member** request at each; all must **403**.
   Because the gate rides the scope, this proves coverage can't be forgotten.
2. **Operator not broken** — a member is non-403 on the everyday routes; owner-only
   routes still 403 a plain member; the owner passes.
3. **Record-derived tail** — `/api/agents/:agentId` & `/api/tasks/:taskId`:
   non-member 403, member 200, missing row 403 (fail closed).
4. **Grandfather** — a legacy rowless owner is not locked out; an outsider still 403s.
5. **Exempt boundary** — agent-token API unaffected.

Plus `tests/rbac-membership.test.ts` — unit coverage of `resolveRequestOrg`
(precedence, derivation, fail-closed-on-missing, scoped:false) and
`requireOrgMembership` (OPTIONS skip, 401 no-user, stand-down on no-org-context).

The pre-existing MCA-85 guard (`auth-scoping.test.ts`) still holds: org routes must be
Clerk-authed (not public). Together: org routes are in the secured scope (MCA-85) **and**
the secured scope enforces membership (this fix). The `auth-scoping` boot now mirrors
`index.ts` by installing the same hook.

## Flagged edge cases (failed closed and/or surfaced, not silently guessed)

1. **`transfer`/`clone` target org** — now membership-checked (member of target
   required). This is the *conservative* read: it blocks injecting an agent into an org
   you don't belong to. If cross-org **admin** transfer between one operator's own orgs
   is ever desired, the operator is a member of both, so it keeps working; a broader
   "super-admin moves any agent anywhere" model is intentionally **not** introduced.
2. **`GET /api/users/:userId/orgs`** — made self-only. If an admin ever needs to read
   another user's memberships, that's a deliberate new capability, not this route.
3. **`POST /api/approvals/:id/decide`** — record-derived via `:id`; **already**
   self-enforces membership + a **type-mapped** role in-handler (AUDIT-ONB3 H-1). The
   scope hook deliberately stands down for it (no `:orgId`/`:agentId`/`:taskId`), so its
   type-role logic is preserved and there is no double-check. Covered by
   `onb3-approval-gate.test.ts`.
4. **`db.query.{agents,tasks}` derivation cost** — the hook does one extra DB read on
   the bare `:agentId`/`:taskId` routes (those handlers already load the record). The
   `/api/orgs/:orgId/*` bulk pays **no** extra read (path param).

## Verify

```
cd backend && npm test        # 1253 pass, 0 fail
              npm run evals    # 11/11
              npm run typecheck # clean
```
