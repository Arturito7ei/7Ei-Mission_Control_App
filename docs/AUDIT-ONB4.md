# AUDIT — ONB4 (the one-time API-key claim)

**Scope:** Epic ONB, Stage 4 (PR #253, merged to `main` as `c35e1ac`). The credential-minting
stage: the `mcc_` claim secret minted at join, and the one-time `mca_` token claim.
**Auditor:** independent (did not build ONB4). **Date:** 2026-07-15.
**Method:** traced every write of the raw token/secret across DB columns, logs, telemetry,
audit metadata, and every route response; drove the fail-closed matrix, the two-CAS single-use
path, and the posture gate against the real in-memory libSQL suite; re-verified the ONB3
gate-fix residuals.

## VERDICT: **PASS-WITH-FIXES**

The security core is sound. The raw `mca_` token and the `mcc_` claim secret are hash-only at
rest, appear in plaintext only in their single respective response bodies, and reach no log,
telemetry, audit sink, or operator surface. Single-use is enforced by two atomic compare-and-set
statements and holds under concurrency. Every claim failure collapses to one identical flat 404.
The landmine guard, the posture gate, and the fixed rate-limit keying are all applied to the claim.

One **LOW** was found and **fixed in this PR** (missing `no-store` on the join response, which
since ONB4 carries the raw `mcc_` secret). The remaining items are **product/operator calls**,
not defects, and are enumerated below so the decision is recorded rather than implied.

No blocker. No high. No secret in the tree or git history.

---

## Findings by severity

### LOW-1 — join response returns the raw `mcc_` claim secret without `cache-control: no-store` — **FIXED**
`backend/src/routes/agent-invites.ts` (join handler, ~L399).
Before ONB4 the join 201 body carried no credential, so it set no cache header. ONB4 added the
raw `mcc_` claim secret to that body but did not add `no-store` — while the claim POST
(`agent-invites.ts:452`) and both onboarding-doc GETs (`:520`, `:532`) deliberately do. A POST
response is not cached by standard intermediaries absent explicit headers, so this is
defense-in-depth rather than a live leak, but the codebase's own convention is to mark every
credential-bearing response `no-store`.
**Fix applied:** `reply.header('cache-control', 'no-store')` on the join response.

### LOW-2 — invite-create response returns the raw invite token + embedded onboarding prompt without `no-store` — **left for owner (pre-existing, ONB1)**
`backend/src/routes/agent-invites.ts` (`POST /api/orgs/:orgId/agent-invites`, ~L137–162).
The same class as LOW-1 but pre-dates ONB4: the invite-create 201 body returns the raw
`mci_inv_` token and an `onboardingPrompt` that embeds it, with no `no-store`. It is
owner-gated (Clerk) and consumed by the operator's own browser, so lower urgency, and it is
ONB1 surface, not ONB4 — flagged, not changed, to keep this audit's diff scoped to the stage
under review. Recommend the same one-liner in an ONB-hardening pass.

### NIT-1 — pre-compare timing distinguishes "unknown request" from "known request" (not the secret)
`backend/src/services/claim.ts:110–136`.
An unknown `joinRequestId` returns at the first `findFirst` (no agent read, no compare); a
known-but-not-approved request returns at the `status` check; an approved-unclaimed request runs
the full path incl. the agent read and the constant-time compare. So response *latency* can in
principle distinguish request existence/coarse state — but **not** the secret, whose compare is
constant-time. Non-actionable: the `requestId` is a UUID and not itself a bearer credential
(knowing a valid one buys nothing without the 256-bit secret), the endpoint is per-IP
rate-limited to 10/min, and a network timing side-channel at that rate is not practically
exploitable. Recorded for completeness; no change recommended.

---

## Rulings on the builder's 4 self-flags

### Flag #1 — flat 404 for every claim failure, vs design §3.6's distinct 403/409/410. **RULING: ACCEPT the deviation.**
Design §3.6 specified a granular ladder (not-approved→403, expired→410, already-claimed→409,
hash-mismatch→403). The builder collapsed all of it to one flat 404 to match the epic's
established no-oracle posture (the join route and the onboarding-doc route already answer every
closed state with the same 404). This is the **stronger** choice: the granular codes would turn
the claim endpoint into a status oracle — a holder of a *requestId* but not the secret could
learn "this request exists and is approved but you have the wrong secret" (403) vs "already
claimed" (409) vs "expired" (410). Against an unauthenticated, internet-facing endpoint that is
a real leak. The tradeoff — a legitimate agent with a genuinely expired secret gets a 404 and
must re-join rather than reading "expired" — is acceptable because the same agent still holds the
`claimStatus`/`claimSecretExpiresAt` it was handed at join, so it can tell locally that its
window closed. The design doc's §3.6 failure-state text was updated in-PR to match, so the spec
and the code agree. **The no-oracle posture wins; the deviation is correct.**

### Flag #2 — two sequential CAS + compensation instead of one DB transaction. **RULING: single-use-correct and safe; one narrow availability gap (LOW, not fixed here).**
The consume is CAS #1 (`claimed_at IS NULL` in the WHERE, `claimed_at` stamped + `claim_secret_hash`
cleared in the *same* UPDATE, every precondition re-asserted in the WHERE). The mint is CAS #2
(`api_token_hash IS NULL`). This is genuinely single-use: two claims cannot both win CAS #1
(SQLite executes each UPDATE atomically), so exactly one token is ever minted. Verified by both
the route-level and service-level concurrency tests (see below).

**The window the flag asks about, analyzed:** if the process dies *between* CAS #1 winning and
CAS #2, the request is left `claimed_at`-stamped with its hash cleared, while the agent's
`api_token_hash` is still NULL — the agent is now **permanently un-claimable** (`claimSecretHash`
is null → precondition fails; CAS #1 would fail on `claimed_at`). No token leaked and no double
mint, so it **fails closed** — but the agent is stranded un-credentialed and the operator must
intervene (delete the agent / have it re-join). The in-code compensation only covers CAS #2
returning `rowsAffected !== 1` (agent deleted or credentialed out-of-band between the reads and
the mint) — it correctly rolls `claimed_at` back to NULL and re-derives the hash, guarded on the
exact `claimed_at` it stamped so a concurrent claim can't be clobbered, and a retry then fails
closed at `if (agent.apiTokenHash) return FAIL` rather than minting a second token. It does **not**
cover a hard crash between the two statements.

**Ruling:** the two-CAS design is correct and safe for the *security* property (exactly-one
token, no leak, no double-mint) — a real transaction would not make it *more* single-use. The
only thing a transaction would buy is closing the crash-between-statements *availability* gap
(all-or-nothing). Given that libSQL `db.transaction()` opens a second connection the `:memory:`
harness cannot follow (the builder's stated reason, and it matches AUDIT-ONB3 M-1), and that the
gap is fail-closed and requires a crash in a sub-millisecond window, deferring the transaction is
acceptable. **Recommend** (LOW, operator/roadmap): before packaged/loopback GA, add a
recovery/repair path or a real transaction so a stranded request is self-healing rather than
manual. Not a blocker.

### Flag #3 — `secrets.scope` CHECK constraint not done; the code allow-list `AGENT_RESOLVABLE_SCOPES` is the boundary. **RULING: ACCEPT.**
`AGENT_RESOLVABLE_SCOPES = ['company','agent']` (`services/secrets.ts:42`) is the single source of
truth: `resolveSecretsForAgent` resolves only those two scopes, and the DB read for
`GET /api/agent/secrets` filters on the same list, so a `join_request`-scoped parked secret is
inert by construction and un-resolvable, not merely discarded. A SQL `CHECK` on `secrets.scope`
would be defense-in-depth, but adding one to a *live* table is a table rebuild (SQLite can't add a
CHECK via `ALTER`), which is unsafe as an additive migration and would violate the "no renames /
idempotent ALTER only" convention. The code boundary is enforced at both the resolver and the
query, and is guarded by tests. **The code allow-list is an acceptable boundary; the CHECK is
correctly deferred.**

### Flag #4 — the claim secret in the join response body is never logged. **RULING: CONFIRMED.**
Traced every sink:
- **DB:** only `claim_secret_hash` (sha256) is persisted, NULLed on claim; `mca_` stored as
  `api_token_hash` only. The whole-DB assertion in the ONB4 test proves the raw token appears in
  no table.
- **Audit log:** `auditLogPlugin` captures `req.body` only (recursively sanitized) — never the
  *response* payload — so the raw token/secret, which live only in response bodies, never reach
  `audit_logs`. The hook is additionally a no-op in prod.
- **Request logger:** Fastify's default logger logs req/res metadata, not bodies. No global
  `onSend`/response-serializer captures payloads (verified — none exists).
- **Redaction belt:** `mcc_` and `mca_` are both in `TOKEN_SEGMENT_PATTERNS` and the
  `redactTokensInText` alternation, so any path segment or free-text echo carrying either is
  masked before any sink.
**Confirmed: neither the claim secret nor the token can be logged by any current sink.**

---

## The 4 audit dimensions — verified

### 1. Token security (the crux) — **CLEAN**
- `mca_` minted exactly once (`generateAgentToken`, `randomBytes(32)`), stored **hash-only**
  (`api_token_hash`), returned raw only in the single claim response, never persisted plaintext,
  never logged (see Flag #4).
- `mcc_` claim secret minted at join (`generateClaimSecret`, `randomBytes(32)`), stored
  **hash-only** with `claim_secret_expires_at`, returned raw only in the single join response,
  NULLed on claim.
- `operatorCanSeeClaimedKey` is a literal `false` in the posture (`deployment-profile.ts:169,248`);
  no operator route/view returns a token or its hash (invite list/view/join-request view all omit
  it; the approve/reject and decide routes return `agentToken: null`).
- TTL clamp: `claimSecretExpiry(now, inviteExpiresAt)` returns `min(now+24h, inviteExpiresAt)` —
  a claim secret is strictly shorter-lived than the invite it came through (§3.4). ✔

### 2. Fail-closed preconditions — **CLEAN**
`claimApiKey` (`services/claim.ts`) fails closed to the identical `{ok:false}` on: shape mismatch,
unknown request, `status!=='approved'`, missing `agentId`, missing/cleared `claimSecretHash`,
`claimedAt` set, missing/expired `claim_secret_expires_at`, **missing agent row**, agent already
credentialed, and constant-time hash mismatch. The agent row is **re-read** and rejected if
absent or already-credentialed — it never trusts `status='approved'` alone (ONB3 auditor #3,
and it neutralises the M-1 ghost-agent shape). Constant-time compare via
`hashesEqual`/`timingSafeEqual` (`arturita-session.ts:55`), the shared helper — never a SQL `=`
on the hash, never a JS `===`. The fail-closed matrix is driven end-to-end in the test suite,
each case asserting the identical `{error:'Not found'}` 404.
**Ruling on the flat-404 posture:** see Flag #1 — correct.

### 3. Atomic single-use — **CLEAN**
Two real CAS statements (§Flag #2). `rowsAffected !== 1` → flat failure on each. The token is
minted only *after* the consume CAS wins. The concurrency proof exists at **two** levels:
- route-level: `Promise.all([claim, claim])` → `[200, 404]`, one token hash on the agent;
- **service-level**: `Promise.all([claimApiKey, claimApiKey])` → exactly one `ok:true`, and the
  agent ends with exactly the winner's hash.

On the "does the in-memory driver undermine it like the ONB3 route test did?" concern: the
ONB3-route worry was that `:memory:` serializes requests so a route-level `Promise.all` isn't a
true wall-clock race. That does not undermine *this* proof, because single-use here is a property
of the **CAS WHERE clause**, which SQLite enforces atomically per-statement regardless of
scheduling — even fully serialized execution proves the second UPDATE affects 0 rows. The
service-level test additionally exercises the TOCTOU directly (both callers pass the pre-checks
before either writes), which is the meaningful proof. **Exactly-one-token is proven.**

### 4. Invariants — **CLEAN**
- `TOKEN_CLAIM_IMPLEMENTED = true` (`deployment-profile.ts:93`); `PUBLIC_JOIN_IMPLEMENTED = true`.
- Landmine guard (`auth-scoping.test.ts`) asserts **both directions**: the claim route exists
  *iff* `TOKEN_CLAIM_IMPLEMENTED` (exactly one, public/token-addressed), and the join route iff
  `PUBLIC_JOIN_IMPLEMENTED`. 6/6 pass.
- Claimed agent stays `low_trust_review` (invariant #3 — `buildApprovedAgent` reads
  `INVITE_AGENTS_ALWAYS_LOW_TRUST`; the ONB4 test asserts `trustMode==='low_trust_review'` pre-
  and post-claim); `claude_code` stays plan-mode (untouched).
- ONB3 approval-gate RBAC intact (see residual re-verify below).
- Fixed rate-limit keying (`rateLimitClientIp`: `Fly-Client-IP`/socket, never the spoofable
  leftmost `X-Forwarded-For`) is applied to the claim route via
  `perIpRateLimit(JOIN_RATE_LIMIT_PER_MINUTE)`. ✔

### 6. Conventions / migration / secrets-in-tree — **CLEAN**
- Migration: additive idempotent `ALTER TABLE agent_join_requests ADD COLUMN …` for
  `claim_secret_hash`/`claim_secret_expires_at`/`claimed_at`, plus the fresh `CREATE TABLE …`
  carrying them (`db/setup.ts:206,219–221`). **No backfill** — a pre-ONB4 row has a null hash and
  is un-claimable by construction. No column renamed. Matches the stated convention.
- Exposure follows the deployment profile: hosted-without-`MC_ENABLE_REMOTE_ONBOARDING` answers a
  flat 404 on the claim (test 11), same as the join.
- `git log -p`/tree scan: no `mcc_`/`mca_` literal secret committed; only test fixtures using
  `'a'.repeat(64)`-style placeholders.

---

## ONB3 gate-fix residual re-verify (AUDIT-ONB3 addendum)

- **type→role map covers the minting set.** `AGENT_MINTING_APPROVAL_TYPES =
  ['agent_join_request','agent_create']` → OWNER; `requiredRoleForApproval` fails **closed to
  owner** on absent/empty/non-string type; every other well-formed type → MEMBER (membership is
  now the floor). `enforceOrgRole` runs on `POST /api/approvals/:id/decide` against the org
  **derived from the row** (the route has no `:orgId`, so `requireOrgRole` would no-op — the R-4
  trap — and this is the correct workaround). ✔
- **`low_trust_review` → `actionType` escalation reads the right field.** `isAgentMintingApproval`
  escalates a `low_trust_review` card to owner when `normType(payload.actionType)` is itself a
  minting type; the route passes `actionType: (approval.payload)?.actionType` — the correct field.
  Step-up gating separately reads `payload.requiresStepUp` for the wrapped-dangerous case. ✔
- **`wallet_tx`/`machine_exec` sit at member + A2 step-up — should any be owner?** They are
  `DANGEROUS_APPROVAL_TYPES`, so deciding them requires a *fresh Arturita command session*
  (step-up) on top of **membership**, but not owner. **RULING: acceptable as-is, but flag for the
  product owner.** These are *action* approvals, not *agent-minting* approvals — the ONB3 gate's
  purpose is specifically to stop a member (or a contained agent) from bringing an agent into
  existence, which `wallet_tx`/`machine_exec` do not do. Gating everyday dangerous actions to
  owner would over-restrict the normal operator flow, and A2 step-up already forces a fresh,
  deliberate human session for them. **Not an ONB4 defect.** If the product intent is that moving
  funds or executing on a host is an *owner-only* act regardless of step-up, that is a one-line
  policy change (add them to an owner set) — a product call, recorded here, not made by the audit.

---

## Is onboarding CORE (ONB1–ONB4) sound enough to enable in a packaged/loopback deployment?

**Yes, with two caveats recorded, not blocking.** The security spine is complete and verified:
inverted lifecycle (no credential exists before a human approves), owner-gated board approval on
*both* doors, single-use invite consume, single-use claim with hash-only storage and no-oracle
failure, profile-gated exposure, and the fixed rate-limit keying. For a **packaged/loopback**
target (the operator owns the machine; loopback is trusted) the residual risks are availability,
not confidentiality:
1. the crash-between-CAS availability gap (Flag #2) — a stranded request needs a manual/repair
   path before you'd want this hands-off at scale;
2. the audit trail is still a no-op by construction (operator cost decision, unchanged here) — a
   packaged deployment minting real credentials should decide whether it wants the trail on.

Neither blocks a loopback-trusted enable. **Enabling the same flow on the *hosted* backend**
remains correctly gated behind `MC_ENABLE_REMOTE_ONBOARDING` (false today) and should stay off
until those two are addressed.

---

## What I changed
- `backend/src/routes/agent-invites.ts` — added `cache-control: no-store` to the join response
  (LOW-1).
- `docs/AUDIT-ONB4.md` — this document.

## Verification after the fix
- `npm test` → **1221/1221** pass · `npm run typecheck` clean · `npm run evals` → **11/11**.
- Scoped: `onb4-claim.test.ts` 12/12 · `auth-scoping.test.ts` (landmine guard) 6/6.
