# PRD — Arturita: Voice-First Personal AI Agent

> **Status:** Draft for review · **Owner:** operator (arturito@7ei.ai) · **Author:** build agent · **Date:** 2026-07-07
> **Type:** Major update to 7Ei Mission Control (same monorepo) · **Supersedes:** the "Incoming major update" placeholder in `HANDOFF.md`
> **Companions:** `CLAUDE.md` (conventions), `STATUS.md` (shipped surface), `docs/DESIGN_SYSTEM.md` (binding design rules), `GO-LIVE.md` (console actions), `HANDOFF.md` (kickoff)

This PRD is a **plan of record**, not an implementation. It restates scope and acceptance so the next session can file it as epics/stories and ship one PR per story with the invariant green (backend tests · 11/11 evals · web build). It deliberately **reuses existing Mission Control primitives** rather than inventing parallel ones — every capability below names the primitive it extends.

---

## 1. Summary

**Arturita** is a voice-first personal AI agent that lives inside 7Ei Mission Control as a special, single-operator agent persona (the female counterpart to the org's auto-hired **Arturito**). She is the operator's always-on chief-of-staff: talk to her, and she reads and writes files on the operator's machine, triages email and calendar, prepares (but never auto-signs) crypto transactions, and reports back — from the desk via the web Cockpit and voice, or remotely from an iPhone over Telegram (voice notes, text, files).

Arturita is **not a new runtime**. She is a new *surface* (voice + a hardened local host + a remote Telegram control plane) on top of the existing agent-executor, LLM router, approval flow, preflight/budget guards, watchdogs, secrets store, and heartbeat/timeline. The single most important design commitment: **every irreversible or outward-facing action passes through the existing tri-state approval flow with a human in the loop.** Wallet signing, destructive file operations, and sending email are never autonomous.

### One-paragraph pitch
"Hey Arturita, archive last week's downloads, draft a reply to the Fly invoice email, and check my calendar for Thursday." She transcribes the voice, plans the steps, executes the safe ones (read calendar, list files, draft the reply into a file), and **stops at the two dangerous ones** — moving files and sending email — surfacing each as an approval card you confirm by voice, tap, or Telegram button. Everything she does shows up on the Cockpit timeline and in the task thread, so there's never a silent action.

---

## 2. Goals & non-goals

### Goals
1. **Voice-first control** of the operator's machine, email, and calendar from the desk and remotely.
2. **Remote control from iPhone** via Telegram: voice notes, text commands, file up/download, and one-tap approvals — no App Store release required for v1.
3. **Full machine control, safely bounded**: read/edit/create/move files, directories, and documents on the operator's Mac, with destructive operations gated by approval and a blast-radius cap.
4. **Crypto wallet awareness with human-in-the-loop signing only**: read balances/positions, *prepare* transactions, *simulate* them — but **never** hold keys or auto-sign. The operator signs in MetaMask/Brave themselves.
5. **Resilient LLM backbone**: swap providers per task and **fail over automatically** across the existing multi-provider router, with cost governed by the existing preflight/budget system.
6. **Zero silent actions**: everything Arturita does is a task with a thread, a heartbeat block, and (for dangerous actions) an approval record.

### Non-goals (v1)
- **Not** a custodial wallet. Arturita never imports, stores, or transmits a private key or seed phrase. No auto-signing, ever. (See §7.4.)
- **Not** a native iOS app on the App Store for v1. Remote control is via Telegram; a thin native/PWA client is a v2 candidate (§10).
- **Not** a general multi-user product. Arturita is scoped to **one operator** (the org owner). She is not offered to other org members or tenants in v1.
- **Not** a replacement for Arturito or the existing agents. She is an additional persona on the same executor.
- **Not** autonomous outbound comms. She drafts; the operator approves the send.
- **Not** a new LLM runtime or model — she uses the existing `llm-router.ts` providers.

### Success metrics
- **Safety (primary):** 100% of destructive file ops, wallet transactions, and email sends pass through an approval before execution. Zero private keys ever touch Arturita's process (verified by design + secret-scan CI).
- **Latency:** desk voice → first action ≤ 3 s p50; Telegram voice note → acknowledged ≤ 5 s p50.
- **Reliability:** LLM failover succeeds (task completes on a fallback provider) in ≥ 95% of primary-provider outages, within the per-wake cost cap.
- **Recall/misrecognition safety:** ≥ 99% of destructive voice commands require an explicit confirmation utterance/tap before executing (no "one-shot" destructive voice).
- **Coverage:** operator can complete the "top 10 daily flows" (§4) end-to-end by voice, from desk and from phone.

---

## 3. Personas & surfaces

| Persona | Who | Surface |
|---|---|---|
| **Operator (owner)** | arturito@7ei.ai — sole controller | Web Cockpit (desk), voice (desk mic), Telegram (remote) |
| **Arturita** | the agent persona | Runs on the existing executor; speaks via TTS; acts via the local host + connectors |

### Surfaces
- **A. Web Cockpit voice panel** (`web/app/dashboard/cockpit/`): push-to-talk / wake-word, live transcript, spoken responses, and an approval-aware action feed. New cockpit section, same primitives as the existing 15 sections.
- **B. Arturita Local Host** (new, under `adapters/arturita-host/`): a hardened local daemon on the operator's Mac that performs file/machine actions inside an allowlisted root, behind the approval gate. It is the **only** component with filesystem write access, and it is the operator's machine — self-hosted, off the cloud.
- **C. Telegram remote** (extends existing `telegram-bot.ts` + per-org webhook receiver with HMAC): voice notes (STT), text commands, file transfer, inline-button approvals, spoken replies (voice message TTS).
- **D. Backend orchestration** (existing `agent-executor.ts` + services): plans, routes LLM calls, enforces governance/budget/preflight, records tasks/threads/heartbeat.

---

## 4. Top user flows (acceptance-shaped)

Each flow is a task on the existing board with a thread, heartbeat block, and — where dangerous — an approval. "Dangerous" = destructive file op, wallet tx, or outbound send.

1. **"What's on my calendar Thursday?"** — read-only. Voice → STT → calendar connector (existing Google) → spoken + text answer. No approval. (Reuses `ask` `work_mode` single-turn path.)
2. **"Draft a reply to the Fly invoice email."** — reads Gmail thread, writes a *draft file* (or Gmail draft), returns it. **No send.** Sending is a separate approved step.
3. **"Send that reply."** — outbound. Creates an `[APPROVAL: email_send | ...]` card with the exact recipient + body; operator confirms; only then does the Gmail connector send.
4. **"Archive last week's downloads to ~/Archive/2026-07."** — destructive file move. Local host computes the exact file list, returns a **preview manifest** (N files, total size, destination), raises `[APPROVAL: file_destructive | move 42 files → ~/Archive/2026-07]`; on approval, executes atomically with an undo journal.
5. **"Edit the PRD — change the deadline to August."** — file edit. Small, in-root edit shows a diff preview; edits inside the allowlisted root and under a size threshold are auto-safe; edits outside root or above threshold need approval.
6. **"What's my ETH balance and the gas price?"** — read-only wallet. Reads public chain data via RPC / wallet read; no key needed. Spoken answer.
7. **"Prepare a swap of 0.5 ETH to USDC."** — wallet transaction. Arturita builds the unsigned tx, **simulates** it (gas, slippage, expected output), raises `[APPROVAL: wallet_tx | ...]` with the decoded human-readable summary; on approval she hands the **unsigned** tx to MetaMask/Brave for the operator to sign **in the wallet UI**. Arturita never signs.
8. **"From my phone: move the screenshots into the Q3 folder."** — Telegram voice note → STT → same file-move flow → inline "✅ Approve / ✕ Reject / ↩ Changes" buttons in Telegram.
9. **"From my phone: here's a PDF, save it to the project and summarize it."** — Telegram file upload → local host writes it into root (auto-safe if in-root + under threshold) → document-ingest → spoken summary back as a Telegram voice message.
10. **"Stop everything / kill switch."** — voice or Telegram `/panic` immediately pauses Arturita (existing `canAgentRun` paused state), cancels in-flight runs, and revokes the current session token. Always available, never itself gated.

---

## 5. Architecture — how it maps onto existing primitives

```
  Desk voice ─┐                                   ┌─ Google (Gmail/Calendar) — existing connectors
  Cockpit ────┼─► Voice Gateway (STT/TTS) ─► Backend agent-executor ─┼─ Vault memory — existing bus
  Telegram ───┘        (new)                  (existing loop)         ├─ LLM router (failover) — existing
                                                     │                └─ Wallet read/prepare (new, read+simulate only)
                                                     ▼
                                       Governance + Approvals (existing tri-state)
                                                     │  (dangerous actions gated here)
                                                     ▼
                                       Arturita Local Host (new daemon on the Mac)
                                          file/dir/doc ops inside allowlisted root
```

### Reuse map (do not reinvent)
| Need | Existing primitive | Extension |
|---|---|---|
| Plan/execute the loop | `agent-executor.ts` | Arturita is an internal agent persona; voice tasks route through it |
| Single-turn Q&A ("what's on my calendar") | `askmode.ts` `work_mode: ask` | Voice questions default to `ask`; work orders to `execute` |
| Wake an idle thread | `thread.ts` wake-on-comment | A follow-up voice note re-enters the same task thread |
| Gate dangerous actions | `governance.ts` `[APPROVAL: …]` + `approvals.ts` tri-state | New approval *types*: `file_destructive`, `wallet_tx`, `email_send`, `machine_exec` |
| Govern LLM cost | `preflight.ts` per-wake cap + `budget.ts` scoped budgets | Failover retries are bounded by the same per-wake cap |
| Provider swap/failover | `llm-router.ts` (Anthropic/Gemini/OpenAI-compatible/local) | Add an ordered fallback chain + health/circuit-breaker (§6) |
| Remote comms | `telegram-bot.ts` + `webhook-auth.ts` (HMAC per-org) | Voice notes, files, inline-button approvals, per-operator binding |
| Secrets at rest | `secrets.ts` (AES-256-GCM, scoped, never into prompts) | Wallet RPC keys, provider keys, Telegram binding — **never** private keys |
| Declarative safety checks | `watchdogs.ts` | Runaway-run / cost / no-activity watchdogs on long Arturita tasks |
| Visibility | `timeline.ts` heartbeat + `receipts.ts` + task thread | Every voice action is a visible task with a heartbeat block |
| Machine runtime pattern | `adapters/mac-mini/` (OpenClaw, launchd keep-alive) | New sibling `adapters/arturita-host/` daemon, same install/keep-alive shape |
| Self-description | `openapi.ts` | New endpoints self-describe; CLI `7ei-mc` gains voice/host verbs |

### New components (minimum viable)
1. **Voice Gateway** (`backend/src/services/voice.ts` + a thin STT/TTS provider layer): transcribe audio → text, synthesize text → audio. Provider-pluggable (same philosophy as `llm-router`): a cloud STT/TTS by default, with a **local/offline** fallback (§8). Pure helpers for transcript normalization, wake-word/confirmation-phrase detection, and destructive-intent tagging are individually testable (`node --test`), routes stay thin.
2. **Arturita Local Host** (`adapters/arturita-host/`): a small, audited daemon. Exposes a *capability API* (list/read/write/move/delete within root, run-allowlisted-command) that the backend calls **only after** an approval clears. Holds an allowlist root, a denylist, a size/'count blast-radius cap, and an **undo journal**. Talks to the backend over an authenticated channel (agent token + mTLS or a signed local socket). See §7.3.
3. **Wallet Read/Prepare service** (`backend/src/services/wallet.ts`): read balances/positions via RPC; build + **simulate** unsigned transactions; decode calldata to a human-readable summary for the approval card; hand the unsigned tx to the wallet for signing. **No key custody.** See §7.4.
4. **Session/auth binding for Arturita** (`backend/src/services/arturita-session.ts`): binds the single operator to Telegram chat id + Cockpit Clerk identity; issues short-lived, revocable **command sessions**; enforces step-up confirmation for dangerous actions. See §7.1.

---

## 6. LLM provider swap & failover

Arturita must keep working when a provider degrades. Built on the existing `llm-router.ts` (already unifies Anthropic, Gemini, OpenAI-compatible, DeepSeek, Kimi, Qwen, MiniMax, Ollama/local).

- **Ordered fallback chain** per agent (config-as-secret in `org.deployConfig`, e.g. `arturita_fallback_chain: ["claude-sonnet", "gpt-4o", "gemini-2.0-flash", "deepseek-chat", "ollama/llama3.3"]`). Primary first; on failure, walk the chain.
- **Failure classes handled:** provider 5xx/timeout, rate-limit (429), auth error (bad/rotated key → skip that provider, alert operator), context-length overflow (down-shift to a larger-context model or summarize), content filter/refusal (retry once on next provider).
- **Circuit breaker:** a provider that fails N times in a window is marked unhealthy for a cooldown; the router skips it and re-probes after cooldown. Health surfaced on the Cockpit and via `/health`.
- **Cost-bounded retries:** every retry re-runs the existing **preflight per-wake cost cap** — failover cannot blow the budget. If the whole chain would exceed the cap or is exhausted, the task parks `blocked`/`needs_attention` with a plain-language `system_notice` (feeds the W1 recovery card) and Arturita says so aloud.
- **Local last resort:** the final fallback is a local Ollama model so Arturita can still answer/queue when the network is down (degraded mode, §8).
- **Determinism for safety:** the *approval summary* for a dangerous action is always regenerated and shown verbatim regardless of which model produced the plan — the human approves the concrete action, not the model's prose.

---

## 7. Safety, security & edge cases (the core of this PRD)

Arturita's blast radius is large by design (machine + email + wallet). Safety is not a section — it's the product. Every subsection below is an acceptance requirement.

### 7.1 Authentication & anti-spoofing (remote command auth)
- **Single operator binding.** Telegram control works only from the **bound chat id** of the owner. First bind requires a one-time code generated in the Cockpit (Clerk-authenticated) and entered in Telegram; binding is stored scoped in `secrets.ts`. Unbound chats get a flat refusal, logged.
- **HMAC on every inbound webhook** (existing `webhook-auth.ts`): Telegram `secret_token` is verified before any work; forged/misrouted updates are 403'd before DB access. **`WEBHOOK_SIGNING_SECRET` must be set** for Arturita remote control to be enabled (it's a launch gate, not dev-optional — see §11).
- **Short-lived command sessions.** A remote session is a revocable token with a TTL; `/panic` and Cockpit both revoke instantly. Dangerous actions require the session to be **fresh** (re-auth/step-up if older than a threshold).
- **Step-up confirmation for dangerous actions.** Approvals for `wallet_tx`, `file_destructive`, `machine_exec`, and `email_send` require an explicit second factor: a typed confirmation phrase, a distinct Telegram button (not the same tap as "continue"), or a Cockpit click — never a bare voice "yes" alone for the highest tier (§7.2).
- **Replay & idempotency.** Every command carries a nonce; the backend rejects duplicates (protects against Telegram redelivery and a captured voice note replayed).
- **No secrets over the wire in cleartext to the model.** Consistent with `secrets.ts`: secrets are injected into execution, **never** into LLM prompts or transcripts.

### 7.2 Voice misrecognition on destructive commands
STT is fallible; a misheard destructive command must never execute silently.
- **Two-phase for anything destructive.** Destructive intents (delete, move, overwrite, send, sign, transfer) are detected by a pure `classifyIntent()` helper. They **always** produce a preview + explicit confirmation step — Arturita reads back the *concrete effect* ("This will permanently delete 42 files totaling 1.2 GB from ~/Downloads. Say 'confirm delete' or tap Approve.") and waits.
- **Confirmation must be explicit and distinct.** A generic "yeah" is insufficient for the top tier; require a confirmation phrase ("confirm delete") or a tap. Ambiguous/low-confidence transcripts (STT confidence below threshold) are **rejected with a re-prompt**, never guessed.
- **Homophone & entity guards.** Numbers, amounts, addresses, filenames, and recipients are echoed back and, for wallet/email, shown as text for visual confirmation before approval — voice alone never authorizes an address or an amount.
- **No batching of confirmations.** Each destructive action is confirmed on its own; "approve all" is not offered for destructive tiers.
- **Cool-down / undo window.** Destructive file ops execute via the undo journal (§7.3) with a short reversible window where feasible.

### 7.3 Machine-control blast radius
- **Allowlisted root only.** The local host operates inside an operator-configured root (e.g. `~/` minus a denylist, or a set of allowed roots). Anything outside root is refused — no absolute-path escape, no `..` traversal (canonicalize + verify prefix).
- **Denylist of catastrophic targets.** System dirs, `~/.ssh`, keychains, `.env`/secret files, wallet vaults, browser profiles holding wallet extension data, and the Arturita host's own config are **hard-denied** for read *and* write (so a compromised model can't exfil keys or brick the machine).
- **Blast-radius caps.** Operations touching more than N files or more than X GB, or recursive deletes, require approval regardless of location; a hard ceiling refuses outright and asks the operator to narrow the request.
- **Command execution is allowlisted, not arbitrary.** `machine_exec` runs only from a curated allowlist of commands (or explicitly-approved one-offs), never a free-form shell from the model. Every exec is an approval-gated `machine_exec` with the exact argv shown.
- **Undo journal.** File moves/edits/deletes record a reversible journal (originals staged, not immediately purged) so a mistaken op can be rolled back by voice ("undo that").
- **Least privilege.** The host runs as the operator user (not root); no sudo. It's the operator's own machine, self-hosted, keep-alive via launchd like the existing mac-mini adapter.
- **Auditability.** Every host action is a task + thread entry + heartbeat block; nothing the host does is invisible in the Cockpit.

### 7.4 Wallet safety (never auto-sign)
This is the hardest constraint and the clearest line.
- **No key custody — ever.** Arturita never imports, stores, generates, or transmits a private key or seed phrase. `secrets.ts` holds RPC endpoints and *read* keys only; a CI secret-scan and a design invariant forbid private-key material in the process.
- **Read + prepare + simulate only.** Arturita reads balances/positions (public RPC), *constructs* unsigned transactions, and **simulates** them (gas, slippage, expected output, revert check) to build a human-readable approval summary.
- **Human-in-the-loop signing in the wallet UI.** On approval, the unsigned tx is handed to MetaMask/Brave (via WalletConnect or the browser extension prompt) and **the operator signs in the wallet**, where they see the wallet's own confirmation. Two independent confirmations: Arturita's approval card *and* the wallet's native prompt.
- **Decoded, not raw.** The approval card shows decoded calldata ("Swap 0.5 ETH → ~1,180 USDC on Uniswap v3, max slippage 0.5%, gas ~$3.10"), the destination contract's known label, and warnings for unknown contracts/approvals-to-spender.
- **Hard limits & allowlists.** Per-tx and per-day value caps; destination-address allowlist for higher amounts; unlimited-approval (`approve(spender, max)`) transactions flagged as high-risk with an extra warning. Anything over a cap requires step-up (§7.1).
- **Phishing/scam guards.** Warn on transfers to never-before-seen addresses, on `setApprovalForAll`, on contracts flagged by a reputation source, and on drain-pattern calldata.
- **No private mempool / MEV auto-actions.** Arturita does not run trading bots or auto-execute strategies (that's the separate 7PolyBet track, not Arturita).

### 7.5 Email & outbound comms
- **Draft by default, send by approval.** Every send is an `[APPROVAL: email_send | to · subject]` with the full body shown; the Gmail connector sends only after approval.
- **Recipient guardrails.** External recipients, large BCC/CC, and anything with attachments get an explicit warning; reply-all is flagged.
- **No auto-forwarding of secrets.** Outbound scanning refuses to send content matching secret patterns (keys, seed phrases) without explicit override.

### 7.6 Offline / degraded modes
- **Network down:** local Ollama LLM + local STT/TTS keep Arturita conversational; actions that need cloud connectors (Gmail, RPC) queue with a spoken "queued, will run when back online," and replay on reconnect (idempotent, nonce-guarded).
- **Local host down:** file/machine actions are refused with a clear spoken reason; read-only cloud actions still work.
- **STT/TTS provider down:** fall back to the alt provider, then to text-only (Cockpit/Telegram) with a notice.
- **Backend unreachable from host:** host does nothing autonomously (fail-closed) — it only ever acts on an authenticated, approved backend command.

### 7.7 Secrets handling
- All provider keys, RPC keys, Telegram binding, and host credentials live in the existing scoped `secrets.ts` store (AES-256-GCM), injected into execution, **never** into prompts, transcripts, logs, or the vault. Redaction on all logs/telemetry. Rotation via the existing Cockpit → Secrets flow (no plaintext on disk, per the go-live adapter change).

### 7.8 Privacy & data retention
- Voice audio is transcribed then **discarded by default** (no long-term audio store); transcripts live in the task thread (operator-owned, deletable). Telegram voice notes are fetched, transcribed, and the audio not retained.
- The operator can purge any task/thread; a "what did you hear/do" audit view lists recent transcripts + actions.
- No third-party training on operator data (choose STT/TTS/LLM providers accordingly; prefer local for sensitive contexts).

### 7.9 Failure UX
Reuse the shipped W-epic surface: failures post `system_notice` → W1 recovery card; long/expensive Arturita runs get `watchdogs` (runtime/cost/no_activity); parked tasks show a plain-language reason and Arturita says it aloud rather than failing silently.

---

## 8. Voice pipeline detail

- **Capture:** desk = Cockpit mic (WebAudio, push-to-talk + optional wake word "Arturita"); remote = Telegram voice note.
- **STT:** provider-pluggable (`voice.ts`), cloud default + local (e.g. whisper.cpp) fallback for offline/sensitive. Returns transcript **with confidence**; low confidence → re-prompt (§7.2).
- **Understanding:** transcript → `agent-executor` (ask vs execute via `work_mode`); intent classified for destructive tagging *before* planning.
- **TTS:** provider-pluggable, cloud default + local fallback; spoken reply on desk and as a Telegram voice message remotely. A concise, consistent Arturita voice/persona.
- **Barge-in & length:** operator can interrupt TTS; long answers are summarized aloud with full text in the thread.
- **Latency budget:** STT ≤ 1.5 s, plan+first-action ≤ 1.5 s for simple asks (p50), matching §2 targets.

---

## 9. Data model & API (deltas, all idempotent per convention)

New tables (idempotent `CREATE TABLE IF NOT EXISTS` in `db/setup.ts`, thin routes → pure services):
- `arturita_sessions` — operator command sessions (token hash, TTL, revoked_at, last_stepup_at, source: desk|telegram).
- `arturita_bindings` — operator ↔ Telegram chat id (+ Cockpit identity), one row, revocable.
- `host_actions` — audit of every local-host op (kind, path/argv, blast-radius, approval_id, undo_ref, result).
- `wallet_intents` — prepared unsigned txs (decoded summary, simulation result, caps checked, approval_id, signed_txhash once the operator signs; **no key material**).
- Reuse existing `approval_requests` (add types `file_destructive|wallet_tx|email_send|machine_exec`), `task_comments`/thread, `task_watchdogs`, `agent_runs`/heartbeat.

New endpoints (self-described via `openapi.ts`, Clerk-secured except the Telegram receiver which stays public+HMAC):
- `POST /api/arturita/voice` — audio in → task + spoken/text reply (ask or execute).
- `POST /api/arturita/session` / `DELETE …/session` — mint/revoke command session; `POST …/bind` for Telegram binding.
- `POST /api/arturita/panic` — kill switch (pause + cancel runs + revoke sessions).
- `GET/POST /api/arturita/host/*` — capability API proxied to the local host (**only** after approval); never a raw shell.
- `GET/POST /api/arturita/wallet/*` — read balances, prepare+simulate tx, fetch decoded summary (no signing endpoint — signing is in the wallet UI).
- Extend the Telegram receiver (`POST /api/telegram/webhook/:orgId`) to handle voice notes, files, and inline-button approval callbacks.
- CLI `7ei-mc`: `arturita bind`, `arturita panic`, `arturita host-status` verbs.

---

## 10. Phasing (epics → stories, one PR per story, invariant green each)

**Epic A — Foundation & safety spine** (must land first)
- A1 Arturita persona + session/binding + `/panic` kill switch (`arturita-session.ts`).
- A2 New approval *types* (`file_destructive|wallet_tx|email_send|machine_exec`) wired to the existing tri-state flow + step-up confirmation.
- A3 Intent classifier (`classifyIntent`) + destructive two-phase confirmation helpers (pure, tested).

**Epic B — Voice**
- B1 Voice Gateway (`voice.ts`) STT/TTS provider layer + local fallback; transcript-with-confidence + low-confidence re-prompt.
- B2 Cockpit voice panel (push-to-talk, transcript, spoken replies, action feed) — colorblind-safe, DESIGN_SYSTEM v2.
- B3 Ask vs execute routing from voice (reuse `askmode`/`thread`).

**Epic C — Machine control**
- C1 Arturita Local Host daemon (`adapters/arturita-host/`): allowlist root, denylist, blast-radius caps, canonicalization, mTLS/token auth, fail-closed.
- C2 File ops (list/read/write/move/delete) with preview manifests + undo journal, gated by approval.
- C3 `machine_exec` allowlist + doc/document editing with diff preview.

**Epic D — Remote (Telegram)**
- D1 Voice notes (STT) + text commands from the bound chat; HMAC-enforced; nonce/replay guard.
- D2 File up/download; inline-button approvals (✅/✕/↩) mapped to the tri-state flow; spoken (voice-message) replies.

**Epic E — Wallet (read + prepare, never sign)**
- E1 `wallet.ts`: balances/positions read via RPC; unsigned tx build + simulation + calldata decode.
- E2 `wallet_tx` approval card (decoded summary, caps, scam guards) + WalletConnect/extension handoff for the operator to sign; caps/allowlists.

**Epic F — Resilience & LLM failover**
- F1 Ordered fallback chain + circuit breaker on `llm-router.ts`, cost-bounded by preflight; health on `/health` + Cockpit.
- F2 Degraded/offline modes (local LLM + local STT/TTS; queue-and-replay) + watchdogs on long runs.

**Epic G — Docs/DX & go-live**
- G1 `openapi` self-description of all new endpoints; CLI verbs; `docs/API.md` narrative.
- G2 Go-live gates (§11) + operator runbook; update `STATUS.md`/`HANDOFF.md`/vault.

> Sequencing rule: **A before everything** (no dangerous surface ships before the approval spine + kill switch). Wallet signing handoff (E2) and `machine_exec` (C3) are the last, most-guarded stories.

---

## 11. Go-live gates (user-only console actions — assistant can't do these)
Extends `GO-LIVE.md`:
1. **`WEBHOOK_SIGNING_SECRET` set** (already a standing item) — **required** to enable Telegram remote control (receivers must be HMAC-enforced, not open).
2. **STT/TTS provider keys** set via Cockpit → Secrets (+ local models installed on the Mac for offline fallback).
3. **Telegram bot** created + bound to the operator's chat id via the one-time Cockpit code.
4. **Arturita Local Host** installed on the Mac (`adapters/arturita-host/setup.sh`, launchd keep-alive), root/denylist/caps configured by the operator.
5. **Wallet:** WalletConnect project id / RPC endpoints set; per-tx and per-day caps + address allowlist configured. **Confirm the no-custody invariant** (no private key anywhere).
6. **LLM fallback chain** + per-wake cost cap configured in `deployConfig`.

## 12. Open questions
- STT/TTS vendor default (cloud provider vs. local-first for privacy)? Lean local-first for sensitive contexts.
- Wallet integration path: WalletConnect (works with MetaMask/Brave, cleaner) vs. a browser-extension bridge — likely WalletConnect for v1.
- Wake-word on desk: always-listening vs. push-to-talk default (privacy). Recommend push-to-talk default, wake-word opt-in.
- Does the operator want a thin PWA/native iOS client in v2, or is Telegram sufficient long-term?
- Scope of `machine_exec` allowlist at launch (probably empty; opt-in per command).

## 13. Risks
- **Blast radius** (machine + email + wallet) — mitigated by approval-gating, allowlist root, no key custody, kill switch.
- **Voice misrecognition on destructive ops** — mitigated by two-phase confirm, confidence thresholds, visual echo of entities.
- **Remote spoofing** — mitigated by single-operator binding + HMAC + nonces + short sessions + step-up.
- **LLM cost runaway on failover** — mitigated by preflight per-wake cap bounding every retry.
- **Provider outage** — mitigated by ordered fallback + local last resort + degraded mode.
- **Scope creep into custodial/trading territory** — explicitly out of scope; wallet is read+prepare+human-sign only (7PolyBet is a separate track).

---

_This PRD supersedes the "Incoming major update — plan placeholder" in `HANDOFF.md`. Next session: file Epics A–G as MCA issues, sequence per §10 (A first), and ship one PR per story keeping the invariant green (backend tests · 11/11 evals · web build)._
