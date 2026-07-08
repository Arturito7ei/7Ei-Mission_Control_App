# PRD — Arturita "Jarvis" Assistant Tab

> **Companion to `docs/PRD-arturita.md`** (the voice-first personal agent) and `docs/PLAN-arturita.md` (stories). This spec scopes a **Cockpit "Arturita" tab**: a Jarvis-style conversational surface with a reactive HUD orb. It **reuses the Arturita spine** (F1 fallback, B1/B2 voice, B3 routing, A1 sessions, A2 approvals, A3 intent) — it does not fork it.
> **Status:** v1 shipped (J1) · **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai) · **Epic:** **J — Jarvis Cockpit** (see PLAN §0)

---

## 1. What makes a "Jarvis"? (research → design targets)

"Jarvis" (Iron Man's assistant) is the popular reference point for an ambient AI companion. Distilled from the canon, seven characteristics define the feel — each maps to a concrete, testable target for Arturita:

| # | Jarvis characteristic | What it means concretely | Design target for Arturita |
|---|---|---|---|
| **J-a** | **Instant, low-latency, streaming replies** | Feels real-time — words appear as they're "spoken", no request→response lag wall. | Streamed conversational replies; first token fast; a "thinking" state, not a spinner-then-dump. |
| **J-b** | **Natural, always-available voice** | Talk to it hands-free; it listens, you interrupt, it adapts. | Push-to-talk default + "Arturita" wake-word (S5); barge-in/interrupt; typed fallback always. |
| **J-c** | **Ambient, non-intrusive presence** | It's *there*, converses directly, and only mobilises machinery when asked. | **Default = Arturita answers herself.** She spins up the agent swarm / kicks off builds **only on explicit request.** |
| **J-d** | **System / context awareness** | Knows the state of the "suit" — current tasks, subsystems, recent events. | Reuses cockpit data (fleet, tasks, activity) + the vault/memory graph as grounding context. |
| **J-e** | **A living, reactive UI** | The signature glowing HUD that reacts as it listens/thinks/speaks. | A reactive **orb** animating across idle / listening / thinking / speaking. |
| **J-f** | **Personality + continuity** | Consistent voice, remembers the thread, picks up where you left off. | Reuses the Arturita persona (A1) + command sessions + task-thread continuity. |
| **J-g** | **Trustworthy / permission-aware** | Powerful, but bounded — it never does something irreversible without a go-ahead. | Every real action flows through the **A2 approval gate**; wallet/machine/email stay gated. |

**The load-bearing behaviour is J-c.** A cockpit full of agents makes it tempting to route *everything* into the swarm. Jarvis doesn't — he answers you. Arturita's default is **direct conversation**; delegation to the agent org is **opt-in, per request**, routed through the existing **B3 ask-vs-execute** + **A3 intent classifier**. This is what makes her an assistant rather than a task-dispatcher.

---

## 2. Feature list → work needed → reuse vs. new

For each characteristic: the feature, the work required, and how much is **already shipped** vs. **genuinely new**.

### J-a · Instant, streaming conversational replies
- **Feature:** replies stream into the conversation view; a "thinking" state bridges send→first-token.
- **Reuse:** `llm-router.streamLLM` (already token-streams) · **F1** `llm-fallback-runtime.streamLLMWithFallback` (ordered chain + circuit breaker, cost-bounded by preflight) · `preflight` per-wake cap.
- **New:** a conversational **front-door endpoint** (`/arturita/converse`) that calls the LLM path directly for a *reply* (not just a task+ack, which is all `/voice` produced). **v1 streams client-side** (endpoint returns the full answer from the chain; the tab reveals it progressively). **True server token-streaming (SSE)** is the J-a fast-follow.

### J-b · Natural, always-available voice
- **Feature:** push-to-talk (default) + "Arturita" wake-word (opt-in); typed fallback; spoken replies; barge-in.
- **Reuse:** **B2** `voicePanel.logic` (`decideSubmit`, wake-word gate — shared verbatim with the new tab) · **B1** `voice-config`/`voice-provider` (`local|provider` TTS) · Web Speech API capture pattern from `VoiceSection`.
- **New:** minimal — the tab consumes the same capture gate. Barge-in (cancel TTS when the mic reopens) and server-side raw-audio STT remain **B1 go-live** items.

### J-c · Ambient presence + opt-in delegation *(the core)*
- **Feature:** Arturita answers directly by default; routes to the task/agent flow **only** on an explicit build/do/delegate request (or a destructive intent, which must be gated); the routing decision is **surfaced** on each turn.
- **Reuse:** **A3** `intent.classifyIntent` (destructive detection) · **B3** `voice-routing.routeVoiceCommand` (ask vs execute) · the existing task board + thread.
- **New:** pure `arturita-converse.decideConverseMode` — *answer vs delegate*, precedence: destructive → delegate (gated); explicit flag/phrase/build-order → delegate; else → **answer**. Fully unit-tested.

### J-d · System / context awareness
- **Feature:** answers are grounded in live state — fleet size/active count, open work, (later) vault/memory graph + recent activity.
- **Reuse:** cockpit `GET /cockpit`, `timeline`, `inbox` payloads · **M-epic** vault-graph (`/memory/graph`) · `agent-memory`/`vector-search`.
- **New (v1):** a cheap **system-awareness block** (fleet + open-task counts) injected into the converse prompt. **Deeper grounding** (calendar/Gmail via existing Google connectors, vault RAG, recent-activity digest) is phased (J3).

### J-e · Reactive HUD orb
- **Feature:** an orb that animates idle / listening / thinking / speaking; glassmorphism hero; colorblind-safe.
- **Reuse:** design tokens (`tokens.ts` v2), `.mc-glass` chrome pattern, DESIGN_SYSTEM v2 rules.
- **New:** `AssistantOrb` + orb CSS (layered rings, per-state color+icon+label+motion), the glass hero, and the orb state machine (`assistant.logic.orbVisual`/`resolveVoiceState`). Motion is a **scoped, deliberate exception** to the 150ms-animation rule (a reactive HUD) — fully disabled under `prefers-reduced-motion`, where state still reads from icon + label + color.

### J-f · Personality + conversational memory
- **Feature:** consistent persona; the thread continues across turns; follow-ups re-enter the same task.
- **Reuse:** **A1** `buildArturitaAgent` persona + command sessions · `thread.ts` wake-on-comment · task `parentTaskId`.
- **New:** short-turn **history** passed to `/converse` (client-side rolling window) for in-session continuity. Durable cross-session memory is phased (J3, reuse `agent-memory`).

### J-g · Permission-aware (safety)
- **Feature:** any real/dangerous action still stops at approval; nothing irreversible happens from a chat turn.
- **Reuse:** **A2** dangerous-approval types + step-up · `governance`/`approvals` tri-state · Inbox surfacing.
- **New:** none — the converse endpoint's `answer` mode takes **no actions**; `delegate` mode only creates a `pending` task (destructive → execute-mode → the A2 gate). No new dangerous surface.

**Net:** the Jarvis tab is **mostly assembly** of shipped primitives. The genuinely new code is small and safe: one pure decision helper, one non-dangerous endpoint, and a presentation layer (orb + glass + streamed conversation).

---

## 3. Phased work breakdown (Epic J) + acceptance criteria

| Story | Scope | Acceptance criteria | Status |
|---|---|---|---|
| **J1 · Assistant tab v1 (this PR)** | Cockpit "Arturita" tab: glass hero + reactive orb (4 states, PTT + wake-word + typed), streamed conversation, `decideConverseMode` + `/arturita/converse` (answer via F1 chain, delegate via B3), routing surfaced, placeholder logo slot. | Tab renders colorblind-safe (icon+text+shape; red never lone CTA), light+dark, tokens only. Default turn = direct answer; explicit build/do/delegate (or destructive) → task on the board, decision shown. No dangerous action from a chat turn. Pure logic unit-tested (backend + web); web build green. | **done** |
| **J2 · True token streaming (SSE)** | Replace client-side reveal with server-sent token streaming from `streamLLMWithFallback.onToken`; first-token latency metric on `/health`. | Tokens render as produced (not post-hoc reveal); reconnect/abort handled; p50 first-token target documented. | todo |
| **J3 · Deep context awareness** | Ground answers in calendar/Gmail (existing Google connectors), vault/memory graph (M-epic), recent-activity digest; durable conversational memory via `agent-memory`. | "What's on my calendar Thursday" answers from the real connector; "what shipped this week" cites activity; a fact told this week is recalled next session. Read-only; no new dangerous surface. | todo |
| **J4 · Barge-in + wake-word polish** | Cancel in-flight TTS when the mic reopens; wake-word tuning; VAD end-pointing; spoken-reply provider path (B1 `provider` bytes) in the tab. | Speaking over Arturita stops her cleanly; wake-word false-accept/reject within target; provider-TTS audio plays when configured, degrades to local. | todo |
| **J5 · HUD depth (visualisation)** | Live waveform/level meter while listening, subtle audio-reactive orb, at-a-glance system-awareness chips (fleet/open-work/breaker health) in the hero. | Level meter reflects mic input; chips reflect live cockpit state; all colorblind-safe; motion respects reduced-motion. | todo |
| **J6 · Approvals inline in the tab** | Surface pending A2 approvals inline in the conversation (reuse the B2 tri-state controls) so a delegated destructive action can be resolved without leaving the tab. | A delegated destructive turn shows its approval inline with approve / request-changes / reject; decisions hit `/approvals/:id/decide`; parity with the Inbox. | todo |

**Definition of done (per story):** pure-helper + `node --test`; UI colorblind-safe per DESIGN_SYSTEM v2; endpoints self-described (openapi) with correct auth scope; STATUS/PLAN/REQUIREMENTS bumped; invariant green (backend tests · 11/11 evals · web build); one PR, squash-merged `--admin`.

---

## 4. Requirements added (see `docs/REQUIREMENTS-arturita.md`)

- **FR-43** — Arturita answers the operator **directly by default** (a single conversational LLM turn via the F1 fallback chain); she routes into the task/agent flow **only** on an explicit build/do/delegate request or a destructive intent. *(J1 — `decideConverseMode`.)*
- **FR-44** — The routing decision (answer vs delegate, and why) is **surfaced** to the operator on every turn. *(J1.)*
- **FR-45** — The Assistant tab presents a **reactive HUD orb** reflecting voice state (idle/listening/thinking/speaking), colorblind-safe (color + icon + label + motion), motion disabled under `prefers-reduced-motion`. *(J1.)*
- **FR-46** — Conversational replies are **streamed** (v1 client-side reveal; J2 server SSE). *(J1/J2.)*
- **NFR-30** — The Jarvis tab ships **no new dangerous surface**: `answer` takes no actions; `delegate` only creates a `pending` task; every destructive/irreversible/outward action still flows through the **A2 approval gate**. *(J1.)*
- **NFR-31** — Glassmorphism uses **design tokens only** (no raw hex); the glass hero is a floating chrome panel (DESIGN_SYSTEM v2), not a content list card. *(J1.)*

---

## 5. What v1 (J1) ships

- A new Cockpit **"Arturita"** tab (🌸) beside Cockpit/Memory.
- A **glass hero** with a **reactive orb** (idle/listening/thinking/speaking), driven by the B2 voice pipeline: **push-to-talk** (default), **"Arturita" wake-word** (opt-in), and a **typed fallback**; optional spoken replies (local browser TTS).
- A **streamed conversation view** wired to `POST /arturita/converse` → the **F1 fallback LLM chain**; **default = Arturita answers directly**, and only routes to the task/agent flow when the operator **explicitly** asks (or the intent is destructive) — with the **routing decision shown** on each turn.
- A **placeholder logo** at `web/public/arturita-logo.svg`, referenced exactly once (`ARTURITA_LOGO_SRC` in `AssistantPanel.tsx`) — drop the real asset at that path for a one-file swap.
- Safety held: **no dangerous action from a chat turn**; delegated destructive work lands as a task at the A2 gate.

**Not in v1 (phased above):** server token-streaming (J2), deep calendar/vault grounding (J3), barge-in + provider-TTS in-tab (J4), audio-reactive HUD depth (J5), inline approvals (J6).
