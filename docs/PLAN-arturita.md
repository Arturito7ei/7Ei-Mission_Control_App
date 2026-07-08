# PLAN — Arturita: story-level build plan

> **Companion to `docs/PRD-arturita.md`** (the what/why). This is the how: Epics A–G broken into shippable stories with IDs, scope, acceptance criteria, dependencies, and sequencing — the same shape as the T/W/V/D plan that just completed (MCA-82/83/84/85).
> **Status:** Draft for review · **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai)
> **Convention:** one PR per story, squash-merged with `--admin`; pure-helper services + `node --test`; idempotent migrations; colorblind-safe UI (DESIGN_SYSTEM v2); docs bump per PR; invariant green each merge (**backend tests · 11/11 evals · web build**).

**Before writing any code, resolve the pre-build decisions/spikes in §3.** Two of them (STT/TTS provider, mac-control adapter approach) block the first stories of Epics B and C respectively. Epic A has no external blockers and can start immediately.

**Companion docs:** `docs/PRD-arturita.md` (intent) · `docs/DECISIONS-arturita.md` (S1–S6) · `docs/REQUIREMENTS-arturita.md` (FR/NFR acceptance checklist) · `docs/ONBOARDING-arturita.md` (cold-start) · `HANDOFF.md` (current story).

---

## 0. Status tracker (living — update on every merge)

This table is the source of truth for per-story status. Update the **Status** + **PR** cells in the same PR that lands the story (`todo` → `in-progress` → `done`). HANDOFF stays the "current story" pointer; this is the full board.

| Story | Title | Status | PR | Gating decision |
|---|---|---|---|---|
| **A1** | Persona, sessions & `/panic` kill switch | `done` | [#174](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/174) | — |
| **A2** | Dangerous-action approval types + step-up | `done` | [#175](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/175) | — |
| **A3** | Intent classifier + two-phase destructive confirm | `in-progress` | PR pending | — |
| **B1** | Voice Gateway (STT/TTS) | `todo` | — | S1 |
| **B2** | Cockpit voice panel | `todo` | — | S5 |
| **B3** | Ask-vs-execute routing from voice | `todo` | — | — |
| **C1** | Local Host daemon | `in-progress` (pure planner only — daemon blocked on **S3**) | PR pending | **S3** |
| **C2** | File ops + preview + undo | `todo` | — | S3 |
| **C3** | `machine_exec` allowlist + doc editing | `todo` | — | **S6** |
| **D1** | Telegram voice notes + text + auth | `todo` | — | S2 |
| **D2** | Telegram files + inline approvals + voice replies | `todo` | — | S2 |
| **E1** | Wallet read + prepare + simulate | `done` | [#178](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/178) | — |
| **E2** | Wallet approval card + WalletConnect handoff | `todo` | — | **S4** |
| **F1** | LLM fallback chain + circuit breaker | `done` | [#177](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/177) (pure layer; executor wiring follow-up) | — |
| **F2** | Degraded/offline + watchdogs | `todo` | — | — |
| **G1** | Self-description + CLI | `todo` | — | — |
| **G2** | Go-live gates + runbook | `todo` | — | — |

**Next story:** **A1** (no blockers). See `HANDOFF.md`. Bold gating decisions (**S3/S4/S6**) are safety-critical — the dependent story must not merge until that decision is `CONFIRMED` in `docs/DECISIONS-arturita.md`.

---

## 1. Story map (Epics A–G)

Story IDs are `<epic><n>` (A1, B2, …). Jira MCA issue numbers are **not yet assigned** — Atlassian OAuth is unavailable in build sessions (see HANDOFF standing items); file these interactively and back-fill the numbers here.

Legend — **Blocks**: what must land first. **Spike**: needs a decision/spike from §3 before it can start.

### Epic A — Foundation & safety spine `[no external blockers — start here]`
The dangerous surfaces (B/C/D/E) must not ship before this epic. A is the gate.

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **A1** · Persona, sessions & kill switch | New `services/arturita-session.ts` (pure: session mint/verify/revoke, TTL, freshness/step-up check, single-operator binding). New `arturita_sessions` + `arturita_bindings` tables (idempotent). Arturita agent persona seeded per org (owner-scoped). Endpoints: `POST/DELETE /api/arturita/session`, `POST /api/arturita/bind`, **`POST /api/arturita/panic`**. | `/panic` pauses Arturita (existing `canAgentRun` paused state), cancels in-flight runs, revokes all sessions — and is itself never gated. Sessions expire on TTL and are individually revocable. Binding is one operator only; unbound identities get a logged refusal. Pure helpers unit-tested; boot/auth-scoping tests green (panic public-but-owner-authed, session/bind Clerk-secured). | — |
| **A2** · Dangerous-action approval types + step-up | Extend the existing tri-state approval flow (`governance.ts` `[APPROVAL:…]` + `approvals.ts`) with four types: `file_destructive`, `wallet_tx`, `email_send`, `machine_exec`. Add step-up requirement (fresh session / explicit second factor) to `decideApproval` for these types. | Emitting any of the four directives creates an approval that **cannot** be executed without a fresh-session/step-up confirmation. Existing approve/reject/revision loop unchanged for other types. Approval card carries a machine-regenerated, verbatim action summary (not model prose). Helper tests cover each type + the step-up gate. | A1 |
| **A3** · Intent classifier + two-phase destructive confirm | New pure `services/intent.ts`: `classifyIntent(transcript)` tags destructive intents (delete/move/overwrite/send/sign/transfer); `confirmationPhraseFor(intent)`; low-confidence handling. Two-phase confirm helper: preview → explicit confirm utterance/tap. | Every destructive intent yields a preview + explicit distinct confirmation; a generic "yes"/"yeah" is insufficient for the top tier; STT-confidence below threshold → re-prompt, never guess. Pure, table-driven tests over a corpus of destructive/safe/ambiguous phrasings. | A1 |

### Epic B — Voice `[B1 needs Spike S1: STT/TTS provider]`

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **B1** · Voice Gateway (STT/TTS) | New `services/voice.ts` provider layer (same philosophy as `llm-router`): STT audio→transcript-with-confidence, TTS text→audio; cloud default + local fallback. Pure helpers: transcript normalization, wake/confirmation-phrase detection. Endpoint `POST /api/arturita/voice` (audio in → task + reply). | Transcribe returns confidence; low confidence routes to A3 re-prompt. Provider swap is config-driven; a provider outage falls back (cloud→alt→local→text-only) without dropping the command. Audio discarded post-transcription (PRD §7.8). Pure helpers unit-tested; endpoint self-described. | A1, A3, **S1** |
| **B2** · Cockpit voice panel | New `web/app/dashboard/cockpit/` voice section: push-to-talk (wake-word opt-in), live transcript, spoken replies, approval-aware action feed. | Colorblind-safe (icon+text+shape, never color-only; red never lone CTA — DESIGN_SYSTEM v2). Push-to-talk default; wake-word opt-in. Approvals render inline with the tri-state controls. Web build green. | B1, A2 |
| **B3** · Ask-vs-execute routing from voice | Route voice through the executor: questions → `ask` `work_mode` single-turn (reuse `askmode.ts`); work orders → `execute`. Follow-up voice notes re-enter the same thread (reuse `thread.ts` wake-on-comment). | "What's on my calendar" answers single-turn without a workspace/checkout; a work order runs the execute loop; a follow-up utterance continues the same task thread. Reuses existing helpers (no new loop). Tests cover the routing decision. | B1 |

### Epic C — Machine control `[C1 needs Spike S3: adapter approach]`

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **C1** · Local Host daemon | New `adapters/arturita-host/` daemon (sibling to `adapters/mac-mini/`; launchd keep-alive, `setup.sh`). Capability API (list/read/write/move/delete within root); allowlist root + hard denylist + blast-radius caps + path canonicalization; authenticated channel to backend (agent token + mTLS/signed socket); **fail-closed** (acts only on an authenticated, approved backend command). | Anything outside the allowlist root or matching the denylist (`~/.ssh`, keychains, `.env`, wallet vaults, host's own config) is refused for read *and* write. Path traversal (`..`, symlink escape) blocked via canonicalize-then-prefix-check. Runs as operator user, no sudo. No backend command → no action. Host action-layer has its own tests (language TBD by S3). | A1, **S3** |
| **C2** · File ops + preview + undo | File list/read/write/move/delete via the capability API, each producing a **preview manifest** (N files, size, destination) and an **undo journal** (originals staged, not purged). Gated by `file_destructive` approval when destructive or over threshold; in-root + under-threshold edits are auto-safe. New `host_actions` audit table. | A move/delete shows the exact manifest before executing; execution is reversible ("undo that") within the window; every op is a task+thread+heartbeat entry (nothing invisible). Blast-radius over cap → approval; over hard ceiling → refuse + ask to narrow. | C1, A2, A3 |
| **C3** · `machine_exec` allowlist + doc editing | Allowlisted command execution (no free-form shell from the model); each exec is an approval-gated `machine_exec` showing exact argv. Document editing with diff preview. | Only allowlisted (or explicitly one-off-approved) commands run; argv shown verbatim in the approval. Doc edits show a diff before write. Default allowlist empty (opt-in per command — see S6). | C1, A2 |

### Epic D — Remote (Telegram) `[D depends on the operator's surface choice, Spike S2]`

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **D1** · Voice notes + text + auth | Extend the existing Telegram receiver (`telegram-bot.ts` + `webhook-auth.ts` HMAC): voice notes → STT, text commands, from the **bound chat id** only; nonce/replay guard; short session + step-up for dangerous. | Only the bound operator chat controls Arturita; forged/misrouted updates 403 before DB work (HMAC); duplicate/replayed updates rejected (nonce). Voice notes transcribed via B1; audio not retained. Requires `WEBHOOK_SIGNING_SECRET` set (go-live gate). | A1, B1, D-surface (**S2**) |
| **D2** · Files + inline approvals + voice replies | Telegram file up/download (→ local host / document-ingest); inline-button approvals (✅ Approve / ✕ Reject / ↩ Changes) mapped to the tri-state flow; spoken replies as Telegram voice messages (TTS). | A remote destructive action surfaces distinct inline buttons (not one bared tap) mapped to approve/reject/revision; an uploaded file lands in-root (auto-safe if in-root+under-threshold) and can be summarized; replies come back as voice + text. | D1, C2, A2 |

### Epic E — Wallet (read + prepare, never sign) `[WalletConnect decided; E2 needs Spike S4 integration proof]`

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **E1** · Read + prepare + simulate | New `services/wallet.ts`: read balances/positions via RPC; build **unsigned** tx; **simulate** (gas, slippage, expected output, revert); decode calldata to a human-readable summary. RPC keys in `secrets.ts`. New `wallet_intents` table (decoded summary, sim result, caps checked — **no key material**). | Reads work with no key custody; unsigned tx + simulation produced; calldata decoded to plain language + contract label; **CI secret-scan + design invariant forbid any private-key/seed material in the process.** Helper tests over decode/simulate/cap logic. | A1 |
| **E2** · Approval card + WalletConnect handoff + caps | `wallet_tx` approval card (decoded summary, per-tx/per-day caps, address allowlist, scam guards: new-address/`setApprovalForAll`/unlimited-approval/drain-pattern warnings). On approval, hand the **unsigned** tx to MetaMask/Brave via **WalletConnect** (per §12 decision); the operator signs in the wallet UI. Record `signed_txhash` after the fact. | Two independent confirmations (Arturita's card + the wallet's native prompt); Arturita never signs. Over-cap → step-up; unknown contract / unlimited approval → extra warning. Value never authorized by voice alone (visual echo per A3/PRD §7.2/§7.4). | E1, A2, **S4** |

### Epic F — Resilience & LLM failover

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **F1** · Fallback chain + circuit breaker | Ordered fallback chain per agent in `deployConfig` (e.g. `arturita_fallback_chain`); circuit breaker on `llm-router.ts` (N failures → cooldown → re-probe); handle 5xx/timeout/429/auth/context-overflow/refusal; health on `/health` + Cockpit. | Primary outage → task completes on a fallback in ≥95% of cases; every retry re-runs the **preflight per-wake cost cap** (failover can't blow budget); exhausted/over-cap chain → task parks `blocked` with a plain-language `system_notice` (W1 recovery card) and Arturita says so aloud. Pure chain/breaker logic tested. | F depends on nothing new; do after A |
| **F2** · Degraded/offline + watchdogs | Local Ollama LLM + local STT/TTS keep Arturita conversational offline; cloud-dependent actions queue with "queued, will run when back online" and replay on reconnect (idempotent/nonce-guarded). Attach `watchdogs` (runtime/cost/no_activity) to long Arturita tasks. | Network down → still conversational + queued actions replay exactly once on reconnect; host down → file/machine actions refused with a spoken reason, read-only cloud still works; backend unreachable from host → host fail-closed. Watchdogs fire once on transition (edge-triggered, existing behavior). | F1, C1, B1 |

### Epic G — Docs/DX & go-live

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **G1** · Self-description + CLI | All new endpoints self-described via `openapi.ts` (`documentEndpoint`); CLI `7ei-mc` gains `arturita bind` / `arturita panic` / `arturita host-status`; `docs/API.md` narrative for the Arturita surface. | New paths appear in `/api/openapi.json` with correct auth scope (auth-scoping test green); CLI verbs work token/session-appropriately; API.md updated. | after A–E land |
| **G2** · Go-live gates + runbook | Extend `GO-LIVE.md` with PRD §11 gates (WEBHOOK_SIGNING_SECRET as hard prereq, STT/TTS keys + local models, Telegram bind, host install, WalletConnect project id + caps, fallback chain). Operator runbook. Update `STATUS.md`/`HANDOFF.md`/vault milestone. | Every user-only console action documented with the exact step; runbook lets the operator bring Arturita up from zero; docs/vault bumped. | G1 |

---

## 2. Sequencing & critical path

```
A1 ─┬─ A2 ─┬───────────────────────────────► (gates every dangerous story)
    └─ A3 ─┘
              B1 ─ B2 ─ B3        (voice; B1 waits on S1)
              C1 ─ C2 ─ C3        (machine; C1 waits on S3)
                        D1 ─ D2   (remote; needs B1+C2, surface choice S2)
              E1 ─ E2             (wallet; E2 waits on S4)
              F1 ─ F2             (resilience; F1 after A)
                        G1 ─ G2   (docs/go-live; after A–E)
```

- **Start now:** **A1** (no blockers). Then **A2** + **A3** in parallel after A1.
- **In parallel with A2/A3:** kick off spikes **S1** (STT/TTS) and **S3** (mac adapter) so B1/C1 aren't blocked when A lands.
- **Critical path:** A1 → A2 → (B1|C1) → C2/B2 → D1 → D2. Wallet (E) and resilience (F) run alongside once A is in.
- **Ship order rule (safety):** no B/C/D/E story merges before A2 (the approval-type gate) is on `main`. `machine_exec` (C3) and wallet signing (E2) are the **last** and most-guarded stories.
- **Suggested first PR:** **A1** — persona + session + `/panic` kill switch. It's the smallest self-contained safety primitive and unblocks everything.

---

## 3. Pre-build decisions & spikes (resolve before the blocked stories)

> **Recorded as a decision log in `docs/DECISIONS-arturita.md`** with per-item status (`PROVISIONAL — pending operator confirm` / `CONFIRMED`). The table below is the at-a-glance reference; DECISIONS is where status flips when the operator signs off.

These need an operator decision or a short timeboxed spike **before** the dependent stories start. None require writing feature code — they're decisions + throwaway proofs.

| # | Decision/Spike | Blocks | Recommendation | Needs from operator |
|---|---|---|---|---|
| **S1** | **STT/TTS provider** — cloud (quality/latency) vs local-first (privacy, offline). | B1, B3, D1 | **Local-first with a cloud option**: whisper.cpp (STT) + a local TTS for sensitive/offline, a cloud provider (higher quality) for everyday, provider-pluggable like `llm-router`. Prefer local for anything touching secrets/wallet. | Confirm privacy stance + budget; name the cloud provider if any. |
| **S2** | **iPhone surface** — Telegram-only (v1, no App Store) vs a thin PWA/native client. | D1, D2 (framing) | **Telegram-only for v1** (fastest, no App Store, reuses the HMAC receiver); revisit a PWA in v2 once flows settle. | Confirm Telegram is acceptable as the sole remote surface for v1. |
| **S3** | **Mac-control adapter approach** — build the custom hardened daemon (`adapters/arturita-host/`) vs. wrap an existing MCP (e.g. desktop-commander / computer-use) vs. hybrid. | C1, C2, C3 | **Custom daemon for the write/destructive path** (we need the allowlist-root + denylist + blast-radius caps + undo journal + fail-closed guarantees, which a general MCP won't enforce). Optionally *read/inspection* via an existing MCP. Timebox a spike to confirm the daemon's auth channel (mTLS vs signed local socket) and language (Node to match the repo vs a small Swift/Go helper for macOS APIs). | Approve building a local daemon on the Mac; confirm the allowlist root(s) + denylist. |
| **S4** | **WalletConnect integration proof** — v1 provider is **decided** (PRD §12); the spike is a read+prepare+simulate + unsigned-tx handoff proof against MetaMask **and** Brave, plus calldata decoding source (self-hosted decoder vs a decode API). | E2 | Timebox a WalletConnect v2 handshake + one simulated swap end-to-end (no real funds); pick the calldata-decode + contract-label source; confirm the no-custody invariant holds through the handoff. | Provide/confirm a WalletConnect project id (go-live); confirm test wallet + testnet. |
| **S5** | **Wake-word** — always-listening vs push-to-talk default. | B2 | **Push-to-talk default, wake-word opt-in** (privacy). | Confirm. |
| **S6** | **`machine_exec` allowlist scope at launch** — which commands (if any) are pre-allowed. | C3 | **Empty allowlist at launch**; every command opt-in per approval. | Provide the initial command allowlist (likely none). |

**Also flagged from the PRD (no decision needed, but call out at build time):**
- Voice audio retention default = discard-after-transcription (PRD §7.8) — confirm no audit-audio store is wanted.
- Per-tx / per-day wallet caps + address allowlist are operator-configured at go-live (E2 / GO-LIVE) — values TBD by operator.

---

## 4. Definition of done (per story)
- Pure-helper service with `node --test` coverage; routes thin (routes→services only).
- Idempotent migration if schema changes; boot + auth-scoping tests green.
- UI (if any) colorblind-safe per DESIGN_SYSTEM v2.
- New endpoints self-described (openapi) with correct auth scope.
- `STATUS.md` bumped; milestone mirrored to the vault `07-Agents/`.
- Invariant green: backend tests · 11/11 evals · web build.
- One PR, squash-merged with `--admin`.

_Next session: file Epics A–G as MCA issues, resolve S1–S6, and open the **A1** PR (persona + session + `/panic`). Do not ship any dangerous surface before A2 is on `main`._
