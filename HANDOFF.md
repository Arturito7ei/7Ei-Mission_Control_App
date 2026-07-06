# Mission Control — Session Handoff (for a fresh agent)

_Last updated: 2026-07-06 (post W2 work surface). Paste the "Kickoff prompt" below into a new session; the rest of this doc is the detail it should verify._

## Kickoff prompt

You're taking over the **7Ei Mission Control App** — an AI-agent "virtual office" control plane (our flagship). Read `HANDOFF.md`, `STATUS.md`, `CLAUDE.md` (layered — subsystem guides load on demand), `GO-LIVE.md`, and `docs/DESIGN_SYSTEM.md` (v2 — binding design rules incl. the red-green-colorblind constraint). Run the verification commands in HANDOFF.md and flag divergence. Current work: four epics are filed and sequenced — MCA-82 Theme (T1 ✅, T2 glass chrome ✅, **T3 hex sweep = NEXT per plan order**), MCA-83 Work surface/failure UX (W1 recovery cards ✅, W2 blocker chips + next-up + sub-task cost rollups ✅; W3 thread w/ wake-on-comment later), MCA-84 Visibility, MCA-85 DX. Plans: repo `docs/DESIGN_SYSTEM.md` + vault `01-Projects/Paperclip-Gap-Analysis-v2-2026-07-06.md`. Ship per convention (one PR per story, tests+evals+build green, squash --admin, STATUS.md bump, Jira transition). Continue with W2 unless I say otherwise. Ask before anything touching the live OpenClaw adapter, credentials, or vendor consoles.

## Repo + stack

- **Path:** `/Users/artutito/Developer/7Ei-Mission_Control_App` (GitHub `Arturito7ei/7Ei-Mission_Control_App`).
- **backend/** — Fastify + Drizzle + Turso/libSQL, deployed on Fly app `7ei-backend` (region fra).
- **web/** — Next.js 15 on Vercel (`app.7ei.ai`), Clerk auth on a **dev** instance.
- **adapters/** — external BYO-agent runtime (`openclaw/`, `mac-mini/`, `presets/`).
- **cli/** — `7ei-mc` zero-dep Node CLI over the agent API. **evals/** — orchestration eval harness.

## State (verify each)

- Paperclip-parity gap-bridge: **5/5 phases shipped** — epics MCA-47 (execution core: atomic checkout, run telemetry, deps, overspend), MCA-52 (adapter http-executor + presets + CLI), MCA-56 (attachments/work-products, ticket timeline, workspace preview URLs), MCA-60 (execution policies + config rollback + per-agent permissions + HMAC run-tokens + plugin jobs), MCA-65 (orchestration evals + PWA + self-host Docker).
- UI epic **MCA-69 complete** (MCA-70/71/72/73): design tokens (`web/app/dashboard/tokens.ts`), task drawer, governance panel, a11y/responsive.
- Go-live hardening (**PR #147**): OpenClaw adapter (`adapters/openclaw/mc_adapter.py`) reads `MC_LLM_API_KEY` from the encrypted secret store at boot (no plaintext key on disk); `adapters/mac-mini/setup.sh` one-command installer; `GO-LIVE.md` runbook.
- Hardened adapter deployed to the laptop's live `~/.openclaw/mc-adapter/` on 2026-07-02 (backup: `mc_adapter.py.bak-*`). **Still pending:** key rotation (then strip `MC_LLM_API_KEY` from `mc.env`) and the move to the Mac mini — see GO-LIVE.md §3–4.
- Shared-memory sprint (2026-07-02 evening, proposal: vault `02-Architecture/Shared-Memory-Upgrade-2026-07-02.md`): **MCA-74** all.ts split into domain route modules + `services/push.ts` (PR #148); **MCA-75** memory bus — session-summary endpoint, org+agent long-term vault memory injected into `buildSystemPrompt()`, nightly KV export (PR #149); **MCA-76** weekly consolidation routine, Sun ≥04:00 UTC (PR #150). Backend now 448 tests. Vault has per-agent namespaces `Memory/agents/<slug>/`. **All memory-bus features dormant until `GITHUB_VAULT_TOKEN` is set** (GO-LIVE §3b).
- CLAUDE.md is layered: slim root + `backend/`, `web/`, `adapters/` files (keep root <70 lines; state belongs in STATUS.md, not CLAUDE.md).
- **7Ei_OS PR #3 open** (protocols: MC as primary coordination + memory bus) — human review required; after merge, re-sync the vault `Protocols/7Ei_OS/` mirror.
- UI overhaul epic MCA-78 COMPLETE (2026-07-03/06): MCA-77 connectors replace-token/pills, MCA-79 foundation (density/text/space tokens, `dashboard/ui.tsx` primitives, `web/lib/api.ts` client), MCA-80 Cockpit split (129-line root + 13 `cockpit/` components), MCA-81 KPI strip + skeletons + consolidated Google card + gear settings (backend `GOOGLE_CONNECTOR_CONFIG` config-as-secret + GET/PUT `/connectors/:id/config`). Backend 460 tests.
- Paperclip gap analysis v2 + live-instance teardown (2026-07-06): vault `01-Projects/Paperclip-Gap-Analysis-v2-2026-07-06.md`. Their strength = failure/recovery UX; their Memory is still roadmap (we're live — press with R4). Epics filed: MCA-83 W, MCA-84 V, MCA-85 D.
- 7Ei theme (design system v2, `docs/DESIGN_SYSTEM.md`): **MCA-86 T1 shipped** — light+dark CSS-variable themes, ThemeProvider + toggle, colorblind-safe statuses (⚠ user is red-green colorblind: red never a CTA, always iconed; active=purple), official 7-hexagon mark top-left (`web/public/7ei-mark.svg`). **T2 glass chrome shipped** — `.mc-glass` utility (translucent `--glass` + 16px blur, solid `--s1` `@supports` fallback) on sidebar/TaskDrawer/all cockpit modals; new `web/app/dashboard/CommandPalette.tsx` (⌘K, keyboard-first, grouped Navigate+Theme commands, built to be extended by Epic V); tokenized `--shadow-modal`/`--shadow-drawer`. **W1 recovery cards shipped** (PR TBD) — `services/recovery.ts` `buildRecovery()` + `GET /api/tasks/:id/recovery`, `system_notice` comments on failure (new `task_comments.kind`), `web/app/dashboard/RecoveryCard.tsx` at the top of TaskDrawer (red left border + ⚠, owner/source-run/evidence/next-action, Retry-run + Add-a-note, open-until-decision), TaskBoard ⚠ on failed/blocked. **W2 work surface shipped** — new `services/worksurface.ts` (`nextUp`/`readyQueue` + `rollupCost`, pure/tested); `buildRecovery()` emits reasoned `blockers` chips (upstream title+status, open-first); `/subtasks`→`{ subtasks, rollup }`, `/cockpit`→`nextUp`; RecoveryCard blocker chips, TaskDrawer sub-task cost roll-up + header total, TaskBoard "Next up" banner + head-card flag. Backend 482 tests. **NEXT per plan order: T3** — hex sweep (cockpit `shared.tsx` domain colors → semantic/purple, contrast audit both modes, PWA `theme-color`); then V1. T3 still pending.
- Onboarding system live in 7Ei_OS (`onboarding/`, PRs #3+#4 merged); OpenClaw first graduate; memory bus verified E2E in prod on rotated credentials.
- Other candidates: R4 vault RAG (Turso native vectors — backend-only, parallelizable), R6 Sync-Registry automation, MCA-81 follow-ups (Google userinfo email at OAuth callback; executor driveScope), archive `app/` (Expo) decision.

## Conventions

One PR per story, squash-merged with `--admin` (auto-deploys Fly + Vercel). Idempotent ALTER migrations in `backend/src/db/setup.ts`. Pure-helper services with `node --test`. Boot test `backend/src/tests/boot.test.ts` guards route collisions. Keep `STATUS.md` current each shipped story; mirror milestones to the vault.

## Shared memory / vault

Canonical Obsidian vault: `/Users/artutito/7Ei-MC_TARCO` (repo `Arturito7ei/7Ei-MC_TARCO`, content under `vault/`). Latest status doc: `vault/07-Agents/STATUS-Mission-Control-2026-07-02.md`. Connectors: Jira via Atlassian Rovo OAuth (cloudId `5dadc567-085a-4cd8-99a3-c0bd9886fee9`, projects MCA + OS), Slack, Gmail.

## Open items — user-only console actions (see GO-LIVE.md)

1. Clerk **production** instance → `pk_live`/`sk_live` on Vercel.
2. Google consent-screen sensitive scopes (Gmail/Calendar) + add test user.
3. Rotate NVIDIA key → set as `MC_LLM_API_KEY` secret; rotate vault GitHub PAT.
4. Run `adapters/mac-mini/setup.sh` on the Mac mini; unload the laptop's launchd service.

## Verify before trusting the above

```bash
cd /Users/artutito/Developer/7Ei-Mission_Control_App
git log --oneline -15
cd backend && npm test && npm run evals
cd ../web && npm run build
curl -s https://7ei-backend.fly.dev/api/health   # expect 200, db: connected
```
