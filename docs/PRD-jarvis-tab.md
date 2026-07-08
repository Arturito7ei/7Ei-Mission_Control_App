# PRD — Arturita "Jarvis" Assistant Tab (research-first)

> **Companion to** `docs/PRD-arturita.md` (voice-first personal agent) · `docs/PLAN-arturita.md` (stories) · `docs/DECISIONS-arturita.md` (S1–S7). This spec scopes a **Cockpit "Arturita" tab**: a conversational **thinking/brainstorming partner** with a reactive HUD orb, built **free-first + self-hosted-first with configurable fallbacks**, reusing the Arturita spine (F1 fallback, B1/B2 voice, B3 routing, A1 sessions, A2 approvals, A3 intent).
> **Status:** research doc (this PR) · a minimal Glassmorphism shell + orb + placeholder logo already scaffolded in **J1** (#199) · **hold deeper build pending this doc.** · **Date:** 2026-07-08 · **Owner:** operator (arturito@7ei.ai) · **Epic:** **J — Jarvis Cockpit**

---

## 0. Core product principle (read this first)

**The tab is for *thinking and talking with* Arturita — a brainstorming partner first, a command console second.**

By default the operator **converses** with Arturita: asks, explores, reasons out loud, riffs on ideas. She answers **herself**, directly, in that conversation. She is a chief-of-staff/sounding-board, **not** a dispatcher that reflexively spawns agents.

She **commands the builder/executor agents only when the operator explicitly tells her to.** Delegation is a deliberate, confirmed handoff — never the default, never a side effect of a normal question. This is the line that makes her Jarvis (a partner) rather than a ticket-router.

Everything else in this doc — the models, the orb, the streaming — serves that principle. The two hard rules:

1. **Default = brainstorm/converse.** Direct conversational answers, no task created, no agent touched.
2. **Delegate = explicit + confirmed.** Only an explicit "build/do/delegate/hand this to the team" (or a destructive intent, which must be gated) crosses into the task/agent flow — routed through **B3 ask-vs-execute** + **A3 intent** and gated by **A2 approvals**.

---

## 1. Interaction model — conversation ⇄ delegation

### 1.1 Two modes, one surface

| | **Brainstorm / Converse (default)** | **Delegate to agents (explicit)** |
|---|---|---|
| Trigger | any normal message/question | explicit delegation language, a build/work order, the **"Delegate to the office"** toggle, or a destructive intent |
| Who acts | **Arturita herself** — one conversational LLM turn | the **agent swarm** — a task on the board, run by builder/executor agents |
| Side effects | **none** (no task, no file, no send, no agent) | a `pending` task created; dangerous work stops at the **A2 approval gate** |
| Continuity | rolling in-session history (+ later durable memory) | task thread (`thread.ts` wake-on-comment); follow-ups re-enter it |
| Surfaced as | a chat reply, streamed | a chat reply **+ a visible "delegated" decision** (why it routed, task link) |

### 1.2 How the handoff is triggered + confirmed

The decision is the pure `arturita-converse.decideConverseMode` helper (shipped in J1), precedence **safety-first**:

```
1. destructive intent (delete/move/overwrite/send/sign/exec — A3 classifyIntent)
        → DELEGATE, and the task routes to execute-mode → the A2 approval gate.
2. explicit "Delegate to the office" toggle set for this turn
        → DELEGATE.
3. explicit delegation phrase ("have the team…", "delegate…", "spin up an agent…",
   "open a task…", "kick off…")                       → DELEGATE.
4. concrete build/work order ("build…", "implement…", "deploy…", "scaffold…",
   "refactor…", "write the code/script…")             → DELEGATE.
5. otherwise                                           → ANSWER directly (brainstorm).
```

- **Confirmation layers.** A *non-destructive* delegation is confirmed by the explicit signal itself (the operator said "delegate" / flipped the toggle / gave a build order) and is **surfaced** ("▸ Delegated to the office — here's why + the task link"). A *destructive/irreversible* delegation additionally goes through **A3 two-phase confirm** (preview → a distinct confirmation phrase, never a bare "yes") and the **A2 tri-state approval** (approve / request-changes / reject) before anything runs. Voice never authorizes value/destruction alone — entities are echoed visually.
- **Routing target.** `delegate` → `routeVoiceCommand` (B3): a question routes to a single-turn **`ask`** work-mode; a work order routes to the full **`execute`** loop; a follow-up re-enters the same task thread. No new loop — it reuses the shipped executor.
- **Reversibility of the handoff.** Because delegation only ever creates a `pending` task (not an executed action), the operator can reject it at the gate; nothing irreversible has happened yet. "Brainstorm about X" and "go build X" are cleanly separable.

### 1.3 What this looks like in the tab

- Talk/type freely → streamed answers, orb reacts, **no task**.
- Say **"okay, have the team build that"** (or flip the toggle) → Arturita acknowledges, the decision chip shows **▸ Delegated**, a task appears on the board / in the Inbox; anything destructive waits at the A2 gate.
- The operator stays in the conversation the whole time; delegation is a punctuation mark, not a mode-switch they have to manage.

---

## 2. Free-first, self-hosted-first, fallback-everywhere (the infra principle)

Every model/service in the Jarvis pipeline (LLM · STT · TTS) **defaults to a free or self-hosted option, has a configured fallback chain, and is switchable from the Config panel.** This is a direct extension of the shipped **S1 `local | provider`** voice-config model and the **F1** LLM fallback chain — generalized to *every* layer as an ordered **primary → fallback → … → last-resort** list, each entry free or self-hosted unless the operator opts into a paid provider.

**Design rules:**
- **Default free/self-hosted.** Primary of every layer is something already on this machine or installable at $0.
- **Ordered fallbacks.** Each layer is a list; on failure (see §2.4 triggers) the next entry is tried.
- **Config-switchable.** The operator picks primary + fallbacks per layer in the Config panel (schema §2.4); no code change, no redeploy.
- **Privacy wins (S1 carry-over).** A `local`/sensitive context is **never** allowed to fall back to a cloud entry — it degrades within local options or to text-only, never leaking audio/content off-device.
- **Cost-bounded (D-g carry-over).** LLM fallbacks re-run the **preflight per-wake cap**; failover can't blow the budget.

This machine (ground truth, `2026-07-08`): **Apple M4 · 16 GB RAM**, Ollama `0.31.1` with `llama3.2:3b`, `qwen3:8b`, `gemma3:4b`, `qwen2.5:14b` already pulled.

### 2.1 LLM layer — comparison

Primary = **local Ollama** (already installed, $0, private). Fallbacks: other local models first, then **free-tier cloud**, then (opt-in) paid.

| Option | Free? | Self-hosted? | Footprint / latency (M4/16GB) | Quality / role | License | Fallback role |
|---|---|---|---|---|---|---|
| **Ollama `llama3.2:3b`** | ✅ | ✅ | 2.0 GB · very fast, snappy chat | Good for fast conversational turns | Llama 3.2 Community | **Primary (default)** — low-latency brainstorm |
| **Ollama `qwen3:8b`** | ✅ | ✅ | 5.2 GB · fast | Stronger reasoning/brainstorm | Apache-2.0 | **Fallback 1** — heavier reasoning |
| **Ollama `gemma3:4b`** | ✅ | ✅ | 3.3 GB · fast | Solid mid tier | Gemma terms | Fallback 2 |
| **Ollama `qwen2.5:14b`** | ✅ | ✅ | 9.0 GB · slower (heavy on 16 GB) | Strongest local (used for the vault graph) | Apache-2.0 | Fallback 3 — deepest local, use sparingly |
| **Groq free tier** | ✅ (no card) | ❌ cloud | sub-200 ms TTFT (fastest) | Llama/Qwen/etc. hosted | provider ToS | **Cloud fallback A** — when local is down/slow; 30 RPM · ~1k req/day |
| **Google AI Studio (Gemini free)** | ✅ (no card) | ❌ cloud | fast | Gemini 2.5 Flash/Flash-Lite | provider ToS | **Cloud fallback B** — 1,500 req/day · 1M TPM |
| Anthropic / OpenAI (existing keys) | ❌ paid | ❌ cloud | fast | Highest quality | provider ToS | **Opt-in** last resort (operator enables) |

**Notes.** `qwen2.5:14b` at 9 GB is heavy on 16 GB alongside the app + STT/TTS — keep it a deliberate fallback, not the primary. The whole chain reuses **F1** (`llm-router` + `llm-fallback` circuit breaker) — no new failover code.

### 2.2 STT layer — comparison

Primary = **whisper.cpp** (self-hosted; Metal-accelerated on Apple Silicon by default — ideal on M4). Zero-install fallback = **browser Web Speech API** (what B2 uses today).

| Option | Free? | Self-hosted? | Model sizes / footprint | Latency (Apple Silicon) | Streaming? | License | Fallback role |
|---|---|---|---|---|---|---|---|
| **whisper.cpp** ([ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)) | ✅ | ✅ | tiny 39M/~75MB · base 74M/~142MB · **small 244M/~466MB (sweet spot)** · medium 769M · large-v3 1550M · large-v3-turbo 809M | Metal by default; ~10× real-time (large-v3); RTF ≈0.02–0.08 tiny→small; +CoreML/ANE ~2–3× more | Batch; near-real-time via [whisper-streaming](https://github.com/ufal/whisper_streaming) | MIT | **Primary (default)** — `small` (or `base` for speed) |
| **faster-whisper** ([SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)) | ✅ | ✅ | same Whisper weights (CTranslate2) | **CPU-only on Mac (no Metal)** → slower here; great on NVIDIA/Linux | Streaming back-end for whisper-streaming | MIT | **Fallback (non-Mac hosts)** / when whisper.cpp absent |
| **OpenAI Whisper (reference)** ([openai/whisper](https://github.com/openai/whisper)) | ✅ | ✅ | same sizes, PyTorch | Slower than the C++/CT2 ports | Batch | MIT | Reference / research |
| **Browser Web Speech API** | ✅ (no install) | ❌ (vendor cloud, e.g. Chrome→Google) | none | ~real-time | Yes (interim results) | browser | **Zero-install fallback** — **non-sensitive only** (audio leaves device; never for `local` mode) |

**Notes.** Whisper models are ≤0.5–2 s behind live speech depending on size; `small` is the accuracy/speed sweet spot and runs faster than real-time on any M-series Mac. B2 today captures via the Web Speech API (client-side) — the self-hosted whisper.cpp path is the **B1 raw-audio STT go-live** item, and becomes the default once a local engine is running; Web Speech stays the zero-install fallback for non-sensitive capture.

### 2.3 TTS layer — comparison

Primary = a **self-hosted** engine (Piper for speed on any hardware, or local Chatterbox for quality on a GPU). Zero-install fallback = **browser SpeechSynthesis** (what the tab uses now).

**Chatterbox — resolved (the operator's open question):** Chatterbox is **Resemble AI's open-source, MIT-licensed** TTS. It runs **BOTH ways from the same v3 weights**: (a) **self-hosted locally** (pip/PyTorch, GPU recommended, CPU works — [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox), server wrapper [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server)), or (b) **NVIDIA-hosted** via the NVIDIA build catalog / NIM ([build.nvidia.com](https://build.nvidia.com/resembleai/chatterbox-multilingual-tts/modelcard)) — the variant our current **B1 `NVIDIA_API_KEY`** path targets (`integrate.api.nvidia.com`). So: the model is open/local; the B1 integration used the *hosted* endpoint. **Free-first flips the default to local Chatterbox/Piper; NVIDIA-hosted Chatterbox becomes an opt-in `provider`.**

| Option | Free? | Self-hosted? | Footprint / latency | Quality | License | Fallback role |
|---|---|---|---|---|---|---|
| **Piper** ([OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)) | ✅ | ✅ | tiny (ONNX/VITS); **~30–50 ms first audio**; real-time on a Raspberry Pi | Good, natural | **GPL-3.0** (active fork; original rhasspy/piper MIT, archived Oct 2025) | **Primary (default)** — fast, low-resource |
| **Chatterbox (local)** ([resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox)) | ✅ | ✅ | PyTorch; GPU recommended, CPU works | Excellent; emotion + 5-s voice cloning | **MIT** | **Fallback 1 (quality)** — Arturita's signature voice on a capable host |
| **Kokoro / StyleTTS 2** | ✅ | ✅ | small–mid | High quality, permissive | Apache-2.0 / MIT | Fallback (permissive high-quality) |
| **Coqui XTTS-v2** ([coqui-tts](https://pypi.org/project/coqui-tts/)) | ✅ | ✅ | GPU; <200 ms streaming | Best cloning quality | **CPML — non-commercial only** ⚠️ | Optional (flagged non-commercial) |
| **Chatterbox via NVIDIA NIM** | ❌ (hosted, key) | ❌ cloud | fast, scale | Equivalent to local v3 | MIT weights / NVIDIA Open Model Agmt | **Opt-in `provider`** (existing B1 key) |
| **Browser SpeechSynthesis** | ✅ (no install) | ~OS voices | none | OS-dependent | browser | **Zero-install fallback** — current tab default |

**License flag:** Coqui XTTS-v2 weights are **non-commercial (CPML)** — do not ship as a default; Piper's active fork is **GPL-3.0** (fine to run as a separate local service; note copyleft if ever bundled into closed source). Chatterbox and Kokoro/StyleTTS2 are commercial-friendly (MIT/Apache).

### 2.4 Config schema + fallback-trigger mechanics

**One config model per layer**, stored in `org.deployConfig` (same store as `arturita_voice_mode` and `arturita_fallback_chain`), read by pure resolvers (extending `voice-config.ts`), and edited in the **Config panel**. Each layer is an ordered chain; each entry names an engine + options; a `mode` flags local vs provider for the S1 privacy rule.

```jsonc
// org.deployConfig — Arturita Jarvis pipeline (all optional; sane free-first defaults if unset)
{
  // ── LLM (extends the shipped F1 arturita_fallback_chain) ──
  "arturita_llm_chain": [
    { "provider": "ollama", "model": "llama3.2:3b", "mode": "local" },   // primary — free, on-device
    { "provider": "ollama", "model": "qwen3:8b",    "mode": "local" },   // heavier local reasoning
    { "provider": "ollama", "model": "qwen2.5:14b", "mode": "local" },   // deepest local (heavy)
    { "provider": "groq",   "model": "llama-3.3-70b","mode": "provider" },// free-tier cloud
    { "provider": "google", "model": "gemini-2.5-flash","mode":"provider"}// free-tier cloud
    // { "provider": "anthropic", "model": "claude-sonnet-4", "mode": "provider" }  // opt-in paid
  ],

  // ── STT ──
  "arturita_stt_chain": [
    { "engine": "whisper_cpp", "model": "small", "mode": "local" },      // primary — self-hosted, Metal
    { "engine": "whisper_cpp", "model": "base",  "mode": "local" },      // faster local fallback
    { "engine": "web_speech",                     "mode": "provider" }   // zero-install; non-sensitive only
  ],

  // ── TTS ──
  "arturita_tts_chain": [
    { "engine": "piper",       "voice": "en_US-amy", "mode": "local" },  // primary — fast, self-hosted
    { "engine": "chatterbox",  "voice": "arturita",  "mode": "local" },  // quality local (GPU)
    { "engine": "speech_synth",                       "mode": "provider"},// browser fallback (current default)
    { "engine": "chatterbox_nvidia", "voice": "arturita", "mode": "provider" } // opt-in hosted (B1 key)
  ],

  // ── privacy + cost (carry-overs) ──
  "arturita_voice_mode": "local",          // S1 default; sensitive contexts always forced local
  "maxCostPerWakeUsd": "0.05"              // preflight cap; local = $0, bounds any paid fallback
}
```

**Resolution + fallback triggers (reuse F1 circuit breaker for every layer):**
- **Order:** try entries top-to-bottom; the first that succeeds wins.
- **Trigger a fallback on:** out-of-credits / rate-limit (**429**), **timeout**, provider **5xx**, **auth error** (bad/rotated/absent key → skip that entry, alert), context-overflow (LLM: down-shift), content-filter/refusal (retry next). Same `classifyLlmError` classes the F1 layer already implements.
- **Circuit breaker:** an entry that fails N times in a window is marked unhealthy for a cooldown and skipped, then re-probed — exactly the shipped `llm-fallback-runtime` behavior; STT/TTS get the same registry.
- **Privacy guard (S1):** in a `local`/sensitive context, `mode:"provider"` entries are **skipped** (never leak) — degrade to text-only rather than cloud.
- **Cost guard (D-g):** LLM fallbacks re-run the preflight per-wake cap; local entries are $0, so the chain stays free unless a paid entry is explicitly reached and within cap.
- **Exhaustion:** whole chain unavailable → the layer fails **safe** (LLM → a plain "couldn't reach a model" reply + a W1 recovery notice; STT → typed input; TTS → text-only). Arturita says so; nothing silently drops.

---

## 3. Jarvis feature research (reframed around brainstorm-first + free-first)

The seven "Jarvis" (Iron Man) traits, each now framed by §0–§2:

| # | Trait | Concrete target | How (free-first / reuse) |
|---|---|---|---|
| J-a | Instant, streaming replies | words appear as produced; a "thinking" state, not spinner-then-dump | local Ollama first-token is fast; **F1** chain streams; v1 client-side reveal → **J2** server SSE from `streamLLMWithFallback.onToken` |
| J-b | Natural, always-available voice | PTT default + "Arturita" wake-word (S5) + typed; **barge-in** (interrupt her mid-speak) | B2 capture gate reused; STT whisper.cpp / Web-Speech; TTS Piper/Chatterbox/browser; barge-in = cancel TTS when mic reopens (**J4**) |
| **J-c** | **Ambient presence + opt-in delegation** | **brainstorm by default; command agents only when told** (§0–§1) | `decideConverseMode` (shipped) + B3 routing + A3 intent + A2 gate |
| J-d | System/context awareness | grounded in fleet/tasks/vault/calendar | v1 cheap awareness block (fleet + open-task counts); **J3** calendar/Gmail (Google connectors) + vault/memory graph (Epic M) + activity digest |
| J-e | Living, reactive UI | orb across idle/listening/thinking/speaking; glass hero | shipped in J1; colorblind-safe (color+icon+label+motion), reduced-motion guarded, tokens only |
| J-f | Personality + continuity | consistent persona; thread continues; picks up where you left off | A1 Arturita persona + command sessions; in-session history (v1) → durable `agent-memory` (**J3**); `thread.ts` for delegated work |
| J-g | Trustworthy / permission-aware | powerful but bounded — nothing irreversible without a go-ahead | **A2** gate on every dangerous action; wallet/machine/email stay gated; free-first means the *default* pipeline is fully on-device (no data egress) |

**Free-first is also a privacy win:** with local LLM + local STT + local TTS, a brainstorm session never leaves the machine — which is exactly the S1 stance, now the default for the whole tab.

---

## 4. Phased work breakdown (Epic J) + acceptance criteria

| Story | Scope | Acceptance criteria | Status |
|---|---|---|---|
| **J1 · Assistant tab v1 (scaffold shipped)** | Glass hero + reactive orb (4 states, PTT + wake-word + typed) · `decideConverseMode` + `/arturita/converse` (answer via F1 chain, delegate via B3) · routing surfaced · placeholder logo. | Renders colorblind-safe, light+dark, tokens only. Default = direct answer; explicit build/do/delegate (or destructive) → task on the board, decision shown. **No dangerous action from a chat turn.** Pure logic unit-tested; web build green. | **done (#199)** |
| **J2 · Free-first pipeline config + resolvers** | Extend `voice-config.ts` into per-layer chain resolvers (`arturita_llm_chain`/`stt_chain`/`tts_chain`, §2.4); **Config-panel** UI to pick primary + fallbacks per layer; wire the F1 circuit breaker to STT/TTS. | Operator sets each layer's chain from the Config panel; defaults are free/self-hosted; a failed entry falls through per §2.4; `local` never falls to `provider`; pure resolvers unit-tested. | todo |
| **J3 · Self-hosted STT/TTS engines** | whisper.cpp STT service (Metal) + Piper/Chatterbox local TTS service, behind the adapter interface; browser Web-Speech/SpeechSynthesis as zero-install fallbacks (already live). | Local STT transcribes with confidence (gates via A3); local TTS speaks Arturita's reply; both degrade to browser engines then text-only; audio discarded post-transcription (D-e). | todo |
| **J4 · Server token-streaming (SSE) + barge-in** | Replace client reveal with SSE from `streamLLMWithFallback.onToken`; cancel in-flight TTS when the mic reopens; wake-word tuning; first-token metric on `/health`. | Tokens render as produced; speaking over Arturita stops her cleanly; p50 first-token target documented. | todo |
| **J5 · Deep context awareness** | Ground answers in calendar/Gmail (Google connectors), vault/memory graph (Epic M), recent-activity digest; durable conversational memory via `agent-memory`. | "What's on my calendar Thursday" answers from the real connector; "what shipped this week" cites activity; a fact told this week recalled next session; read-only, no new dangerous surface. | todo |
| **J6 · HUD depth + inline approvals** | Live level meter while listening, audio-reactive orb, awareness chips (fleet/open-work/breaker health); surface pending A2 approvals inline (reuse B2 tri-state) so a delegated destructive action resolves without leaving the tab. | Meter reflects mic input; chips reflect live state; inline approve/request-changes/reject hits `/approvals/:id/decide`; all colorblind-safe, reduced-motion respected. | todo |

**Definition of done (per story):** pure-helper + `node --test`; UI colorblind-safe per DESIGN_SYSTEM v2; endpoints self-described (openapi) with correct auth scope; STATUS/PLAN/REQUIREMENTS bumped; invariant green (backend tests · 11/11 evals · web build); one PR, squash-merged `--admin`.

---

## 5. Requirements + decisions (cross-ref)

**REQUIREMENTS (`docs/REQUIREMENTS-arturita.md`):**
- **FR-43** direct-answer default; explicit-only delegation *(J1, shipped)*.
- **FR-44** routing decision surfaced per turn *(J1, shipped)*.
- **FR-45** reactive HUD orb, colorblind-safe, reduced-motion guarded *(J1, shipped)*.
- **FR-46** streamed replies (v1 client reveal → J4 SSE).
- **FR-47** *(new)* **every layer (LLM/STT/TTS) defaults free/self-hosted, has a configured fallback chain, and is switchable from the Config panel** (§2). *(J2.)*
- **FR-48** *(new)* the tab is a **brainstorm/conversation partner by default**; delegation to builder/executor agents is **explicit + confirmed**, routed through B3/A3 into the task flow + A2 approvals (§0–§1). *(J1 core; J6 inline approvals.)*
- **NFR-30** no new dangerous surface *(J1, shipped)*.
- **NFR-31** glassmorphism = tokens only, floating chrome panel *(J1, shipped)*.
- **NFR-32** *(new)* **the default pipeline is fully on-device** (local LLM+STT+TTS) — a brainstorm session need not leave the machine; a `local`/sensitive context never falls back to a cloud entry. *(J2/J3.)*

**DECISIONS (`docs/DECISIONS-arturita.md`):** logged as **S7** — free-first per-layer defaults + fallback chains + config schema (LLM: Ollama local → free-tier cloud; STT: whisper.cpp → Web Speech; TTS: Piper/Chatterbox-local → browser; Chatterbox resolved as open-source-local *or* NVIDIA-hosted). Extends **S1** (`local|provider`) and **D-g** (cost-bounded failover).

---

## 6. Status: what's built vs. held

- **Built (J1, #199):** the minimal Glassmorphism shell + reactive orb + placeholder logo slot + the `answer-vs-delegate` decision + `/converse` endpoint on the F1 chain. This already satisfies "minimal UI scaffold."
- **Held (this doc first):** the deeper build — the per-layer free-first config + resolvers (J2), self-hosted STT/TTS engines (J3), SSE + barge-in (J4), deep context (J5), HUD depth + inline approvals (J6). **Do not go deep until this research doc is reviewed.**
- **Logo:** placeholder at **`web/public/arturita-logo.svg`**, referenced exactly once (`ARTURITA_LOGO_SRC` in `web/app/dashboard/AssistantPanel.tsx`). Drop the real 7Ei/Arturita asset at that exact path (same filename) for a one-file swap — no code change. Uploads to these sessions are still arriving empty; if the operator commits the file to the repo it's picked up automatically, otherwise this is where it goes.

---

### Sources (research, 2026-07-08)
- Chatterbox (Resemble AI): [resemble.ai/chatterbox](https://www.resemble.ai/learn/models/chatterbox) · [github/resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) · [github/devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) · [build.nvidia.com Chatterbox NIM](https://build.nvidia.com/resembleai/chatterbox-multilingual-tts/modelcard)
- STT: [github/ggml-org whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [github/SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [github/openai/whisper](https://github.com/openai/whisper) · [whisper.cpp Apple Silicon benchmark](https://getspeakup.app/blog/whisper-cpp-benchmark-mac/) · [Whisper model sizes](https://openwhispr.com/blog/whisper-model-sizes-explained)
- TTS: [Piper (OHF-Voice/piper1-gpl)](https://github.com/OHF-Voice/piper1-gpl) · [coqui-tts (PyPI)](https://pypi.org/project/coqui-tts/) · [local TTS license comparison 2026](https://www.promptquorum.com/power-local-llm/local-tts-voice-cloning-piper-coqui-xtts) · [best local TTS 2026](https://localaimaster.com/blog/best-local-tts-models)
- Free-tier cloud LLM: [Groq free-tier limits 2026](https://tokenmix.ai/blog/groq-free-tier-limits-2026) · [Gemini API free tier 2026](https://tokenmix.ai/blog/gemini-api-free-tier-limits) · [free LLM APIs compared 2026](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/)
