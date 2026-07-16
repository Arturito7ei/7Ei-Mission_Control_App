# 7Ei Mission Control — root guide

> Companions: `HANDOFF.md` (fresh-session kickoff + verification), `STATUS.md` (what's shipped — don't duplicate it here), `GO-LIVE.md` (pending user-only console actions). Layered guides load automatically when you work in a subsystem: `backend/CLAUDE.md`, `web/CLAUDE.md`, `adapters/CLAUDE.md`. Verify claims against the repo before acting on them.

## Layer 0 — 7Ei OS

This repo is part of the 7Ei agent organisation. Cross-agent protocols live in [`Arturito7ei/7Ei_OS`](https://github.com/Arturito7ei/7Ei_OS) (memory, governance, coordination) — mirrored in the vault at `Protocols/7Ei_OS/`. Shared memory/knowledge: Obsidian vault `/Users/artutito/7Ei-MC_TARCO` (repo `Arturito7ei/7Ei-MC_TARCO`, content under `vault/`). Instructions live in git; knowledge lives in the vault — don't blur the two.

## Quick orientation

```
Monorepo (npm workspaces)
├── backend/   Node 22 · TypeScript · Fastify · Drizzle · Turso — Fly `7ei-backend` (fra)  → backend/CLAUDE.md
├── web/       Next.js 15 App Router — Vercel (app.7ei.ai), Clerk — PRIMARY UI            → web/CLAUDE.md
├── apps/mobile/   React Native (Expo SDK 54) — iPhone remote, SHIPPING → mirror web here (below)
├── apps/desktop/  Electron shell packaging the mesh (Epic H)
├── app/       React Native (Expo) — LEGACY/frozen; do not build new features here (≠ apps/mobile)
├── adapters/  External BYO-agent runtimes (OpenClaw, Cursor, presets)                     → adapters/CLAUDE.md
├── cli/       `7ei-mc` zero-dep Node CLI over the agent API
├── evals/     Orchestration eval harness (11 scenarios)
└── docs/      ADRs, API.md, DEPLOY.md, sprint plans
```

**Backend live at:** https://7ei-backend.fly.dev (`/api/health` → 200, `db: connected`)

## Verify before merging anything

```bash
cd backend && npm test && npm run evals   # zero failures + 11/11 — the invariant
cd web && npm run build
```

## Web ⇄ mobile parity (standing rule — applies to every UI story)

**Any web/desktop feature or UX change must be mirrored to `apps/mobile/` in the same PR, or in one that immediately follows.** The phone is not a side project: it is the operator's remote, and a gap there is a broken promise, not a backlog item. Say which of the three you did — mirrored, deferred to a named story, or **N/A with a reason** (a web-only surface — e.g. the reactor — has no phone peer; don't invent one to have something to mirror).

- **The phone is a thin REST client to the SAME hosted backend**, so a backend change usually serves both already — mirroring is normally client work only. Reuse the web's exact contract (same endpoint, same field names, same limits) so behaviour is identical.
- **Mobile mirrors stay additive, Expo SDK 54, and bootable in Expo Go.** SDK 54 is the App Store Expo Go ceiling — **do not bump it**; take dep versions from `apps/mobile/node_modules/expo/bundledNativeModules.json`, keep the `react`/`react-dom` exact pins.
- **Mirror the decision, don't re-invent it.** Metro can't import from `web/`, so shared limits/lists get hand-copied — then pin the copy with a test that imports the web module and asserts they agree (`src/navModel.test.ts`, `src/attach.test.ts`). Copy without a tripwire = silent drift.
- **Verify:** `cd apps/mobile && npm test && npm run typecheck && npm run export`. **CI now runs this too** — the `Mobile (apps/mobile)` job in `.github/workflows/ci.yml` fires on every PR to `main` (and on push to `main`), running the same three gates off `apps/mobile`'s own lockfile via `npm ci`. It's what makes the parity tripwires bite: before it existed they fired into the void and a web nav change (#286) landed red on `main` unseen. ⚠️ **But it is not yet BLOCKING**: `main` has **no branch protection**, so no check gates a merge — and our standing `--squash --admin` convention bypasses protection even once it's added. Until protection lands *and* admin-bypass stops being routine, a red Mobile job only *reports*; still run the command yourself, and read the job before merging.
- Plan + as-built log: `docs/DESIGN-mobile-parity.md` (§6.2 is the worked example).

## Conventions (cross-cutting)

- One PR per story, squash-merged with `--admin`; merge auto-deploys Fly + Vercel. Keep GitHub Actions green.
- Update `STATUS.md` at each shipped story; mirror milestones to the vault (`07-Agents/`).
- Jira: Atlassian Rovo OAuth, cloudId `5dadc567-085a-4cd8-99a3-c0bd9886fee9`, projects MCA + OS.

## DO NOT (cross-cutting)

- Do NOT paste live secrets into chat, code, or docs — set them via Cockpit → Secrets or Fly secrets.
- Do NOT touch `.github/workflows/` unless a task explicitly requires it.
- Do NOT add npm packages without checking if a built-in or existing dep covers the need.
- Do NOT touch the live adapter (`~/.openclaw/mc-adapter/`), rotate credentials, or change vendor-console settings without asking the user.

<!-- Maintainer note: keep this file <70 lines. Subsystem detail belongs in backend|web|adapters/CLAUDE.md; state belongs in STATUS.md. -->
