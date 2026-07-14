# AUDIT — Epic ONB, Stage 1 (ONB1, PR #244)

> Independent code/security audit of the ONB1 spine: the invite object, the server-side adapter
> registry, and the deployment-profile / config-bundle addendum (`docs/DESIGN-agent-onboarding.md` §8).
> The auditor did not build ONB1. Scope: `backend/src/services/{agent-invites,adapter-registry,deployment-profile,config-bundle}.ts`,
> `backend/src/routes/agent-invites.ts`, the `agent_invites` migration, the three ONB1 test suites, and the
> surfaces ONB1 touches (`index.ts` wiring, `middleware/audit-log.ts`, `web/lib/adapterProfile.ts`).
>
> Audited at `2506eab`. Fixes from this audit ship in the audit PR (see §5).

## VERDICT: **PASS-WITH-FIXES**

ONB1 is a genuinely conservative piece of security engineering and it is safe on main today: it wires
**no public join surface at all**, so none of the findings below is currently exploitable. There are
**no blockers**. ONB2 may start.

Two **HIGH** findings are latent — they are harmless while the join flow does not exist, and become
live defects the moment the story that consumes them lands. Both must be resolved **in or before**
the story named:

| # | Finding | Must be fixed before |
|---|---|---|
| **H1** | `consumeUsePatch` only *advises* a compare-and-set — nothing enforces it, and a read-then-write consume is a real TOCTOU race that lets two concurrent joins both spend a single-use invite's last use. | **ONB3** (the story that first consumes a use) |
| **H2** | The invite token is a **bearer credential carried in the URL path**. Any token-addressed route will have that raw token written verbatim into `audit_logs.path` and into the request log. | **ONB2** (the first story to serve a token-addressed route) — ✅ **FIXED in ONB2 (PR #246)**, see §7 |

---

## 1. Findings by severity

### BLOCKER

None.

### HIGH

#### H1 — `consumeUsePatch` advises a CAS but cannot enforce one; the single-use invariant is racy
`backend/src/services/agent-invites.ts:231` (`consumeUsePatch`)

The helper returns `{ usedCount: record.usedCount + 1, lastAcceptedAt }` and the doc-comment instructs the
route to "make the update conditional on `used_count = <the value it read>`". That instruction is not
enforceable by the type system, is not test-locked, and is one story away from being forgotten by a
different author.

**The race is real.** With a naive `read → compute → UPDATE … SET used_count = ?` (which is exactly what
`consumeUsePatch`'s return shape invites), two concurrent joins against a single-use invite both read
`used_count = 0`, both see `inviteStatus === 'active'`, both write `used_count = 1`, and **both join
requests are created**. On a public join endpoint that is a remotely-reachable bypass of invariant (2) —
a single-use door admits N agents. Turso/libSQL gives no serializable isolation to lean on here, and the
check (`isInviteUsable`) and the write are separated by a network round-trip.

**Required enforcement for ONB3 — the exact shape.** Do not read-then-write. Make the consume a single
atomic conditional UPDATE whose WHERE clause re-asserts *every* precondition, and treat "0 rows affected"
as the fail-closed `not_found`:

```ts
// ONB3 — consume one use. The WHERE clause IS the state machine: it re-checks
// revoked/expired/exhausted atomically with the write, so a lost race consumes nothing.
const res = await db.update(schema.agentInvites)
  .set({ usedCount: sql`${schema.agentInvites.usedCount} + 1`, lastAcceptedAt: now })
  .where(and(
    eq(schema.agentInvites.id, invite.id),
    isNull(schema.agentInvites.revokedAt),
    gt(schema.agentInvites.expiresAt, now),
    lt(schema.agentInvites.usedCount, schema.agentInvites.maxUses),   // ← the CAS
  ))

if (res.rowsAffected !== 1) {
  // Lost the race, or the invite was revoked/expired between lookup and write.
  // Collapse to the SAME flat 404 as unknown/expired/revoked — no oracle.
  return reply.code(404).send({ error: 'Not found' })
}
```

Three points that are not optional:
1. **`used_count = used_count + 1` in SQL**, never a value computed in Node — a client-computed value is
   the race.
2. **`used_count < max_uses` in the WHERE clause** is the compare-and-set. It is what makes a concurrent
   double-spend impossible rather than merely unlikely.
3. **The join request row must be created only after `rowsAffected === 1`**, in that order. Creating the
   join request first and consuming after re-opens the same hole.

Recommend ONB3 also *delete* `consumeUsePatch` rather than keep it: a helper that returns a
client-computed `usedCount` is a loaded gun, and its only correct use is not to use it. Replace it with a
`consumeInviteUse(db, invite, now)` service that owns the conditional UPDATE, so there is exactly one
consume path and it is the safe one.

#### H2 — the invite token is a bearer credential in the URL path; it will be logged verbatim
`backend/src/services/agent-invites.ts:273` (`inviteUrls`), with `backend/src/middleware/audit-log.ts:61` and `backend/src/index.ts:49`

`inviteUrls()` bakes the raw `mci_inv_*` token into the **path**: `/api/agent-invites/<token>`,
`…/onboarding`, `…/onboarding.txt`. ONB2 renders these into the onboarding document, and ONB3/ONB4 will
register routes at them.

The audit-log hook records **every** response with `path: req.url.split('?')[0]` — the query string is
stripped, the path is not. So the first token-addressed route ships a **live bearer credential written in
plaintext into the `audit_logs` table**, plus into Fastify's request log (`level: info` outside
production), plus into Fly's HTTP access logs. That is precisely the exposure the hash-only storage design
exists to prevent: the DB is supposed to yield no working invite links, and this puts working links back
into it, in a queryable table.

Mitigating context, honestly stated: the invite is a *door*, not a credential — walking through it buys a
row in an approval queue, never a token — and it is single-use with a 72 h TTL. The blast radius of a
leaked invite is "an attacker submits a join request that a human then declines". This is why it is HIGH
and not a blocker. But an invite is still the thing that gates who may *ask*, and a token in a log is a
token in a log.

**Recommended fix (pick one, in ONB2 — before the first token-addressed route exists):**
- **Preferred:** keep the token in the URL for the human-pastable doc link (it must be one clickable
  string), and **redact it at the log boundary**: in `audit-log.ts`, replace any path segment matching
  `/^mci_inv_[0-9a-f]{32}$/` with `:token` before persisting, and set Fastify's `redact`/`serializers` so
  `req.url` is scrubbed the same way. One regex, applied in both sinks, and add a test asserting an
  `mci_inv_` string never reaches `audit_logs.path`.
- **Alternative:** move the token to an `X-MC-Invite` header or the request body for the machine-facing
  join/claim calls, leaving only the *doc-fetch* route token-addressed. More surgery, strictly safer.

Whichever is chosen, ONB2 should also treat the invite as a token in every other sink it adds
(no console.log of the URL, no error message echoing the path).

### MEDIUM

#### M1 — the new routes were in neither guard suite  ✅ **FIXED in this audit**
`backend/src/tests/boot.test.ts`, `backend/src/tests/auth-scoping.test.ts`

`agentInviteRoutes` / `adapterRegistryRoutes` were registered in `index.ts` but in **neither**
`boot.test.ts` (the duplicate-route guard that exists because a route collision took prod down on
2026-07-01) nor `auth-scoping.test.ts` (the MCA-85 guard that asserts no `:orgId`-scoped route is
publicly reachable). The claim "the only public route is `GET /api/adapters`" was therefore true only by
inspection — nothing failed if a future edit registered an invite route in the public scope.

Fixed: both suites now register the ONB routes, so the invite routes are covered by the existing leak
guard, plus two new explicit tests (see §5).

#### M2 — `toRecord` failed OPEN on a corrupt allow-list  ✅ **FIXED in this audit**
`backend/src/routes/agent-invites.ts:41` (as merged)

```ts
try {
  const parsed = JSON.parse(row.allowedAdapterTypes)
  if (Array.isArray(parsed)) allowed = parsed.map(String)
} catch { allowed = null }      // ← null means "ANY joinable adapter"
```

`null` is not a neutral value in this record — it is the *widest* value: `checkInviteAccepts` reads
`record.allowedAdapterTypes && !includes(...)`, so `null` means **any invitable+available adapter may walk
through**. A corrupt, truncated, or non-array `allowed_adapter_types` column therefore silently *widened*
an invite the operator had deliberately narrowed to (say) `['cursor']` into an invite that accepts
`openclaw_local` — which `executesHostCommands`. A parse failure must never relax a restriction.

Fixed with a tested pure helper `parseAllowedAdapterTypes()` in the service: absent/empty → `null` ("never
restricted"); corrupt / non-array / empty-array → `[]`, an allow-list that admits **nothing**, so the
invite is inert until re-created. Test asserts the deny-all list actually denies.

#### M3 — `validateConfigBundle` accepts a bundle that lies about the invariants, and one that turns adapters ON
`backend/src/services/config-bundle.ts:148`

The bundle restates the four invariants "so an importing machine can *verify* it agrees with them rather
than assume" (§8.3) — but `validateConfigBundle` never actually verifies them. It checks the version, that
`deployment` exists, and `assertNoSecrets`, then returns `raw as ConfigBundle`. A hand-edited bundle
carrying `onboarding.invariants.operatorCanSeeClaimedKey: true`, `publicJoinEnabled: true`, or
`adapterAvailability: { hermes_gateway: true, http_webhook: true }` validates clean.

Nothing *applies* a bundle today, so this is inert — but Epic H's H4 ("fresh-machine config/secret
bootstrap") is the story that will apply one, and the bundle is an **importable file**, i.e. attacker-
adjacent input.

**Recommend, before H4 (or ONB6, whichever applies a bundle first):**
- Reject any bundle whose `deployment.onboarding.invariants` disagree with this build's constants
  (`REQUIRE_HUMAN_APPROVAL`, `INVITES_SINGLE_USE_BY_DEFAULT`, `INVITE_AGENTS_ALWAYS_LOW_TRUST`,
  `operatorCanSeeClaimedKey === false`). The design says "verify rather than assume" — write the verify.
- Treat `publicJoinEnabled` in an imported bundle as **advisory only**: the applying machine must always
  re-derive it from `onboardingPosture(env)`, never adopt the value from the file.
- Constrain `adapterAvailability` to a **one-way ratchet**: it may turn an adapter **off**, never on. The
  registry's `available: false` entries are unavailable because the dispatch half is *not built*; a config
  file must not be able to claim otherwise.

#### M4 — `assertNoSecrets` inspects keys, never values
`backend/src/services/config-bundle.ts:74`

The detector is good (token-based, catches `apiKey`/`x-openclaw-token`/`webhookAuthHeader`, leaves
`sessionKeyStrategy` alone) but it only walks **key names**. A bundle carrying
`{ model: "sk-live-abc…" }` or `{ mcApiUrl: "https://u:mca_…@host" }` passes the "hard throw" untouched.
The guarantee "secrets are never in the bundle" is enforced against *well-named* secrets only.

**Recommend:** add a value scan alongside the key scan — throw on any string value matching the credential
prefixes this system actually mints (`mca_`, `mci_inv_`, `art_`) plus the common vendor shapes (`sk-`,
`ghp_`, `xox[baprs]-`). Narrow prefixes, so the false-positive risk is negligible, and it closes the gap
between what the doc promises and what the code checks.

#### M5 — the two sources of truth already disagree on a safety default (`allowShell`)
`web/lib/adapterProfile.ts:40` vs `backend/src/services/adapter-registry.ts:104`

This is the concrete harm behind flagged item (c), and it is not hypothetical:

| Source | `openclaw` shell execution |
|---|---|
| Server registry (`adapter-registry.ts:104`) | `allowShell` **default `false`** — *"Off unless the operator opts in."* |
| Web wizard (`adapterProfile.ts:40`) | emits **`MC_ALLOW_SHELL=1`** in the copy-paste `mc.env` |

The wizard is the source that produces what an operator actually pastes onto a host, so **today, shell
execution is on by default** for every OpenClaw agent onboarded through the UI, while the new registry
declares the opposite as an intentional safety default. Whichever is right, they cannot both be.

Note this is **pre-existing** (CC4, not introduced by ONB1) — but ONB1 is what makes the contradiction
visible, and consolidating the two is exactly what ONB6 is for. Flipping the wizard to `MC_ALLOW_SHELL=0`
changes what shipped operators paste and may break the live ops agent, so this is a **product call, not an
audit fix** — see the ruling in §3(c).

#### M6 — ONB1's own acceptance criterion is not met (and the doc does not say so)
`docs/DESIGN-agent-onboarding.md:334`

The ONB1 acceptance row reads: *"Registry is the single source of truth; `adapterProfile.ts` renders
**from** it."* The second clause did not ship — `adapterProfile.ts` is untouched and still hardcodes its
own table. Everything else in that row shipped and is verified. Deferring the refactor is the right call
(see §3(c)), but the design doc should record the deferral against ONB6 rather than leave a shipped story
carrying an unmet acceptance criterion.

### LOW / NIT

| # | Finding | File | Status |
|---|---|---|---|
| L1 | `inviteStatus` imported but never used in the route module. | `routes/agent-invites.ts:23` | ✅ **Fixed** |
| L2 | The migration wraps `CREATE TABLE` + both `CREATE INDEX` in one `try {} catch {}`. If the CREATE TABLE throws for any transient reason, the **unique** index on `token_hash` — a security control (no two invites share a door) — is silently skipped along with it. Splitting the unique index into its own `try` costs one line. Matches the file's existing convention, so: recommend, don't mandate. | `db/setup.ts:186` | Recommendation |
| L3 | `GET …/agent-invites` returns every invite an org has ever created, unbounded and unpaginated. Fine at today's scale; add a `limit` when the UI lands (ONB6). | `routes/agent-invites.ts:109` | Recommendation |
| L4 | `createdBy: (req as any).auth?.userId ?? 'unknown'` — unreachable behind Clerk + `requireOrgRole('owner')` (both 401 first), but an invite whose creator is literally `'unknown'` is a bad audit record. Prefer failing. | `routes/agent-invites.ts:76` | Recommendation |
| L5 | A malformed request body makes `CreateInviteBody.parse` throw a `ZodError`, which has no `statusCode`, so the global error handler returns **500** where 400 is meant. Repo-wide convention, not an ONB1 regression — noted for the eventual global fix. | `index.ts:212` | Recommendation |
| L6 | `isSecretShapedKey` deliberately excludes the bare token `key` (to spare `sessionKeyStrategy`), so `sshKey` / `licenseKey` are not detected. Correct trade-off — the registry's *allowlist* refuses any undeclared key anyway, so the payload path is covered regardless. No action; recorded so a future reader doesn't "fix" it into a false-positive machine. | `config-bundle.ts:55` | Accepted |

---

## 2. Verified clean

Each of these was checked against the code, not against the PR description.

**Invite object / credential handling**
- **Hash-only storage.** `createInvite` stores `hashToken(token)` and the raw token exists only in the
  create response; the `InviteRecord` provably never carries it (test asserts the token is absent from
  `JSON.stringify(record)`). Reuses `hashToken`/`hashesEqual` from `arturita-session` rather than
  re-implementing — no drift.
- **Shown once, unrecoverable.** The raw token crosses the wire exactly once (`routes:98`). No route,
  view, or log can re-read it. `inviteView` omits both the token and its hash (test-locked).
- **128-bit entropy**, `mci_inv_` prefixed, shape-validated *before* a DB round-trip
  (`isInviteTokenShaped`) so attacker input is neither hashed nor queried on a malformed token.
- **No enumeration oracle.** `checkInviteAccepts` collapses unknown/expired/revoked/exhausted into one
  identical `publicReason: 'not_found'`; the specific reason stays internal for the audit log. Test-locked
  across all three states. `adapter_not_allowed` is correctly treated as a *different* class (the caller
  already holds a valid invite, so telling them leaks nothing).
- **Out-of-range TTL/uses are refused, not clamped** — a security control that silently adjusts is a
  security control that surprises. Test-locked for `expiresInHours ≤ 0`, `> 168`, `maxUses` `0`/`1.5`/`> 50`,
  oversized message, empty allow-list.
- **State machine precedence** `revoked > expired > accepted > active` is computed, never stored — it
  cannot go stale. Revocation always wins, even on an expired+exhausted invite (test-locked).
- **Revoke is idempotent** and org-scoped (`and(id, orgId)`), so a cross-org invite id 404s.

**Owner-gating / route surface**
- Create, list, revoke and `onboarding-posture` are all inside the Clerk `secured` scope **and** carry
  `preHandler: requireOrgRole('owner')`. Confirmed at `index.ts:118` and per-route.
- `GET /api/adapters` is the **only** public route added, and it is genuinely safe to be: static,
  org-agnostic, no tenant data. Secret *field names* appear; no values (test asserts nothing
  token-shaped is in the payload).
- **Nothing of join/claim is wired.** No public join endpoint, no join request, no claim, no token
  minting exists anywhere in the tree. Verified by grep and now by a new test (§5).
- The create response's `inviteToken` is **not** logged: the audit-log hook sanitizes the *request* body
  only and never records responses. (The *path* is a separate problem — H2.)

**The four invariants**
1. **Public join off / profile-gated.** `onboardingPosture()` is closed in every profile because
   `PUBLIC_JOIN_IMPLEMENTED === false`, and `MC_ENABLE_REMOTE_ONBOARDING=1` alone cannot open it
   (test-locked). `resolveDeploymentProfile` safe-defaults to **`hosted`** — the harder posture — for
   unset, empty, and garbage values (`'local_trusted'` → `hosted`, test-locked). Case/whitespace handled.
2. **Single-use default.** `DEFAULT_MAX_USES === 1`, asserted both directly and via the posture
   (`invitesSingleUseByDefault`). Multi-use is an explicit, bounded (≤ 50) per-invite opt-in.
   *(Enforcement of the consume is H1 — the default is clean, the spend is not yet.)*
3. **Universal `low_trust_review`.** `INVITE_AGENTS_ALWAYS_LOW_TRUST === true` and is surfaced through the
   posture and the bundle. Correctly a constant with no consumer yet — no agent is created from an invite
   until ONB3. **ONB3 must derive the trust level from this constant**, not re-decide it per runtime; that
   is the story where this invariant becomes enforceable, and it needs its own test.
4. **Token never operator-visible.** `operatorCanSeeClaimedKey: false` is a literal type (`false`, not
   `boolean`) — a future edit trying to set it true is a **compile error**, which is stronger than a test.
   Also restated in the config bundle so an importing machine carries the same posture.

**The `claude_code` autonomy tripwire — confirmed working**
- `permissionMode` enum is `['plan', 'acceptEdits']`, default `'plan'`. The enum **cannot express
  autonomy**: no `bypassPermissions`, no `dangerously-skip-permissions`, no `auto`.
- The tripwire test (`adapter-registry.test.ts:60`) asserts no enum value matches `/auto|bypass|yolo|dangerous/i`
  — so a future edit adding an autonomous value **fails the suite**. Verified the test actually fails when
  such a value is added (checked by inspection of the regex against `bypassPermissions`, `acceptEdits`).
- `validateDefaultsPayload('claude_code', { permissionMode: 'bypassPermissions' })` is refused by the enum
  check. Onboarding is not a back door around CC6's two host guards or the CC5 denylist.
- `openclaw_local.allowShell` defaults to `false` in the registry (though see M5 for the wizard).

**Payload validation (`validateDefaultsPayload`) — fail-closed by construction**
- **Allowlist, not sanitize**: any key not in the adapter's declared field list is refused.
- **Declared secrets route to `secrets`**, never to `config` — test asserts `sk-live-xyz` does not appear
  anywhere in the returned config. No secret field carries a default (test-locked across the whole
  registry: "we never invent a credential").
- **Undeclared secret-shaped keys are refused loudly**, not dropped quietly — the right call: a silently
  dropped credential is a credential the joining agent believes it configured.
- `__proto__` / `constructor` / `prototype` refused at top level **and** inside `object`-typed fields;
  prototype pollution test asserts `({}).polluted === undefined`.
- Size (8 KB), key-count (40), string-length (2000), type and enum caps all enforced and tested.
- Unknown / non-invitable (`internal`) / declared-but-unavailable adapter types all refused with distinct
  internal reasons.
- A refused payload yields **nothing at all** (`config: {}`, `secrets: {}`) — no partial application.

**Config bundle**
- `assertNoSecrets` is a hard **throw**, not a warning, and runs on both build and validate. Walks arrays
  and nested objects. (Keys only — M4.)
- One detector shared by the bundle and the registry, so the bundle rule and the payload rule cannot drift.
- Version check refuses a bundle newer than the build understands.

**Conventions**
- Pure services / thin routes: every decision (state machine, validation, posture) lives in a pure,
  injectable-`now` service; the route layer does DB + HTTP only. No `src/routes/` import inside
  `src/services/`.
- Migration is idempotent (`CREATE TABLE IF NOT EXISTS` + `IF NOT EXISTS` indexes), backfills nothing,
  touches no existing table, and adds a **unique** index on `token_hash` so a duplicate mint is a hard
  failure rather than two invites sharing one door. The legacy `agents.runtime` column and its enum are
  untouched — the registry maps onto it (test-locked for every adapter).
- Every new function has a unit test in `src/tests/` (Node built-in runner). No new npm packages.
- **No secret in tree or history**: scanned the ONB1 diff for `mci_inv_*`/`mca_*`/`sk-*` shaped strings —
  clean. Registry examples use explicit `<sent once; stored encrypted>` placeholders.
- No UI shipped in ONB1, so no colorblind/token surface to audit.

---

## 3. Rulings on the three flagged items

### (a) `consumeUsePatch` only *advises* a compare-and-set — is there a real race?

**Yes. Real, and it defeats invariant (2).** Ruled **HIGH**, must be fixed in ONB3. Two concurrent joins
both read `used_count = 0` on a single-use invite, both pass `isInviteUsable`, both write `1`, and both
are admitted. Full analysis and the exact required enforcement — a single conditional UPDATE with
`used_count < max_uses` in the WHERE clause, `used_count = used_count + 1` computed in SQL,
`rowsAffected !== 1` → the same flat 404 — are in **H1** above. ONB3 should delete `consumeUsePatch` and
replace it with a service that owns the atomic consume, so the unsafe path stops existing.

It is not a blocker *today* only because nothing calls it.

### (b) `PUBLIC_JOIN_IMPLEMENTED` is a hand-maintained constant — landmine?

**Partly. It is sound as a belt, but it was not a brace — and it is now.** Ruled **MEDIUM, mitigated in
this audit.**

The constant is *good* defence-in-depth: it is the reason `MC_ENABLE_REMOTE_ONBOARDING=1` cannot open a
door that does not exist, and `onboardingPosture` reports it honestly through `closedBecause`. The
landmine is not that it might be flipped to `true` too early — it is that **nothing connected the constant
to reality**. It is a *promise* that no join surface exists. If a future PR registers a join route and
forgets to flip it, the posture keeps cheerfully reporting `publicJoinEnabled: false` while an
unauthenticated join endpoint is live — the config lies, and every operator surface reads the lie.

The safer guard is not a different constant; it is to make the constant **checkable**. Shipped in this
audit (`auth-scoping.test.ts`): while `PUBLIC_JOIN_IMPLEMENTED === false`, **no join/claim route may be
registered in any scope** — the suite boots the real app wiring and fails if one appears. The constant now
*enforces* rather than *promises*, and the failure message tells the ONB4 author exactly what to do (land
the approval gate + one-time claim + per-IP rate limit, then flip it in that PR).

Recommended for ONB4, in addition: the join route must call `onboardingPosture(process.env)` **at request
time** and 404 when `publicJoinEnabled` is false. Belt (constant) + brace (test) + runtime check — a
boot-time-only guard is one hot-reload away from being wrong.

### (c) `adapterProfile.ts` is still a second client-side source of truth until ONB6 — acceptable?

**The deferral is acceptable. The drift it is currently hiding is not.** Ruled: **acceptable deferral for
the refactor (ONB6), with one contradiction that needs a product decision now.**

Why the deferral is fine: `adapterProfile.ts` is a *rendering* helper for the existing manual Hire/Add-Agent
wizard. It is not a validation authority — nothing server-side trusts it, and the registry is already the
sole authority for anything a joining agent submits (`validateDefaultsPayload`). The two can coexist
safely for one epic, and folding the wizard onto `GET /api/adapters` is exactly ONB6's job. Forcing it
into ONB1 would have meant a web refactor inside a backend-spine story.

Why it is not free: the two sources **already disagree on a safety default** (M5). The registry says
`allowShell` is off by default; the wizard emits `MC_ALLOW_SHELL=1`. The wizard is the one that produces
what an operator actually pastes onto a host, so the shipped behaviour is the *less safe* of the two,
while the new code documents the safer one as intentional. That is the precise failure mode a second
source of truth creates, and it is worth naming before it compounds.

Required (not optional) for ONB6: `adapterProfile.ts` must render **from** `GET /api/adapters`, and the
`allowShell` / `MC_ALLOW_SHELL` contradiction must be resolved **deliberately** — decide which default is
right and make both sides say it. **This audit does not change the wizard's shell default**: flipping
`MC_ALLOW_SHELL` to `0` changes what already-onboarded operators paste and could break the live OpenClaw
ops agent. That is a product call for the operator, not an auditor's unilateral fix. Until ONB6, treat the
registry's `allowShell: false` as *aspirational*, not as a description of what ships.

---

## 4. Test coverage assessment

**Strong** where it matters. The suites are genuinely invariant-locking rather than
coverage-padding — the hash-only test asserts the token is absent from the serialized record, the oracle
test asserts all three closed states return the *same* public reason, the tripwire test would fail on a
future autonomous enum value, and `operatorCanSeeClaimedKey: false` is enforced by the *type system*.
`refuses out-of-range inputs rather than silently clamping them` and `a refused payload yields nothing at
all` are the kind of assertions that catch real regressions.

Gaps found, and their disposition:

| Gap | Severity | Disposition |
|---|---|---|
| The new routes were in neither `boot.test.ts` nor `auth-scoping.test.ts` — the "only public route is `GET /api/adapters`" claim was untested. | Medium | ✅ Fixed (M1) |
| Nothing asserted that no join/claim route exists while `PUBLIC_JOIN_IMPLEMENTED` is false. | Medium | ✅ Fixed (§3b) |
| `toRecord`'s allow-list parse was untested — and failed open. | Medium | ✅ Fixed (M2) |
| No route-level (`app.inject`) test of owner-gating on create/list/revoke. The `requireOrgRole('owner')` preHandler is present and the MCA-85 guard now proves the routes are Clerk-scoped, but "a *member* gets 403" is asserted nowhere. | Low | Recommended for ONB6 (needs a DB fixture; the existing suites avoid DB) |
| The atomic-consume contract (H1) is untestable until ONB3 writes it. | — | **ONB3 must ship a concurrency test**: fire two consumes at one single-use invite, assert exactly one wins. |
| No test asserts an `mci_inv_` token never reaches `audit_logs.path` (H2). | — | ONB2, with the fix. |

---

## 5. What this audit fixed

Shipped in the audit PR (backend `1134/1134` tests, `11/11` evals, typecheck clean):

1. **`parseAllowedAdapterTypes()`** — new tested pure helper in `services/agent-invites.ts`; the route's
   `toRecord` now fails **closed** on a corrupt allow-list (deny-all) instead of widening the invite to
   "any adapter" (M2). Seven corrupt-input cases tested, each asserting the resulting list actually denies.
2. **`boot.test.ts`** — registers `agentInviteRoutes` + `adapterRegistryRoutes`, so the ONB routes are
   inside the route-collision guard that exists because a collision took prod down once (M1).
3. **`auth-scoping.test.ts`** — registers both route groups, bringing the invite routes under the MCA-85
   public-leak guard, plus two new tests:
   - the four invite routes are **Clerk-secured**, `GET /api/adapters` is the **only** public onboarding
     route, and no route matching `agent-invite|onboarding|/join|/claim` is public;
   - while `PUBLIC_JOIN_IMPLEMENTED === false`, **no join/claim route is registered at all** — the
     landmine guard from §3(b).
4. **Dropped an unused import** (`inviteStatus`) from the route module (L1).

Deliberately **not** fixed here (design/product calls, left as recommendations): H1, H2, M3, M4, M5, M6,
and the L-series. None of them was worked around by weakening an invariant.

---

## 6. Summary for the ONB2 author

You are clear to start. Three things to carry into your story:

1. **H2 is yours.** ONB2 serves the first token-addressed route. Redact `mci_inv_*` out of
   `audit_logs.path` and the request log *in the same PR*, with a test.
2. The onboarding doc renders from `GET /api/adapters` — the registry is the source of truth for the
   payload contract. Do not re-describe adapters in ONB2; read the table.
3. The operator-supplied invite `message` will be echoed into a document a not-yet-trusted agent fetches.
   It is owner-authored (low risk) but treat it as untrusted content on the way out: escape it, and don't
   let it inject instructions into the pastable prompt.

And for ONB3: **H1**, plus a concurrency test, plus derive `low_trust_review` from
`INVITE_AGENTS_ALWAYS_LOW_TRUST` rather than re-deciding it per runtime.

---

## 7. ONB2 follow-up (2026-07-14, PR #246) — what the ONB2 author did with this audit

**H2 — CLOSED.** ONB2 serves the first token-addressed route (`GET /api/agent-invites/:token/onboarding[.txt]`),
so the fix shipped in the same PR, taking the audit's *preferred* option:

- Pure `backend/src/services/log-redaction.ts` — `redactPath()` replaces any credential-shaped **path
  segment** (`mci_inv_*`, `mca_*`, `art_*`, plus `mcc_*`, reserved for ONB4's claim secret so that story
  inherits the redaction for free) with `:token`; `redactTokensInText()` does the same inside free text.
- Applied in **both sinks**, from the one helper, so they cannot drift: `middleware/audit-log.ts` now builds
  its row through a pure `buildAuditRow()` that redacts the path *before* it is used at all (not even the
  derived `action` sees the raw URL), and `src/index.ts` sets a Fastify `req` **log serializer** that
  redacts `req.url` the same way.
- **Tests:** the pure helper (positive + negative: an ordinary path is never mangled), `buildAuditRow`
  (`JSON.stringify(row)` contains no `mci_inv_` at all), and an **end-to-end** test that drives the real
  token-addressed route through real Fastify routing with a real token in the URL and asserts the persisted
  row's `path` is `/api/agent-invites/:token/onboarding.txt`.

**NEW FINDING, pre-existing, out of ONB1's scope — the audit-log hook never fires in production.**
`auditLogPlugin` adds its `onResponse` hook **inside its own encapsulated plugin scope** (`src/index.ts:148`),
and every route group is registered in a *sibling* scope. A Fastify hook added in an encapsulated context
applies only to that context and its **descendants** — never to its siblings. Verified empirically. So
`audit_logs` receives **no rows at all** for any route today, and has not since the plugin was written.

Two consequences, stated plainly:

1. The **audit trail is a no-op** — a compliance-relevant gap that has nothing to do with Epic ONB.
2. It means H2's exposure was latent for a second reason nobody had noticed. The redaction above is
   nonetheless a **prerequisite** for fixing the wiring: the moment the hook is made to fire, every
   token-addressed request would otherwise write a working invite link into a queryable table.

**Deliberately not fixed in ONB2.** Correcting the wiring (wrapping the plugin so its hook applies app-wide)
turns on a **DB insert per request** against Turso on the live backend — a cost/latency/PII change to a
running system, and an operator call, not a build-agent one. It is flagged here, in `STATUS.md` and in
`HANDOFF.md`, with the fix pre-staged: the redaction is in place, so switching the audit log on is now a
one-line wiring change that is safe by construction.

**Left untouched, as instructed:** the `allowShell` / `MC_ALLOW_SHELL` contradiction (M5) — still a pending
operator product decision, still flagged, still unchanged.
