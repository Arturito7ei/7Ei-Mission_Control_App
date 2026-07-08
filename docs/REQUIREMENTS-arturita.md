# REQUIREMENTS — Arturita (master acceptance checklist)

> **The master acceptance checklist.** Every functional (FR) and non-functional (NFR) requirement from `docs/PRD-arturita.md`, made checkable and mapped to the story (`docs/PLAN-arturita.md`) that delivers it. A requirement is `[x]` only when its story has merged **and** the requirement is verified.
> **Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done + verified. **Date:** 2026-07-08.

**How to use:** when a story merges, tick its requirements here and in the same PR. This file is the single source of truth for "are we done?" — the PRD describes intent, this enumerates the testable bar.

---

## Functional requirements

### Voice & interaction
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-1 | Operator can issue spoken commands from the desk (Cockpit mic, push-to-talk). | B2 | `[ ]` |
| FR-2 | Spoken input is transcribed with a confidence score; low-confidence transcripts trigger a re-prompt, never a guess. | B1, A3 | `[ ]` |
| FR-3 | Wake-word ("Arturita") is available as an opt-in; push-to-talk is the default. | B2 (S5) | `[ ]` |
| FR-4 | Arturita replies by voice (TTS) on the desk and as a Telegram voice message remotely. | B1, D2 | `[ ]` |
| FR-5 | Questions route to a single-turn `ask` (no workspace/checkout); work orders route to the `execute` loop. | B3 | `[ ]` |
| FR-6 | A follow-up utterance continues the same task thread (wake-on-comment). | B3 | `[ ]` |
| FR-7 | Operator can interrupt (barge-in) a spoken reply; long answers summarized aloud with full text in the thread. | B1/B2 | `[ ]` |

### Machine control
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-8 | Arturita can list/read files & directories within the allowlisted root. | C1, C2 | `[ ]` |
| FR-9 | Arturita can create/edit files & documents; edits show a diff preview; in-root + under-threshold edits are auto-safe. | C2, C3 | `[ ]` |
| FR-10 | Destructive file ops (move/delete/overwrite) produce a preview manifest (count, size, destination) before executing. | C2 | `[ ]` |
| FR-11 | Destructive/over-threshold file ops require a `file_destructive` approval. | C2, A2 | `[ ]` |
| FR-12 | File ops are reversible via an undo journal ("undo that") within the window. | C2 | `[ ]` |
| FR-13 | `machine_exec` runs only allowlisted (or explicitly one-off-approved) commands, showing exact argv; never a free-form model shell. | C3, A2 | `[ ]` |
| FR-14 | Every host action is recorded as a task + thread entry + heartbeat block (nothing invisible). | C2 | `[ ]` |

### Email & calendar
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-15 | Arturita can read calendar and answer scheduling questions (read-only, no approval). | B3 (Google connector) | `[ ]` |
| FR-16 | Arturita can read Gmail threads and draft replies (draft only, no send). | B3 (Google connector) | `[ ]` |
| FR-17 | Sending email requires an `email_send` approval showing recipient + full body. | A2 | `[~]` (A2: `email_send` type + machine-rendered summary showing recipients + subject + body size; the actual Gmail send wiring is a later B3/email story) |
| FR-18 | External-recipient / reply-all / attachment sends carry an explicit warning; secret-pattern content is refused without override. | A2 (PRD §7.5) | `[~]` (A2: renderer surfaces external/reply-all/attachment/secret-pattern warnings on the card; enforcement of the refuse-without-override wires with the send path) |

### Crypto wallet (read + prepare, never sign)
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-19 | Arturita reads balances/positions and public chain data (gas, etc.) via RPC — no key needed. | E1 | `[ ]` |
| FR-20 | Arturita builds an **unsigned** transaction and **simulates** it (gas, slippage, expected output, revert). | E1 | `[ ]` |
| FR-21 | Transactions surface a `wallet_tx` approval with decoded calldata + contract label in plain language. | E2, A2 | `[ ]` |
| FR-22 | On approval the unsigned tx is handed to MetaMask/Brave via WalletConnect; the operator signs in the wallet UI. Arturita never signs. | E2 (S4) | `[ ]` |
| FR-23 | Per-tx / per-day caps + destination allowlist enforced; over-cap requires step-up. | E2 | `[ ]` |
| FR-24 | Scam guards: warn on new addresses, `setApprovalForAll`, unlimited approvals, drain-pattern calldata. | E2 | `[ ]` |

### Remote (Telegram)
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-25 | Operator controls Arturita remotely via Telegram voice notes and text, from the bound chat only. | D1 | `[ ]` |
| FR-26 | Operator can send/receive files over Telegram (upload → in-root/document-ingest; download). | D2 | `[ ]` |
| FR-27 | Approvals surface in Telegram as distinct inline buttons (✅ Approve / ✕ Reject / ↩ Changes) mapped to the tri-state flow. | D2, A2 | `[ ]` |
| FR-28 | `/panic` kill switch is available by voice and Telegram: pauses Arturita, cancels in-flight runs, revokes sessions. | A1 | `[~]` (A1: `POST /api/orgs/:orgId/arturita/panic` mechanism done — pauses persona, cancels runs, revokes all sessions, owner-authed via session token; voice/Telegram surfaces wire in B/D) |

### Resilience & LLM
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-29 | Arturita swaps LLM providers per task and fails over across an ordered fallback chain on provider failure. | F1 | `[ ]` |
| FR-30 | Failover handles 5xx/timeout/429/auth/context-overflow/refusal; a circuit breaker skips unhealthy providers. | F1 | `[ ]` |
| FR-31 | Offline/degraded: local LLM + local STT/TTS keep Arturita conversational; cloud-dependent actions queue and replay idempotently on reconnect. | F2 | `[ ]` |
| FR-32 | Provider/model health is visible on `/health` + the Cockpit. | F1 | `[ ]` |

### Session, auth & orchestration
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-33 | Arturita exists as an owner-scoped agent persona per org. | A1 | `[x]` (A1: `agentType='arturita'`, idempotently ensured per org) |
| FR-34 | Remote control is bound to the single operator (Telegram chat id + Cockpit identity) via a one-time Cockpit code. | A1 | `[~]` (A1: begin/confirm/revoke binding + one-time hashed code with TTL, single-use; primary Telegram-driven confirm path lands in D1) |
| FR-35 | Command sessions are short-lived and individually revocable; dangerous actions require a fresh session / step-up. | A1, A2 | `[x]` (A1: short-lived + individually revocable sessions + `isFresh`/`needsStepUp`; A2: `POST /api/approvals/:id/decide` refuses to *approve* a dangerous type without a fresh command session — 403) |
| FR-36 | Destructive intents are classified and always produce a preview + explicit distinct confirmation (two-phase). | A3 | `[ ]` |
| FR-37 | New endpoints are self-described via `/api/openapi.json`; CLI `7ei-mc` gains `arturita bind|panic|host-status`. | G1 | `[ ]` |

---

## Non-functional requirements

### Safety (primary)
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-1 | **100%** of destructive file ops, wallet txs, and email sends pass through an approval before execution. | A2 + C2/E2/A2 | `[~]` (A2: the gate exists — dangerous types + machine-rendered verbatim summary + step-up on approve; per-surface *execution* wiring enforced in C2/E2/D2) |
| NFR-2 | **Zero** private keys / seed phrases ever touch Arturita's process — enforced by design invariant + CI secret-scan. | E1 | `[ ]` |
| NFR-3 | No dangerous surface (B/C/D/E) merges before A2 (the approval-type gate) is on `main`. | sequencing | `[ ]` |
| NFR-4 | Destructive voice commands are never one-shot: ≥99% require an explicit confirmation utterance/tap; ambiguous/low-confidence → reject + re-prompt. | A3, B1 | `[ ]` |
| NFR-5 | Voice never authorizes an address or amount alone — entities echoed visually before wallet/email approval. | A3, E2 | `[ ]` |
| NFR-6 | Machine ops cannot escape the allowlist root (canonicalize + prefix check; no `..`/symlink escape); denylist hard-refused for read + write. | C1 | `[ ]` |
| NFR-7 | Blast-radius caps: over-cap ops require approval; over hard-ceiling refused outright. | C1, C2 | `[ ]` |
| NFR-8 | Local host is fail-closed — acts only on an authenticated, approved backend command; runs as operator user, no sudo. | C1 | `[ ]` |

### Security
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-9 | Every inbound Telegram webhook is HMAC-verified (403 before DB work); `WEBHOOK_SIGNING_SECRET` required to enable remote control. | D1 (existing webhook-auth) | `[ ]` |
| NFR-10 | Commands carry a nonce; duplicate/replayed commands are rejected (Telegram redelivery + captured-voice replay). | A1, D1 | `[~]` (A1: `isFreshNonce` helper + `arturita_nonces` unique-index ledger; enforcement on the command path lands in D1) |
| NFR-11 | Secrets (provider keys, RPC keys, bindings, host creds) live in the scoped AES-256-GCM store; injected into execution, never into prompts/transcripts/logs/vault. | A1, E1 (existing secrets.ts) | `[ ]` |
| NFR-12 | Unbound identities and forged commands are refused and logged. | A1 | `[x]` (A1: `isBoundChat`/`isBoundOperator` fail closed; `/panic` refuses + logs an invalid/absent session token) |

### Reliability & performance
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-13 | LLM failover completes the task on a fallback in ≥95% of primary-provider outages, within the per-wake cost cap. | F1 | `[ ]` |
| NFR-14 | Failover retries are cost-bounded — cannot exceed the preflight per-wake cap; exhausted chain parks the task with a plain-language `system_notice`. | F1 | `[ ]` |
| NFR-15 | Desk voice → first action ≤ 3s p50; Telegram voice note → acknowledged ≤ 5s p50. | B1/B2/D1 | `[ ]` |
| NFR-16 | Long/expensive Arturita runs carry watchdogs (runtime/cost/no_activity), edge-triggered (fire once on transition). | F2 | `[ ]` |

### Privacy & observability
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-17 | Voice audio discarded after transcription; no long-term audio store; transcripts operator-deletable. | B1 | `[ ]` |
| NFR-18 | A "what did you hear/do" audit view lists recent transcripts + actions. | B2/G1 | `[ ]` |
| NFR-19 | Every Arturita action is visible as a task with a thread + heartbeat block (no silent actions). | A1/C2/timeline | `[ ]` |

### Conventions & quality gates (per story)
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-20 | Business logic in pure-helper services with `node --test`; routes thin (routes→services only). | all | `[ ]` |
| NFR-21 | Schema changes are idempotent migrations; boot + auth-scoping tests green. | all | `[ ]` |
| NFR-22 | UI is colorblind-safe per DESIGN_SYSTEM v2 (icon+text+shape, red never lone CTA). | B2/D2 | `[ ]` |
| NFR-23 | Invariant green each merge: backend tests · 11/11 evals · web build. | all | `[ ]` |
| NFR-24 | Docs bumped per PR (STATUS + this checklist + PLAN tracker); milestone mirrored to the vault. | all | `[ ]` |

---

_Master checklist for Arturita. Tick items in the same PR that delivers them. When every FR/NFR is `[x]`, Arturita v1 is done. Cross-reference: `docs/PLAN-arturita.md` (stories) · `docs/PRD-arturita.md` (intent) · `docs/DECISIONS-arturita.md` (S1–S6)._
