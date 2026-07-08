# DECISIONS — Arturita (S1–S6 + standing decisions)

> **Companion to `docs/PRD-arturita.md` (what/why) and `docs/PLAN-arturita.md` (how/stories).** This is the decision log: the pre-build spikes/decisions that gate the first stories, each recorded with a provisional answer, rationale, and what it unblocks.
> **Status legend:** `PROVISIONAL — pending operator confirm` (recommended answer, not yet signed off) · `CONFIRMED` (operator signed off, or already decided in the PRD) · `OPEN` (no recommendation yet).
> **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai)

**How to use this file:** a decision stays `PROVISIONAL` until the operator confirms. A build agent **may proceed on a PROVISIONAL decision** for non-destructive scaffolding, but **must not** ship a dangerous surface (B/C/D/E) whose safety envelope depends on an unconfirmed decision (S3 root/denylist, S4 wallet handoff, S6 exec allowlist) until it is `CONFIRMED`. When the operator confirms, flip the status here and note the date.

---

## S1 — STT/TTS provider
**Status:** `PROVISIONAL — pending operator confirm`
**Decision:** Local-first, provider-pluggable. Default to **local models** (whisper.cpp for STT + a local TTS) for anything touching secrets, wallet, or offline use; offer an **optional cloud tier** (higher-quality STT/TTS) selectable per-context, wired the same way `llm-router.ts` abstracts LLM providers.
**Rationale:** Voice carries the operator's private context (emails, file names, wallet amounts). Local-first keeps that off third-party servers by default and satisfies the degraded/offline mode (PRD §7.6, §8). A pluggable layer lets the operator opt into cloud quality where privacy isn't a concern, with no lock-in.
**Unblocks:** B1 (Voice Gateway), and therefore B2/B3, D1.
**Needs from operator:** confirm the local-first stance; approve a cloud provider + budget if the optional tier is wanted; confirm no cloud STT for wallet/secret-adjacent commands.

## S2 — iPhone / remote surface
**Status:** `PROVISIONAL — pending operator confirm`
**Decision:** **Telegram-only for v1.** No App Store release. Remote voice/text/files/approvals ride the existing Telegram receiver (`telegram-bot.ts` + `webhook-auth.ts` HMAC). A thin PWA or native client is a **v2 candidate**, revisited once the flows settle.
**Rationale:** Fastest path to remote control, zero App Store latency/review, and it reuses a hardened primitive (per-org HMAC receiver) instead of standing up a new client + push infra. PWA/native adds a large surface for marginal v1 value.
**Unblocks:** D1/D2 framing (and confirms no `app/` Expo revival is needed for this).
**Needs from operator:** confirm Telegram is acceptable as the **sole** remote surface for v1.

## S3 — Mac-control adapter approach
**Status:** `PROVISIONAL — pending operator confirm` *(safety-critical — must be CONFIRMED before C-epic dangerous stories ship)*
**Decision:** Build a **custom hardened local daemon** (`adapters/arturita-host/`, sibling to `adapters/mac-mini/`) for the write/destructive path. Optionally use an existing MCP (desktop-commander / computer-use) for **read/inspection only**. The daemon owns the safety envelope: allowlist root, hard denylist, blast-radius caps, path canonicalization, undo journal, fail-closed, runs as the operator user (no sudo).
**Rationale:** A general-purpose MCP (desktop-commander/computer-use) does not and cannot enforce the allowlist-root + denylist + blast-radius + undo + fail-closed guarantees the PRD requires (§7.3). Those guarantees are the product's safety story; they must live in code we own and test, not a third-party tool with broad filesystem/shell reach. A custom daemon also gives a clean authenticated channel (agent token + mTLS or signed local socket) and matches the existing mac-mini adapter install/keep-alive pattern.
**Open sub-choices (resolve in the S3 spike):** (a) daemon language — Node (matches the repo) vs a small Swift/Go helper for native macOS APIs; (b) auth channel — mTLS vs signed local socket.
**Unblocks:** C1 (Local Host daemon), and therefore C2/C3, D2.
**Needs from operator:** approve building a local daemon on the Mac; provide the **allowlist root(s)** and confirm the **denylist** (`~/.ssh`, keychains, `.env`/secret files, wallet vaults, browser profiles with wallet-extension data, the host's own config).

## S4 — WalletConnect integration proof
**Status:** `CONFIRMED (provider)` in PRD §12 · spike `PROVISIONAL`
**Decision:** **WalletConnect** is the v1 wallet-integration provider (decided in PRD §12 — works with MetaMask + Brave, keeps Arturita out of key custody, avoids a fragile extension bridge). The remaining work is a **timeboxed spike**: a WalletConnect v2 handshake + one **simulated** swap end-to-end (no real funds) against MetaMask **and** Brave, plus choosing the calldata-decode + contract-label source (self-hosted decoder vs a decode API).
**Rationale:** Provider is settled; the spike de-risks the unsigned-tx handoff and confirms the no-custody invariant holds through the flow before E2 is built.
**Unblocks:** E2 (approval card + signing handoff).
**Needs from operator:** a **WalletConnect project id** (go-live), a **test wallet + testnet** for the spike, and confirmation of per-tx / per-day caps + destination allowlist values.

## S5 — Wake-word vs push-to-talk
**Status:** `PROVISIONAL — pending operator confirm`
**Decision:** **Push-to-talk by default; wake-word ("Arturita") opt-in.**
**Rationale:** Always-listening is a standing privacy cost (a hot mic in the operator's office/home); push-to-talk is an explicit, auditable capture. Wake-word remains available for hands-free use as an opt-in.
**Unblocks:** B2 (Cockpit voice panel default behavior).
**Needs from operator:** confirm push-to-talk default is acceptable.

## S6 — `machine_exec` allowlist scope at launch
**Status:** `PROVISIONAL — pending operator confirm` *(safety-critical — must be CONFIRMED before C3 ships)*
**Decision:** **Empty allowlist at launch.** No command runs from the model without an explicit per-command opt-in (each an approval-gated `machine_exec` showing exact argv). Never a free-form shell from the model.
**Rationale:** `machine_exec` is the highest-blast-radius capability. Starting empty means the default posture is "Arturita cannot run commands," and the operator grows the allowlist deliberately.
**Unblocks:** C3 (`machine_exec` + doc editing).
**Needs from operator:** provide the initial command allowlist (recommended: none) and confirm the opt-in-per-command model.

---

## Standing decisions (already settled in the PRD — recorded here for the cold-start reader)
| # | Decision | Source | Status |
|---|---|---|---|
| D-a | **No key custody, ever** — Arturita never imports/stores/transmits a private key or seed phrase; wallet is read+prepare+simulate only; the operator signs in the wallet UI. | PRD §2, §7.4 | `CONFIRMED` (invariant) |
| D-b | **Every dangerous action gates through the existing tri-state approval flow** (`file_destructive`/`wallet_tx`/`email_send`/`machine_exec`) with step-up. | PRD §7.1, PLAN A2 | `CONFIRMED` |
| D-c | **Safety spine (Epic A) ships before any dangerous surface;** `machine_exec` (C3) + wallet signing (E2) are last. | PRD §10, PLAN §2 | `CONFIRMED` |
| D-d | **Single operator only** — Arturita is owner-scoped, not multi-tenant, in v1. | PRD §2 | `CONFIRMED` |
| D-e | **Voice audio discarded after transcription** — no long-term audio store; transcripts live in the (deletable) task thread. | PRD §7.8 | `CONFIRMED` (confirm no audit-audio store wanted) |
| D-f | **`WEBHOOK_SIGNING_SECRET` is a hard prerequisite** for enabling Telegram remote control (receivers must be HMAC-enforced, not open). | PRD §11, §7.1 | `CONFIRMED` (operator must set the secret at go-live) |
| D-g | **LLM failover is cost-bounded** — every retry re-runs the preflight per-wake cap. | PRD §6 | `CONFIRMED` |

---

_Linked from `docs/PLAN-arturita.md` §3 and `HANDOFF.md`. When the operator confirms an S-decision, flip its status to `CONFIRMED (YYYY-MM-DD)` here and note it in the PLAN §3 table + HANDOFF._
