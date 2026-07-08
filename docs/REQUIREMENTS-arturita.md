# REQUIREMENTS — Arturita (master acceptance checklist)

> **The master acceptance checklist.** Every functional (FR) and non-functional (NFR) requirement from `docs/PRD-arturita.md`, made checkable and mapped to the story (`docs/PLAN-arturita.md`) that delivers it. A requirement is `[x]` only when its story has merged **and** the requirement is verified.
> **Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done + verified. **Date:** 2026-07-08.

**How to use:** when a story merges, tick its requirements here and in the same PR. This file is the single source of truth for "are we done?" — the PRD describes intent, this enumerates the testable bar.

---

## Functional requirements

### Voice & interaction
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-1 | Operator can issue spoken commands from the desk (Cockpit mic, push-to-talk). | B2 | `[x]` (B2 #197: `VoiceSection` push-to-talk mic in Cockpit via Web Speech API, routes through `/arturita/voice`; typed fallback for no-mic browsers. Live raw-audio STT *engine* server-side remains the go-live item) |
| FR-2 | Spoken input is transcribed with a confidence score; low-confidence transcripts trigger a re-prompt, never a guess. | B1, A3 | `[~]` (B1: `gateTranscript` (empty/reprompt/accept) + `TranscriptResult.confidence`; A3 re-prompt path done; live STT provider returning the score wires when an S1 provider is configured) |
| FR-3 | Wake-word ("Arturita") is available as an opt-in; push-to-talk is the default. | B2 (S5) | `[x]` (B2 #197: Cockpit panel — push-to-talk default, "Arturita" wake-word opt-in toggle; client gate mirrors B1's `hasWakeWord`/`stripWakeWord`, unit-tested) |
| FR-3a | **(new — S1)** Voice runs under a **`local\|provider` config setting, selectable per context**; interim `provider` = **Chatterbox TTS via NVIDIA API**; `local` default for sensitive/wallet-adjacent contexts. Provider key lives in the encrypted secrets store, never git. | B1 (S1) | `[x]` (B1 #188: `voice-config.ts` `resolveVoiceMode` (sensitive→forced local) + `selectVoiceProvider`; `voice-provider.ts` `chatterboxNvidiaSynthesize` reads `NVIDIA_API_KEY` from the secret store at call time; `POST …/arturita/voice`) |
| FR-4 | Arturita replies by voice (TTS) on the desk and as a Telegram voice message remotely. | B1, B2, D2 | `[~]` (B1 #188: `synthesizeSpeech` returns spoken audio (Chatterbox/NVIDIA or local), degrading to text on outage. **B2 #197: desk playback shipped** — provider TTS bytes play directly, else the browser SpeechSynthesis voices the text locally. Telegram voice replies remain D2) |
| FR-5 | Questions route to a single-turn `ask` (no workspace/checkout); work orders route to the `execute` loop. | B3 | `[~]` (B3: `routeVoiceCommand` — question→ask, work order→execute, destructive→execute-always; reuses `askmode`/`intent`. Executor wiring pends the B1 voice endpoint) |
| FR-6 | A follow-up utterance continues the same task thread (wake-on-comment). | B3, B2 | `[~]` (B3 `routeVoiceCommand` sets `isFollowUp` from an existing thread id; the `/voice` endpoint links `parentTaskId`, and **B2 passes the last `taskId` as `existingThreadId`** so consecutive utterances thread. Full wake-on-comment re-entry into a *running* thread pends the executor wiring) |
| FR-7 | Operator can interrupt (barge-in) a spoken reply; long answers summarized aloud with full text in the thread. | B1/B2 | `[ ]` |

### Machine control
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-8 | **(changed — S3)** Arturita can list/read files & directories across the **whole machine** (full control assumed), except the minimal self-protection denylist (own secret store, burner keystore, daemon config, OS system-integrity paths). | C1, C2 | `[~]` (C1 #189: `adapters/arturita-host` daemon does real `/list`+`/read` enforcing whole-machine root + denylist, verified over HTTP; backend→daemon proxy is C2) |
| FR-9 | Arturita can create/edit files & documents; edits show a diff preview; in-root + under-threshold edits are auto-safe. | C2, C3 | `[ ]` |
| FR-10 | Destructive file ops (move/delete/overwrite) produce a preview manifest (count, size, destination) before executing. | C2 | `[~]` (C1 #189: daemon `/preview` builds the manifest (count/size/destination) without acting; `buildPreviewManifest` in host-planner) |
| FR-11 | Destructive/over-threshold file ops require a `file_destructive` approval. | C2, A2 | `[ ]` |
| FR-12 | File ops are reversible via an undo journal ("undo that") within the window. | C2 | `[~]` (C1 #189: approved destructive ops stage originals + `/undo` restores within a 10-min window; verified with tests) |
| FR-13 | **(changed — S6)** `machine_exec` allows broad commands (full control assumed); the **destructive/irreversible subset** is A2-gated + two-phase confirm, showing exact argv verbatim. A misheard/mis-planned destructive command can't run silently. | C3, A2 | `[ ]` |
| FR-14 | Every host action is recorded as a task + thread entry + heartbeat block (nothing invisible). | C2 | `[ ]` |

### Email & calendar
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-15 | Arturita can read calendar and answer scheduling questions (read-only, no approval). | B3 (Google connector) | `[ ]` |
| FR-16 | Arturita can read Gmail threads and draft replies (draft only, no send). | B3 (Google connector) | `[ ]` |
| FR-17 | Sending email requires an `email_send` approval showing recipient + full body. | A2 | `[~]` (A2: `email_send` type + machine-rendered summary showing recipients + subject + body size; the actual Gmail send wiring is a later B3/email story) |
| FR-18 | External-recipient / reply-all / attachment sends carry an explicit warning; secret-pattern content is refused without override. | A2 (PRD §7.5) | `[~]` (A2: renderer surfaces external/reply-all/attachment/secret-pattern warnings on the card; enforcement of the refuse-without-override wires with the send path) |

### Crypto wallet (read + prepare + policy-gated bounded signing — **model changed 2026-07-08, S4**)
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-19 | Arturita reads balances/positions and public chain data (gas, etc.) via RPC — no key needed. | E1 | `[~]` (E1: unit helpers + `wallet_intents` + prepare/simulate endpoints; live RPC balance read wires when an RPC endpoint is configured — no key needed by design) |
| FR-20 | Arturita builds a transaction and **simulates** it (gas, slippage, expected output, revert) **before any signing**. | E1 | `[x]` (E1: `buildUnsignedTx` (key-free) + `summarizeSimulation` (gas cost + revert) + `POST …/wallet/prepare`/`…/simulate`) |
| FR-21 | Transactions at/above the per-tx threshold surface a `wallet_tx` approval with decoded calldata + contract label in plain language. | E2, A2 | `[ ]` |
| FR-22 | **(changed — S4)** Sub-threshold **in-policy** txs are **signed autonomously from the dedicated capped burner** (testnet this wave); at/above-threshold txs go to the operator via approval. The operator's **main** wallet is never held; the burner key is sealed, never plaintext/logged. Mainnet autonomous signing is off until an explicit go flag. | E2 (S4) | `[ ]` |
| FR-23 | Per-tx threshold (default **$100**, configurable) + per-day cap + destination allowlist enforced by the **policy engine**; over-cap / off-allowlist requires step-up/approval. | E2 | `[~]` (E2 #186: `evaluateWalletPolicy` (per-tx threshold/per-day/allowlist → autonomous_sign\|require_approval\|refuse) + `wallet_policy` table + `PUT/POST …/wallet/policy`/`…/evaluate`; live signer wiring is go-live) |
| FR-24 | Scam guards: warn/step-up on new addresses, `setApprovalForAll`, unlimited approvals, drain-pattern calldata — forcing approval even below the value threshold. | E2 | `[~]` (E1: `detectScamSignals` covers all four (+ unknown contract), surfaced on `prepare`; the `wallet_tx` approval *card* + policy step-up is E2) |
| FR-24a | **(new — S4)** Simulate-before-sign is enforced: a tx that would revert or lacks a simulation is **refused, not signed** (autonomous or approved). | E2 | `[~]` (E2 #186: `evaluateWalletPolicy` returns `refuse` on null/reverting sim + drain pattern, before any signing gate) |
| FR-24b | **(new — S4)** The burner wallet is **dedicated + separate** from the operator's main wallet, funded with a capped balance (capped funding = capped loss). | E2 (go-live) | `[ ]` |

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
| FR-29 | Arturita swaps LLM providers per task and fails over across an ordered fallback chain on provider failure. | F1 | `[x]` (F1 #187: `streamLLMWithFallback` wraps the live executor `streamLLM` call — walks `arturita_fallback_chain` from deployConfig on failure; identical to a bare call when no chain is set) |
| FR-30 | Failover handles 5xx/timeout/429/auth/context-overflow/refusal; a circuit breaker skips unhealthy providers. | F1 | `[~]` (F1: `classifyLlmError` covers all six classes + `recordFailure`/`isProviderHealthy` circuit breaker with cooldown/re-probe, all tested; live wiring is the follow-up) |
| FR-31 | Offline/degraded: local LLM + local STT/TTS keep Arturita conversational; cloud-dependent actions queue and replay idempotently on reconnect. | F2 | `[~]` (F2: `routeForConnectivity` (local run / cloud queue-offline / host fail-closed) + `planReplay` idempotent nonce-guarded exactly-once replay — pure logic done; queue store + host-health wiring pends B1/C1 execution) |
| FR-32 | Provider/model health is visible on `/health` + the Cockpit. | F1 | `[~]` (F1 #187: `/health` now returns `llm.providers` (breaker state per provider) + `llm.unhealthy`; a Cockpit surface can render it) |

### Session, auth & orchestration
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-33 | Arturita exists as an owner-scoped agent persona per org. | A1 | `[x]` (A1: `agentType='arturita'`, idempotently ensured per org) |
| FR-34 | Remote control is bound to the single operator (Telegram chat id + Cockpit identity) via a one-time Cockpit code. | A1 | `[~]` (A1: begin/confirm/revoke binding + one-time hashed code with TTL, single-use; primary Telegram-driven confirm path lands in D1) |
| FR-35 | Command sessions are short-lived and individually revocable; dangerous actions require a fresh session / step-up. | A1, A2 | `[x]` (A1: short-lived + individually revocable sessions + `isFresh`/`needsStepUp`; A2: `POST /api/approvals/:id/decide` refuses to *approve* a dangerous type without a fresh command session — 403) |
| FR-36 | Destructive intents are classified and always produce a preview + explicit distinct confirmation (two-phase). | A3 | `[~]` (A3: `classifyIntent`/`confirmationPhraseFor`/`isConfirmed` pure two-phase logic done — generic yes rejected for the top tier, low STT-confidence re-prompts; wired to the voice loop in B1/B3) |
| FR-37 | New endpoints are self-described via `/api/openapi.json`; CLI `7ei-mc` gains `arturita bind|panic|host-status`. | G1 | `[ ]` |

### Packaging & distribution (Epic H — new 2026-07-08; design/plan this wave)
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-38 | The solution is installable on a fresh Mac as a **signed + notarized** `.dmg` / app bundle (Gatekeeper-accepted), built reproducibly from the repo. | H1 | `[ ]` |
| FR-39 | A **first-run permission wizard** walks the operator through granting the macOS TCC permissions the host daemon needs (Full Disk Access, Accessibility, Automation, Microphone, …), shows granted/missing state, and the daemon fails closed on a missing grant. | H2 | `[ ]` |
| FR-40 | Installed hosts **auto-update** via a signature-verified release feed, with version pinning + rollback. | H3 | `[ ]` |
| FR-41 | A fresh machine can be **bootstrapped from zero**: encrypted secret-store init, secrets/keystore load (NVIDIA key, Telegram token, RPC, burner keystore), `deployConfig`, and the one-time bind — no plaintext secret on disk, nothing committed. | H4 | `[ ]` |
| FR-42 | The iPhone remote surface is delivered as **v1 Telegram** (Epic D) and a **v2 dedicated native/PWA client** (design/plan only this wave). | H5, D1/D2 | `[ ]` |

### Jarvis Cockpit tab (Epic J — new 2026-07-08; `docs/PRD-jarvis-tab.md`)
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-43 | Arturita **answers the operator directly by default** (one conversational LLM turn via the F1 fallback chain); she routes into the task/agent flow **only** on an explicit build/do/delegate request or a destructive intent. | J1 | `[x]` (J1: pure `decideConverseMode` — destructive→delegate(gated); explicit flag/phrase/build-order→delegate; else answer; 12 tests. `/converse` answer mode calls `streamLLMWithFallback`, takes no actions) |
| FR-44 | The **routing decision** (answer vs delegate, and why) is surfaced to the operator on every turn. | J1 | `[x]` (J1: `routing` on the `/converse` response + `routingBadge`/reason rendered on each Arturita message) |
| FR-45 | The Assistant tab presents a **reactive HUD orb** reflecting voice state (idle/listening/thinking/speaking), colorblind-safe (color + icon + label + motion), motion disabled under `prefers-reduced-motion`. | J1 | `[x]` (J1: `AssistantOrb` + `orbVisual`/`resolveVoiceState`; per-state icon+label+motion in the purple/blue family — no red/green-only; reduced-motion CSS guard) |
| FR-46 | Conversational replies are **streamed** (v1 client-side reveal; J4 server SSE). | J1, J4 | `[~]` (J1: client-side typewriter reveal over the full chain answer; server token-streaming/SSE = J4) |
| FR-47 | Every pipeline layer (**LLM · STT · TTS**) **defaults to a free/self-hosted option, has a configured fallback chain, and is switchable from the Config panel** (extends S1 `local\|provider`; reuses the F1 circuit breaker on all three layers). Defaults: LLM local Ollama→free-tier cloud; STT whisper.cpp→Web Speech; TTS Piper/local-Chatterbox→browser. | J2, J3 | `[x]` (J2 #202/#203: pure resolvers + free-first defaults + `GET/PUT /arturita/pipeline` + Config-panel editor; LLM chain live in converse; STT/TTS chains configurable — engine wiring for host whisper.cpp/Piper = J3 go-live) |
| FR-48 | The tab is a **brainstorm/conversation partner by default**; delegation to builder/executor agents is **explicit + confirmed** (delegation phrase / build order / toggle / destructive intent), routed through B3 ask-vs-execute + A3 intent into the task flow, gated by A2 approvals. | J1, J6 | `[x]` (J1: `decideConverseMode` — answer-by-default, explicit-only delegate; interaction model in PRD §1; inline approvals = J6) |

### Memory & vault graph (Epic M — new 2026-07-08; operator request)
| ID | Requirement | Story | Status |
|---|---|---|---|
| FR-43 | The Memory tab has a **vault picker** at the top: the operator selects/points the Obsidian vault (repo/root/branch), defaulting to the org TARCO vault; the choice **persists** (`VAULT_CONFIG`). Path is configurable, never hardcoded. | M1, M3 | `[~]` (backend `VAULT_CONFIG` persistence reused; picker UI = M3) |
| FR-44 | The tab renders an **interactive force-directed graph** of the vault: nodes = notes (+tags), edges = `[[wikilinks]]`/tags/containment; color/cluster by folder; node size by degree; zoom/pan/search; hover highlights connections; clicking a node opens the note. | M3 | `[~]` (graph model shipped; d3 view = M3) |
| FR-45 | The graph renders from a **Graphify `graph.json`** when one exists in the vault (richer backend), and **falls back to a native `[[wikilink]]`/#tag/frontmatter parse** when it does not. | M1, M2 | `[x]` (`/memory/graph`: Graphify-first via `parseGraphifyGraph`, native fallback via `buildNativeGraph`) |
| FR-46 | A way to **(re)build** the graph for the selected vault is surfaced as a status + command in the tab (`graphify update <root>`); MCP exposure of the graph for agents is scaffolded as a follow-up. | M2 | `[~]` (rebuild command + `?rebuild=1` cache-bust shipped; MCP = follow-up) |
| FR-47 | The initial `graph.json` is **built from the current TARCO vault** and committed to the vault repo (not the app bundle). | M2 | `[x]` (structural/AST pass, committed to `vault/graphify-out/`) |

---

## Non-functional requirements

### Safety (primary)
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-1 | **(changed — S4/S6)** **100%** of destructive file ops, **wallet txs at/above the per-tx threshold**, destructive/irreversible `machine_exec`, and email sends pass through an approval before execution. Sub-threshold in-policy burner txs are autonomous but simulated + cap-checked + logged. | A2 + C2/E2/A2 | `[~]` (A2: the gate exists — dangerous types + machine-rendered verbatim summary + step-up on approve; per-surface *execution* wiring enforced in C2/E2/D2) |
| NFR-2 | **(changed — S4)** The operator's **main-wallet** private key / seed never touches Arturita's process. The **burner** key exists only **sealed** in the encrypted keystore — never plaintext at rest, never logged, never in a prompt/transcript/vault, never an API in/out, denylisted from the host. Enforced by design invariant + CI secret-scan. | E1/E2 | `[~]` (E1: `looksLikeKeyMaterial`/`assertNoKeyMaterial` guard every persisted `wallet_intents` field; E2 adds the sealed-keystore boundary + no-key-in-API rule; CI secret-scan **workflow** is a go-live item — `.github/workflows` change, see QUESTIONS) |
| NFR-3 | No dangerous surface (B/C/D/E) merges before A2 (the approval-type gate) is on `main`. | sequencing | `[ ]` |
| NFR-4 | Destructive voice commands are never one-shot: ≥99% require an explicit confirmation utterance/tap; ambiguous/low-confidence → reject + re-prompt. | A3, B1 | `[~]` (A3: two-phase confirm logic — bare affirmative rejected, action-verb restatement or tap required, sub-threshold STT re-prompts; end-to-end voice wiring in B1) |
| NFR-5 | Voice never authorizes an address or amount alone — entities echoed visually before wallet/email approval. | A3, E2 | `[ ]` |
| NFR-6 | **(changed — S3)** Machine ops span the whole machine but **cannot touch the self-protection denylist** (own secret store, burner keystore, daemon config, OS system-integrity paths), hard-refused for read + write; canonicalize + no `..`/symlink escape past the denylist boundary. | C1 | `[~]` (C1 planner: `canonicalizePath`/`isWithinRoot`/`hitsDenylist`/`decideAccess` logic done + tested; the daemon (`adapters/arturita-host` #189) realpath-resolves symlinks + enforces root+denylist over HTTP, verified end-to-end) |
| NFR-6a | **(new — S4)** The **burner keystore** is denylisted from the host daemon (S3) and from any file/exec path — Arturita cannot read or overwrite her own signing key. | C1, E2 | `[~]` (E2 #186: keystore-denylist invariant documented in `docs/WALLET-KEYSTORE-arturita.md` §2; host-daemon denylist enforcement is C1) |
| NFR-7 | Blast-radius caps: over-cap ops require approval; over hard-ceiling refused outright. | C1, C2 | `[~]` (C1 planner: `classifyBlastRadius` — auto-safe / needs-approval / refuse, destructive never auto-safe — done + tested; execution wiring blocked on S3) |
| NFR-8 | Local host is fail-closed — acts only on an authenticated, approved backend command; runs as operator user, no sudo. | C1 | `[~]` (C1 #189: daemon binds 127.0.0.1 only, requires a bearer token (refuses to start without one), destructive `/apply` requires `approved:true` else refused; runs as operator user, no sudo) |

### Security
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-9 | Every inbound Telegram webhook is HMAC-verified (403 before DB work); `WEBHOOK_SIGNING_SECRET` required to enable remote control. | D1 (existing webhook-auth) | `[ ]` |
| NFR-10 | Commands carry a nonce; duplicate/replayed commands are rejected (Telegram redelivery + captured-voice replay). | A1, D1 | `[~]` (A1: `isFreshNonce` helper + `arturita_nonces` unique-index ledger; enforcement on the command path lands in D1) |
| NFR-11 | Secrets (provider keys incl. `NVIDIA_API_KEY`, Telegram bot token, RPC keys, bindings, host creds, **sealed burner keystore**) live in the scoped AES-256-GCM store; injected into execution, never into prompts/transcripts/logs/vault, **never committed to git** (`.env.example` placeholders only). | A1, E1, B1, E2 (existing secrets.ts) | `[ ]` |
| NFR-12 | Unbound identities and forged commands are refused and logged. | A1 | `[x]` (A1: `isBoundChat`/`isBoundOperator` fail closed; `/panic` refuses + logs an invalid/absent session token) |

### Reliability & performance
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-13 | LLM failover completes the task on a fallback in ≥95% of primary-provider outages, within the per-wake cost cap. | F1 | `[~]` (F1 #187: live wiring done — failover engages on the executor hot path; the ≥95% figure is an operational metric to validate once a chain is configured with real providers) |
| NFR-14 | Failover retries are cost-bounded — cannot exceed the preflight per-wake cap; exhausted chain parks the task with a plain-language `system_notice`. | F1 | `[~]` (F1: `planFallback` drops hops over the per-wake cap (reuses `estimateWakeCost`) and emits a plain-language park reason when exhausted; posting the `system_notice` wires with the executor follow-up) |
| NFR-15 | Desk voice → first action ≤ 3s p50; Telegram voice note → acknowledged ≤ 5s p50. | B1/B2/D1 | `[ ]` |
| NFR-16 | Long/expensive Arturita runs carry watchdogs (runtime/cost/no_activity), edge-triggered (fire once on transition). | F2 | `[~]` (F2: `defaultArturitaWatchdogs` builds runtime/cost/no_activity specs via the shipped `watchdogs.ts` (edge-triggered W4 sweep unchanged); attaching them on task creation wires with the voice endpoint) |

### Privacy & observability
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-17 | Voice audio discarded after transcription; no long-term audio store; transcripts operator-deletable. | B1 | `[~]` (B1: `AUDIO_RETENTION='discard_after_transcription'` invariant marker + no audio persisted by design; enforced end-to-end when the voice endpoint lands with the S1 provider) |
| NFR-18 | A "what did you hear/do" audit view lists recent transcripts + actions. | B2/G1 | `[~]` (B2 #197: the panel's action feed lists recent commands heard + how each routed (ask/execute/reprompt, needs-approval); a persisted org-wide audit view is G1) |
| NFR-19 | Every Arturita action is visible as a task with a thread + heartbeat block (no silent actions). | A1/C2/timeline | `[ ]` |

### Conventions & quality gates (per story)
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-20 | Business logic in pure-helper services with `node --test`; routes thin (routes→services only). | all | `[ ]` |
| NFR-21 | Schema changes are idempotent migrations; boot + auth-scoping tests green. | all | `[ ]` |
| NFR-22 | UI is colorblind-safe per DESIGN_SYSTEM v2 (icon+text+shape, red never lone CTA). | B2/D2 | `[~]` (B2 #197: voice panel is colorblind-safe — every state carries icon+text+shape, tri-state approvals reuse the accent/accent/red pattern where red is never the lone CTA, design tokens only; D2 Telegram surface pending) |
| NFR-23 | Invariant green each merge: backend tests · 11/11 evals · web build. | all | `[ ]` |
| NFR-24 | Docs bumped per PR (STATUS + this checklist + PLAN tracker); milestone mirrored to the vault. | all | `[ ]` |

### Packaging & distribution (Epic H — non-functional)
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-25 | The macOS bundle is **code-signed (Developer ID) + notarized**; updates are signature-verified; a bad update can be rolled back. | H1, H3 | `[ ]` |
| NFR-26 | Fresh-machine bootstrap writes **no plaintext secret to disk** and commits nothing; the burner key is sealed at rest. | H4 | `[ ]` |
| NFR-27 | The host daemon **fails closed** on any macOS TCC permission it needs but hasn't been granted, with a clear spoken/text reason (ties to the H2 wizard). | H2, C1 | `[ ]` |

### Memory & vault graph (Epic M — non-functional)
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-28 | The Graphify **semantic pass costs money (AI API + key)** and is **never run unprompted**: the graph is built with the **structural/AST pass only** (`graphify update --no-cluster`, no LLM); running the semantic pass is an explicit operator decision (which provider/key + rough cost), logged in DECISIONS/QUESTIONS. **No API key is ever committed.** | M2 | `[x]` (structural pass only; no key present in env; semantic pass deferred to operator — QUESTIONS Q-M1) |
| NFR-29 | The graph endpoint is **read-cheap**: Graphify graph.json is one fetch; the native fallback is capped (≤120 notes) + TTL-cached + flags truncation; colorblind-safe clustering (folder hues, never red/green-only). | M1, M3 | `[x]` (backend: cap+cache+`hasGraphify`/`truncated`; UI CVD ramp = M3) |

### Jarvis Cockpit tab (Epic J — non-functional)
| ID | Requirement | Story | Status |
|---|---|---|---|
| NFR-30 | The Jarvis tab ships **no new dangerous surface**: `answer` mode takes no actions; `delegate` mode only creates a `pending` task; every destructive/irreversible/outward action still flows through the **A2 approval gate**. | J1 | `[x]` (J1: `/converse` answer mode is read-only LLM; delegate mode inserts a `pending` task via B3 routing — destructive→execute-mode→A2; verified: no file/send/sign/exec path) |
| NFR-31 | Glassmorphism uses **design tokens only** (no raw hex); the glass hero is a floating chrome panel (DESIGN_SYSTEM v2), not a content list card; light+dark. | J1 | `[x]` (J1: `.mc-hero`/`.mc-orb` consume theme CSS vars only; hero is a floating panel; orb colors from `--accent`/`--info`/`--accent-2`/`--muted`) |
| NFR-32 | The **default pipeline is fully on-device** (local LLM + STT + TTS) so a brainstorm session need not leave the machine; a `local`/sensitive context **never** falls back to a cloud entry (S1 privacy); LLM fallbacks stay within the preflight per-wake cap (D-g). | J2, J3 | `[~]` (J2/J3: browser-direct **local Ollama** streams the answer on-device; `filterForContext` drops provider entries for sensitive contexts; `usableLlmChain` prunes to a cost-bounded chain. Fully-on-device STT/TTS needs host whisper.cpp/Piper — go-live) |

---

_Master checklist for Arturita. Tick items in the same PR that delivers them. When every FR/NFR is `[x]`, Arturita v1 is done. Cross-reference: `docs/PLAN-arturita.md` (stories) · `docs/PRD-arturita.md` (intent) · `docs/DECISIONS-arturita.md` (S1–S6)._
