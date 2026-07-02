# 7Ei Mission Control — root guide

> Companions: `HANDOFF.md` (fresh-session kickoff + verification), `STATUS.md` (what's shipped — don't duplicate it here), `GO-LIVE.md` (pending user-only console actions). Layered guides load automatically when you work in a subsystem: `backend/CLAUDE.md`, `web/CLAUDE.md`, `adapters/CLAUDE.md`. Verify claims against the repo before acting on them.

## Layer 0 — 7Ei OS

This repo is part of the 7Ei agent organisation. Cross-agent protocols live in [`Arturito7ei/7Ei_OS`](https://github.com/Arturito7ei/7Ei_OS) (memory, governance, coordination) — mirrored in the vault at `Protocols/7Ei_OS/`. Shared memory/knowledge: Obsidian vault `/Users/artutito/7Ei-MC_TARCO` (repo `Arturito7ei/7Ei-MC_TARCO`, content under `vault/`). Instructions live in git; knowledge lives in the vault — don't blur the two.

## Quick orientation

```
Monorepo (npm workspaces)
├── backend/   Node 22 · TypeScript · Fastify · Drizzle · Turso — Fly `7ei-backend` (fra)  → backend/CLAUDE.md
├── web/       Next.js 15 App Router — Vercel (app.7ei.ai), Clerk — PRIMARY UI            → web/CLAUDE.md
├── app/       React Native (Expo) — LEGACY/frozen; do not build new features here
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
