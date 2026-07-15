# Security posture — Mission Control

One place to see the security model a reviewer or operator would otherwise have to
reconstruct from a dozen audit reports. Each claim below is established by an
independent audit (auditor did not build the thing they audited) and locked by tests
in the merge invariant (**1263 backend tests · 11/11 evals · typecheck clean** as of
2026-07-15). This is a summary, not the source of truth — the audits are.

Owner: Arturito · Last updated: 2026-07-15 (Epic ONB Stage 7) · Companion to `GO-LIVE.md`, `docs/RUNBOOK-agent-onboarding.md`

---

## 1. The stage → audit protocol (how we got confidence)

Every security-relevant story ships, then **stops for an independent audit** by a
separate session that did not write it. The audit produces a verdict
(`PASS` / `PASS-WITH-FIXES` / `NEEDS-FIXES`), and any fixes land before the next
stage starts. This is why several findings below read "fixed one layer short, then
re-audited and closed" — the protocol is designed to catch exactly that. The audit
docs (`docs/AUDIT-*.md`) are the durable record; each names its red-proof (disable
the fix → which tests go red).

---

## 2. Agent onboarding — the inverted token lifecycle

**The load-bearing idea:** self-describe *first*, a human approves *second*, the
credential is minted and claimed *last* — by the party that will use it, never through
the operator's clipboard. This is strictly safer than the legacy model, where
`7ei-mc onboard` mints a token *before* any human decision.

- **No credential exists before approval.** `POST …/join` creates a row in the
  owner's approval queue and returns `{ requestId, claimPath, claimSecret }` — never
  an agent token. Proven against a real DB: after a join, the `agents` table is empty.
- **The claim is minted once, under two atomic compare-and-set statements**, stored
  **hash-only** on the agent, matched with a **constant-time compare**. A concurrency
  test proves two simultaneous claims yield exactly one token.
- **The raw token crosses the wire exactly once, to the claimer.** Never persisted
  plaintext, never logged (`mcc_`/`mca_` redacted before persistence in both the audit
  path and the request-log serializer), never in an operator UI
  (`operatorCanSeeClaimedKey` is literal `false`).
- **No enumeration oracle.** Every failure — unknown/expired/revoked/exhausted invite,
  not-approved, wrong secret, already-claimed, lost race, missing agent row — collapses
  to **one identical flat 404**.
- **No free-text field in the join body.** `.strict()` Zod, an allow-listed capability
  enum (never prose, never empty — empty = allow-all in governance), a charset-restricted
  name, and `agentDefaultsPayload` validated field-by-field against the registry. A
  third-party secret in free text could reach `audit_logs.metadata`, so no such field
  exists.

### The four ONB invariants (operator-locked defaults, not switches — each test-locked)

1. **Public join is OFF by default**, gated by deployment profile. Packaged =
   loopback-trusted; hosted = requires an explicit `MC_ENABLE_REMOTE_ONBOARDING` **plus**
   full hardening. No env var can open the join surface before the controls that make it
   safe exist (the hardening checklist is *computed*, not asserted).
2. **Invites are SINGLE-USE by default** (multi-use is an explicit, bounded opt-in — we
   invert Paperclip's default).
3. **Every invite-created agent lands in `low_trust_review` regardless of runtime** —
   *more* contained than one created by the Add-Agent wizard.
4. **The raw claimed token is never shown in the UI or the clipboard** — only the
   claiming agent reads it, once, from the raw HTTP response.

---

## 3. Low trust by default

- **Invite-onboarded agents are `low_trust_review` regardless of runtime** (ONB invariant
  #3). The invite gate **stacks in front of** the A2 dangerous-action gate and P1
  containment — it softens nothing.
- **Code executors register contained** (`secureRegistration`, CC3): `claude_code` gets
  `low_trust_review` + an **explicit non-empty** capability list (the empty-list =
  allow-all footgun is closed) + a `trust_boundary` seeded from the target workspace.
- **The registry never hands out an autonomous default.** `claude_code.permissionMode`
  defaults to `plan` (propose-and-approve) and the enum cannot express autonomy — a
  tripwire test locks it. Onboarding is not a back door around the CC6 host guards.

---

## 4. Multi-tenant isolation — the membership gate + leak-guard

**The gap the ONB audits kept surfacing:** the whole `/api/orgs/:orgId/*` surface was
Clerk-*authenticated* but not membership-*checked* — any logged-in user could act on any
org by swapping `:orgId` or a record id. Closed in two stages (R-4, then HIGH-1),
surface-wide and fail-closed.

- **One scope-level gate.** `requireOrgMembership` (`middleware/rbac.ts`) is a
  `preHandler` on the whole Clerk-secured scope. It enforces baseline `member` for the
  org each request targets — resolved from `:orgId`, from the `:agentId`/`:taskId`
  record, or from **14 route-prefix→owning-table** entries (`RECORD_ORG_ROUTES`) for the
  ~25 top-level record routes whose org lives in another param (`:projectId`, `:itemId`,
  generic `:id` for secrets/webhooks/policies/…). Because it rides the scope, a **new org
  route is covered the moment it registers**.
- **Fail-closed.** A missing or foreign record → 403, never a skip.
- **Grandfathered.** `enforceOrgRole` honours `organisations.ownerId` as an implicit
  owner, so existing owners keep full access with zero migration; only a genuine
  non-member/wrong-org request newly 403s. No path lets a non-owner set `ownerId`
  (`PATCH /api/orgs/:orgId` strips it).
- **Leak-guard with teeth.** `membership-scoping.test.ts` is an allow-list-negation sweep
  over **all** secured routes: each must resolve an org or be on a short justified EXEMPT
  allowlist; a new secured route resolving unscoped-and-unlisted **fails CI**. Red-proof:
  disabling the fix reds four tests. The guard's boot mirrors `index.ts` — the missing
  `webhookRoutes` registration was the blind spot that hid the webhook leak.
- **Flagged, by design:** global-library skills (`skills.orgId` null) stand down (a shared
  library, not a tenant record); per-org skills are gated. The agent-token API
  (`/api/agent/*`) is a separate token-authed scope, proven unaffected. Object-level
  scoping (a member reading a foreign record *within* their own org path) is a separate
  authz concern, still open.

### 4a. Packaged-profile identity — the loopback local operator (Epic H / H6)

The membership gate above authenticates hosted callers with Clerk. A **packaged** `.dmg`
instance is single-tenant on `127.0.0.1` and ships **no Clerk keys**, so H6 replaces the
*identity source* — and only the identity source — with a single local operator. The gate
itself is untouched.

- **Profile-branched auth hook, same gate.** `index.ts` installs
  `profile === 'packaged' ? loopbackAuth : clerkAuth` on the **same** secured scope. Both
  attach the identical `req.auth.userId`, so `requireOrgMembership`, `requireOrgRole`, and
  the audit/telemetry hooks run **unchanged**. Hosted resolves to `clerkAuth` (the
  safe-default profile) → byte-identical.
- **The identity is OS-user-bound (H-Q6).** `loopbackAuth` (`middleware/loopback-auth.ts`)
  authenticates a request AS the `local-operator` iff it presents the per-install
  `MC_LOOPBACK_SESSION_SECRET` (constant-time compared, no length/timing oracle). That
  secret lives in the **macOS login Keychain** (readable only in the logged-in user's
  session) and is injected by the Electron shell as the `Authorization` bearer on every
  window→backend request — **never in page JS**. A request without it **401s**: a second OS
  account, a browser tab that never got the header, a stray localhost caller. **Not "no
  auth" — a single-operator local identity.**
- **A real owner, not a bypass.** `services/loopback-identity.ts` idempotently seeds the one
  local org owned by `local-operator` (+ owner `org_members` row), so the operator passes
  the **same** membership/owner-checked write routes (secrets, connectors, invites, …) a
  Clerk owner passes on hosted. The packaged app is not open-on-loopback.
- **Fail-closed secrets (AUDIT-H1 #1/#2/#4).** Per-install `SECRETS_ENC_KEY` /
  `RUN_TOKEN_SECRET` / `MC_LOOPBACK_SESSION_SECRET` are generated into the Keychain (three
  distinct keys, never the source default). `services/secret-keys.ts` `assertSecretKeysSafe()`
  **refuses to boot** a packaged instance on any missing/default/reused key — so no real
  secret is ever encrypted under a world-readable default. No-op on hosted.
- **Verification-gated (honest flag):** the full built-app round-trip (Keychain under a
  signed `.app`, the injected-header flow in a live BrowserWindow) is confirmed by the H6
  audit on a built run — the same non-interactive limit as H1's sign/notarize. The backend
  auth + fail-closed logic is covered by real-DB tests (`loopback-auth`/`secret-keys.test.ts`).

---

## 5. The audit trail

- **On, for the sensitive half only.** Every mutating method (POST/PUT/PATCH/DELETE)
  plus the onboarding/invite/join/approval surfaces are recorded; the read-only GET
  dashboard-poll flood is skipped by construction (`shouldAudit`). High-frequency
  agent-runtime writes (heartbeat / run-log / messages) are excluded so the daily insert
  rate is bounded away from the heartbeat cadence.
- **Fire-and-forget.** One `.catch()`-swallowed Turso INSERT per sensitive request — it
  can never add latency to or fail the request it records.
- **Bounded retention.** Rows older than `MC_AUDIT_RETENTION_DAYS` (default **90**;
  junk/0/negative/sub-one-day safe-defaults to 90 so a typo can't wipe the table) are
  pruned on a daily scheduler tick.
- **Redaction is registry-driven, at every sink.** `sanitizeBody` recurses (depth-capped)
  and redacts against `allSecretFieldKeys()` — the adapter registry is the source of
  truth, so a new adapter's declared secret is redacted the moment it is *declared*. The
  path is redacted to `:token` before persistence. Proven end-to-end through the live
  hook: a join carrying a nested `apiKey` + a registry `webhookAuthHeader` bearer + a
  token in the path persists a row with no secret anywhere.
- **Reads are owner-gated + tenant-isolated.** `GET /api/orgs/:orgId/{audit-log,traces}`
  are Clerk + `requireOrgRole('owner')`; the traces route was re-scoped from a bare
  `/api/traces` (authenticated but cross-tenant) to an org-filtered one.
- **Telemetry left OFF** — a separate concern (in-memory span ring buffer, no Turso
  writes); enabling it is its own operator call.

---

## 6. Fail-closed patterns (the recurring discipline)

- **Onboarding failures → one flat 404** (no oracle).
- **Membership resolution → 403 on any unresolved/foreign record** (never a skip).
- **Secret-shaped undeclared keys → refused loudly**, never dropped quietly.
- **Unknown approval type → owner-required** (data-driven role, fail-closed).
- **Unknown shell command → gated** (`cc-denylist`: deny > allow > gate; unknown ⇒ gated).
- **Autonomous host exec → collapses to plan mode** if any of its three preconditions is
  missing.
- **Deployment profile unset → resolves to `hosted`** (the harder posture).
- **Retention env junk → 90 days** (never 0 → never a table wipe).

---

## 7. Wallet — no custody until explicitly enabled

- **Read / prepare / simulate only in what's shipped** — never sign, no key custody in
  the shipped code path.
- **Policy engine + fail-closed signing gate** (E2): autonomous signing is bounded
  (**< $100** per-tx from a dedicated capped burner; **≥ $100 → A2 approval**).
- **Mainnet is OFF; testnet-only.** Mainnet signing sits behind an explicit go flag and
  is not shipped. No mainnet signing, no key in code, no irreversible on-chain action
  today — every dangerous path stays behind the A2 gate. (See `GO-LIVE.md` for how to
  enable, and `docs/WALLET-KEYSTORE-arturita.md`.)

---

## 8. Machine-exec / shell posture

- **Shell OFF by default for new agents** (audit M5). The wizard/run-block emits
  `MC_ALLOW_SHELL=0` to match the registry's `allowShell: false`; an operator opts in via
  an advanced, off-by-default checkbox.
- **Enforcement is client-side** — the adapter's local `MC_ALLOW_SHELL` decides; **no
  server gate reads a stored `allowShell`.** So the default change cannot retroactively
  disable a running agent, and existing agents (incl. the live OpenClaw ops agent) are
  **grandfathered** with zero touch.
- **Claude Code host exec is propose-and-approve.** Shell/destructive ops surface as A2
  `machine_exec` approvals with **verbatim argv** + step-up; nothing runs un-approved.
  Autonomous exec is OFF by default, fail-closed behind two operator guards + the CC5
  command denylist (catastrophic/privilege/exfil/reverse-shell **refused**; unknown
  **proposed**; only allow-listed read-only commands run un-attended).
- **The local host daemon (Arturita C1)** is localhost+token, real read/preview/undo,
  destructive fail-closed behind the A2 `approved` flag, with a whole-machine root +
  self-protection denylist.

---

## 9. Cross-cutting credential handling

- **Secrets at rest:** AES-256-GCM (`SECRETS_ENC_KEY`); run-tokens HMAC
  (`RUN_TOKEN_SECRET`). Both **must be set on Fly** before storing any real secret —
  they fall back to a public default otherwise (see `GO-LIVE.md`). **Still to set.**
- **Tokens are hash-only in the DB** (agent tokens, invite tokens, claim secrets) — a DB
  read yields no working credential.
- **One redaction detector, every sink** — the adapter registry declares what is secret;
  the audit row, the request log, and the config-bundle `assertNoSecrets()` all use it,
  so the lists cannot drift.
- **Secrets never travel in the config bundle or the package** — `assertNoSecrets()`
  throws; they stay in the encrypted store and are re-supplied per machine.

---

## 10. Known / accepted residuals

- **Object-level authz** (a member reading a foreign record by id *within* their own org
  path) — a separate concern, still open.
- **`requireOrgRole` no-ops on a path with no `:orgId`** — a live footgun left flagged;
  making it fail-closed could 403 live routes and needs its own PR. Record-derived routes
  route around it via `enforceOrgRole`.
- **`llm.call` spans carry no org id**, so the org-scoped traces route under-reports
  (isolation-first is the correct direction to fail).
- **The audit-log plugin's own hook** records via the hoisted root instance; the legacy
  encapsulated no-op is guarded by the `[ONB2-H1]` tripwire either way.
- **Fly secrets `SECRETS_ENC_KEY` / `RUN_TOKEN_SECRET` / `WEBHOOK_SIGNING_SECRET`** are
  not yet set in production — tracked in `GO-LIVE.md`.

---

## 11. Audit index

| Doc | Subject | Verdict |
|---|---|---|
| `AUDIT-ONB1.md` | Invite object + adapter registry (H2 redaction) | PASS + fixes |
| `AUDIT-ONB2.md` / `AUDIT-ONB2-hardening.md` | Onboarding doc; audit-surface + sanitize + registry-detector | PASS-WITH-FIXES |
| `AUDIT-ONB3.md` | Join + board-approval gate (H-1: second ungated door) | H-1 closed (#252) |
| `AUDIT-ONB4.md` (see PR #254) | One-time claim | PASS-WITH-FIXES |
| `AUDIT-ONB6.md` | Create-invite UI + prompt + CLI | PASS-WITH-FIXES |
| `AUDIT-audit-trail.md` | Audit-trail enablement + retention | PASS-WITH-FIXES |
| `AUDIT-shell-default.md` | Shell-execution default OFF | PASS |
| `AUDIT-MCA-membership.md` + `-review.md` + `-review2.md` | Multi-tenant membership (R-4, HIGH-1) | HIGH-1 re-audit PASS (#265) |
