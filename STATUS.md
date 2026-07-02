# 7Ei Mission Control — Status

_Last updated: 2026-07-02 · auto-maintained by the build agent (bumped at each story/phase)._

**Live:** backend on Fly (`7ei-backend`), web on Vercel (`app.7ei.ai`), Turso DB. All PRs merged to `main`.
Full write-up in the shared vault: `07-Agents/STATUS-Mission-Control-2026-07-02.md` · plan: `01-Projects/Paperclip-Gap-Analysis.md`.

## Paperclip gap-bridge — 5 / 5 phases shipped
| Epic | Phase | Status |
|---|---|---|
| MCA-47 | 1 · Execution core (atomic checkout, run telemetry, deps, overspend) | ✅ Done |
| MCA-52 | 2 · Adapters (http executor, presets) + `7ei-mc` CLI | ✅ Done |
| MCA-56 | 3 · Attachments/work-products, ticket timeline, workspace preview URLs | ✅ Done |
| MCA-60 | 4 · Execution policies + rollback, permissions, run-tokens, plugin jobs | ✅ Done |
| MCA-65 | 5 · Orchestration evals, PWA, self-host Docker | ✅ Done |

## UI (epic MCA-69)
| Story | Status |
|---|---|
| MCA-71 · Task detail drawer (timeline/attachments/runs/comments) | ✅ Done |
| MCA-72 · Governance panel (policies, permissions, revisions/rollback) | ✅ Done |
| MCA-70 · Design tokens + shared primitives | ⬜ To do |
| MCA-73 · Accessibility + responsive/mobile | ⬜ To do |

## Open items
Clerk **production** instance · Google consent-screen scopes (Gmail/Calendar) · rotate exposed NVIDIA + vault tokens ·
OpenClaw runs on this Mac (move to Mac mini when desired).

## Verify
`cd backend && npm test` · `npm run evals` · `cd web && npm run build` · self-host: `docker compose up -d --build`.
