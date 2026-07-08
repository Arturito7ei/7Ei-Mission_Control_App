# Code Review — Arturita + Paperclip-parity work (pre-live-review QA)

**Reviewer:** Claude (automated review pass) · **Date:** 2026-07-08 · **Branch reviewed:** `main` @ `602671c`
**Scope:** Arturita tab + free-first pipeline (#201–#204), TTS-fix + custom-model insertion (#206–#207),
Epic P1 low-trust review (#208), P2 model profiles (#209), Paperclip-IA nav re-fold (#212–#213), and the
earlier Arturita epics (A/B/C/E/F) as they interact.

---

## Verdict

**Healthy — good to demo Arturita live.** All suites pass, the security-critical surfaces are fail-closed,
and the review found **no blockers and no high-severity code defects introduced by the Arturita work.**
The one **HIGH** item is an *operational* one (production env keys that fall back to public defaults) with a
non-breaking mitigation shipped here and an operator action recorded in `GO-LIVE.md §5`. The remaining items
are medium/low hardening and UX polish, none of which gate a live review.

The wallet — the highest-risk surface — is in the safest possible posture: **there is literally no signing
endpoint in the codebase.** Arturita can read/prepare/simulate/evaluate a tx and route to approval, but the
key custody + signing path is not wired, so mainnet signing cannot be triggered regardless of any flag.

---

## Test / build results (exact)

| Suite | Command | Result |
|---|---|---|
| Backend unit/integration | `cd backend && npm test` | **867 pass / 0 fail** (116 suites) |
| Orchestration evals | `npm run evals` | **11 / 11 scenarios passed** |
| Backend typecheck | `cd backend && npm run typecheck` | **clean** |
| Web tests | `cd web && npm test` | **80 pass / 0 fail** |
| Web typecheck | `cd web && npm run typecheck` | **clean** |
| Web production build | `cd web && npm run build` | **success** (re-run green after the token fix below) |

No flakes observed. Nothing skipped.

---

## What I fixed in this pass (shipped)

1. **[LOW → fixed] Undefined design tokens rendered raw hex.** `--warning-text` / `--warning-dim` were
   referenced with a `#b45309` fallback at 4 sites but never defined, so the raw hex always rendered
   (violates web/CLAUDE.md "tokens only, no hardcoded values"). Defined both tokens (light + dark) in
   `web/app/dashboard/tokens.ts` and removed the hex fallbacks in `GovernancePanel.tsx` (×2) and
   `cockpit/InboxSection.tsx` (×2). Verified by a clean web build.
2. **[HIGH mitigation — non-breaking] Surfaced the secret-key env requirement.** Added `GO-LIVE.md §5`
   and the two keys to `scripts/check-secrets.sh` so the operator sets `SECRETS_ENC_KEY` /
   `RUN_TOKEN_SECRET` (and `WEBHOOK_SIGNING_SECRET`) on Fly before storing real secrets. See **H1** below.
   I did **not** ship the boot-time fail-closed guard — that would crash prod if the secret isn't set yet,
   and must be coordinated with the operator (see recommendation).

---

## Findings by severity

### HIGH

**H1 — Secret-store & run-token keys fall back to a public hard-coded default.**
`backend/src/services/secrets.ts:5` derives the AES-256-GCM key from `process.env.SECRETS_ENC_KEY ??
'dev-7ei-mc-secrets-key'`; `backend/src/routes/agent-api.ts:261` signs per-run HMAC tokens with
`RUN_TOKEN_SECRET || SECRETS_ENC_KEY || 'dev-7ei-mc-run'`. Neither was in `check-secrets.sh`, `GO-LIVE.md`,
or `backend/CLAUDE.md`'s env list. **If unset in production**, every encrypted secret in the DB (custom-model
API keys, `MC_LLM_API_KEY`, `GITHUB_VAULT_TOKEN`, scoped agent secrets) is decryptable with a key that lives
in the source, and run-tokens are forgeable. AES-256-GCM itself is implemented correctly (random 12-byte IV,
auth tag) — the weakness is purely the default-key fallback.
- **Fixed here:** added to `GO-LIVE.md §5` + `check-secrets.sh` (operator sets the Fly secrets).
- **Operator action (required before/at go-live):** `flyctl secrets set SECRETS_ENC_KEY=… RUN_TOKEN_SECRET=…`
  **before** storing any real secret (data encrypted under the dev default won't decrypt under a new key).
- **Recommended eng follow-up:** a boot guard that refuses to start when `NODE_ENV==='production'` and the
  key is missing/default. Not shipped here to avoid crash-looping prod before the secret is set.
- *Not a live-review blocker* (the demo org can run on the dev default), but must be closed before real
  secrets/multi-tenant go-live.

### MEDIUM

**M2 — Inbound webhook auth fails OPEN when the signing secret is unset.**
`backend/src/services/webhook-auth.ts:43` returns `{ authorized: true, enforced: false }` when
`serverSecret` is falsy. The secret is `WEBHOOK_SIGNING_SECRET ?? {JIRA,TELEGRAM}_WEBHOOK_SECRET`
(`routes/jira-webhook.ts:9`, `routes/comms.ts:11`). If unset in prod, the public receivers
`POST /api/{jira,telegram}/webhook/:orgId` accept **unsigned** events, letting any network caller forge
jira/telegram events into any org (spurious tasks/inbox items). Pre-existing (not introduced by #201–#213).
- **Fix:** require the secret in production (`enforced` must be true, else refuse); verify it's set on Fly
  (added to `check-secrets.sh` as recommended).

**M3 — Webhook receivers have no replay/timestamp/nonce protection.**
`webhook-auth.ts` — the per-org secret is static, deterministic, and echoed on every delivery, so a captured
valid delivery can be replayed indefinitely. Pre-existing. **Fix:** signed timestamp + short acceptance
window, or delivery-id dedupe.

**M4 — Converse degraded reason isn't surfaced to the operator.**
`backend/src/routes/arturita-converse.ts:166–175` correctly returns the true failover cause in
`resp.error`, but the web layer (`assistant.logic.ts` `toArturitaMessage`) never reads it, so a degraded turn
always shows one generic "provider chain is unavailable" — the operator can't tell rate-limited vs bad-key vs
all-providers-down. **Fix:** surface `resp.error` / a reason code in the degraded bubble.

**M5 — Delegate + DB legs of converse/voice are unguarded → opaque 500.**
`arturita-converse.ts:82–98` and `arturita-voice.ts:66–93` wrap only the *answer* LLM leg in try/catch; the
`db.query`/`ensureArturita` insert/`db.insert(tasks)` paths are bare, so a DB blip in delegate mode throws an
opaque Fastify 500 instead of a specific message. **Fix:** wrap the DB writes, return a 502/503 with a
delegate-specific message.

### LOW

**L1 — `ensureArturita` find-then-insert race.** `arturita-converse.ts:45–53` & `arturita-voice.ts:38–46` —
no uniqueness guard between `findFirst` and `insert`; two concurrent first-turns on a fresh org (or converse +
voice at once) can double-insert the `arturita` agent or hit a constraint → 500. **Fix:** `onConflictDoNothing`
or a unique index on `(orgId, agentType='arturita')`.

**L2 — Assistant panel allows overlapping turns.** `web/app/dashboard/AssistantPanel.tsx:137–197` — `send`
guards only on `thinking`, which is already false during local-Ollama streaming / the reveal typewriter, so a
second turn (voice final result, or Enter) can fire mid-stream and mutate shared state. **Fix:** gate on an
"active turn" flag covering streaming + reveal.

**L3 — `requireOrgRole` skips entirely when the route has no `:orgId` param.** `backend/src/middleware/rbac.ts:15`
(`if (!orgId) return`). The four owner-gated agent-trust routes are keyed on `:orgId` so they're covered today,
but any future owner-gated route keyed on a different param silently loses its check. **Fix:** fail-closed —
resolve the org from the target resource or 400.

**L4 — `checkOrgMembership` is a misleading stub.** `rbac.ts:34–38` always returns `allowed:true` for `member`;
only used in tests. **Fix:** remove or rename to reflect it's a test-only helper.

**L5 — App-wide org-scoping trusts any authenticated user on any `:orgId`.** Baseline org-scoped reads
(`tasks.ts:43` inbox, `scheduled.ts:22`, `tasks.ts:477`, and the arturita converse/pipeline/voice/wallet
routes) read `:orgId` from the URL and filter by it but don't verify caller membership — a valid Clerk user of
org A can read/enumerate org B. **This is the established app-wide norm, NOT a regression from the Arturita
work** (which is consistent with it); `requireOrgRole` is applied only to owner-privileged mutations and *does*
enforce real membership (`rbac.ts:17–23`) when present. Low real risk while effectively single-operator, but a
genuine tenant-isolation gap before multi-tenant go-live. **Fix:** a `requireOrgMember` baseline preHandler on
the secured scope.

**L6 — [fixed] Undefined `--warning-text`/`--warning-dim` tokens.** See "What I fixed" above.

**L7 — Owner-gating inconsistency on Arturita config writes.** `arturita-pipeline.ts` (PUT pipeline chains) and
`arturita-wallet.ts` (PUT wallet policy switches) have no `requireOrgRole`, while the sibling
`arturita-custom-model.ts` writes are `requireOrgRole('owner')`. Consistent with the app-wide norm (L5) but the
inconsistency between siblings is worth resolving. Blast radius is currently nil for the wallet (no signing
path). **Fix:** gate the pipeline/wallet-policy writes to `owner` to match custom-model.

### NIT

- **N1** — `BUILD_ORDER` in `services/arturita-converse.ts` includes a bare `merge`, so "merge the notes"
  false-positives into delegate. Qualify the pattern (e.g. `merge (?:the )?(?:pr|branch|changes)`).
- **N2** — Host denylist uses `last.startsWith(dl)` (`host-planner.ts:140`, `adapters/arturita-host/src/safety.mjs:39`)
  so `keystore` also blocks `keystore-notes.txt`. Over-blocks (fail-closed direction) — accept or tighten to
  exact-segment.
- **N3** — Outbound webhook sends an unsigned `X-7Ei-Timestamp` header alongside the signed in-body timestamp
  (`outbound-webhooks.ts:56`). Document that receivers must validate the in-body one.
- **N4** — `web/app/dashboard/VaultGraph.tsx:31–32` uses raw hex (Okabe-Ito colorblind palette + a tag grey).
  Intentional data-viz palette, pre-existing, out of the #201–#213 scope — noted for completeness.

---

## Verified clean (checked and passed)

**Wallet / signing (crown jewel):**
- No signing endpoint exists — routes are read/prepare/simulate/evaluate only (`routes/arturita-wallet.ts`).
- `evaluateWalletPolicy` is fail-closed by precedence: no/failed simulation → refuse; drain → refuse;
  any trigger (≥threshold, over per-day, off-allowlist, scam flag, autonomy-off, mainnet-not-enabled) →
  require_approval; else autonomous. Both switches default **false** (`wallet-policy.ts:69–78`).
- `checkSigningGate` / `assertSigningAllowed` is defense-in-depth: signing allowed only when
  autonomy-on AND (testnet OR mainnet explicitly enabled) AND decision is `autonomous_sign`
  (`wallet-policy.ts:203–230`). Mainnet stays OFF this wave. Covered by `wallet-policy.test.ts`.

**Custom-model API-key handling:**
- AES-256-GCM correctly implemented (random IV + auth tag, `secrets.ts:8–21`).
- Key stored encrypted as `<slug>_api_key_enc`, never on the chain entry, never returned (masked tail only),
  never logged (`custom-model.ts`, `routes/arturita-custom-model.ts`). Writes are `requireOrgRole('owner')`.
- **Test already proves the raw key never serializes:** `custom-model.test.ts:75`
  `assert.ok(!JSON.stringify(out.deployConfig).includes('sk-secret'))`. The pipeline/agents GET endpoints
  return only chain entries (provider/model/label/baseUrl), never key fields.

**Low-trust review gate (#208) — additive, not an A2 bypass.** A low-trust agent's dangerous action goes
through quarantine (new gate) **and** the existing A2 step-up: `review.ts` reuses the A2 danger classes and
persists a real `approval_requests` row with `requiresStepUp`; the approval-decide path
(`tasks.ts:455` + `approvals.ts:57`) still demands a fresh command session. Strictly stricter — never a cheaper
path to a dangerous action.

**Host daemon (#189) — fail-closed.** Master kill-switch `HOST_EXECUTION_ENABLED=false`
(`host-planner.ts:26`) makes every op non-executable; `decideAccess` denies on blank/symlink-escape/outside-root/
denylist with allow only as the final explicit branch; the daemon (`adapters/arturita-host/src/safety.mjs`) adds
real symlink/realpath resolution. Unmatched → DENY.

**Per-org webhook HMAC.** Inbound secret is `HMAC-SHA256(serverSecret, "channel:orgId")` — unique per
org+channel — and compared with `crypto.timingSafeEqual` + length guard (`webhook-auth.ts:19–31`). (Caveats:
M2 fail-open, M3 replay.)

**Auth scoping.** `clerkAuth` strictly rejects missing/invalid tokens (401); `auth-scoping.test.ts` [MCA-85] is
an active regression net asserting no `:orgId`/`:agentId` route is publicly reachable outside a short allowlist.
Routes registered outside the secured scope (models = static catalogue; jira/telegram/comms receivers = per-org
HMAC; arturita `panic` = command-session token; routine trigger = unguessable DB token; Google OAuth) carry
their own auth or expose no tenant data.

**Secrets hygiene.** No real key material committed anywhere in the tree or in git history — scans for
`sk-…`/`AKIA…`/private keys/`xoxb-…` return only test fixtures and `<placeholder>` preset values. `.gitignore`
covers `.env*`, keys, DBs.

**Arturita converse + TTS + fallback (traced end-to-end).**
- Brainstorm-first is correct and **not** accidentally delegating: `decideConverseMode` defaults to `answer`
  and only delegates on destructive intent (→ task + A2 gate), explicit delegate flag, or narrow
  delegation/build phrases; the answer system prompt forbids in-turn actions.
- Graceful per-leg degrade: local Ollama down → cloud fallback (`AssistantPanel.tsx`); cloud chain walks healthy
  hops under a cost cap with a circuit breaker (`llm-fallback-runtime.ts`), always appending the agent's
  guaranteed hop so the path is never empty; total failure → honest text-only bubble. Server TTS never throws —
  NVIDIA/local/missing-key all degrade to `text_only` with a note (`voice-provider.ts`); browser SpeechSynthesis
  retries once on a forced on-device voice. Keys are params, never logged.

**Consistency / conventions.**
- routes→services import direction clean (no `services/*` importing `routes/*`).
- All 7 new Epic-P services have matching `*.test.ts`.
- Colorblind rules honored — status uses icon+label+shape, not color alone (InboxSection `🛡 Low-trust review`,
  agent status `statusIcon()` + `aria-label`).
- Migrations idempotent (`db/setup.ts` try/catch ALTER convention); new NOT NULL columns have safe defaults
  (`trust_mode DEFAULT 'standard'`, `cheap_model_enabled DEFAULT 0`); other new columns nullable.
- Nav re-fold (#212/#213): all 14 tabs map to live render branches, 8 sections render via `CockpitPanel`,
  7 placeholders render an honest `PlaceholderView` (declared Epic-P gaps, not silent orphans) — no unreachable
  prior surface. `navModel.ts` is unit-tested.
- No `TODO`/`FIXME`/`console.log` in the new backend services or web nav components.

---

## Recommended follow-ups (operator / product calls — not guessed)

1. **Set `SECRETS_ENC_KEY` + `RUN_TOKEN_SECRET` (+ `WEBHOOK_SIGNING_SECRET`) on Fly** before storing real
   secrets (H1/M2) — `GO-LIVE.md §5`.
2. **Add a production boot guard** that fails closed on the default secret-store key (H1) — coordinate with #1
   so it doesn't crash-loop.
3. **Decide the tenant-isolation posture** (L5): add a `requireOrgMember` baseline, or accept single-operator
   trust and document it. If closing, gate the arturita pipeline/wallet-policy writes to `owner` too (L7).
4. **Webhook replay protection** (M3) if jira/telegram receivers are exposed to untrusted networks.
5. Quick UX/robustness polish: surface the degraded reason (M4), guard the converse DB legs (M5), fix the
   `ensureArturita` race (L1) and the overlapping-turn guard (L2).
