# npm audit — policy, disposition, and standing exceptions

> Owner: hardening epic, stage 1 (HARD-1). Companion CI job: `.github/workflows/security.yml` → `audit`.
> Update this file in the SAME PR as any change to that job. A threshold change with no entry here is a regression.

## The policy in one paragraph

CI runs `npm audit --audit-level=high` in **every workspace that ships** — `backend`, `web`, `apps/mobile`. **Backend and web fail the job** on any **high** or **critical** advisory. There is **no allow-list, no ignore file, and no `|| true`** on those two workspaces. Residual **moderate** advisories are permitted, and every one of them is enumerated below with a written exposure analysis.

### Time-boxed B policy — `apps/mobile` only (2026-08-13 → **2026-09-13**)

Thierry GO 2026-08-13. Option C (`--omit=dev`) is void — prod deps pull Metro and 19 highs remain. To unblock CRIT-01 (#345) without bumping Expo SDK:

- **`npm audit (apps/mobile)` runs on every PR but does not fail the job** until **2026-09-13** (or until the 19 highs are remediated within SDK 54).
- Residual ownership: issue **#353** on epic **#348**.
- **Expire action:** on or before 2026-09-13, either (a) restore blocking mobile audit with a green lockfile, (b) Thierry approves SDK 57, or (c) a judgment-tier rewrite with documented carve-outs. Silent extension is forbidden.
- Backend/web blocking behaviour is unchanged.

## Why the check was permanently red before HARD-1

The old job audited `backend` and `app`. Two things were wrong with that, and together they produced the worst possible outcome — a red check nobody could act on, guarding nothing that mattered:

1. **It audited a workspace that does not ship.** `app/` is the frozen legacy Expo client (root `CLAUDE.md`: *"LEGACY/frozen; do not build new features here"*), last touched 2026-06-22, and absent from `deploy.yml`. It carried **33 advisories including 1 critical**, none of which were fixable without breaking a codebase that is deliberately not maintained. That is an unresolvable red check by construction.
2. **It did not audit the workspace that matters most.** `web/` — live on Vercel at `app.7ei.ai` — was never audited. It was carrying **two CRITICAL Clerk authorization-bypass advisories** (below). The check that was failing every day was failing for the wrong repository, while the real vulnerability sat unreported.

A permanently-red check is not a safety measure. It is a training exercise in ignoring red, and it is a direct reason `--admin` squash-merging past failing checks became routine here (see root `CLAUDE.md` on branch protection). Fixing it was a prerequisite for enabling branch protection at all — protection turned on over a red check would block every merge.

**The fix increases coverage.** Dropping the frozen `app/` and adding live `web/` + `apps/mobile/` means CI now audits 3 shipping workspaces instead of 1 shipping + 1 dead.

### On excluding `app/`

This is the one exclusion in the policy, so it deserves to be defended explicitly rather than buried. `app/` is excluded because **it is not deployed to anyone** — not because its findings are inconvenient. The moment `app/` ships again, it goes back in the matrix, and its 33 advisories become blocking work. If that workspace is genuinely dead it should be deleted from the repo, which would make this exception unnecessary; that is a separate call for the operator and is deliberately not made here.

---

## Disposition — every advisory, before and after

### `backend` — 8 → 4 (was: 4 high + 4 moderate · now: 4 moderate) ✅ green at `high`

| Package | Sev | Direct? | Advisory | Disposition |
|---|---|---|---|---|
| `fast-uri` | **HIGH** | transitive | [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) — host confusion via backslash authority | ✅ **FIXED** — `npm audit fix`, 3.1.4 → 3.1.5 |
| `find-my-way` | **HIGH** | transitive | [GHSA-c96f-x56v-gq3h](https://github.com/advisories/GHSA-c96f-x56v-gq3h) — DDoS with HTTP/2 | ✅ **FIXED** — `npm audit fix`, 9.6.0 → 9.7.0 (Fastify router) |
| `pdfjs-dist` | **HIGH** | transitive | [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j) — arbitrary JS on malicious PDF | ✅ **FIXED** — `officeparser` 7.1.0 → 7.5.1 + `overrides.pdfjs-dist: 6.2.108` |
| `form-data` | **HIGH** | transitive | [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) — CRLF injection via unescaped multipart field names | ✅ **FIXED** (HARD-1) — 4.0.5 → 4.0.6, lockfile-only |
| `esbuild` | moderate | transitive | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | ⚠️ **ACCEPTED** — see exposure note E1 |
| `@esbuild-kit/core-utils` | moderate | transitive | depends on vulnerable `esbuild` | ⚠️ ACCEPTED (same chain, E1) |
| `@esbuild-kit/esm-loader` | moderate | transitive | depends on `@esbuild-kit/core-utils` | ⚠️ ACCEPTED (same chain, E1) |
| `drizzle-kit` | moderate | **direct** (dev) | depends on `@esbuild-kit/esm-loader` | ⚠️ ACCEPTED (same chain, E1) |

### `web` — 3 → 0 high (was: 3 high · now: 0 high) ✅ green at `high`

| Package | Sev | Direct? | Advisory | Disposition |
|---|---|---|---|---|
| `next` | **HIGH** | **direct** | [GHSA-m99w-x7hq-7vfj](https://github.com/advisories/GHSA-m99w-x7hq-7vfj) and related Server Actions / cache-confusion advisories (reclassified since HARD-1) | ✅ **FIXED** — 15.5.19 → 15.5.23 |
| `nanoid` | **HIGH** | transitive | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) (new since initial #347 pass) | ✅ **FIXED** — `npm audit fix` → 3.3.18 |
| `postcss` | **HIGH** | transitive | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) and related source-map advisories (reclassified moderate→high since HARD-1) | ✅ **FIXED** — `overrides.postcss: ^8.5.26` (next@15.5.23 still pins 8.4.31) |
| `@clerk/nextjs` | **CRITICAL** | **direct** | [GHSA-vqx2-fgx2-5wq9](https://github.com/advisories/GHSA-vqx2-fgx2-5wq9) · [GHSA-w24r-5266-9c3c](https://github.com/advisories/GHSA-w24r-5266-9c3c) | ✅ **FIXED** (HARD-1) — 6.39.1 → 6.39.6 |

> **The Clerk finding is the headline of this PR.** Both criticals are *authorization bypasses* in the library that enforces route protection and organisation scoping on the live dashboard. This repo leans on exactly those mechanisms — Clerk middleware for route protection, and org-scoped role gates (`requireOrgRole`, the membership gates closed in #264/#265, the mass-assignment class closed in #333). An auth-bypass advisory in that layer is the highest-severity item found in this workstream. It was fixed by a patch-level bump inside the existing semver range, and CI would have surfaced it months earlier had `web/` been in the matrix.

### `apps/mobile` — 19 high / 0 critical ⚠️ informational until 2026-09-13 (time-boxed B)

**Regression since HARD-1:** npm advisory database reclassified several packages from moderate to **high** (`postcss`, `image-size` chain via Metro). The lockfile pins were unchanged; the gate turned red without a code change.

| Package / chain | Sev | Advisory (representative) | Fix npm offers | Disposition |
|---|---|---|---|---|
| `image-size` via `metro` / `@expo/metro` | **HIGH** | [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr), [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) | `expo@57` only — **forbidden** (SDK 54 ceiling) | ⚠️ **BLOCKED** — see exposure note E3 |
| `postcss` via `metro` | **HIGH** | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) (reclassified) | `expo@57` only | ⚠️ BLOCKED (E3) |
| `@solana-mobile/*` via `@clerk/clerk-js` | **HIGH** | wallet-adapter transitive chain | Clerk major downgrade or `expo@57` | ⚠️ BLOCKED — MC mobile does not use Solana wallets; chain is Clerk bundle bloat (E4) |
| `js-yaml`, `tar`, `undici` via `@expo/cli` | **HIGH** / critical | various | `expo@57` or overrides that break Expo 54 | ⚠️ BLOCKED pending Expo 54 patch or judgment-tier gate change |
| `brace-expansion`, `nanoid` | **HIGH** | transitive via RN/Metro | reclassified since HARD-1 | ⚠️ BLOCKED (E3) — same SDK 54 ceiling |

> **`npm audit --omit=dev --audit-level=high` exits 1** on the current lockfile (19 high) — verified 2026-08-13. Prod deps **`expo`**, **`react-native`**, and **`@clerk/clerk-expo`** transitively pull Metro/`@expo/cli`; `--omit=dev` does **not** exclude them. Option C is **void**. **Time-boxed B active:** CI job reports but does not fail until **2026-09-13** (Thierry GO 2026-08-13; tracked #353).

No changes were required and **the mobile lockfile was not touched** in the backend/web remediation PR. Pins verified intact: `expo ~54.0.36`, `react 19.1.0`, `react-dom 19.1.0`.

---

## Exposure notes for the accepted moderates

These are the *written justifications* the policy requires. Neither is reachable in production.

### E1 — `esbuild` dev-server advisories, via `drizzle-kit` **and `tsx`** (backend, 4 moderate)

**Why not fixed:** the only offered remedy is `npm audit fix --force` → `drizzle-kit@0.18.1`, a **major downgrade** from the pinned `^0.31.10`. That would break the migration tooling this project's schema workflow depends on (`src/db/setup.ts` is the migration convention). Forcing it trades a non-reachable advisory for a broken build — a strictly worse position.

**There are TWO vulnerable `esbuild` paths, and one of them ships to production.** Be precise about this, because the obvious-sounding justification is wrong:

```
node_modules/@esbuild-kit/core-utils/node_modules/esbuild   ← via drizzle-kit (dev tooling)
node_modules/tsx/node_modules/esbuild                       ← via tsx, the PROD ENTRYPOINT
```

`backend/Dockerfile` runs `RUN npm install` — **all** dependencies including devDependencies — and only sets `ENV NODE_ENV=production` *afterwards*, so that flag never prunes anything. Its own comment says so: *"Install ALL dependencies (tsx is in devDeps, needed to run TypeScript)"*. The container then starts with `CMD ["npx", "tsx", "src/index.ts"]`. So **`tsx`, and the vulnerable `esbuild` underneath it, are installed in the Fly image and are actively running in production.** Any claim that these packages "are not installed in the deployed image" is false.

**Actual exposure: none — but on reachability, not on absence.** Both advisories require **`esbuild`'s development HTTP server** (the `serve` API):
- [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) — any website can send requests to that dev server and read the responses. **`tsx` never invokes `serve`.** It uses only esbuild's **transform** API to compile TypeScript in-process; it does not open a socket, and no HTTP server from esbuild is ever started in this image. `drizzle-kit` likewise uses esbuild to transpile its config, not to serve.
- [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) — arbitrary file read, **Windows-only**. Production is `node:22-alpine` (Linux) and development is macOS, so this leg cannot apply on any machine that runs this code.

So the package is present and executing; the *vulnerable function* is not called. That is a weaker guarantee than "not installed" and it is the honest one.

**Re-evaluate if:** anything in the backend starts an esbuild dev server or `tsx` gains a watch/serve mode that is used in the image; a `drizzle-kit` or `tsx` release resolves the chain forward; or the Dockerfile switches to `npm ci --omit=dev` with a compiled build step (which would remove the prod leg entirely and is the cleanest long-term fix). Worth re-checking each dependency sweep.

### E2 — `postcss` / `nanoid` via `next` (web) — **FIXED 2026-08-13**

Was accepted as moderate at HARD-1; advisory database later reclassified the chain to **high**. `next@15.5.23` alone still pinned `postcss@8.4.31` and `nanoid@3.3.11` after new advisories ([GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv)). Resolved by `npm audit fix` (nanoid → 3.3.18) + **`overrides.postcss: ^8.5.26`**. Build verified green. Historical exposure analysis (build-time only, no tenant CSS input) remains valid for the period it was accepted.

### E3 — `image-size` / Metro build toolchain (`apps/mobile`, SDK 54 blocked)

**Why not fixed:** npm's only offered remedy is **`expo@57`**, which violates the SDK 54 / Expo Go ceiling (root `CLAUDE.md`). The `image-size` advisory scope is `*` (all published versions flagged).

**Actual exposure: none in the shipped Hermes bundle** — `image-size` runs in Metro during bundling. **However, `--omit=dev` does not clear the gate:** `expo` and `react-native` are production dependencies and npm counts their Metro/`@expo/cli` transitive tree in prod-only audits (19 high as of 2026-08-13; matches CI run on #352).

**Re-evaluate if:** Expo SDK 54 receives a Metro bump; SDK 57 is approved; or **2026-09-13** expires (restore blocking gate or judgment-tier rewrite).

### E4 — `@solana-mobile/*` via `@clerk/clerk-js` (mobile, transitive)

**Why not fixed:** Pulled by Clerk for optional wallet UI MC mobile never uses. npm offers Clerk major downgrades or `expo@57` — neither acceptable.

**Actual exposure: none.** No MC mobile code imports `@solana/*`.

---

## How to re-verify locally

```bash
cd backend    && npm audit --audit-level=high; echo "backend exit: $?"   # expect 0
cd web        && npm audit --audit-level=high; echo "web exit: $?"       # expect 0
cd apps/mobile && npm audit --audit-level=high; echo "mobile exit: $?"   # expect 1 (19 high; CI informational until 2026-09-13)
cd apps/mobile && npm audit --omit=dev --audit-level=high; echo "mobile prod-only exit: $?"   # expect 1 (option C void)
```

Full (informational) picture including the accepted moderates: drop `--audit-level=high`.

## Triage rule for a NEW advisory

1. **Is it high or critical?** CI is already red. It is a merge blocker — treat it as such.
2. **Does `npm audit fix` resolve it without `--force`?** Take it, then re-run the full gates for that workspace (`npm test`, `npm run typecheck`, `npm run build` / `npm run export`, plus `npm run evals` for backend). For `apps/mobile`, additionally confirm the SDK-54 / React-19.1.0 pins did not move — back the fix out if they did.
3. **Does it need a breaking bump?** Do **not** force it silently. Add a row to the disposition table and an exposure note here, and either fix it properly or state plainly why it cannot be. "Unfixable" always requires a reachability argument, never just a version constraint.
4. **Never** add `|| true`, `--audit-level=critical`, or an ignore file to make **backend/web** green. The one documented exception is the **time-boxed B** mobile informational job (§ B-policy above) — it must carry an expire date and a tracking issue, not be silent.
