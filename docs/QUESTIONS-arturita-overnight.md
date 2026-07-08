# Arturita overnight build — questions & deferrals log

> **Read me first.** This is the running log from the overnight autonomous build session (operator away ~5h). Every deferred decision, provisional assumption, and blocker is here. Most-important items first. Cross-reference: `docs/DECISIONS-arturita.md` (S1–S6), `docs/PLAN-arturita.md` §0 tracker.
>
> **Session start:** 2026-07-08 · baseline green (588 backend tests · 11/11 evals · web build). Scope tonight: the safe spine (Epic A) + any B–G story whose safety envelope does **not** depend on an unconfirmed safety-critical decision (S3/S4/S6). No dangerous surface merges before A2 is on `main`; nothing that performs a real destructive machine op, auto-signs a wallet tx, or sends email.

---

## ✅ DECISION LOCK 2026-07-08 — S1–S6 all CONFIRMED (was: blocking)

The operator confirmed all six S-decisions at their desk and added two new requirements. Details + rationale in `docs/DECISIONS-arturita.md`; the wave is unblocked. Summary of the confirmed answers:

| # | Decision | Confirmed answer |
|---|---|---|
| **S1** | STT/TTS provider | `local\|provider` config, per-context; interim `provider` = **Chatterbox TTS via NVIDIA API** (key in encrypted store, **never git** — verified not committed). |
| **S2** | iPhone surface | **Telegram-only v1** (operator provides bot token); **v2 native/PWA app → Epic H**. |
| **S3** | Mac-control + access | Custom daemon, **whole-machine access** (full control assumed), **minimal self-protection denylist only**. Destructive ops still A2-gated. |
| **S4** | **Wallet — CHANGED** | **Bounded autonomous signing from a capped burner**; autonomous < **$100**, ≥ $100 → approval; local keystore/session key; **testnet only, mainnet flag-gated**. Overrides the old never-sign invariant. |
| **S5** | Wake-word | **Push-to-talk default**, "Arturita" wake-word opt-in. |
| **S6** | `machine_exec` | **Broad exec allowed** (full control); destructive/irreversible still A2-gated with argv verbatim. |

**New requirements (2026-07-08):** distributable packaging + iPhone app → **Epic H** (PLAN) + FR-38..42 / NFR-25..27 (REQUIREMENTS).

### Still needed from the operator (go-live, not build blockers)
- **Telegram bot token** + set `WEBHOOK_SIGNING_SECRET` (enables D-epic remote control).
- **Wallet:** fund + name the **burner** (separate from main wallet), testnet + RPC, confirm per-tx threshold ($100 default)/per-day cap/allowlist, and the **final explicit go** before any mainnet autonomous signing.
- **F1 default fallback chain** confirmed: `claude-sonnet → gpt-4o → gemini-2.0-flash → deepseek → local llama`.
- Load `NVIDIA_API_KEY` into the encrypted store (Cockpit → Secrets); local voice models installed for `local` mode.

---

## Assumptions I made (provisional — tell me if wrong)

Scaffolded on the PROVISIONAL decisions in `DECISIONS-arturita.md`; none of these shipped a dangerous surface. Flag any you'd change:
- **S1 local-first:** `voice.ts` `orderVoiceProviders` prefers **local-only** for sensitive/wallet-adjacent contexts (drops cloud entirely), cloud-first otherwise, text-only last. `AUDIO_RETENTION = discard_after_transcription`.
- **S2 Telegram-only** for v1 remote surface (no PWA/native) — D-epic not started, but B/F assume this framing.
- **S5 push-to-talk default**, wake-word (`"Arturita"`) opt-in (`shouldProcessCapture`).
- **S6 empty `machine_exec` allowlist** at launch — C1 planner marks non-allowlisted commands as one-off-approval-only; nothing pre-enabled.
- **Session/step-up timings** (`arturita-session.ts`): session TTL **30 min**, step-up freshness window **5 min**, bind-code TTL **10 min**. Change if you want tighter/looser.
- **Blast-radius default caps** (`host-planner.ts`, all S3-gated, no execution): auto-safe ≤ **10 files / 50 MB**; hard ceiling **5000 files / 20 GB**; destructive ops (move/delete) are **never** auto-safe. Undo window **10 min**.
- **Circuit-breaker defaults** (`llm-fallback.ts`): **3** failures / **60 s** window → **120 s** cooldown, then re-probe.
- **Wallet caps model** (`wallet.ts`): per-tx / per-day USD caps + destination allowlist are operator-config; an **empty allowlist means no allowlist restriction** (not "deny all"). Confirm you want that default (vs. deny-all until an address is added).
- **B3 destructive-always-execute:** a destructive intent phrased as a question (e.g. "can you delete X?") routes to `execute` (so it hits the approval gate), **not** to a single-turn `ask`. Deliberate safety choice.

---

## Decision-lock build wave (2026-07-08 pm) — what shipped + new deferrals

**Shipped this wave (5 PRs, main green throughout — 750 backend tests · 11/11 evals):**
- **#185** docs — decision-lock S1–S6 + wallet-model change (S4) + Epic H packaging, cascaded across PRD/PLAN/REQUIREMENTS.
- **#186 E2 wallet policy engine** — `wallet-policy.ts` (autonomous_sign/require_approval/refuse, per-tx $100 threshold/per-day/allowlist, fail-closed signing gate keeping mainnet OFF), `wallet_policy` table, policy/evaluate endpoints, `docs/WALLET-KEYSTORE-arturita.md`. **No signing, no key in code.**
- **#187 F1 executor wiring** — `llm-fallback-runtime.ts` wraps the live `streamLLM`; breaker registry; `/health` breaker surface. Identical to bare call when no chain set.
- **#188 B1 voice** — `voice-config.ts` (local|provider per-context, sensitive→forced local), `voice-provider.ts` (Chatterbox/NVIDIA TTS, degrades to text), `POST …/arturita/voice`.
- **#189 C1 host daemon** — `adapters/arturita-host/` real read/preview/undo, fail-closed destructive behind `approved`, S3 whole-machine root + self-protection denylist; verified over HTTP.

**New deferrals / go-live items from this wave:**
- **NVIDIA voice key — load into the encrypted store.** Verified NOT committed to git (tree + history clean). `.env.example` has the `NVIDIA_API_KEY=` placeholder. Operator loads the real value via **Cockpit → Secrets** (or agent-secrets injection) — I can't write the live encrypted store from a build session.
- **E2 live testnet signer (go-live).** Policy engine + fail-closed gate + keystore design shipped; the actual burner keystore/session-key + testnet signing lib is go-live wiring (needs a funded testnet wallet + the signer-library choice). **Mainnet stays off** (`WALLET_MAINNET_ENABLED`/`WALLET_AUTONOMOUS_SIGNING_ENABLED` default false).
- **C2 backend→daemon proxy.** The daemon is real; the backend `/api/orgs/:orgId/arturita/host/*` proxy + `host_actions` audit table + A2-approval→`/apply` wiring is the C2 follow-up. Also: install the daemon on the Mac (`adapters/arturita-host/setup.sh`) + grant TCC (Epic H wizard).
- **B1 raw-audio STT + local engine.** The `/voice` endpoint takes a transcript; STT-of-audio-bytes + a server-side local TTS engine wire at go-live (needs the loaded key + local models).
- **F1 default chain confirmed** as `claude-sonnet → gpt-4o → gemini-2.0-flash → deepseek → local llama` (set in `deployConfig.arturita_fallback_chain`).

## Deferred / smaller questions (still open from overnight)
- **A1 panic auth model.** `/panic` is public-scope but owner-authed via a valid command-session token. The Cockpit panic button therefore needs a live session token to call it. **Q:** OK that the button mints/uses a command session, or do you want a Clerk-only panic variant too? (Telegram-driven panic lands in D1 via the HMAC receiver.)
- **A1 bind confirm path.** A1 exposes `POST …/arturita/bind/confirm` in the Clerk scope so you can confirm a binding from the Cockpit. In D1 the *primary* confirm path moves to the HMAC Telegram receiver (operator types the code in Telegram). Confirm that's the intended UX.
- **NFR-2 CI secret-scan (needs a workflow change — I did not touch `.github/workflows`).** E1 enforces the no-key-custody **design invariant** in code (`assertNoKeyMaterial` guards every persisted `wallet_intents` field; `UnsignedTx` has no key fields; there is no signing endpoint). The **CI secret-scan** half of NFR-2 needs a `.github/workflows` addition (e.g. gitleaks/trufflehog + a grep gate for private-key/seed patterns), which the CLAUDE.md convention says not to touch without an explicit task. **Q:** want me to add that workflow in a dedicated PR?
- **E1 RPC endpoint (go-live).** `prepare`/`simulate` are fully testable from structured inputs; the live balance-read + `eth_call`/`estimateGas` simulation need an RPC endpoint (per chain) configured in `secrets.ts`/`deployConfig`. **Q:** which chains + RPC provider for v1 (mainnet + a testnet for the S4 spike)?

---

## Blocked on (couldn't do in a build session)

- **Jira issue creation** for Epics A–G — Atlassian OAuth unavailable in build sessions. File interactively, back-fill MCA numbers into PLAN §1.
- **Vault mirror** — will mirror milestone to `vault/07-Agents/Arturita.md` if the Obsidian MCP / vault is reachable; noted per story if not.

---

## What shipped tonight

Nine PRs squash-merged to `main`, invariant green throughout (ended at **707 backend tests · 11/11 evals · web build**; started at 588). Full detail in `STATUS.md` + PLAN §0.

| PR | Story | One line |
|---|---|---|
| **#174** | A1 | Persona + command sessions + single-operator binding + `/panic` kill switch |
| **#175** | A2 | Dangerous approval types + machine-rendered verbatim summaries + step-up gate |
| **#176** | A3 | Intent classifier + two-phase destructive confirm (bare "yes" rejected, low-confidence re-prompts) |
| **#177** | F1 | LLM fallback chain + circuit breaker, cost-bounded (pure decision layer) |
| **#178** | E1 | Wallet read/prepare/**simulate** — never sign, no key custody |
| **#179** | C1 planner | Host safety logic (allowlist-root/denylist/blast-radius/undo) — **fail-closed, no execution, S3-gated** |
| **#180** | B1 helpers | Voice pure core (STT-confidence gating, wake-word, provider fallback) |
| **#181** | B3 | Ask-vs-execute routing from voice (reuses askmode/intent/thread) |
| **#182** | F2 | Degraded/offline queue-replay (exactly-once, nonce-guarded) + watchdog specs |

**Epic A (safety spine) is 100% complete and on `main`.** Every dangerous surface (files/wallet/email/machine) is gated behind the A2 approval gate + a fail-closed default; **no dangerous action was shipped** — no real destructive machine op, no wallet signing, no email send.

### Not started / needs you before it can proceed
- **B2** Cockpit voice panel (needs S5 confirm + a voice provider; UI story).
- **C2/C3** real file ops + `machine_exec` — **blocked on S3/S6 CONFIRMED** (planner logic is ready).
- **D1/D2** Telegram remote — needs S2 confirm + `WEBHOOK_SIGNING_SECRET` set.
- **E2** wallet approval card + WalletConnect handoff — **blocked on S4**.
- **G1/G2** self-description + go-live runbook — can run once the above land.
- **FR-7** barge-in / long-answer summarization — pends the live B1 voice endpoint.

### Follow-ups I chose not to do unattended (all logged above)
- F1 → live executor/`streamLLM` wiring + `/health` breaker surface.
- B1/B3 → the `/voice` endpoint + provider adapters (S1 keys).
- NFR-2 → the CI secret-scan **workflow** (`.github/workflows` — untouched per convention).
- E1 → live RPC endpoint for balance reads + real simulation.

### Housekeeping
- Recovered cleanly from a mid-session `ECONNRESET` (dropped while polling F2's CI): F2 (#182) was verified green and merged on resume; tracker docs reconciled to match `main`.
- **Jira** Epics A–G still not filed (Atlassian OAuth unavailable in build sessions) — file interactively, back-fill MCA numbers.
- **Vault mirror** (`vault/07-Agents/Arturita.md`) — Obsidian MCP was disconnected at wrap-up; mirror pending (see below).
