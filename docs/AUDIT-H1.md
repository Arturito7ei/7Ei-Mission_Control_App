# AUDIT-H1 — independent security audit of the H1 packaging build pipeline (PR #269)

**Auditor:** independent session (did NOT build H1).
**Scope:** the production packaging build pipeline shipped on `main` at `0689cf7` — compiled backend, `electron-builder.yml`, inert signing/notarization hooks, hardened-runtime entitlements, and the deployment-profile/secret surface the packaged boot touches. Security-relevant surface of a distributable macOS desktop app.
**Method:** static review of `apps/desktop/` + the backend auth/secret paths the packaged boot reaches; git tree + history scan for committed secrets; shell-precedence verification of the signing flip. No signed build was produced (Apple-account-gated, H-Q1/H-Q2) — findings that require a real signed build to confirm are flagged as verification-gated.

**Date:** 2026-07-15.

---

## VERDICT: **PASS-WITH-FIXES**

No blocker, no HIGH. No dangerous entitlement, no committed/logged signing secret, and the packaged auth bypass **cannot** leak into or weaken the hosted build. One real signing-path footgun (a documented flip that silently produced an *unsigned* build) was found and **fixed** in this PR. Two items are left for the owner/H6: an entitlement-tightening opportunity (verification-gated) and the temporary `SECRETS_ENC_KEY` bypass (H6 product scope). None block *building* the unsigned artifact; the signed-distribution and runtime-auth gates are correctly deferred and clearly flagged.

---

## Findings by severity

### LOW-1 — Signing flip silently shipped an *unsigned* build via the documented "inline override" — **FIXED**
**Where:** `apps/desktop/package.json` (`dist:mac`, `pack:mac`); `GO-LIVE.md` §17 step 3; `docs/DESIGN-packaging.md` §16.4/§16.5.

The scripts hard-set the guard *inline*, immediately before `electron-builder`:
```
CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac …
```
A shell assignment prefix on a command overrides any exported/inherited value **for that command**. GO-LIVE §17 told the operator to enable signing by "override it inline for this run" → `CSC_IDENTITY_AUTO_DISCOVERY=true npm run dist:mac`. That exported `true` is shadowed by the script's inline `=false`, so electron-builder still sees `false` → **the build stays unsigned**, and `notarize.cjs` self-skips (`signingSkipped=true`). The operator provides a real cert + notarytool creds, follows the runbook, and ships a **silently unsigned/unnotarized `.dmg`** believing it is signed. Verified the shadowing with `FOO=true sh -c 'FOO=false sh -c echo $FOO'` → `false`.

**Fix (applied):** the scripts now read `CSC_IDENTITY_AUTO_DISCOVERY=${CSC_IDENTITY_AUTO_DISCOVERY:-false}` — a deterministic unsigned build by default (unchanged), but an exported override is honoured, so the documented inline flip works. GO-LIVE §17 and DESIGN §16.4/§16.5 updated to match, and a `spctl -a -vv … → source=Notarized Developer ID` verify-step was added so a mis-flip is caught before distribution rather than shipped.

**Residual (report only):** the *primary* documented method (editing the script to remove the guard) always worked; the reverse footgun — cert provided + flip taken but notarytool creds forgotten → electron-builder signs, `notarize.cjs` skips → a **signed-but-not-notarized** app (Gatekeeper-blocked for downloaded apps just like unsigned) — remains inherent to the wired-inert design. It is now caught by the added `spctl` verify step. Acceptable.

### LOW-2 — `com.apple.security.cs.allow-dyld-environment-variables` is not clearly least-privilege — **report only (verification-gated)**
**Where:** `apps/desktop/build/entitlements.mac.plist:35`.

The plist is otherwise exemplary (see verified-clean). This one entitlement is justified in-file as needed because "the shell forks the backend/UI children with `ELECTRON_RUN_AS_NODE` … the child Node honours `DYLD_*` only with this." That justification is questionable: `ELECTRON_RUN_AS_NODE` is **not** a `DYLD_*` variable and is honoured regardless of this entitlement, and `main.cjs`/`build-desktop.mjs` pass **no `DYLD_*` variable at all** (grepped: none). The `.node` addon (`@libsql/darwin-arm64`) loads via a normal `require`/`dlopen`, not via `DYLD_INSERT_LIBRARIES`. This entitlement re-permits `DYLD_*` injection into the hardened process — precisely a protection the hardened runtime otherwise removes — so on a least-privilege reading it appears **removable**.

It is **not dangerous** in the `disable-library-validation` class, and it is fully **inert today** (the app is unsigned), so there is no live risk. Recommend: on the first signed build (H-Q2), remove this key and confirm the app still forks its backend/web children and boots green; keep only `allow-jit` + `allow-unsigned-executable-memory` if so. Not fixed here because it cannot be validated without a signed build (Apple-account-gated) and the builder asserts it is required — removing it blind could break the eventual signed build.

**Ruling on the entitlement set:** `allow-jit` and `allow-unsigned-executable-memory` are correctly required (V8 JIT generates + executes unsigned pages). No `disable-library-validation`, no `disable-executable-page-protection`, no `get-task-allow`, no TCC usage strings (correctly deferred to H2 as Info.plist keys). The set is **minimal and safe**; `allow-dyld-environment-variables` is the single line worth challenging and tightening once signing is live.

### LOW-3 — Temporary packaged `SECRETS_ENC_KEY` bypass — **report only (H6 product scope)**
**Where:** `apps/desktop/src/main.cjs:122`; `backend/src/services/secrets.ts:5`.

Packaged boot injects a throwaway `SECRETS_ENC_KEY` default (`'h0-spike-local-only-not-secure'`, overridable by env) and runs with Clerk gated off. `secrets.ts` derives the AES-256-GCM key from that value at module load. The concern is whether this throwaway key can become a real at-rest key for real secrets before H6.

**Assessed reachability (the mitigation):** every secret-*write* path — the scoped secret store (`tasks.ts:235`), connectors (`connectors.ts:30`), Jira config (`jira.ts:43`), and join-declared secrets (`agent-invites.ts:367`) — is registered inside the Clerk-`secured` scope (`index.ts:147-186`), except the public join. In packaged mode there is **no `CLERK_SECRET_KEY`**, so `clerkAuth`'s verifier throws and **every secured route 401s** — even with a token (`middleware/clerk-auth.ts:24-27,54-67`). The one public write, the invite *join* (`agent-invites.ts:367`), requires a valid invite, and invites can only be **created** via the Clerk-secured `agentInviteRoutes` (401 in packaged). A fresh packaged `mc.db` has no invites. **Net: no secret-write path is reachable in packaged mode today, so the throwaway key currently encrypts nothing.**

**Residual risk: LOW**, and entirely contingent on H6 not opening a write path before provisioning a real key. It is clearly flagged as not security-complete in `main.cjs:14-15,118-122`, DESIGN §16.6, and the commit body.

**Cannot leak to hosted:** the throwaway default only applies when `main.cjs` forks the backend (desktop-only). Hosted Fly sets `SECRETS_ENC_KEY` as a real secret; `secrets.ts` reads whatever the environment provides. Nothing in this PR touches the hosted env. Confirmed.

**What H6 MUST guarantee (before the packaged app is distributed for real use):**
1. **A real, per-install, randomly-generated `SECRETS_ENC_KEY`** persisted to the OS keystore/`userData` and injected before any secret-write path is reachable — never the committed default.
2. **Fail-closed-on-default-key:** the backend must refuse to start (or refuse secret writes) if `SECRETS_ENC_KEY` is absent or equals the known `h0-spike-…`/`dev-…` default. (Named already in DESIGN §16.6 as the H6 requirement — this audit endorses it as mandatory, not optional.)
3. **The new single-operator loopback identity must gate the same write routes Clerk gates today** (scoped secrets, connectors, Jira, invite create), so they do not become open-on-loopback the moment Clerk is removed.
4. Same treatment for `RUN_TOKEN_SECRET`, which also falls back to `SECRETS_ENC_KEY` (`agent-api.ts:271`).

### NIT — notarize skip message conflates two states — **report only**
**Where:** `apps/desktop/scripts/notarize.cjs:38`.

The skip log — `unsigned build or no notarization credentials present` — reads the same whether the build was genuinely unsigned or was **signed but missing notarytool creds**. Harmless (the hook still correctly no-ops and never submits or logs a credential), but a more specific message would help an operator distinguish a "signed-but-not-notarized" mis-flip from an intended unsigned build. Left as-is to avoid touching the signing hook logic; the LOW-1 `spctl` verify-step covers the operational risk.

---

## Verified clean

1. **Entitlements — no dangerous keys.** No `disable-library-validation`, `disable-executable-page-protection`, or `get-task-allow` anywhere in `apps/desktop/` (the only `disable-library-validation` string is a comment explaining why it is *excluded*). `hardenedRuntime: true` + `entitlements`/`entitlementsInherit` wired (`electron-builder.yml:58-61`). TCC usage strings correctly deferred to H2.
2. **notarize.cjs self-skips safely.** Returns early on non-darwin; skips when `CSC_IDENTITY_AUTO_DISCOVERY=false` *or* no complete credential set is present (`notarize.cjs:31-40`). No crash without creds, no accidental submission of an unsigned app, `@electron/notarize` required **lazily** only when actually notarizing. Logs only `appName`/`bundleId` — **no credential is ever logged**.
3. **No signing/Apple secret in tree or history.** No `.p12/.p8/.cer/.pem/.mobileprovision/.keychain` tracked or ever added (git history scanned). No `CSC_KEY_PASSWORD=…`, `CSC_LINK=<base64…>`, `APPLE_APP_SPECIFIC_PASSWORD=…`, or `AuthKey_*.p8` literals committed — only placeholder runbook examples.
4. **Deterministic unsigned build.** `CSC_IDENTITY_AUTO_DISCOVERY` defaults to `false` (post-fix, still deterministic) + `gatekeeperAssess: false` → no identity discovery, no signing, reproducible unsigned `.app`/`.dmg`.
5. **Hosted isolation — additive only.** PR #269 touches `apps/desktop/` + docs only; **no `backend/` or `web/` code changed**. `web/next.config.ts:14` gates `output: 'standalone'` behind `DESKTOP_BUILD==='1'` (spread conditionally); Vercel never sets it → byte-identical hosted config. `build-desktop.mjs:94` explicitly clears `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` for the desktop web build so no key bleeds in. No shared config/env bleed.
6. **Bundling integrity.** `build-desktop.mjs` esbuild-bundles `backend/src/index.ts` → one ESM `index.js`; only `@libsql/client` + `officeparser` stay external and are re-installed **pinned, prod-only** (`--omit=dev`) into a fresh runtime `package.json`. `electron-builder.yml` packs only the desktop supervisor `src/**` into asar and copies the compiled `build-stage/{backend,web}` as `extraResources` — **no `tsx`/`typescript`/`drizzle-kit`/backend TS source ships** (design-doc-verified against the built `.app`; corroborated by the staging logic). esbuild uses no `define`, so `process.env.*` stay runtime reads — no secret inlined into the bundle. The libSQL native addon loads from the pruned closure. Registry-access reproducibility caveat for the two externals is documented and acceptable.
7. **Build artifacts untracked.** `build-stage/`, `dist/`, `node_modules/` are gitignored and untracked; committed build *inputs* (`build/entitlements.mac.plist`, `build/icon.png`) are correctly un-ignored so a fresh checkout reproduces the build.
8. **main is green.** `main` @ `0689cf7`: Test / CI / Deploy all `success`.

---

## Fixes applied in this PR
- `apps/desktop/package.json` — `dist:mac`/`pack:mac`: `CSC_IDENTITY_AUTO_DISCOVERY=${CSC_IDENTITY_AUTO_DISCOVERY:-false}` (LOW-1).
- `GO-LIVE.md` §17 — corrected the signing-flip runbook + added the `spctl` verify step (LOW-1).
- `docs/DESIGN-packaging.md` §16.4/§16.5 — aligned the flip description with the fixed script (LOW-1).
- `docs/AUDIT-H1.md` — this document.

No code under audit (entitlements plist, notarize hook, main.cjs bypass, esbuild pipeline) was altered — those findings are verification-gated or H6 product scope and left in this report.
