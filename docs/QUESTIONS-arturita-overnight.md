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

_(appended as the session progresses)_

---

## Deferred / smaller questions

- **F1 executor wiring (follow-up, not a blocker).** F1 shipped the full pure decision layer (fallback chain + circuit breaker + cost-bounded planning) with tests, but I deliberately did **not** wire it into the live `agent-executor`/`streamLLM` retry loop overnight — that changes the LLM hot path and I'd want you to validate real failover behavior (and confirm the fallback-chain values in `deployConfig`) before it goes live. Follow-up story: catch `streamLLM` errors → `classifyLlmError` → `planFallback` → retry, holding a module-level breaker registry, plus surface breaker health on `/health` + Cockpit. **Q:** confirm the desired default `arturita_fallback_chain` (e.g. `claude-sonnet-4-20250514, gpt-4o, gemini-2.0-flash, deepseek-chat, ollama/llama3.3`).
- **A1 panic auth model.** `/panic` is public-scope but owner-authed via a valid command-session token. The Cockpit panic button therefore needs a live session token to call it. **Q:** OK that the button mints/uses a command session, or do you want a Clerk-only panic variant too? (Telegram-driven panic lands in D1 via the HMAC receiver.)
- **A1 bind confirm path.** A1 exposes `POST …/arturita/bind/confirm` in the Clerk scope so you can confirm a binding from the Cockpit. In D1 the *primary* confirm path moves to the HMAC Telegram receiver (operator types the code in Telegram). Confirm that's the intended UX.

---

## Blocked on (couldn't do in a build session)

- **Jira issue creation** for Epics A–G — Atlassian OAuth unavailable in build sessions. File interactively, back-fill MCA numbers into PLAN §1.
- **Vault mirror** — will mirror milestone to `vault/07-Agents/Arturita.md` if the Obsidian MCP / vault is reachable; noted per story if not.

---

## What shipped tonight

_(appended as each PR merges — see PLAN §0 for the live tracker)_
