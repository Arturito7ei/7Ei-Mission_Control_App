# Arturita overnight build — questions & deferrals log

> **Read me first.** This is the running log from the overnight autonomous build session (operator away ~5h). Every deferred decision, provisional assumption, and blocker is here. Most-important items first. Cross-reference: `docs/DECISIONS-arturita.md` (S1–S6), `docs/PLAN-arturita.md` §0 tracker.
>
> **Session start:** 2026-07-08 · baseline green (588 backend tests · 11/11 evals · web build). Scope tonight: the safe spine (Epic A) + any B–G story whose safety envelope does **not** depend on an unconfirmed safety-critical decision (S3/S4/S6). No dangerous surface merges before A2 is on `main`; nothing that performs a real destructive machine op, auto-signs a wallet tx, or sends email.

---

## ⚠️ Decisions I need you to confirm (blocking further dangerous work)

These are the S-decisions from `DECISIONS-arturita.md`. Until you flip them to `CONFIRMED`, I have **not** shipped the dangerous surface they gate — only pure logic behind a fail-closed default.

| # | Decision | What I need | Why it blocks |
|---|---|---|---|
| **S3** | Mac-control adapter approach + allowlist root/denylist | Approve building a local daemon; give the **allowlist root(s)** and confirm the **denylist**. | Blocks shipping any real host filesystem write/destructive path (C1/C2/C3 execution). I built the pure planners + fail-closed guard only. |
| **S6** | `machine_exec` allowlist at launch | Confirm **empty allowlist** at launch + opt-in-per-command. | Blocks C3. Launch default is empty; no command is enabled. |
| **S4** | WalletConnect project id + test wallet | Provide a **WalletConnect project id** (go-live) + a **test wallet/testnet**; confirm per-tx/per-day caps + destination allowlist values. | Blocks E2 live handshake. I built prepare/simulate/decode + unsigned-tx handoff against a **mocked** handshake only. **No auto-signing, ever.** |
| **S1** | STT/TTS provider | Confirm local-first stance; name a cloud provider + budget if you want the optional tier. | I scaffolded `voice.ts` pure helpers on the provisional local-first decision. No provider keys wired. |
| **S2** | iPhone surface (Telegram-only v1) | Confirm Telegram is the sole remote surface for v1. | Framing only; I proceeded on Telegram-only. |
| **S5** | Wake-word vs push-to-talk | Confirm push-to-talk default. | UI default only. |

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

## Deferred / smaller questions

- **F1 executor wiring (follow-up, not a blocker).** F1 shipped the full pure decision layer (fallback chain + circuit breaker + cost-bounded planning) with tests, but I deliberately did **not** wire it into the live `agent-executor`/`streamLLM` retry loop overnight — that changes the LLM hot path and I'd want you to validate real failover behavior (and confirm the fallback-chain values in `deployConfig`) before it goes live. Follow-up story: catch `streamLLM` errors → `classifyLlmError` → `planFallback` → retry, holding a module-level breaker registry, plus surface breaker health on `/health` + Cockpit. **Q:** confirm the desired default `arturita_fallback_chain` (e.g. `claude-sonnet-4-20250514, gpt-4o, gemini-2.0-flash, deepseek-chat, ollama/llama3.3`).
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
