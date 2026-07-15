# AUDIT-H6 — packaged loopback auth + per-install secrets + fail-closed boot

> **Scope:** PR #271 (`220849d`, on `main`) — the packaged product's authentication and
> at-rest-secret model: `middleware/loopback-auth.ts`, `services/loopback-identity.ts`,
> `services/secret-keys.ts`, the `index.ts` profile branch, `apps/desktop/src/keychain.cjs`
> + `main.cjs` header injection, `web/app/dashboard/page.tsx` packaged gate — audited
> against the unchanged hosted Clerk path (`middleware/clerk-auth.ts`) and the membership /
> owner gates (`middleware/rbac.ts`).
> **Auditor:** independent (did not build H6). **Date:** 2026-07-15.
> **Method:** static read of the full diff + the gates it branches against; behavioural
> replay of the H6 test suites; full backend suite + typecheck; secret-in-tree/history scan.
> **Verdict:** **PASS-WITH-FIXES** — one comment-accuracy NIT fixed in this PR; the rest are
> documented residuals and verification-gated items, none blocking. The packaged auth model
> is **sound for distribution**, conditional on the real-built-`.app` confirmations in §D.

---

## VERDICT

**PASS-WITH-FIXES.** No blocker, high, or medium finding. The identity swap is a genuine
gate-preserving substitution, not a weakening; the session secret does not reach page JS;
the three per-install keys are distinct, random, OS-user-bound, read each boot, and the
fail-closed guard refuses an unprovisioned packaged boot; the hosted Clerk path is
byte-identical and cannot be flipped to the no-Clerk path on Vercel. All findings are LOW/NIT
— one fixed here, the rest recorded as residual risk or as items that must be confirmed on a
real built `.app` (which the PR itself flags as not exercised headlessly).

**Tests:** backend **1277/1277 pass** (incl. the +14 H6 tests), backend + web typecheck clean,
no secret in the working tree or git history, `build-stage/` is gitignored. `main` is green.

---

## The five audit questions — rulings

### 1. The identity swap is sound, not a weakening ✅

- **Same scope, same contract.** `index.ts` selects the secured-scope `onRequest` hook by
  profile: `deploymentProfile === 'packaged' ? loopbackAuth : clerkAuth`
  (`backend/src/index.ts:164-166`). Both hooks attach the **identical** request shape —
  `req.userId`, `req.clerkSession`, and `req.auth = { userId, sessionId, claims }`
  (`clerk-auth.ts:61-64` vs `loopback-auth.ts:70-73`). Every downstream reader
  (`requireOrgMembership`, `requireOrgRole('owner')`, the audit + telemetry hooks) reads
  `req.auth.userId` / `req.userId` and is therefore profile-agnostic.
- **No Clerk-gated route becomes ungated.** The branch swaps only the identity *source*; the
  `requireOrgMembership` preHandler (`index.ts:178`) and every per-route `requireOrgRole`
  layer on top unchanged. There is no second secured scope and no route that hard-codes
  `clerkAuth` outside the branch (`clerkAuthPlugin` is defined but never registered). The one
  WebSocket route (`/api/orgs/:orgId/jira/live`) is registered *inside* the branched scope
  (`index.ts:194`), so it inherits `loopbackAuth` on packaged and fail-closes to 401 without
  the bearer (no browser client uses it today).
- **A real owner, not a bypass.** `bootstrapLocalOperator` (`loopback-identity.ts:48-78`)
  idempotently seeds the one local org with `ownerId = 'local-operator'` **and** an explicit
  `org_members` owner row, so the operator satisfies both the membership-row path and the
  `ownerId` grandfather path in `enforceOrgRole` (`rbac.ts:49-56`). The synthetic
  `'local-operator'` id is never a `user_…` Clerk sub, so it cannot collide with a hosted
  identity, and **no secured route looks a Clerk user up by id** (no `clerkClient`/`getUser`
  call sites), so the opaque id breaks no downstream lookup.
- **Fail-closed, constant-time, no oracle.** No configured secret → every secured route 401s
  (`loopback-auth.ts:58-60`). Wrong/absent bearer → 401 (`:62-65`). `secretsMatch`
  length-guards then `timingSafeEqual` (`:36-41`) — a wrong-length token returns `false`
  rather than throwing, so it is timing-indistinguishable from a same-length miss.
- **Proven behaviourally** — `loopback-auth.test.ts` (replayed, 14/14 green): a valid secret
  authenticates *as* the local operator (`:41`); no/wrong/**same-length** bearer 401s (`:52`);
  an unconfigured secret fails closed (`:64`); the operator **passes** the real secured
  membership gate and `GET /api/orgs` returns the local org, while a request with no bearer is
  401 (`:124`); an outsider id is 403 (`:113`).

### 2. The session secret can't leak ✅ (one residual, §NIT-2/§NIT-3)

- **Injected by the Electron main process only.** `installLoopbackAuthHeader`
  (`main.cjs:127-139`) registers `session.defaultSession.webRequest.onBeforeSendHeaders`,
  deletes any inbound `Authorization` (case-insensitive) and sets
  `Bearer <MC_LOOPBACK_SESSION_SECRET>`. The secret is held in `provisioned` in the trusted
  main process (`main.cjs:100`) and is never passed into the renderer.
- **Renderer cannot read it.** `contextIsolation: true`, `nodeIntegration: false`
  (`main.cjs:244`). The page's `useAuth` placeholder returns the harmless literal
  `'mc-loopback'`, **not** the real secret (`web/app/dashboard/page.tsx:35`) — page JS only
  ever holds a placeholder, and the real bearer is stamped on at the network layer *after* JS.
  Nothing writes it to `localStorage`.
- **Not logged.** No H6 code path emits the secret to a log sink; the packaged boot line logs
  only the org id (`index.ts:150`). See §NIT-2 for the one defense-in-depth gap (the raw
  64-hex secret has no prefix, so the pattern-based `log-redaction.ts` would *not* catch it
  *if* a future change ever logged it — not a live leak today).
- **Local-attacker residual (ruling):** a second **OS user** on the same Mac cannot read the
  login-Keychain item and cannot read the backend's env → **LOW**. A malicious **same-user**
  process is already inside the trust boundary (it can read the login Keychain and, absent a
  hardened runtime, attach to the backend) — the residual there reduces to **whether the
  Keychain ACL and env are actually protected, which is deterministic only under H1
  signing + hardened runtime** (see §D). The injected-header design also grants *ambient
  authority* to anything running in the window's session (§NIT-3). Net: **acceptable for a
  single-tenant loopback product; residual is same-user, and signing is what pins it.**

### 3. Per-install keys + fail-closed (the H1 requirements) ✅

- **Three distinct 32-byte random values.** `keychain.cjs generateKey()` =
  `crypto.randomBytes(32).toString('hex')` (`:29-31`); `provisionSecrets`
  (`main.cjs:108-117`) generates `SECRETS_ENC_KEY`, `RUN_TOKEN_SECRET`,
  `MC_LOOPBACK_SESSION_SECRET` as three separate Keychain accounts.
- **OS-user-bound + idempotent + read-back each boot.** Stored in the macOS **login**
  Keychain via the zero-dep `security` CLI under a stable service
  (`ai.7ei.missioncontrol`); `getOrCreateKey` reads an existing value or generates + persists
  + **reads back to confirm** (`keychain.cjs:62-74`), so the encrypted DB stays decryptable
  across boots. The throwaway `h0-spike-local-only-not-secure` default is gone from the boot
  path.
- **The guard refuses an unprovisioned packaged boot.** `assertSecretKeysSafe`
  (`secret-keys.ts:97-105`) throws in `packaged` on any missing/known-default key **or** if
  `RUN_TOKEN_SECRET === SECRETS_ENC_KEY`; it is a **no-op on hosted** (`checkSecretKeys`
  returns `ok` for any non-packaged profile, `:64-66`). It is called at the very top of
  `start()` before any secret-write path is reachable (`index.ts:81`), and
  `start().catch(process.exit(1))` turns the throw into a hard refusal.
- **Default-key list is complete (ruling).** `KNOWN_INSECURE_KEYS` = `{ '',
  'dev-7ei-mc-secrets-key', 'dev-7ei-mc-run', 'h0-spike-local-only-not-secure' }`
  (`secret-keys.ts:31-36`). Verified against every current code fallback:
  `secrets.ts:5` (`… ?? 'dev-7ei-mc-secrets-key'`), `agent-api.ts:271`
  (`RUN_TOKEN_SECRET || SECRETS_ENC_KEY || 'dev-7ei-mc-run'`), and the shell placeholder —
  **all three present, plus the empty string.** No other literal default for these three keys
  exists in the tree or git history. **Complete.**
- **No real secret can be encrypted under a default.** Because the guard runs before the first
  reachable secret-write and refuses on any default/missing/reused key, `secrets.ts`'s
  SHA-256(`SECRETS_ENC_KEY`) can never key a real store under a default in packaged; and
  because `RUN_TOKEN_SECRET` is required present + distinct, the `agent-api.ts:271`
  `|| SECRETS_ENC_KEY` fallback never fires in packaged. **Requirement #4 met.**
- **Proven** — `secret-keys.test.ts` (replayed, 14/14 green in the combined run): hosted
  no-op even on dev defaults; packaged passes on three distinct real keys; fails closed on
  missing/default `SECRETS_ENC_KEY`, missing/default `RUN_TOKEN_SECRET`, `RUN===ENC` reuse,
  and missing/throwaway loopback secret.

### 4. Hosted untouched ✅

- **Profile resolves from one env var, safe-defaulting hosted.** `resolveDeploymentProfile`
  reads only `MC_DEPLOYMENT_PROFILE`; anything unset/garbage → `'hosted'`
  (`deployment-profile.ts:39-44`). Fly does not set it → hosted → `clerkAuth`, the guard is a
  no-op, and the bootstrap never runs. The Clerk hook and its registration are byte-identical
  to pre-H6 (the diff only *adds* a branch).
- **Defense-in-depth against an accidental flip on hosted:** even if `MC_DEPLOYMENT_PROFILE`
  were mis-set to `packaged` on Fly, `assertSecretKeysSafe` would refuse to boot without three
  distinct non-default per-install keys Fly does not provide. Reaching the loopback path on
  hosted requires a *deliberate* misconfiguration (packaged profile **and** three valid random
  keys **and** no Clerk key) — not an accident.
- **Web gate is double-gated.** `web/app/dashboard/page.tsx` uses the operator placeholder
  only (a) inside the `catch` where `require('@clerk/nextjs')` fails **and** (b) when
  `NEXT_PUBLIC_MC_PACKAGED === '1'`. Hosted has a real Clerk key (the `require` succeeds, the
  `catch` never runs) and never sets the flag (only `apps/desktop/scripts/build-desktop.mjs`
  does). Even if the `catch` ran on hosted, the flag is unset → the `isSignedIn:false` branch
  (bounce to landing), **not** the operator branch. The packaged path cannot enable on the
  hosted build.

### 5. Verification-gated items (builder's flags) — must confirm on a real built `.app` ⚠️

The PR is explicit that the full built-`.app` round-trip was not exercised headlessly. Static
wiring reviewed and correct; the following **must** be confirmed on a signed build before the
`.dmg` ships (tracked in §D, none are code defects):

- **Keychain under a signed app.** `security add/find-generic-password` behaviour and the item
  **ACL are only deterministic under H1 signing + hardened runtime** — an unsigned/ad-hoc dev
  build may prompt or grant different access than the shipped app. Confirm generate-on-first-
  boot, read-back-on-reboot (DB stays decryptable), and no interactive prompt on the signed app.
- **Injected-header flow in a live BrowserWindow.** Confirm real dashboard `fetch`es to
  `127.0.0.1:8787` carry the injected bearer and authenticate; confirm the renderer cannot
  read `MC_LOOPBACK_SESSION_SECRET` (DevTools: no token in JS, `localStorage`, or a page-
  readable header).
- **The `useAuth` catch actually triggers in the packaged Next standalone build** (§NIT-4).
  If `require('@clerk/nextjs')` does **not** throw in the bundle, `useAuth` resolves to the
  real Clerk hook and — with no `ClerkProvider` mounted — throws at render. That fails **closed**
  (no data leak) but the dashboard would not render. Confirm the packaged dashboard renders as
  the operator.
- **Hosted regression:** confirm the live Fly deploy stays Clerk-gated and green post-merge
  (the branch is additive, but the profile branch touches `start()`).

---

## Findings by severity

No BLOCKER / HIGH / MEDIUM.

### NIT-1 — session secret passed as a `security` CLI argument (residual, not fixed)
`apps/desktop/src/keychain.cjs:51` — `writeKey` passes the value as `-w <value>`, so during the
one-time first-boot write the secret is briefly present in the process argument vector
(`ps -ww`, same user). **Residual, LOW:** a same-user process is already inside the Keychain/env
trust boundary, and the macOS `security` CLI has no clean stdin path for
`add-generic-password`. Left as-is (changing the write risks breaking persistence);
documented so a future migration to a native Keychain binding closes it.

### NIT-2 — loopback session secret not covered by the pattern log-redactor (defense-in-depth, not fixed)
`backend/src/services/log-redaction.ts` redacts by known token *prefixes* (`mci_inv_`, `mcc_`,
…). The 64-hex `MC_LOOPBACK_SESSION_SECRET` has no prefix, so it would **not** be redacted if a
future change ever logged the `Authorization` header. **Not a live leak** — no H6 path logs it.
Left as a report item rather than editing the redactor blind (out of the auth diff's blast
radius); recommend adding a generic high-entropy-bearer rule when the redactor is next touched.

### NIT-3 — ambient authority of the injected header (product call, not fixed)
`main.cjs:127-139` injects the bearer on **every** request from the window session to the
backend origin, including page-JS-initiated fetches and any sub-resource the dashboard loads.
The secret never reaches JS, but anything executing in the window's session can *drive*
authenticated backend calls (a confused-deputy surface). Mitigated: the window only ever loads
`WEB_ORIGIN`, external links open in the system browser (`main.cjs:248-251`), and
`contextIsolation`/`nodeIntegration:false` hold. **Acceptable for single-tenant loopback**;
recommend a strict CSP on the packaged web build (and, if feasible, a partitioned session) as
future hardening. Product call — not fixed here.

### NIT-4 — `useAuth` fallback depends on a `require` throw (verification-gated, not fixed)
`web/app/dashboard/page.tsx:23-37` — see §5. Security-neutral (fails closed); confirm on the
real built `.app`. If it proves not to trigger, the fix is to gate the fallback on
`NEXT_PUBLIC_MC_PACKAGED` directly rather than on the `require` throwing.

### NIT-5 — stale secured-scope lead comment ✅ FIXED (this PR)
`backend/src/index.ts:153-156` said routes require "a valid Clerk JWT" — now profile-dependent.
Reworded to "a valid session — a Clerk JWT on hosted, the single-operator loopback bearer on
packaged." Comment-only, zero behavioural change; typecheck clean.

---

## Verified-clean list

- Profile-branched secured-scope hook; identical `req.auth`/`req.userId` contract across
  Clerk and loopback (`index.ts:164-166`, `loopback-auth.ts:70-73`, `clerk-auth.ts:61-64`).
- No Clerk-gated route ungated under loopback; no route hard-codes `clerkAuth` outside the
  branch; the WS route inherits the branched hook and fail-closes.
- Loopback operator is a real seeded owner+member (`loopback-identity.ts`), passing the same
  `requireOrgMembership` / `enforceOrgRole('owner')` gates; outsiders 403.
- Constant-time, length-guarded, no-oracle secret compare; 401 on no/wrong/unconfigured secret.
- Session secret confined to the Electron main process + the loopback request; never in
  renderer JS, `localStorage`, or logs; inbound `Authorization` stripped before injection.
- Three distinct 32-byte random per-install keys in the OS-user-bound login Keychain,
  idempotent + read-back-confirmed each boot; throwaway default removed.
- `assertSecretKeysSafe` refuses packaged boot on missing/default/reused keys, before any
  secret-write; no-op on hosted; `KNOWN_INSECURE_KEYS` complete for every current code default.
- `RUN_TOKEN_SECRET` required present + distinct → the `agent-api.ts:271` `|| SECRETS_ENC_KEY`
  fallback cannot fire in packaged; no real secret encryptable under a default.
- Hosted Clerk path byte-identical; profile safe-defaults hosted; web operator gate
  double-gated and unreachable on the hosted build.
- No secret value in the working tree or git history; `apps/desktop/build-stage/` gitignored.
- Backend **1277/1277** pass; backend + web typecheck clean; `main` green.

---

## §D — what MUST be confirmed on a real built `.app` before shipping the `.dmg`

1. Signed-app Keychain: generate-on-first-boot + read-back-on-reboot, no interactive prompt,
   deterministic ACL under H1 signing + hardened runtime.
2. Live BrowserWindow: dashboard `fetch`es carry the injected bearer and authenticate; the
   renderer cannot read the secret (DevTools).
3. The packaged dashboard renders as the operator (the `useAuth` catch triggers — §NIT-4).
4. Hardened runtime blocks same-user debugger attach to the backend (pins the §2 residual).
5. Post-merge: the hosted Fly deploy stays Clerk-gated and green.

*Is the packaged auth model sound for distribution?* **Yes** — the auth swap preserves every
gate, the secret does not reach page JS, the keys are distinct/random/OS-bound, and the boot
fails closed on an unprovisioned key set. Ship the `.dmg` **after** the §D real-built-run
confirmations (signing is what pins the same-user residual and the Keychain ACL).
