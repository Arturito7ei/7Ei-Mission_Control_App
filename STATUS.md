# 7Ei Mission Control — Status

_Last updated: 2026-07-02 (go-live hardening) · auto-maintained by the build agent (bumped at each story/phase)._

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
| MCA-70 · Design tokens + shared primitives | ✅ Done |
| MCA-73 · Accessibility + responsive/mobile | ✅ Done |

**MCA-69 (UI epic) — complete.**

## Go-live (runbook: `GO-LIVE.md`, PR #147)
Engineering done: adapter now pulls `MC_LLM_API_KEY` from the encrypted secret store at boot (no plaintext key on disk);
`adapters/mac-mini/setup.sh` one-command installer + launchd keep-alive; `GO-LIVE.md` documents each step.

Remaining **user-only** console actions (assistant can't create accounts / enter credentials / rotate tokens):
1. Clerk **production** instance + `pk_live`/`sk_live` on Vercel.
2. Google consent-screen sensitive scopes (Gmail/Calendar) + add test user.
3. Rotate NVIDIA key → set as `MC_LLM_API_KEY` secret; rotate vault GitHub PAT.
4. Run `adapters/mac-mini/setup.sh` on the Mac mini; unload the laptop's launchd service.

## Refactors
- **MCA-74** (2026-07-02): `routes/all.ts` (1,383 lines) split into domain modules (orgs/agents/tasks/projects/costs/skills/auth/credentials), `all.ts` kept as barrel; `sendPushNotification` + token map extracted to `services/push.ts` (fixes the routes→services inversion). No behavior change; 415 tests + 11/11 evals green.

## Verify
`cd backend && npm test` · `npm run evals` · `cd web && npm run build` · self-host: `docker compose up -d --build`.
