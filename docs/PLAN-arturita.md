# PLAN — Arturita: story-level build plan

> **Companion to `docs/PRD-arturita.md`** (the what/why). This is the how: Epics A–G broken into shippable stories with IDs, scope, acceptance criteria, dependencies, and sequencing — the same shape as the T/W/V/D plan that just completed (MCA-82/83/84/85).
> **Status:** Draft for review · **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai)
> **Convention:** one PR per story, squash-merged with `--admin`; pure-helper services + `node --test`; idempotent migrations; colorblind-safe UI (DESIGN_SYSTEM v2); docs bump per PR; invariant green each merge (**backend tests · 11/11 evals · web build**).

**Decision lock 2026-07-08: S1–S6 are all CONFIRMED (§3).** The pre-build decisions are resolved; the wave is unblocked. Epic A (safety spine) shipped. Note two 2026-07-08 changes: **Epic E** wallet model changed to bounded autonomous signing from a capped burner (S4), and **Epic H — Packaging & Distribution** is added (S2/D-h). See `docs/DECISIONS-arturita.md` for the confirmed answers + the wallet-model-change rationale.

**Companion docs:** `docs/PRD-arturita.md` (intent) · `docs/DECISIONS-arturita.md` (S1–S6) · `docs/REQUIREMENTS-arturita.md` (FR/NFR acceptance checklist) · `docs/ONBOARDING-arturita.md` (cold-start) · `HANDOFF.md` (current story).

---

## 0. Status tracker (living — update on every merge)

This table is the source of truth for per-story status. Update the **Status** + **PR** cells in the same PR that lands the story (`todo` → `in-progress` → `done`). HANDOFF stays the "current story" pointer; this is the full board.

| Story | Title | Status | PR | Gating decision |
|---|---|---|---|---|
| **A1** | Persona, sessions & `/panic` kill switch | `done` | [#174](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/174) | — |
| **A2** | Dangerous-action approval types + step-up | `done` | [#175](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/175) | — |
| **A3** | Intent classifier + two-phase destructive confirm | `done` | [#176](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/176) | — |
| **B1** | Voice Gateway (`local|provider` config + Chatterbox/NVIDIA adapter + `/voice`) | `in-progress` (pure helpers done [#180]; config + provider adapter + endpoint = this wave) | [#180](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/180) | S1 ✅ |
| **B2** | Cockpit voice panel | `todo` | — | S5 ✅ |
| **B3** | Ask-vs-execute routing from voice | `in-progress` (pure routing done [#181]; endpoint wiring pends B1-full) | [#181](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/181) | — |
| **C1** | Local Host daemon | `in-progress` (pure planner done [#179]; daemon scaffold + read/preview/undo = this wave, destructive/exec behind A2) | [#179](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/179) | S3 ✅ |
| **C2** | File ops + preview + undo | `todo` (read/preview/undo path this wave; destructive gated) | — | S3 ✅ |
| **C3** | `machine_exec` (broad) + doc editing | `todo` (destructive subset A2-gated) | — | S6 ✅ |
| **D1** | Telegram voice notes + text + auth | `todo` | — | S2 ✅ (needs bot token + `WEBHOOK_SIGNING_SECRET`) |
| **D2** | Telegram files + inline approvals + voice replies | `todo` | — | S2 ✅ |
| **E1** | Wallet read + prepare + simulate | `done` | [#178](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/178) | — |
| **E2** | **Wallet policy engine + burner keystore + testnet signing + `wallet_tx` card** *(model changed — S4)* | `in-progress` (policy engine + fail-closed signing gate + `wallet_policy` table + policy/evaluate endpoints + keystore design doc done; testnet live-signer wiring + `wallet_tx` card are go-live/follow-up) | #186 | S4 ✅ |
| **F1** | LLM fallback chain + circuit breaker | `done` (pure layer [#177]; **live executor wiring + breaker registry + `/health` surface [#187]**) | [#177](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/177), [#187](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/187) | — |
| **F2** | Degraded/offline + watchdogs | `done` (pure helpers; queue/host wiring pends B1/C1 execution) | [#182](https://github.com/Arturito7ei/7Ei-Mission_Control_App/pull/182) | — |
| **G1** | Self-description + CLI | `todo` | — | — |
| **G2** | Go-live gates + runbook | `todo` | — | — |
| **H1** | macOS installable bundle (sign + notarize) | `todo` (design/plan this wave) | — | — |
| **H2** | First-run TCC permission wizard | `todo` (design/plan this wave) | — | — |
| **H3** | Auto-update channel | `todo` (design/plan this wave) | — | — |
| **H4** | Fresh-machine config/secret bootstrap | `todo` (design/plan this wave) | — | — |
| **H5** | iPhone remote surface (v1 Telegram, v2 native/PWA) | `todo` (v1 = D-epic; v2 native design/plan this wave) | — | S2 ✅ |

**Overnight build (2026-07-08) landed the entire safe spine + safe non-blocked work:** A1 #174, A2 #175, A3 #176, F1 #177, E1 #178, C1 planner #179, B1 helpers #180, B3 #181, F2 #182 — all squash-merged to `main`, invariant green (707 backend tests · 11/11 evals · web build).

**Decision lock (2026-07-08): S1–S6 all CONFIRMED** (`docs/DECISIONS-arturita.md`). The wave is unblocked. This wave's build slice: **B1** (`local|provider` config + Chatterbox/NVIDIA provider adapter + `/voice` endpoint), **F1** (wire fallback into the live `agent-executor`/`streamLLM` retry loop + breaker registry + `/health`/Cockpit breaker health), **C1/C2** (host-daemon scaffold + real file-read/preview/undo; **destructive/exec stays behind the A2 gate + two-phase confirm**), and **E2** (wallet **policy engine** + burner-keystore design + **testnet-only** signing path — **NO mainnet autonomous signing**). Still operator-gated for go-live (not build): Telegram bot token + `WEBHOOK_SIGNING_SECRET` (D), funded burner + final mainnet go (E2 mainnet), TCC grants (H). **Safety rule holds:** every destructive/irreversible/≥-threshold action routes through A2; mainnet wallet signing and any irreversible action need the operator.

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

### Epic C — Machine control `[S3 CONFIRMED — whole-machine access + self-protection denylist]`

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **C1** · Local Host daemon | New `adapters/arturita-host/` daemon (sibling to `adapters/mac-mini/`; launchd keep-alive, `setup.sh`). Capability API (list/read/write/move/delete/exec); **whole-machine root** + **minimal self-protection denylist** (own secret store, burner keystore, daemon config, OS system-integrity paths) + blast-radius caps + path canonicalization; authenticated channel to backend (agent token + mTLS/signed socket); **fail-closed** (acts only on an authenticated, approved backend command). **This wave: scaffold + real file read/list/preview + undo path; destructive write/move/delete + exec stay behind the A2 gate.** | Denylist targets (own secret store, burner keystore, daemon config, SIP/system paths) refused for read *and* write. Path traversal (`..`, symlink escape) blocked via canonicalize-then-denylist-check. Runs as operator user, no sudo. No backend command → no action. Host action-layer has its own tests. | A1, S3 ✅ |
| **C2** · File ops + preview + undo | File list/read/write/move/delete via the capability API, each producing a **preview manifest** (N files, size, destination) and an **undo journal** (originals staged, not purged). Gated by `file_destructive` approval + two-phase confirm when destructive or over the blast-radius cap; in-root + under-threshold edits are auto-safe. New `host_actions` audit table. | A move/delete shows the exact manifest before executing; execution is reversible ("undo that") within the window; every op is a task+thread+heartbeat entry (nothing invisible). Blast-radius over cap → approval; over hard ceiling → refuse + ask to narrow. **Verified end-to-end with tests; fail closed on ambiguity.** | C1, A2, A3 |
| **C3** · `machine_exec` (broad) + doc editing | Broad command execution (full control assumed — S6); the **destructive/irreversible subset is approval-gated `machine_exec` showing exact argv verbatim** + two-phase confirm; non-destructive commands run without a per-command approval. Document editing with diff preview. | Destructive/irreversible commands can't run without an A2 approval showing argv verbatim; doc edits show a diff before write; the destructive-intent classifier + denylist bound what runs unattended. Optional operator command-denylist honored. | C1, A2 |

### Epic D — Remote (Telegram) `[D depends on the operator's surface choice, Spike S2]`

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **D1** · Voice notes + text + auth | Extend the existing Telegram receiver (`telegram-bot.ts` + `webhook-auth.ts` HMAC): voice notes → STT, text commands, from the **bound chat id** only; nonce/replay guard; short session + step-up for dangerous. | Only the bound operator chat controls Arturita; forged/misrouted updates 403 before DB work (HMAC); duplicate/replayed updates rejected (nonce). Voice notes transcribed via B1; audio not retained. Requires `WEBHOOK_SIGNING_SECRET` set (go-live gate). | A1, B1, D-surface (**S2**) |
| **D2** · Files + inline approvals + voice replies | Telegram file up/download (→ local host / document-ingest); inline-button approvals (✅ Approve / ✕ Reject / ↩ Changes) mapped to the tri-state flow; spoken replies as Telegram voice messages (TTS). | A remote destructive action surfaces distinct inline buttons (not one bared tap) mapped to approve/reject/revision; an uploaded file lands in-root (auto-safe if in-root+under-threshold) and can be summarized; replies come back as voice + text. | D1, C2, A2 |

### Epic E — Wallet (read + prepare + policy-gated bounded signing) `[S4 CONFIRMED — model changed: capped burner, autonomous < $100, testnet this wave]`

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **E1** · Read + prepare + simulate | New `services/wallet.ts`: read balances/positions via RPC; build tx; **simulate** (gas, slippage, expected output, revert); decode calldata to a human-readable summary; caps + scam guards. `wallet_intents` table (decoded summary, sim result, caps checked — **no key material**). | Reads work; tx + simulation produced; calldata decoded to plain language + contract label; caps/scam-guard helpers tested; `assertNoKeyMaterial` guards persisted fields. **Done (#178).** | A1 |
| **E2** · Policy engine + burner keystore + testnet signing + `wallet_tx` card | **(1)** Policy engine (`services/wallet-policy.ts`, pure): per-tx threshold (**default $100, operator-configurable**), per-day cap, destination allowlist, `autonomous_signing_enabled`/`mainnet_enabled` flags → decide `autonomous_sign` vs `require_approval` vs `refuse`. **(2)** Burner-keystore design + plumbing: sealed local encrypted keystore **or** delegated session key (WalletConnect can't do unattended signing — documented); key never plaintext at rest, never logged, denylisted from the host (S3). **(3)** Testnet-only signing path behind `WALLET_AUTONOMOUS_SIGNING_ENABLED=false`/`WALLET_MAINNET_ENABLED=false` (both default off). **(4)** `wallet_tx` approval card (decoded summary, caps, scam guards) for ≥-threshold txs. `wallet_policy` table. | Sub-threshold + in-policy tx → autonomous testnet sign, logged as a task; ≥-threshold / over-per-day / off-allowlist / scam-flagged → A2 `wallet_tx` approval + step-up. Simulate-before-sign enforced (revert/missing-sim → refuse). **Mainnet autonomous signing impossible without the explicit flags + operator go.** Value never authorized by voice alone (visual echo). No private key in any API in/out, prompt, log, or `wallet_intents`. Pure policy/keystore-decision logic tested; **no real mainnet signing shipped.** | E1, A2, S4 ✅ |

### Epic F — Resilience & LLM failover

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **F1** · Fallback chain + circuit breaker | Ordered fallback chain per agent in `deployConfig` (e.g. `arturita_fallback_chain`); circuit breaker on `llm-router.ts` (N failures → cooldown → re-probe); handle 5xx/timeout/429/auth/context-overflow/refusal; health on `/health` + Cockpit. | Primary outage → task completes on a fallback in ≥95% of cases; every retry re-runs the **preflight per-wake cost cap** (failover can't blow budget); exhausted/over-cap chain → task parks `blocked` with a plain-language `system_notice` (W1 recovery card) and Arturita says so aloud. Pure chain/breaker logic tested. | F depends on nothing new; do after A |
| **F2** · Degraded/offline + watchdogs | Local Ollama LLM + local STT/TTS keep Arturita conversational offline; cloud-dependent actions queue with "queued, will run when back online" and replay on reconnect (idempotent/nonce-guarded). Attach `watchdogs` (runtime/cost/no_activity) to long Arturita tasks. | Network down → still conversational + queued actions replay exactly once on reconnect; host down → file/machine actions refused with a spoken reason, read-only cloud still works; backend unreachable from host → host fail-closed. Watchdogs fire once on transition (edge-triggered, existing behavior). | F1, C1, B1 |

### Epic G — Docs/DX & go-live

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **G1** · Self-description + CLI | All new endpoints self-described via `openapi.ts` (`documentEndpoint`); CLI `7ei-mc` gains `arturita bind` / `arturita panic` / `arturita host-status`; `docs/API.md` narrative for the Arturita surface. | New paths appear in `/api/openapi.json` with correct auth scope (auth-scoping test green); CLI verbs work token/session-appropriately; API.md updated. | after A–E land |
| **G2** · Go-live gates + runbook | Extend `GO-LIVE.md` with PRD §11 gates (WEBHOOK_SIGNING_SECRET as hard prereq, `NVIDIA_API_KEY` + local models, Telegram bot token + bind, host install + TCC grants, **burner fund + caps + mainnet-flag go**, fallback chain, packaging). Operator runbook. Update `STATUS.md`/`HANDOFF.md`/vault milestone. | Every user-only console action documented with the exact step; runbook lets the operator bring Arturita up from zero; docs/vault bumped. | G1 |

### Epic H — Packaging & Distribution `[new 2026-07-08 — S2/D-h; design/plan this wave, build later]`

The whole solution must be replicable/installable on other machines and as an iPhone remote app. This wave captures the design + stories fully so it's tracked; the installer itself is not built yet.

| Story | Scope | Acceptance criteria | Deps |
|---|---|---|---|
| **H1** · macOS installable bundle | A `.dmg` / installable app bundle packaging the local host daemon (+ any desk agent). **Code-signing (Developer ID) + notarization** so Gatekeeper accepts it. Reproducible build from the repo. | A fresh Mac can install from the `.dmg`; the app is signed + notarized (no Gatekeeper block); build is scripted + documented. | C1 |
| **H2** · First-run permission wizard | A first-run flow that walks the operator through granting the macOS **TCC permissions** the host daemon needs: **Full Disk Access, Accessibility, Automation, Microphone** (+ Screen Recording if used). Detects what's granted, deep-links to the right System Settings panes, blocks capabilities whose permission is missing (fail-closed). | Wizard enumerates required permissions, shows granted/missing state, links to each Settings pane, and the daemon refuses a capability whose TCC grant is absent (with a clear spoken/text reason). | H1, C1 |
| **H3** · Auto-update channel | A signed release/update feed (e.g. Sparkle-style appcast or equivalent) so installed hosts update themselves; version pinning + rollback. | An installed host detects + applies a new signed release; updates are signature-verified; a bad update can be rolled back. | H1 |
| **H4** · Fresh-machine config/secret bootstrap | Bootstrapping on a clean machine: initialize the encrypted secret store, load `NVIDIA_API_KEY`/Telegram token/RPC + burner keystore, set `deployConfig` (fallback chain, caps), and run the one-time operator **bind**. No secret ever written to disk in plaintext or committed. | From zero, the operator can stand up a working Arturita (secrets sealed, bound, policy configured) via a documented bootstrap; no plaintext secret on disk; nothing committed. | H1, A1 |
| **H5** · iPhone remote surface | **v1 = Telegram** (Epic D). **v2 = a dedicated native/PWA iPhone client** (push, voice capture, inline approvals) — design + plan only this wave. | v1 Telegram surface tracked in D1/D2; v2 native/PWA client scoped (surface, auth reuse of the bind + HMAC model, push infra) as a design doc; no App Store build this wave. | D1, D2 |

---

## 2. Sequencing & critical path

```
A1 ─┬─ A2 ─┬───────────────────────────────► (gates every dangerous story)  [DONE]
    └─ A3 ─┘
              B1 ─ B2 ─ B3        (voice; S1 ✅ — B1 config+provider+endpoint this wave)
              C1 ─ C2 ─ C3        (machine; S3 ✅ — daemon+read/preview/undo this wave, destructive A2-gated)
                        D1 ─ D2   (remote; S2 ✅ — needs bot token + WEBHOOK_SIGNING_SECRET)
              E1 ─ E2             (wallet; S4 ✅ — policy engine + burner keystore + TESTNET signing; mainnet flag-gated)
              F1 ─ F2             (resilience; F1 executor wiring this wave)
                        G1 ─ G2   (docs/go-live; after A–E)
              H1 ─ H2 ─ H3 ─ H4   (packaging; design/plan this wave, build later)
                        H5        (iPhone: v1 Telegram=D, v2 native/PWA design)
```

- **Start now:** **A1** (no blockers). Then **A2** + **A3** in parallel after A1.
- **In parallel with A2/A3:** kick off spikes **S1** (STT/TTS) and **S3** (mac adapter) so B1/C1 aren't blocked when A lands.
- **Critical path:** A1 → A2 → (B1|C1) → C2/B2 → D1 → D2. Wallet (E) and resilience (F) run alongside once A is in.
- **Ship order rule (safety):** no B/C/D/E story merges before A2 (the approval-type gate) is on `main`. `machine_exec` (C3) and wallet signing (E2) are the **last** and most-guarded stories.
- **Suggested first PR:** **A1** — persona + session + `/panic` kill switch. It's the smallest self-contained safety primitive and unblocks everything.

---

## 3. Pre-build decisions & spikes (resolve before the blocked stories)

> **Recorded as a decision log in `docs/DECISIONS-arturita.md`** with per-item status. **All S1–S6 CONFIRMED 2026-07-08** — this table is the at-a-glance record of the confirmed answers.

| # | Decision | Blocks | **Confirmed answer (2026-07-08)** |
|---|---|---|---|
| **S1** | STT/TTS provider | B1, B3, D1 | **`local\|provider` config setting, per-context.** Interim `provider` = **Chatterbox TTS via NVIDIA API** (key → encrypted secrets store, **never git**; `.env.example` placeholder only). `local` default for sensitive contexts. |
| **S2** | iPhone / remote surface | D1, D2, H5 | **Telegram-only for v1** (operator provides the bot token → HMAC receiver + secrets store). **v2 native/PWA iPhone app → Epic H.** |
| **S3** | Mac-control adapter + access scope | C1, C2, C3 | **Custom hardened daemon**, **whole-machine access** (full control assumed), **minimal self-protection denylist only** (own secret store, burner keystore, daemon config, OS system-integrity paths). Destructive ops still A2-gated with verbatim summary. |
| **S4** | **Wallet model — CHANGED** | E2 | **Bounded autonomous signing from a capped burner.** Autonomous < **$100** (per-tx threshold, configurable); ≥ $100 → A2 approval. Local encrypted keystore / delegated session key (WalletConnect can't do unattended signing). Policy engine (per-tx/per-day/allowlist). **Testnet only this wave; mainnet behind explicit go flag.** |
| **S5** | Wake-word vs push-to-talk | B2 | **Push-to-talk default; "Arturita" wake-word opt-in.** |
| **S6** | `machine_exec` scope | C3 | **Full control assumed → broad exec allowed.** Destructive/irreversible commands still A2-gated + two-phase confirm with argv shown verbatim. |

**Also from the PRD (call out at build time):**
- Voice audio retention default = discard-after-transcription (PRD §7.8) — no audit-audio store (confirmed default).
- Per-tx threshold ($100 default) / per-day cap / destination allowlist are operator-configured at go-live (E2 / GO-LIVE); burner funded by the operator; mainnet stays off until the explicit go.

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
