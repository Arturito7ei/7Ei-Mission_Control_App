# Mission Control — Session Handoff (for a fresh agent)

_Last updated: 2026-07-07 — **all four Paperclip-gap-bridge v2 epics complete** (MCA-82 Theme, MCA-83 Work surface, MCA-84 Visibility, MCA-85 DX), plus unplanned security hardening. The app is at a clean checkpoint, prepped for a **major update** (plan placeholder at the foot of this doc). Paste the "Kickoff prompt" below into a new session; the rest is detail to verify._

## Kickoff prompt

You're taking over the **7Ei Mission Control App** — an AI-agent "virtual office" control plane (our flagship). Read `HANDOFF.md`, `STATUS.md`, `CLAUDE.md` (layered — subsystem guides load on demand), `GO-LIVE.md`, and `docs/DESIGN_SYSTEM.md` (v2 — binding design rules incl. the red-green colorblind constraint). Run the verification commands at the foot of this doc and flag any divergence.

**Where things stand:** all four filed gap-bridge v2 epics are **shipped and merged to `main`** — MCA-82 Theme (T1/T2/T3 ✅), MCA-83 Work surface (W1–W5 ✅), MCA-84 Visibility (V1–V3 ✅), MCA-85 DX (D1/D2 ✅) — plus two unplanned security PRs (auth-scoping hardening #165, per-org webhook signing #166). Invariant is green: **588 backend tests · 11/11 evals · web build**. Backend healthy at v1.3.0.

**This is a checkpoint before a major update.** No feature epic is currently in flight. Read the **State of the app** section below to orient, then the **Incoming major update** placeholder for the plan the operator will drop in. Do **not** start new feature work off the old open-candidates list (R4 vault RAG / R6 Sync-Registry / MCA-81 follow-ups / `app/` archive) unless the operator directs it — the major-update plan supersedes it.

Ship per convention: one PR per story, tests + evals + build green, squash-merge with `--admin`, bump `STATUS.md`, mirror the milestone to the vault. Ask before anything touching the live OpenClaw adapter, credentials, or vendor consoles.

---

## State of the app

### Architecture snapshot
Monorepo (npm workspaces), all merged to `main`, auto-deploys on merge.

| Workspace | Stack | Deploy | Notes |
|---|---|---|---|
| **backend/** | Node 22 · TypeScript · Fastify · Drizzle · Turso/libSQL | Fly `7ei-backend` (fra) | 44 services, ~158 API paths / 26 tag groups, 588 tests. Live: https://7ei-backend.fly.dev |
| **web/** | Next.js 15 App Router · Clerk (dev instance) | Vercel `app.7ei.ai` | **PRIMARY UI.** Dashboard = `web/app/dashboard/` + 15 `cockpit/` section components |
| **adapters/** | Python OpenClaw runtime, mac-mini installer, presets | self-hosted | External BYO-agent execution. **Live adapter is off-limits without asking.** |
| **cli/** | `7ei-mc` zero-dep Node CLI over the agent API | npm `@7ei/mc` | `openapi`, `onboard`, task/agent verbs |
| **evals/** | Orchestration eval harness (11 scenarios) | CI | Part of the merge invariant |
| **app/** | React Native (Expo) | — | **LEGACY/frozen.** Archive decision still open; do not build here. |

**Data flow:** operators drive agents from the web Cockpit → backend tasks/runs → internal agents run the LLM loop in-process (`agent-executor.ts`), external agents execute via adapters and report back. The scheduler tick (1 min) drives heartbeat, watchdog, and routine sweeps. Turso is the system of record; the Obsidian vault holds shared memory/knowledge (not code).

### The four v2 epics — what shipped (detail in STATUS.md)
- **MCA-82 Theme** (#155/#156/#159): light+dark CSS-variable themes, `ThemeProvider` + three-state toggle, colorblind-safe status helpers, glass chrome (`.mc-glass`) on sidebar/drawer/modals, ⌘K command palette, no-raw-hex invariant, WCAG AA contrast audit both modes, theme-aware PWA `theme-color`.
- **MCA-83 Work surface / failure UX** (#157/#158/#161/#168/#169): W1 recovery cards + `system_notice` comments; W2 reasoned blocker chips + next-up + sub-task cost rollups; W3 task thread wake-on-comment; W4 declarative per-task watchdogs (edge-triggered); W5 ask-mode (`work_mode` execute|ask, single-turn answer to thread).
- **MCA-84 Visibility** (#160/#162/#163): V1 heartbeat 24h timeline (per-agent lanes); V2 tri-state approvals + inbox retry rows + board read receipts; V3 per-wake preflight cap + cheap-model config validation.
- **MCA-85 DX** (#164/#167): D1 self-describing API (`/api/openapi.json` auto-collected from Fastify's `onRoute` hook + `7ei-mc openapi`); D2 `llms.txt` + `npx @7ei/mc onboard`.
- **Security (unplanned)** (#165/#166): moved org/agent route groups behind Clerk (openapi.json had exposed public tenant-scoped routes) with an `auth-scoping.test.ts` lock-down; per-org webhook shared-secret verification (`services/webhook-auth.ts`, HMAC-per-org, gated on `WEBHOOK_SIGNING_SECRET`).

### Conventions (binding)
- **Ship via squash-merge with `--admin`** — one PR per story; merge auto-deploys Fly + Vercel. Keep GitHub Actions green.
- **`npm audit` CI check is known non-blocking** — it fails on every PR; merge with `--admin` once functional checks are green.
- **Pure-helper services** — business logic lives in `backend/src/services/*.ts` as pure, individually-tested helpers (`node --test`); routes stay thin and push schemas *into* services (routes→services is the only allowed import direction — a service must never import routes). New logic → new pure helper + tests.
- **Idempotent migrations** — schema changes are idempotent `ADD COLUMN` / `CREATE TABLE ... IF NOT EXISTS` in `backend/src/db/setup.ts` (currently ~69). No migration framework; boot re-applies safely.
- **Colorblind rule** (operator is red-green colorblind, `docs/DESIGN_SYSTEM.md`): red is **never** the lone CTA and is **always** iconed; status is never color-only (icon + text + shape); active = purple, done = ✓, paused = ⏸. Enforce in every new UI surface.
- **Docs bump per PR** — update `STATUS.md` at each shipped story; mirror milestones to the vault `07-Agents/`. Keep root `CLAUDE.md` slim (<70 lines); durable state goes in `STATUS.md`, not `CLAUDE.md`.
- **Boot guard** — `backend/src/tests/boot.test.ts` fails on route collisions; the openapi integration test asserts auth scoping.

### Current surface inventory
- **Backend services (44):** executor/runtime/router/scheduler core; governance + governance2 + budget + preflight; recovery/worksurface/thread/watchdogs/askmode (W-epic); timeline/receipts/approvals/inbox (V-epic); openapi/llms-txt (D-epic); webhook-auth (security); memory/agent-memory/consolidation/vector-search; connectors/google-auth/vault-connector/telegram-bot/outbound-webhooks; hiring/orgchart/orchestrator/goals/routines/plugins/portability/secrets/workspaces/runs/tickets/telemetry/push/heartbeat-engine/document-ingest.
- **Web dashboard:** `web/app/dashboard/` root + 15 `cockpit/` sections (AgentFleet, TaskBoard, Inbox, Budgets, Preflight, Timeline, Goals, Plugins, Secrets, Workspaces, OrgChart, StatsRow, HireDialog/AddAgentWizard, shared) + TaskDrawer, RecoveryCard, CommandPalette, ThemeProvider.
- **API:** ~158 paths / 26 tag groups, self-described at `GET /api/openapi.json`. Public surfaces: health, openapi, `llms.txt`, OAuth handshake, model catalogue, inbound webhook receivers (now secret-verified), agent-api (own token). Everything tenant-scoped is behind Clerk.
- **CLI:** `7ei-mc` — `openapi` (token-free), `onboard` (Clerk-session), task/agent verbs (agent token).

### Known debt & loose ends
- **Standing items** (see STATUS.md → Standing items): Jira transitions pending (Atlassian OAuth unavailable in build sessions); `WEBHOOK_SIGNING_SECRET` not yet set (receivers open in dev — re-register integrations after setting); 7ei.ai apex DNS for the `llms.txt` mirror; vault milestone mirror owed.
- **Go-live user-only actions** (`GO-LIVE.md` §1–4): Clerk **prod** keys (`pk_live`/`sk_live`) on Vercel; Google consent-screen sensitive scopes + test user; NVIDIA key rotation → `MC_LLM_API_KEY` secret + vault GitHub PAT rotation; Mac-mini adapter move (unload laptop launchd). **Memory-bus features stay dormant until `GITHUB_VAULT_TOKEN` is set.**
- **MCA-81 follow-ups:** bound-account email shows `—` until the OAuth callback stores userinfo; agent-executor Drive search doesn't yet honor `driveScope`.
- **`app/` (Expo):** legacy/frozen — archive-vs-keep decision unresolved.
- **Clerk is a dev instance** — prod instance is a go-live prerequisite.
- **Old open-candidates** (R4 vault RAG on Turso native vectors, R6 Sync-Registry automation): parked; superseded by the incoming major-update plan unless the operator re-prioritizes.

---

## Incoming major update — Arturita (voice-first personal AI agent)

> **The plan has landed: `docs/PRD-arturita.md`** — a voice-first personal AI agent persona (the operator's chief-of-staff, female counterpart to Arturito) layered onto the existing Mission Control surface. Voice from the desk (Cockpit) and remote from iPhone via Telegram (voice notes, text, files, one-tap approvals); full-but-bounded machine control via a new hardened local host; email/calendar via the existing Google connectors; and **read+prepare-only** crypto wallet awareness (MetaMask/Brave) with **human-in-the-loop signing — never auto-sign, never key custody**.
>
> **Design commitment:** it reuses existing primitives, it does not fork them — the tri-state **approval flow** gates every dangerous action (`file_destructive`/`wallet_tx`/`email_send`/`machine_exec`); **preflight/budget** bound LLM failover cost; **watchdogs**, **wake-on-comment**, **ask-mode**, **heartbeat/timeline**, the **HMAC Telegram receiver**, the scoped **secrets store**, and the **mac-mini adapter pattern** all carry through. See the PRD's §5 reuse map.
>
> **Story-level plan is filed: `docs/PLAN-arturita.md`** — Epics A–G broken into stories (A1…G2) with scope, acceptance, dependencies, and a sequencing/critical-path diagram, in the same shape as the just-completed T/W/V/D plan. Epics A–G are **not yet filed as MCA issues** (Atlassian OAuth unavailable in build sessions — file interactively and back-fill the numbers).
>
> **Kick off here — Epic A, story A1** (`docs/PLAN-arturita.md` §1): **Arturita persona + command sessions + `/panic` kill switch** (`services/arturita-session.ts`, `arturita_sessions`/`arturita_bindings` tables, `POST /api/arturita/{session,bind,panic}`). It's the smallest self-contained safety primitive and unblocks everything. **Safety rule: no dangerous surface (B/C/D/E) merges before A2 (the approval-type gate) is on `main`;** `machine_exec` (C3) and wallet signing (E2) are the last, most-guarded stories.
>
> **Resolve first (PLAN §3) — decisions/spikes that block the first stories of B/C/D/E, none requiring feature code:** **S1** STT/TTS provider (blocks B1; rec: local-first + optional cloud), **S2** iPhone surface — Telegram-only vs PWA (blocks D framing; rec: Telegram-only for v1), **S3** mac-control adapter approach — custom hardened daemon vs wrap an MCP (blocks C1; rec: custom daemon for the write/destructive path), **S4** WalletConnect integration proof (blocks E2; provider already decided in PRD §12), **S5** wake-word (rec: push-to-talk default), **S6** `machine_exec` allowlist scope (rec: empty at launch). Epic A has **no** external blockers — start it while the spikes run in parallel.
>
> **Conventions unchanged:** pure helpers + `node --test`, idempotent migrations, colorblind rules (DESIGN_SYSTEM v2), ship-via-squash-admin, docs bump per PR, invariant green each merge. Go-live gates in PRD §11 extend `GO-LIVE.md` (`WEBHOOK_SIGNING_SECRET` becomes a hard prerequisite for Telegram remote control).

---

## Shared memory / vault
Canonical Obsidian vault: `/Users/artutito/7Ei-MC_TARCO` (repo `Arturito7ei/7Ei-MC_TARCO`, content under `vault/`). Latest status doc: `vault/07-Agents/STATUS-Mission-Control-2026-07-02.md` (mirror the v2-epics-complete milestone here). Plan of record: `vault/01-Projects/Paperclip-Gap-Analysis-v2-2026-07-06.md`. Connectors: Jira via Atlassian Rovo OAuth (cloudId `5dadc567-085a-4cd8-99a3-c0bd9886fee9`, projects MCA + OS — **OAuth unavailable in build sessions**), Slack, Gmail. **7Ei_OS PR #3** (protocols: MC as primary coordination + memory bus) — after merge, re-sync the `Protocols/7Ei_OS/` vault mirror.

## Verify before trusting the above

```bash
cd /Users/artutito/Developer/7Ei-Mission_Control_App
git log --oneline -15
cd backend && npm test && npm run evals   # expect 588 tests + 11/11
cd ../web && npm run build
curl -s https://7ei-backend.fly.dev/api/health   # expect 200, db: connected, scheduler: running
```
