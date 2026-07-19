# npm audit — policy, disposition, and standing exceptions

> Owner: hardening epic, stage 1 (HARD-1). Companion CI job: `.github/workflows/security.yml` → `audit`.
> Update this file in the SAME PR as any change to that job. A threshold change with no entry here is a regression.

## The policy in one paragraph

CI runs `npm audit --audit-level=high` in **every workspace that ships** — `backend`, `web`, `apps/mobile` — and fails the job on any **high** or **critical** advisory. There is **no allow-list, no ignore file, and no `|| true`**. The job is green because the high/critical findings were actually fixed, not because they were suppressed. Residual **moderate** advisories are permitted, and every one of them is enumerated below with a written exposure analysis; they are all dev-only toolchain paths with no production reachability. If a moderate ever becomes production-reachable, it gets fixed or the threshold drops — it does not get an exception.

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

### `backend` — 5 → 4 (was: 1 high + 4 moderate · now: 4 moderate) ✅ green at `high`

| Package | Sev | Direct? | Advisory | Disposition |
|---|---|---|---|---|
| `form-data` | **HIGH** | transitive | [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) — CRLF injection via unescaped multipart field names | ✅ **FIXED** — `npm audit fix`, 4.0.5 → 4.0.6, lockfile-only |
| `esbuild` | moderate | transitive | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | ⚠️ **ACCEPTED** — see exposure note E1 |
| `@esbuild-kit/core-utils` | moderate | transitive | depends on vulnerable `esbuild` | ⚠️ ACCEPTED (same chain, E1) |
| `@esbuild-kit/esm-loader` | moderate | transitive | depends on `@esbuild-kit/core-utils` | ⚠️ ACCEPTED (same chain, E1) |
| `drizzle-kit` | moderate | **direct** (dev) | depends on `@esbuild-kit/esm-loader` | ⚠️ ACCEPTED (same chain, E1) |

### `web` — 7 → 3 (was: 2 critical + 3 high + 2 moderate · now: 3 moderate) ✅ green at `high`

| Package | Sev | Direct? | Advisory | Disposition |
|---|---|---|---|---|
| `@clerk/nextjs` | **CRITICAL** | **direct** | [GHSA-vqx2-fgx2-5wq9](https://github.com/advisories/GHSA-vqx2-fgx2-5wq9) — middleware-based route-protection bypass · [GHSA-w24r-5266-9c3c](https://github.com/advisories/GHSA-w24r-5266-9c3c) — authz bypass combining org/billing/reverification checks | ✅ **FIXED** — 6.39.1 → 6.39.6, within the existing `^6.0.0` range |
| `@clerk/shared` | **CRITICAL** | transitive | same two advisories | ✅ **FIXED** — 3.47.3 → 3.47.8 |
| `@clerk/backend` | HIGH | transitive | GHSA-w24r-5266-9c3c | ✅ **FIXED** — 2.33.1 → 2.33.6 |
| `@clerk/clerk-react` | HIGH | transitive | GHSA-w24r-5266-9c3c | ✅ **FIXED** — 5.61.4 → 5.61.9 |
| `js-cookie` | HIGH | transitive | [GHSA-qjx8-664m-686j](https://github.com/advisories/GHSA-qjx8-664m-686j) — per-instance prototype hijack → cookie-attribute injection | ✅ **FIXED** — 3.0.5 → 3.0.7 |
| `postcss` | moderate | transitive | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) — XSS via unescaped `</style>` in stringify output | ⚠️ **ACCEPTED** — see exposure note E2 |
| `next` | moderate | **direct** | depends on vulnerable `postcss` | ⚠️ ACCEPTED (same chain, E2) |
| `@clerk/nextjs` | moderate | **direct** | depends on vulnerable `next` (distinct from the CRITICAL rows above — same package, different advisory chain) | ⚠️ ACCEPTED (same chain, E2) |

> **The Clerk finding is the headline of this PR.** Both criticals are *authorization bypasses* in the library that enforces route protection and organisation scoping on the live dashboard. This repo leans on exactly those mechanisms — Clerk middleware for route protection, and org-scoped role gates (`requireOrgRole`, the membership gates closed in #264/#265, the mass-assignment class closed in #333). An auth-bypass advisory in that layer is the highest-severity item found in this workstream. It was fixed by a patch-level bump inside the existing semver range, and CI would have surfaced it months earlier had `web/` been in the matrix.

### `apps/mobile` — 0 high/critical ✅ already green at `high`

No changes were required and **the mobile lockfile was not touched**. Pins verified intact after the work: `expo ~54.0.36`, `react 19.1.0`, `react-dom 19.1.0` — the App Store Expo Go SDK-54 ceiling holds (see the standing rule in root `CLAUDE.md`).

> ### ⚠️ Known future risk — mobile has no permitted remedy
>
> `apps/mobile` currently carries **26 moderate** advisories. Every one of them offers the same fix: **`expo@57`** (plus `@clerk/clerk-expo@2.19.11`, `expo-auth-session@57`, `expo-notifications@57`). That upgrade is **forbidden** — SDK 54 is the App Store Expo Go ceiling and the standing rule in root `CLAUDE.md` is explicit that it must not be bumped (see also the `expo-go-app-store-sdk-ceiling` finding: "latest on npm" ≠ loadable by Expo Go).
>
> **The consequence to plan for:** if *any* of those 26 is ever reclassified from moderate to **high**, the `npm audit (apps/mobile)` job goes red and **there is no permitted fix** — the only remedy npm offers is the one bump we are not allowed to make. Once branch protection lands (the next hardening stage), that state would **block every merge in the repo**, not just mobile ones.
>
> This is recorded, not solved. If it happens, the options are, in order of preference: (a) check whether the specific advisory is reachable in a React Native runtime at all — most of these are Metro/CLI/build-time packages that never ship in the Hermes bundle — and if not, add it as the *first* justified exception to the no-allow-list policy, documented here; (b) pin the single offending transitive dep via `overrides` if it can be moved without touching `expo`; (c) as a last resort, scope the mobile audit to `--omit=dev`, which is a real narrowing of coverage and must be argued here before it is done. Do **not** resolve it by bumping Expo, and do **not** resolve it by deleting the job.

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

### E2 — `postcss` XSS via unescaped `</style>`, via `next` (web, 3 moderate)

**Why not fixed:** npm's only offered remedy is `next@9.3.3` — a **major downgrade** from `15.5.19`, i.e. abandoning the App Router the entire `web/` workspace is built on. Categorically not an option. No forward fix exists at the time of writing.

**Actual exposure: none.** The advisory requires an attacker to control **CSS source text that PostCSS then stringifies**. In this workspace PostCSS runs **at build time only**, over first-party stylesheets and Tailwind output committed to the repo, so no user- or tenant-supplied content ever reaches it.

One nuance worth stating rather than glossing, because `web/` *does* emit a `<style>` tag at render time: `app/layout.tsx:52` writes `<style id="theme-tokens" dangerouslySetInnerHTML={{ __html: themeCss() }} />`. That is **not** a PostCSS path and it is **not** attacker-influenced — `themeCss()` (`app/dashboard/tokens.ts:195`) takes **no arguments** and simply serializes a hardcoded first-party `themes` map into `k:v` declarations. React writes the string straight into the document; PostCSS is not involved at request time at all. So the render-time CSS carries no tenant input, and the build-time CSS that PostCSS *does* process is entirely authored by us. Neither half satisfies the advisory's precondition.

**Re-evaluate if:** `web/` ever gains runtime CSS compilation or accepts user-supplied styles, or when a `next` release ships a patched `postcss` (this one should resolve itself on a routine Next bump — check on each upgrade).

---

## How to re-verify locally

```bash
cd backend    && npm audit --audit-level=high; echo "backend exit: $?"   # expect 0
cd web        && npm audit --audit-level=high; echo "web exit: $?"       # expect 0
cd apps/mobile && npm audit --audit-level=high; echo "mobile exit: $?"   # expect 0
```

Full (informational) picture including the accepted moderates: drop `--audit-level=high`.

## Triage rule for a NEW advisory

1. **Is it high or critical?** CI is already red. It is a merge blocker — treat it as such.
2. **Does `npm audit fix` resolve it without `--force`?** Take it, then re-run the full gates for that workspace (`npm test`, `npm run typecheck`, `npm run build` / `npm run export`, plus `npm run evals` for backend). For `apps/mobile`, additionally confirm the SDK-54 / React-19.1.0 pins did not move — back the fix out if they did.
3. **Does it need a breaking bump?** Do **not** force it silently. Add a row to the disposition table and an exposure note here, and either fix it properly or state plainly why it cannot be. "Unfixable" always requires a reachability argument, never just a version constraint.
4. **Never** add `|| true`, `--audit-level=critical`, or an ignore file to make the job green. Getting to green by lowering the bar is what created the original problem.
