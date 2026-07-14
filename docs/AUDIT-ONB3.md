# AUDIT — Epic ONB, Stage 3 (ONB3, PR #250)

*Independent code/security audit. I did not build this. Everything below was read in the merged
tree at `4e1d7a9` and — where it mattered — **driven against a real (in-memory libSQL) database**
rather than reasoned about.*

**VERDICT: NEEDS-FIXES-BEFORE-ONB4.**

The story ONB3 tells about itself is, with one exception, **true**: the public join endpoint mints
no credential, the single-use consume is a real compare-and-set, the approved agent is contained
with `api_token_hash = NULL`, and the posture constants are honest in both directions. I could not
find a way to get an agent, a token, or a readable secret out of the public surface.

The exception is the gate itself. **The board-approval gate is owner-gated on one of its two doors.**
The dedicated owner routes are gated. The generic tri-state decide route — the one the *shipped Inbox
card actually calls*, and which ONB3 deliberately wired into `applyJoinDecision` — carries **no
membership check and no role check at all**. I proved it: an authenticated user who is **not a member
of the org** is refused (403) by the dedicated route and **creates the agent** (200) through the card.

That does not make production unsafe *today* — `publicJoinEnabled` is false on the hosted backend, so
no join card can exist to decide. It makes the gate not-yet-a-gate, and the gate is the entire
security thesis of the epic. It must close before ONB4 turns "approved" into "claimable credential",
and before `MC_ENABLE_REMOTE_ONBOARDING` is ever set.

| Severity | Count | Status |
|---|---|---|
| Blocker | 0 | — |
| High | 1 (H-1, the approval gate is not owner-gated on the Inbox door) | **open — builder/operator call** |
| Medium | 3 (M-1 integrity, M-2 rate-limit bypass, M-3 secret scope) | **all three fixed here** |
| Low | 4 | 0 fixed, 4 recorded |
| Nit / informational | 2 | recorded |

---

## H-1 (HIGH, open) — the board-approval gate has two doors, and only one of them is owner-gated

**`backend/src/routes/tasks.ts:441`** (`POST /api/approvals/:id/decide`), reached from
**`backend/src/routes/tasks.ts:469-491`** (the ONB3 wiring) → `applyJoinDecision`.

ONB3's own landmine guard states the property exactly right (`auth-scoping.test.ts`):

> *The board-approval gate is the load-bearing control of ONB3, and it is only a gate if it is
> owner-gated. A join request that a member — or an unauthenticated caller — could approve would turn
> "a leaked invite buys a queue item" back into "a leaked invite buys an agent".*

…and then asserts it against the three routes that **have** the gate:
`GET /api/orgs/:orgId/agent-join-requests`, `…/:requestId/approve`, `…/:requestId/reject`. All three
carry `requireOrgRole('owner')` on a path with a real `:orgId`. Correct, and verified.

The fourth door is not in the list. `POST /api/approvals/:id/decide` sits in the Clerk-secured scope
(so: *authenticated*), looks the approval up **by id alone**, and never asks who the caller is:

```ts
app.post('/api/approvals/:id/decide', async (req, reply) => {          // no preHandler
  const approval = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, id) })
  ...
  if (approval.type === JOIN_APPROVAL_TYPE) { await applyJoinDecision({ ... orgId: approval.orgId ... }) }
```

The `orgId` handed to `applyJoinDecision` comes **from the row**, not from the caller — so the
org-scoping inside `applyJoinDecision` is satisfied by construction and enforces nothing about who is
asking. And `requireOrgRole` could not have helped even if someone had reached for it: this path has
no `:orgId`, and `requireOrgRole` silently no-ops without one (**AUDIT-ONB2-hardening R-4** — the trap
the last audit flagged and left live). The same blind spot hides the route from the MCA-85 guard net,
which only inspects routes matching `/:orgId|:agentId/`.

**Proven, not inferred.** Boot `agentJoinRoutes` + `taskRoutes` exactly as `index.ts` does, join with a
valid invite, then act as `user-outsider` — a Clerk user with **no `org_members` row for the org**:

```
OWNER ROUTE  as outsider → 403                      ← the gate
DECIDE ROUTE as outsider → 200                      ← the same decision, no gate
AGENTS CREATED BY OUTSIDER: 1
  { name: 'Evil', trust: 'low_trust_review', perms: '["machine_exec"]', tok: null }
```

The agent lands contained and with no token — every *other* ONB3 control held. But "a human decides"
became "any authenticated user decides", and a member (or, with a known approval id, an outsider)
can also **re-scope the joining party's declared secrets onto an agent** (`join-approvals.ts:132-140`).
Approval ids are UUIDs, but `GET /api/orgs/:orgId/approvals` (`tasks.ts:122`) is **also** Clerk-only
with no membership check, so they are enumerable by anyone who knows an `orgId`.

**Why I did not fix it.** It is an authorization-contract change on a route the web app already uses
for every other card type, and "may a non-owner member approve a join request?" is a product call, not
an auditor's. The fix is small and I recommend exactly this shape:

```ts
// routes/tasks.ts, inside POST /api/approvals/:id/decide, before decideApproval():
if (approval.type === JOIN_APPROVAL_TYPE) {
  const userId = (req as any).auth?.userId
  const m = await db.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.orgId, approval.orgId), eq(schema.orgMembers.userId, String(userId ?? ''))),
  })
  if (!m) return reply.code(403).send({ error: 'Not a member of this organisation' })
  if (m.role !== 'owner') return reply.code(403).send({ error: 'Insufficient permissions. Required role: owner' })
}
```

…plus an `auth-scoping.test.ts` case that asserts **`POST /api/approvals/:id/decide` refuses a
non-owner an `agent_join_request` decision** — a route-table assertion cannot see this one, so it has
to be a driven request. (The broader problem — the whole `/api/orgs/:orgId/*` surface is
Clerk-authenticated but not membership-checked — is **pre-existing and out of ONB3's scope**, but it is
what makes H-1 cross-tenant rather than merely intra-org. It deserves its own PR.)

---

## M-1 (MEDIUM — **fixed here**) — a failed agent insert stranded the request as `approved` forever

**`backend/src/services/join-approvals.ts:123-127`** (as shipped). The builder self-flagged this
(flag #1) and was right to.

`applyJoinDecision` is **not transactional**: the status CAS commits, *then* the agent is inserted,
*then* the secrets are re-scoped. A DB error at the insert left `status = 'approved'` with an
`agent_id` pointing at a row that does not exist — and because a second approve is (correctly) a 409,
the request was **unrecoverable without a manual DB edit**.

**Severity: MEDIUM, not HIGH.** The ordering is fail-*closed* — status first, agent second — so no
crash can ever produce an agent nobody approved (the reverse ordering would). Nothing leaks: the
parked secrets stay in the inert `join_request` scope. The damage is integrity and operability, and it
becomes an ONB4 problem the moment "approved" means "a credential may be claimed" — an ONB4 claim
route that trusts `status = 'approved'` and mints against a missing `agent_id` must fail closed.

**Fixed** (`join-approvals.ts`): the agent insert is now wrapped, and a failure **compensates** — the
CAS is rolled back to `pending_approval` (guarded on the `agent_id` this attempt claimed, so a
concurrent decision cannot be clobbered) and the error is re-thrown. The operator simply retries.
Test: `audit-onb3-fix.test.ts` `[ONB3-audit/M-1]` drives a DB whose `insert` throws and asserts the
request is back to `pending_approval`, no agent exists, and a retry succeeds.

**Recommended for ONB4 (not done here):** make it a real transaction. `db.transaction()` exists on the
libSQL driver, **but it opens a second connection** — and a `:memory:` database is per-connection, so
wrapping this today breaks every ONB3 suite (`no such table: organisations` inside the tx; I
confirmed this by probe). Doing it properly means moving the test harness to a `file:` or
shared-cache DB first. That is a real change, not a one-liner, and it belongs in the ONB4 PR that
also needs a transaction for the claim. `db.batch()` is atomic and single-connection, but the agent
insert must then be conditional in SQL (`INSERT … SELECT … WHERE EXISTS (…status='approved'…)`),
because a batch cannot branch on the CAS result — workable, and uglier than a transaction.

## M-2 (MEDIUM — **fixed here**) — the per-IP join rate limit was bypassable with a header

**`backend/src/middleware/ratelimit.ts:167`** (as shipped): `const ip = req.ip || req.headers['x-forwarded-for']`.

The app boots with `trustProxy: true` (`index.ts:67` — it must, behind Fly), which makes Fastify
resolve `req.ip` to the **leftmost `X-Forwarded-For` entry** — a value the caller types. So the
rate limit keyed on attacker-chosen input. Driven against the real join route with `trustProxy: true`:

```
rotating XFF from ONE socket : 201,201,201,201,201,201,201,201,201,201,201,201,201,201   ← 14/14 admitted
same socket, no XFF          : 201,…,201,429,429,429,429                                 ← the limit works
```

This is precisely the control the **ONB2 re-audit's M-3** demanded exist *before* remote onboarding is
enabled in production, and which ONB3 promotes to a checked hardening requirement
(`join_rate_limited: satisfied: true`). The requirement reported satisfied; the control did not hold.

**Fixed** (`ratelimit.ts`, new exported `rateLimitClientIp`): key on `Fly-Client-IP` (written by our
own proxy, which overwrites whatever the caller sent) and otherwise on the **raw socket address**.
`X-Forwarded-For` is not trusted at all unless the operator declares a proxy with `MC_TRUSTED_PROXY=1`,
and even then only the **rightmost** hop (the one the nearest proxy appended) is used, never the
leftmost one the caller led with. Without the flag, callers behind an unknown proxy share the proxy's
bucket — that throttles onboarding rather than opening it, which is the right way to fail.
`perIpRateLimit` has exactly one call site (the join route), so the blast radius of the change is one
route. Tests: `[ONB3-audit/M-2]` ×2.

Residual (not fixed, deliberate): the limiter is **in-process memory**, so on multiple Fly machines
the effective limit is 10/min *per instance*. Acceptable for a token-addressed endpoint whose token is
32 bytes of entropy; worth a Redis-backed window if remote onboarding ever goes wide.

## M-3 (MEDIUM — **fixed here**) — the parked join-request secrets were inert by convention only

The builder's flag #5, and I agree with the concern more than with the "it's fine" conclusion.

`GET /api/agent/secrets` (`routes/agent-api.ts:102-107`) **selected every secret in the org and
decrypted all of them**, then let `resolveSecretsForAgent` throw away the ones it did not want. A
pending, unapproved joining agent's declared credentials were therefore read out of the database and
decrypted in-process on every single agent poll — protected only by two `if`s in a pure function that
nothing named as a security boundary. Any future resolver that filters by `orgId` alone (exactly the
scenario the builder flagged) would hand them out.

**Fixed:** `services/secrets.ts` now exports `AGENT_RESOLVABLE_SCOPES = ['company', 'agent']` as the
named source of truth, and the route filters on it **in the WHERE clause** — a `join_request`-scoped
row is never fetched, never decrypted, and cannot reach an agent bag. New scopes are now opt-in.
Test: `[ONB3-audit/M-3]`.

**Still recommended (ONB4):** a schema-level `CHECK (scope IN (…))` or a dedicated
`pending_join_secrets` table, so the boundary survives someone adding a scope without reading this
file. A code allow-list is the right first move, not the last one.

---

## LOW

**L-1 — the parked secrets show a masked hint in the operator secrets list.**
`GET /api/orgs/:orgId/secrets` (`routes/tasks.ts:219-223`) returns `••••` + **the last 4 characters**
of the decrypted value for every secret in the org — including a `join_request`-scoped one belonging
to a request nobody has approved yet — and the route is Clerk-only (no membership check, same
contract as H-1). Recommend: filter the list to `AGENT_RESOLVABLE_SCOPES` (or label the parked scope
explicitly) and gate it. Not fixed: it is an operator surface with a live web caller.

**L-2 — `revision_requested` on a join card orphans the request** (the builder's flag #7).
`parseJoinDecision` returns `null`, so no join action runs — correct — but the *card* is still closed
as `revision_requested` (`tasks.ts:468`), while the join request stays `pending_approval`. The item
therefore vanishes from the pending inbox while remaining pending in `agent_join_requests`, with no UI
that pairs them. Recommend ONB6: either 400 the decision for `agent_join_request` cards (there is no
"send it back" channel — the joining agent cannot be told anything), or leave the card `pending`.

**L-3 — `packaged` does no loopback check; it is a name, not a control** (the builder's flag #3).
The server binds `0.0.0.0` (`index.ts:265`) and `publicJoinEnabled` is true for **any** source IP under
`MC_DEPLOYMENT_PROFILE=packaged`. Nothing checks that the caller is on loopback, so
`loopbackTrusted: true` in the posture describes a *trust assumption*, not an enforced one: anyone on
the LAN can join. Given LAN onboarding is the intended product behaviour, **the code is right and the
vocabulary is wrong** — but the posture is the thing operators will read before deciding what to
expose. Recommend: rename the field (`localNetworkTrusted`), and if a real control is ever wanted,
`MC_JOIN_ALLOWED_CIDRS` beats a hard loopback check (which would break the intended use).

**L-4 — the ONB6 escaping caveat is about `config`, not `agentName`** (the builder's flag #4).
`AGENT_NAME_RE` = `/^[\p{L}\p{N} ._\-()]+$/u` admits no `<`, `>`, `"`, `'`, `&`, no URL, and no
bidi/format controls (`Cf` is neither `L` nor `N`) — so the name is genuinely not an injection vector
and the flag over-states its own risk. The real free text on the card is **`selfDeclared.config`**:
registry string fields are validated for *type, length and enum* only (`adapter-registry.ts:404-408`),
so `workdir`, `baseUrl`, `model` etc. are arbitrary strings the joining party chose, and they are
rendered to the approver. ONB6 must escape the **payload**, not just the name. (React/JSX escapes by
default — the caveat is real only if ONB6 reaches for `dangerouslySetInnerHTML` or renders these into
a non-HTML sink.)

## Nits / informational

**N-1 — `externalEndpoint` is a dormant SSRF landmine for ONB5.** `buildApprovedAgent`
(`join-requests.ts:335`) copies `config.externalEndpoint` into the agent verbatim, while the owner-facing
agent-create route validates the same field with `z.string().url()` (`routes/agents.ts:369`). Harmless
**today**: the only adapter declaring the field (`http_webhook`) is `available: false`, so
`validateDefaultsPayload` refuses it, and nothing currently fetches the column
(`notifyExternalAgent` fires the org's configured webhook, not the agent's endpoint). ONB5 is the story
that makes it live, and it must validate the scheme and refuse private/link-local hosts — the value is
supplied by an unauthenticated party now, not an operator.

**N-2 — nothing.** `claimPath` advertises a route that 404s; `claimStatus: 'not_yet_open'` says so in
the same response. That is the honest thing to do, not a bug.

---

## Verified clean (I tried to break these and could not)

- **No credential anywhere in ONB3.** `token`/`mca_`/`hash`/`claimSecret` appear nowhere in the join
  path, the response, the request row, the approval card, or the approved agent. `api_token_hash` is
  `null` on the created agent, and `agentAuth` matches on that hash — an approved ONB3 agent can
  authenticate to nothing. Confirmed in the DB, not just in the response.
- **The public join endpoint creates no agent row.** Confirmed against a real DB
  (`onb3-join-flow.test.ts` inspects `agents` after a join: 0 rows).
- **Declared secrets never touch a plaintext column.** The registry splits `secret: true` fields out;
  the route writes them via `encrypt()`; only the KEY NAMES are persisted on the request and shown on
  the card. Reject deletes them.
- **`.strict()` body, no free-text field.** An unknown key is refused (400), not ignored — so the
  AUDIT-ONB2-hardening ruling-3 hole (a third-party secret in an innocuous free-text key reaching
  `audit_logs.metadata` unredacted) has no field to arrive in. `capabilities` is an allow-listed enum;
  wildcards and an empty list are both refused (the empty list is allow-all in `governance2` — the
  refusal is the point).
- **Flat 404 for every closed state.** Unknown, malformed, expired, revoked, exhausted, lost consume
  race, posture-closed — one identical response. No enumeration oracle. Driven, all six.
- **Hosted production answers the join route with a 404 today.** `MC_ENABLE_REMOTE_ONBOARDING` is unset
  on the live backend, so `publicJoinEnabled` is false and the route is indistinguishable from absent.
- **The landmine guard got stricter, both directions.** Join route exists **iff**
  `PUBLIC_JOIN_IMPLEMENTED`; **no** claim route in **any** scope while `TOKEN_CLAIM_IMPLEMENTED` is
  false. `operatorCanSeeClaimedKey` is literal `false`. `claude_code` is still plan-mode; `allowShell`
  untouched; the audit-log hook is still a no-op (untouched, as instructed).
- **Invariant #3 is read, not re-derived.** `buildApprovedAgent` takes `low_trust_review` from
  `INVITE_AGENTS_ALWAYS_LOW_TRUST`, so a future runtime cannot quietly opt out; the boundary is
  explicitly persisted empty; permissions are the explicit allow-listed list and can never decay to
  `[]`.
- **Double-approve is a 409, never a second agent** (status CAS). Verified.
- **No secret in the tree or the history.** The only token-shaped strings are `sk-live-CANARY` /
  `sk-live-PENDING-CANARY` — deliberate test canaries asserted *absent* from outputs.

---

## Rulings on the builder's seven self-flags

**#1 — `applyJoinDecision` is not transactional.** *Upheld — MEDIUM.* You called it correctly and you
called the ordering correctly: status-first is the fail-closed direction (no agent can exist that
nobody approved), and the residual harm is a stranded, unrecoverable "approved" request. **Fixed here
by compensation**, which removes the stranding without a driver change. A true transaction is still the
right end state and belongs in ONB4 — note that `db.transaction()` opens a second connection and will
break the `:memory:` harness, so the harness moves first. See M-1.

**#2 — the CAS is not proven against real Turso.** *The CAS is correct by construction; the test gap is
acceptable.* `consumeInviteUse` is a **single** `UPDATE … SET used_count = used_count + 1 WHERE id = ?
AND revoked_at IS NULL AND expires_at > ? AND used_count < max_uses`. SQLite/libSQL executes one
statement atomically under a write lock, and Turso has a **single primary** — every write is serialized
there, and the `WHERE` is evaluated against committed state at write time, not against what the client
read. Two racing callers cannot both satisfy `used_count < max_uses`: one commits, the other
re-evaluates and matches 0 rows → `rowsAffected !== 1` → the flat 404. The failure mode under real
contention is a `SQLITE_BUSY`/conflict **error** (a 500), never a double-consume — fail-closed either
way. Your honesty about the route-level "two simultaneous joins" test is warranted (the in-memory
driver serializes it, and it passed against the racy consume — that is a fair, and unusual, thing to
say out loud), but the **TOCTOU test is the real proof**: it reproduces the exact interleaving a
read-then-write consume loses to (both callers hold `used_count = 0`), and it fails against that
consume. That is a property test of the statement, and the statement is what ships. *Nit, not a
finding:* before `MC_ENABLE_REMOTE_ONBOARDING` is ever set, run the same consume once against a real
Turso dev database — not to prove atomicity (the engine gives you that) but to catch the deployment-
shaped surprises (retry/`SQLITE_BUSY` handling, embedded-replica configs, which would break it).

**#3 — the packaged profile has no loopback source-IP check.** *Binding + config is enough — but the
vocabulary is not.* LAN onboarding is the intended behaviour, so a hard loopback check would break the
product. Do not add one. **Do** stop calling it `loopbackTrusted` in a posture an operator reads before
deciding what to expose. See L-3.

**#4 — `agentName` is capped but not escaped.** *Over-stated for the name, under-stated for the payload.*
The charset makes the name inert. The **config strings** are the free text on that card. See L-4.

**#5 — the `join_request` scope is inert by convention, not schema.** *Upheld, and it was worse than you
thought:* the agent secrets route SELECTed and **decrypted** those rows on every poll before discarding
them. **Fixed here** — the allow-list is exported and applied in the SQL. A schema constraint is still
the right ONB4 move. See M-3.

**#6 — no `claimSecret` is returned; ONB4 owns the credential lifecycle.** *Agreed, and it is the single
best decision in this PR.* Minting half a claim protocol now — a secret with nothing to spend it on —
would have created exactly the parked-credential the epic exists to prevent. Correct as shipped.

**#7 — `revision_requested` on a join card creates nothing.** *Acceptable behaviour, unacceptable state.*
Creating nothing is right. Leaving the card closed while the request stays pending is a state with no
UI. LOW; ONB6. See L-2.

---

## What must change before ONB4

1. **H-1 — owner-gate the `POST /api/approvals/:id/decide` door for `agent_join_request` cards**, with a
   driven (not route-table) test. ONB4 turns an approval into a claimable credential; today's "any
   authenticated user can approve" becomes "any authenticated user can cause a credential to exist".
   This is the one that blocks.
2. **M-1 — make `applyJoinDecision` (and the ONB4 claim) genuinely transactional**, moving the test
   harness off `:memory:` first. The compensation shipped here is a floor, not a ceiling.
3. **ONB4's claim must fail closed on a missing agent row** — never mint against `status = 'approved'`
   alone; require the `agents` row to exist and its `api_token_hash` to still be `NULL` (a CAS on the
   hash, so a claim is single-use by the same mechanism the invite is).
4. **M-3 follow-up — a schema-level constraint on `secrets.scope`**, in ONB4's migration.

**Is ONB4 clear to start?** Yes, in parallel — nothing in ONB4's design depends on H-1 being open or
closed. But **ONB4 must not merge before H-1 is fixed**, because ONB4 is precisely what converts H-1
from "an unapproved agent that can authenticate to nothing" into "an unapproved agent that can claim a
key". Fix H-1 in its own small PR first; it is ~10 lines and one test.

---

## What this audit changed

| File | Change |
|---|---|
| `backend/src/services/join-approvals.ts` | M-1 — a failed agent insert compensates the status CAS back to `pending_approval` and re-throws. |
| `backend/src/middleware/ratelimit.ts` | M-2 — new `rateLimitClientIp()`: `Fly-Client-IP` → socket; `X-Forwarded-For` is untrusted unless `MC_TRUSTED_PROXY=1` (and then only the rightmost hop). |
| `backend/src/services/secrets.ts` | M-3 — exports `AGENT_RESOLVABLE_SCOPES` as the named boundary. |
| `backend/src/routes/agent-api.ts` | M-3 — `GET /api/agent/secrets` filters the scope in the WHERE clause; a parked `join_request` secret is never fetched or decrypted. |
| `backend/src/tests/audit-onb3-fix.test.ts` | **new** — 4 tests, each of which fails against #250 as merged. |

Nothing else was touched. `allowShell`/`MC_ALLOW_SHELL` untouched, the audit-log hook untouched (still
a no-op, still the operator's cost call), no invariant weakened, no posture constant flipped.

**Verification:** `npm test` → **1199 passed, 0 failed** (1195 + 4). `npm run evals` → **11/11**.
`npm run typecheck` → clean.
