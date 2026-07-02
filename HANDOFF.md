# Mission Control — Session Handoff (for a fresh agent)

_Last updated: 2026-07-02 (evening — post shared-memory sprint). Paste the "Kickoff prompt" below into a new session; the rest of this doc is the detail it should verify._

## Kickoff prompt

You're taking over the **7Ei Mission Control App** — an AI-agent "virtual office" control plane (our flagship). Start by auditing what exists, then propose next steps. Don't take the doc's word for the state; verify against the repo and tell me where reality diverges. Read `HANDOFF.md`, `STATUS.md`, `CLAUDE.md`, and `GO-LIVE.md` at the repo root, run the verification commands in HANDOFF.md, then give me: (1) anything drifted or broken vs. the summary, (2) the highest-value next work, and (3) a short recommended plan. Ask before anything that touches the live OpenClaw agent, rotates a credential, or changes account settings.

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
- Next engineering candidates: R4 vault RAG (Turso native vectors, not Pinecone), web shared API client → CockpitPanel split, archive `app/` (Expo) decision, R6 Sync-Registry automation.

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
