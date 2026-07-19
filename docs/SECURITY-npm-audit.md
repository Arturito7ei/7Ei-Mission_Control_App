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

> **The Clerk finding is the headline of this PR.** Both criticals are *authorization bypasses* in the library that enforces route protection and organisation scoping on the live dashboard. This repo leans on exactly those mechanisms — Clerk middleware for route protection, and org-scoped role gates (`requireOrgRole`, the membership gates closed in #264/#265, the mass-assignment class closed in #333). An auth-bypass advisory in that layer is the highest-severity item found in this workstream. It was fixed by a patch-level bump inside the existing semver range, and CI would have surfaced it months earlier had `web/` been in the matrix.

### `apps/mobile` — 0 high/critical ✅ already green at `high`

No changes were required and **the mobile lockfile was not touched**. Pins verified intact after the work: `expo ~54.0.36`, `react 19.1.0`, `react-dom 19.1.0` — the App Store Expo Go SDK-54 ceiling holds (see the standing rule in root `CLAUDE.md`).

---

## Exposure notes for the accepted moderates

These are the *written justifications* the policy requires. Neither is reachable in production.

### E1 — `esbuild` dev-server advisories, via `drizzle-kit` (backend, 4 moderate)

**Why not fixed:** the only offered remedy is `npm audit fix --force` → `drizzle-kit@0.18.1`, a **major downgrade** from the pinned `^0.31.10`. That would break the migration tooling this project's schema workflow depends on (`src/db/setup.ts` is the migration convention). Forcing it trades a non-exposed dev advisory for a broken build — a strictly worse position.

**Actual exposure: none in production.** Both advisories describe attacks on **`esbuild`'s development HTTP server** — one lets any website send requests to that dev server and read responses, the other is an arbitrary file read *on Windows*. Concretely:
- `drizzle-kit` is a **devDependency**. It is not installed in, and not invoked by, the deployed Fly image.
- The vulnerable code path is the esbuild **dev server**, which this repo never starts — `drizzle-kit` uses esbuild to transpile config, not to serve.
- The Windows-specific advisory cannot apply: the deploy target is Linux (Fly) and development is macOS.

**Re-evaluate if:** `drizzle-kit` ever becomes a production dependency, or a `drizzle-kit` release lands that resolves the `@esbuild-kit/*` chain forward instead of backward. Worth re-checking each dependency sweep.

### E2 — `postcss` XSS via unescaped `</style>`, via `next` (web, 3 moderate)

**Why not fixed:** npm's only offered remedy is `next@9.3.3` — a **major downgrade** from `15.5.19`, i.e. abandoning the App Router the entire `web/` workspace is built on. Categorically not an option. No forward fix exists at the time of writing.

**Actual exposure: none.** The advisory requires an attacker to control **CSS source text that PostCSS then stringifies**. In this workspace PostCSS runs **at build time only**, over first-party stylesheets and Tailwind output committed to the repo. There is no path by which user- or tenant-supplied content reaches PostCSS: the build inputs are static files under version control, and nothing in `web/` compiles CSS at request time. An advisory whose precondition is attacker-controlled build-time CSS does not apply to a build whose CSS is entirely authored by us.

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
