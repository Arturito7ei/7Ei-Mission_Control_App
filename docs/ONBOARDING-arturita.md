# ONBOARDING — Arturita build (for a fresh coding agent)

> **You've been dropped into the 7Ei Mission Control repo to build Arturita.** This doc gets you from cold-start to "I know exactly which PR to open next" in one read. Arturita is a voice-first personal AI agent layered onto Mission Control — see the read order below. **No feature code has shipped yet; the documentation/planning layer is complete.**

## 1. Read order (do this first)
Read these in order — each builds on the last. Don't skip; the safety model only makes sense end-to-end.

1. **`docs/PRD-arturita.md`** — what Arturita is and why; the safety model, edge cases, and phasing. The intent.
2. **`docs/PLAN-arturita.md`** — Epics A–G broken into stories (A1…G2) with acceptance, dependencies, sequencing, **and the living status tracker** (per-story todo/in-progress/done + PR links). The how.
3. **`docs/DECISIONS-arturita.md`** — the S1–S6 pre-build decisions/spikes (STT/TTS, iPhone surface, mac adapter, WalletConnect, wake-word, exec allowlist) + standing invariants. What's settled vs. pending operator confirm.
4. **`docs/REQUIREMENTS-arturita.md`** — the master FR/NFR acceptance checklist. What "done" means, per requirement, mapped to stories.
5. **`HANDOFF.md`** — the single **"start here / current story"** pointer. It always names the next PR to open. **This is where you find "current story."**

Then the repo-wide context you'd read for any Mission Control work: root **`CLAUDE.md`** (conventions), **`STATUS.md`** (shipped surface), **`docs/DESIGN_SYSTEM.md`** (binding design rules), **`GO-LIVE.md`** (console actions). Subsystem guides (`backend/`, `web/`, `adapters/CLAUDE.md`) load on demand when you work there.

## 2. How to find "current story"
- **`HANDOFF.md`** → "Incoming major update — Arturita" block names the current story and the spikes to resolve first.
- **`docs/PLAN-arturita.md`** → §1 status tracker: the first row not `done` on the critical path (§2) is next, respecting dependencies and the safety gate.
- Rule: **the story whose deps are all `done`, that's earliest on the critical path, and whose gating S-decision (if any) is `CONFIRMED`.**

## 3. Conventions (binding — these override defaults)
- **One PR per story**, squash-merged with `--admin`; merge auto-deploys Fly + Vercel. Keep GitHub Actions green.
- **`npm audit` CI check is non-blocking** — it fails on every PR; merge with `--admin` once functional checks are green.
- **Pure-helper services** — business logic lives in `backend/src/services/*.ts` as pure, individually-tested helpers (`node --test`); routes stay thin and push schemas *into* services (**routes→services is the only allowed import direction** — a service never imports routes). New logic → new pure helper + tests.
- **Idempotent migrations** — schema changes are idempotent `ADD COLUMN` / `CREATE TABLE ... IF NOT EXISTS` in `backend/src/db/setup.ts`. No migration framework; boot re-applies safely.
- **Colorblind rule** (operator is red-green colorblind — `docs/DESIGN_SYSTEM.md`): red is **never** the lone CTA and is **always** iconed; status is never color-only (icon + text + shape); active = purple, done = ✓, paused = ⏸. Enforce in every new UI surface.
- **Docs-bump-per-PR** — update `STATUS.md` at each shipped story; tick the delivered items in `docs/REQUIREMENTS-arturita.md`; update the `docs/PLAN-arturita.md` status tracker (status + PR link); mirror the milestone to the vault `07-Agents/`. Keep root `CLAUDE.md` slim.
- **Invariant, verified before every merge:** `cd backend && npm test && npm run evals` (zero failures + 11/11) · `cd web && npm run build`.

### Arturita-specific safety gate (non-negotiable)
- **No dangerous surface merges before A2.** Epic A (safety spine: sessions + `/panic` + approval types + intent classifier) lands first. No story in Epics B/C/D/E that can perform a `file_destructive`, `wallet_tx`, `email_send`, or `machine_exec` action merges before **A2** (the approval-type gate) is on `main`.
- **`machine_exec` (C3) and wallet signing (E2) are the last, most-guarded stories.**
- **A build agent may scaffold on a PROVISIONAL decision, but must not ship a dangerous surface whose safety envelope depends on an unconfirmed S3 (root/denylist) / S4 (wallet handoff) / S6 (exec allowlist)** until that decision is `CONFIRMED` in `docs/DECISIONS-arturita.md`.
- **Never** paste live secrets into chat/code/docs; set them via Cockpit → Secrets or Fly secrets. **Never** touch the live OpenClaw adapter, rotate credentials, or change vendor-console settings without asking the operator. **Never** implement key custody or auto-signing.

## 4. Repo map (where Arturita's code will live)
```
backend/src/
  services/            ← pure helpers + tests. NEW: arturita-session.ts, intent.ts,
                         voice.ts, wallet.ts  (extend: governance.ts, approvals.ts,
                         llm-router.ts, telegram-bot.ts, webhook-auth.ts, preflight.ts)
  db/setup.ts          ← idempotent migrations. NEW tables: arturita_sessions,
                         arturita_bindings, host_actions, wallet_intents
  routes/              ← thin routes. NEW: /api/arturita/{voice,session,bind,panic},
                         /api/arturita/{host,wallet}/*  (extend telegram receiver)
web/app/dashboard/
  cockpit/             ← NEW voice panel section (colorblind-safe, DESIGN_SYSTEM v2)
adapters/
  arturita-host/       ← NEW hardened local daemon (sibling to mac-mini/): allowlist
                         root, denylist, blast-radius caps, undo journal, fail-closed
cli/                   ← 7ei-mc: NEW verbs arturita bind|panic|host-status
docs/                  ← PRD / PLAN / DECISIONS / REQUIREMENTS / this file
```
Full architecture + the primitive-reuse map are in PRD §5. **Reuse existing primitives; do not fork them** (tri-state approvals, preflight/budget, watchdogs, wake-on-comment, ask-mode, heartbeat/timeline, HMAC Telegram receiver, secrets store, mac-mini adapter pattern, openapi self-description).

## 5. Definition of done (per story) — the checklist to self-verify before you merge
- [ ] Pure-helper service(s) with `node --test` coverage; routes thin.
- [ ] Idempotent migration if schema changed; boot + auth-scoping tests green.
- [ ] UI (if any) colorblind-safe per DESIGN_SYSTEM v2.
- [ ] New endpoints self-described (openapi) with correct auth scope.
- [ ] Gating S-decision `CONFIRMED` if this story ships a dangerous surface.
- [ ] `docs/REQUIREMENTS-arturita.md` items ticked; `docs/PLAN-arturita.md` tracker updated (status + PR link); `STATUS.md` bumped; vault milestone mirrored.
- [ ] Invariant green: backend tests · 11/11 evals · web build.
- [ ] One PR, squash-merged with `--admin`.

## 6. What still needs the operator (can't be done in a build session)
- **Operator confirmations on S1–S6** (`docs/DECISIONS-arturita.md`) — especially the safety-critical S3 (mac allowlist root + denylist) and S6 (exec allowlist) before the C-epic dangerous stories.
- **Jira issue creation** — Epics A–G aren't filed as MCA issues yet (Atlassian OAuth is unavailable in build sessions). File interactively, back-fill the numbers into PLAN §1.
- **Go-live console actions** (PRD §11 / `GO-LIVE.md`): `WEBHOOK_SIGNING_SECRET`, STT/TTS keys + local models, Telegram bind, host install, WalletConnect project id + caps, fallback chain.

---

_Cold-start entry point for the Arturita build. If anything here disagrees with the code, the code wins — verify before acting. Start at `HANDOFF.md` for the current story._
