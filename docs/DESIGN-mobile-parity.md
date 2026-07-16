# DESIGN — Mobile parity: bringing the full web Mission Control to `apps/mobile/`

> **Status:** PLAN + **MOB-6a shipped** (the nav shell — §6.1) + **MOB-5a shipped** (hosted STT — §3.4/§3.5) + **MOB-PAR-1 shipped** (the first parity mirror: document attach + the Tasks fold — §6.2). Everything else below is still plan. **Date:** 2026-07-16 · **Owner:** operator (arturito@7ei.ai)
> **Companions:** `docs/DESIGN-mobile-expo.md` (the H5/MOB epic — this doc **corrects its §6 voice claim**, see §3.1; MOB-5a has since **built** the leg that claim assumed — §3.4), `web/lib/navModel.ts` (the nav source of truth this inventories), `apps/mobile/README.md`.
> Scope: enumerate every web surface, measure the mobile gap, resolve the voice Expo-Go-vs-dev-build split against the actual code, and stage the remaining work as MOB-5 (voice) + MOB-6 (menus).

---

## 0. TL;DR — the four decisions

1. **The web app is not 30 pages — it's one page.** `/dashboard` is the only authed Next route; every "menu" is a client-side `tab` string rendered by conditionals in a 43KB `page.tsx`. Nav is pure data in `web/lib/navModel.ts`. **Mobile can mirror the nav model directly** — it's already a testable, framework-free structure, and porting it means porting data, not routing.
2. **The gap is smaller than the menu count suggests.** 29 routable surfaces, but **7 are placeholders with no UI at all** ("coming soon") and 4 more are thin. The real port is ~12 screens. *(Was "30" — see the count correction in §1.)*
3. **Voice had a backend blocker, not an Expo blocker — and `MOB-5a` has now cleared it.** `DESIGN-mobile-expo.md` §6 said to "POST the audio to the hosted Whisper/converse leg." **That leg did not exist**: no backend endpoint accepted audio at all. The web app got its STT from the browser's Web Speech API (which React Native does not have) or from `adapters/arturita-stt` bound to `127.0.0.1:8790` on the operator's own Mac (which a phone cannot reach). **✅ SHIPPED (`mob-5a-stt-endpoint`): `POST /api/orgs/:orgId/arturita/transcribe`** — the hosted, org-scoped STT leg. Contract in §3.4. **The audio now has somewhere to go; MOB-5c can be written.** ⚠️ It transcribes on Fly **only once the operator supplies a cloud key** — see §3.5.
4. **TTS is free today.** `expo-speech` ships inside Expo Go and is a 1:1 peer of the web's `window.speechSynthesis`. Spoken replies need no dev build and no backend work.

---

## 1. Web nav inventory

**Architecture note that shapes everything below:** there is no file-based routing under `web/app/dashboard/`. `app/dashboard/page.tsx` is a single client component; `Sidebar.tsx`, `PageTabs.tsx`, and `CommandPalette.tsx` all render from `web/lib/navModel.ts`. Only agents deep-link (`#agent/<id>/<tab>` via `lib/agentRoute.ts`); every other tab is lost on reload. **No SSE, no WebSocket, no polling anywhere** — all data is fetch-on-mount plus manual refresh. Auth is Clerk `getToken` prop-drilled into panels (localStorage holds only the sidebar collapse state).

### Overview

| Surface | What it does | Endpoints | Heavy? | Browser-only? |
|---|---|---|---|---|
| `overview` — Dashboard | Org summary: agent/task/project cards | `/api/orgs`, `…/agents`, `…/tasks`, `…/projects`, `…/notifications`, `…/usage`, `/api/skills`, `…/jira/status`, `/api/models` | No | — |
| `assistant` — **Command Center** | Arturita chat + voice + **document attach (CC-ATT)** + pipeline config (`AssistantPanel.tsx`, 31KB) | `POST …/arturita/converse`, `POST …/arturita/attachments/extract`, `GET/PUT …/arturita/pipeline` | **Yes** | **Yes — the app's whole browser-only risk.** See §3 |
| `cockpit` — Operations | Live ops shell hosting the section components | `…/cockpit`, `…/inbox`, `…/timeline`, `…/orgchart`, `…/goals`, `…/budgets`, `…/secrets`, `…/plugins`, `…/workspaces`, `…/preflight`, `/api/agents/:id/:verb`, `/api/approvals/:id/decide` | Yes | — |
| `inbox` — **Inbox** | Approvals + notification triage (hosts tabs `tasks` + `comms` — **P2/#286**) | `…/inbox`, `…/inbox/dismiss`, `/api/approvals/:id/decide` | No | — |
| `activity` — Activity | Event timeline | `…/timeline` | No | — |

### Workspace

| Surface | What it does | Endpoints | Heavy? | Browser-only? |
|---|---|---|---|---|
| `agents` — **Agents** | Grid → detail with 6 sub-tabs (Dashboard/Config/Instructions/Skills/Runs/Budget). 11 files — the largest cluster. | `…/agents`, `…/staff`, `…/agents/:aid/overview`, `…/avatar` (multipart), `…/files`, `…/skills`, `…/runs`, `…/budget`, `…/custom-models`, `…/agents/hire`, `…/agent-invites`, `/api/adapters` | **Yes** | `window.location.hash` routing; `navigator.clipboard`; avatar upload via raw `FormData`; `canvas` in `lib/avatarImage.ts` |
| `projects` — Projects | Project list | `…/projects` | No | — |
| `org` — **Org chart** | Hierarchy viz — hand-rolled `<svg>` + drag, layout in `lib/orgLayout.ts` | `…/orgchart` | **Yes** | drag |
| `routines` | **Placeholder** — backend exists, no UI | — | — | — |

### Operate

| Surface | What it does | Endpoints | Heavy? |
|---|---|---|---|
| `governance` — Governance | Approvals, RBAC, trust tiers, policies, revisions/rollback | `…/policies`, `/api/policies/:id`, `…/agents/:aid/trust`, `…/model-profile`, `/api/agents/:aid/permissions`, `…/available-models`, `…/revisions`, `/api/revisions/:id/rollback` | Moderate (big tables) |
| `review-queue` | **Placeholder** — folded into Governance today | — | — |

### Delivery

| Surface | What it does | Endpoints | Heavy? |
|---|---|---|---|
| `costs` — **Costs** | Spend view (hosts tab `budgets`) | `…/usage` | No |
| `budgets` | Budget caps + preflight | `…/budgets`, `/api/budgets/:id`, `…/preflight` | No |
| `skills` — Skills | Skill catalog + sync | `/api/skills`, `POST /api/skills/sync` | No |
| `memory` — **Memory** | Obsidian vault tree/file viewer + knowledge graph (`VaultGraph.tsx`) | `…/memory/tree`, `…/memory/file`, `…/memory/graph?rebuild=`, `…/connectors/obsidian/config` | **Yes — `d3-force` simulation → `<svg>`, node drag.** The only npm dep beyond Next/React/Clerk |

### Company

| Surface | What it does | Endpoints | Browser-only? |
|---|---|---|---|
| `connectors` — Connectors | Integration registry + OAuth (hosts tab `plugins`, 31KB) | `…/connectors`, `…/connectors/:cid/connect`, `…/test`, `…/connectors/google/config`, `…/auth/google` | **`window.location` OAuth redirect** |
| `plugins` | Plugin manifests | `…/plugins`, `/api/plugins/:id` | — |
| `members` | **Placeholder** | — | — |

### General

| Surface | What it does | Endpoints | Browser-only? |
|---|---|---|---|
| `usage` — Usage | Usage stats | `…/usage` | — |
| `settings` — Settings | Org description/mission/culture + doc ingest (hosts `adapters`, `secrets`) | `PATCH /api/orgs/:id`, `POST …/knowledge/ingest-file` (multipart) | file upload |
| `adapters` | **Placeholder** | — | — |
| `secrets` — Secrets | Secret refs | `…/secrets`, `/api/secrets/:id` | — |

### Hidden (routable via ⌘K, off the rail)

| Surface | What it does | Endpoints |
|---|---|---|
| `goals` | Goals | `…/goals` |
| `workspaces` | Workspaces | `…/workspaces`, `/api/workspaces/:id` |
| `search`, `pipelines`, `artifacts` | **Placeholders** | — |

> **`tasks` left this table in P2 (#286).** It was hidden-but-routable (a Task Log reachable only via ⌘K); it is now a hosted tab of Inbox, labelled **Tasks** — see the Overview table. Its endpoints are unchanged: `/api/tasks/:id/{comments,attachments,subtasks,timeline,runs,execute,recovery,watchdogs}` + the 22KB `TaskDrawer.tsx`.

**Count:** **29** routable surfaces = 18 rail + **6** hosted tabs + 5 hidden. **7 are placeholders** (`routines`, `review-queue`, `members`, `adapters`, `search`, `pipelines`, `artifacts`) — nothing to port. **Evals has no web surface at all** (zero matches in `web/`); it's a backend/CI harness only.

> **Corrected during MOB-6a (was: "30 = 18 + 6 + 6"), re-verified at P2.** Verified against the model rather than the prose: `allNavItems()` → 18, `hostedTabItems()` → **6** (`tasks`, `comms`, `budgets`, `plugins`, `adapters`, `secrets`), `HIDDEN_ITEMS` → **5**, `allSurfaces()` → **29**. P2 moved `tasks` from hidden → hosted, so the split shifted but the **total did not** — the "~12 real screens to port" conclusion and the **30 mobile destinations** (29 + phone-only Status) are unchanged. `apps/mobile/src/navModel.test.ts` asserts that equality against the live web model, so this count can't silently drift again.

---

## 2. Current mobile coverage

`apps/mobile/App.tsx` — a hand-rolled 4-tab bar, no navigation library (deliberate: keeps the Expo Go dependency surface tiny).

> **Superseded by MOB-6a (§6.1).** The bar is now react-navigation's, driven by `apps/mobile/src/navModel.ts`, and every surface in §1 is reachable — the four below as real screens, the rest as placeholders. The table still describes what is *actually implemented*, which is the point of §2. The dependency-surface concern held: every package added ships inside Expo Go, so the SDK-54 pin is intact.

| Tab | Screen | Endpoints | Web peer |
|---|---|---|---|
| **Command** | `CommandCenterScreen.tsx` — text chat + "via" chip + **document attach (MOB-PAR-1, §6.2)** | `POST …/arturita/converse`, `POST …/arturita/attachments/extract` | `assistant` (text + attach — **no voice**) |
| **Inbox** | `InboxScreen.tsx` + `StepUpModal.tsx` — approve/reject/request-changes with on-device step-up (MOB-4) | `GET …/approvals?status=pending`, `POST /api/approvals/:id/decide`, `POST …/arturita/session` | `inbox` |
| **Agents** | `AgentsScreen.tsx` — roster, **read-only, no detail** | `GET …/agents` | `agents` (grid only) |
| **Status** | `HealthScreen.tsx` — connection/health | `GET /api/health` | — (no web peer) |
| — | `ConnectScreen.tsx` — org picker / sign-in | `GET /api/orgs` | — |

Plus `notifications.tsx` (push register + tap→deep-link, MOB-3).

**The gap** — web surfaces with no mobile presence: `overview`, `cockpit`, `activity`, `comms`, **agent detail** (6 sub-tabs), `projects`, `org`, `governance`, `costs`, `budgets`, `skills`, `memory`, `connectors`, `plugins`, `usage`, `settings`, `secrets`, `tasks`, `goals`, `workspaces` — **plus voice inside Command Center**.

---

## 3. Voice — feasibility, precisely

### 3.1 The headline: there was no hosted STT — MOB-5a built it

> **STATUS: RESOLVED by MOB-5a.** The finding below is preserved as the WHY; the
> endpoint that answers it is specified in **§3.4** and its deployment/key reality
> in **§3.5**. Everything in this subsection describes the state *before* MOB-5a.

`DESIGN-mobile-expo.md` §6 step 2 says: *"POST the audio to the hosted Whisper/converse leg (the same STT the web app + `adapters/arturita-stt` use)."* **This was not true of the code, and it was the single fact that gated MOB-5.**

- **No backend route accepts audio.** `@fastify/multipart` is registered (`backend/src/index.ts:8,122`) but only for 25MB *document* uploads on the knowledge routes. `backend/src/routes/arturita-voice.ts:29-36` takes a **JSON transcript**, and its own header comment (`:11-13`) says so: it accepts a transcript "produced client-side or by a future STT adapter."
- **The web app's STT is browser-side or localhost-side, never hosted.** Either `SpeechRecognition`/`webkitSpeechRecognition` (`AssistantPanel.tsx:279`) — an API React Native does not have — or `adapters/arturita-stt`, a Node daemon wrapping the local `whisper` CLI, **bound to `127.0.0.1` only** (`server.mjs:94`) on port 8790, with **no auth** (CORS is its only gate). `AssistantPanel.tsx:336` → `web/lib/whisper.ts:84` POSTs the audio to **localhost**. Audio bytes never touch the Fly backend.

So: a phone off the operator's LAN had **no STT destination**. Mic capture is the easy part; transcription was the missing leg — **now built, see §3.4**.

### 3.2 The split

**Works in Expo Go (SDK 54) today — no dev build:**

| Capability | How | Notes |
|---|---|---|
| **Push-to-talk mic capture** | `expo-av` / `expo-audio` `Audio.Recording` → M4A/AAC | Bundled in Expo Go; needs `NSMicrophoneUsageDescription` + a runtime permission prompt. Foreground clips are exactly what push-to-talk is. **Confirmed fine.** |
| **TTS playback** | **`expo-speech`** — on-device iOS AVSpeechSynthesizer | Bundled in Expo Go. A **1:1 peer of the web's `window.speechSynthesis`** (`AssistantPanel.tsx:116-141`), including voice selection. **No backend, no dev build, no network.** This is the cheapest voice win in the epic. |
| **Playing *returned* audio** | `expo-av` `Audio.Sound` from a `data:` URI | Works in Expo Go. Relevant only if we use the backend TTS below. |
| **Text converse** | already shipped | — |

**Backend work — DONE (was the blocker; not a dev-build issue):**

| Capability | Status |
|---|---|
| **Any phone STT** | ✅ **Unblocked by MOB-5a.** `POST /api/orgs/:orgId/arturita/transcribe` — Clerk-gated (loopback on packaged), org-scoped, multipart audio → `{ transcript, text }`. It deliberately mirrors the `adapters/arturita-stt` contract (`/v1/audio/transcriptions`, field `file`, `{text}` out), so the **web client can point at it by changing a URL alone**. The daemon itself remains **not** deployable as-is — localhost-bound, unauthenticated, shells out to a local CLI — so it is wired as the *self-host* provider only, behind the same interface. **Contract: §3.4. Which provider runs where + the key the operator must supply: §3.5.** |

**Needs an EAS dev build:**

| Capability | Why |
|---|---|
| **Wake word / continuous listening** | **Confirmed.** And worth being precise about what the web actually does: the web's "wake word" is **not a hotword detector**. It's a pure string filter (`voicePanel.logic.ts:10-27`, `WAKE_WORD='arturita'`) applied to a **continuous Web Speech session the operator has already toggled on**. There is no background listener, no Porcupine, no native module. On iOS there is no free continuous recognizer in Expo Go, so the phone needs either a native module (`expo-speech-recognition`, i.e. dev build) or always-open streaming STT (dev build for background audio + real cost). **Dev build + native module. Not v1.** |
| **Background / long-form audio, interruption handling** | Per `DESIGN-mobile-expo.md` §5 — foreground clips are fine, background is not. |

**Bonus finding — a latent bug worth knowing before porting the gate logic:** in the web's Whisper engine path (`AssistantPanel.tsx:336-337`) the transcript goes straight to `send()` **without** `decideSubmit`. So enabling wake-word mode in Brave (where Web Speech is blocked and Whisper is the engine) **silently does nothing** — every utterance submits verbatim. Don't port that shape.

### 3.3 Backend TTS exists but is inert

`POST …/arturita/voice` **can** return `audioBase64` + `mime` when `speak:true` (`arturita-voice.ts:100,121-129`), via NVIDIA Chatterbox (`services/voice-provider.ts:20`), keyed by `NVIDIA_API_KEY` from the encrypted store. **But** `:125` hard-codes `caps:{localAvailable:false}` and the provider returns text-only without a key. **`/converse` returns no audio at all** — the Command Center's TTS is purely browser `speechSynthesis`. **Recommendation: use `expo-speech` on-device and ignore this endpoint.** It costs nothing, needs no key, and matches what the web actually does.

### 3.4 The hosted STT endpoint (MOB-5a — as built)

`backend/src/routes/arturita-stt.ts` (route) + `backend/src/services/stt-provider.ts` (provider layer).

| | |
|---|---|
| **Method + path** | `POST /api/orgs/:orgId/arturita/transcribe` |
| **Auth** | The `secured` scope — **Clerk JWT on hosted, loopback identity on packaged** (H6), exactly like every sibling route. No bearer → **401**. Never public. |
| **Multi-tenancy** | `:orgId` comes from the **path**, and the scope-level `requireOrgMembership` preHandler proves membership of *that* org before the handler runs → **403** for a foreign org. No body/query field can name an org: the session decides, never the caller. |
| **Body** | `multipart/form-data`, **one file part, field `file`** (the OpenAI/daemon/web-client name — `web/lib/whisper.ts:81` already sends it). Non-multipart → **415**. Wrong field → **400**. |
| **Accepted audio** | `audio/m4a`, `audio/x-m4a`, `audio/mp4`, `audio/aac` (**what `expo-av` produces on iOS**), `audio/wav`, `audio/webm`, `audio/ogg`, `audio/mpeg`/`audio/mp3`, `audio/3gpp`, `audio/amr`. Parameters (`;codecs=opus`) and case tolerated. Anything else — **including `application/octet-stream`** — → **415**. *The phone client (MOB-5c) must set a real audio content type.* |
| **Optional** | `?language=en` (forwarded to the provider; omit to auto-detect). |
| **Success** | **200** `{ transcript: string, text: string, provider: 'cloud_openai'\|'local_whisper', bytes: number }`. `text` is the **same value** as `transcript`, under the key the daemon/OpenAI return and `web/lib/whisper.ts:37` already reads — that pairing is what makes this a **drop-in for the daemon URL**. |
| **Errors** (always clean JSON, never a stack) | **401** no bearer · **403** not a member · **400** `no_audio`/`bad_field`/`empty_audio`/`bad_upload` · **413** `too_large` · **415** `not_multipart`/`unsupported_type` · **502** `provider_error` · **504** `timeout` · **503** `not_configured` (no transcriber on this deployment — see §3.5). |
| **Limits** | **10 MB** per clip (`MC_STT_MAX_BYTES`) — a per-route clamp, deliberately *tighter* than the 25 MB global `@fastify/multipart` limit that exists for **document** uploads. **60 s** provider timeout (`MC_STT_TIMEOUT_MS`) → 504. |
| **Duration cap** | Bounded **indirectly**, by bytes + the timeout — *not* by decoded duration. Reading true duration from an m4a/AAC container means parsing MP4 atoms or shelling out to `ffprobe`: a real dependency for a guard the byte cap already provides. Deliberate, and flagged here so it isn't mistaken for an oversight. |
| **Privacy** | Audio is held in memory for the provider call and **never persisted** (AUDIO_RETENTION, PRD §7.8). **Neither audio nor transcript reaches a log sink at any level** — the transcript is user content; only its *length* is logged. Upstream provider error bodies are dropped, never echoed to the client. |
| **Scope** | Transcribes **only**. It creates no task and runs nothing — the caller posts the transcript on to `POST …/arturita/voice` (which gates confidence and routes to the A2 approval path) if it wants an action. The dangerous surface stays where the approval gate already is. |

### 3.5 Which transcriber actually runs — and the key the operator owes

One interface, two legs, chosen by **`MC_STT_PROVIDER`** (`auto` default · `cloud` · `local` · `off`). The local daemon already speaks an **OpenAI-compatible** `/v1/audio/transcriptions` (`adapters/arturita-stt/src/server.mjs:12`), so both legs are the *same* adapter with a different base URL — adding a third OpenAI-compatible engine (Groq, a self-hosted whisper.cpp server) is config, not code.

| Leg | Provider | Where it works | Config |
|---|---|---|---|
| **`cloud_openai`** | OpenAI-compatible hosted Whisper (`whisper-1`) | **The only leg that can ever work on Fly** | Key: per-org `OPENAI_API_KEY` in the encrypted store (Cockpit → Secrets) **→ falls back to** the `OPENAI_API_KEY` env/Fly secret. Same precedence as `llm-router.ts:175`. Overridable: `MC_STT_CLOUD_URL`, `MC_STT_CLOUD_MODEL`. |
| **`local_whisper`** | The `adapters/arturita-stt` daemon | **Self-host only** — `127.0.0.1:8790` on Fly is the Fly VM, not the operator's Mac | `MC_STT_LOCAL_URL=http://127.0.0.1:8790/v1` (**the `/v1` matters** — the daemon matches `req.url` exactly). Not auto-enabled: absent this var, `auto` never guesses a local daemon. |

`auto` picks cloud when a key is present, else local when a URL is configured, else answers a clean **503**. **A pinned `cloud`/`local` never silently falls back to the other** — quietly shipping audio to a cloud the operator pinned *away* from would be a privacy downgrade, so it fails instead.

> ⚠️ **OPERATOR ACTION — STT does not transcribe on Fly until this is done.**
> The deployed backend needs an **`OPENAI_API_KEY`** (Fly secret, or per-org via Cockpit → Secrets). It is listed as an **optional** Fly secret in `backend/CLAUDE.md` and is already used for embeddings (`services/vector-search.ts:25`) and the OpenAI LLM leg — **but whether it is actually set on `7ei-backend` was NOT verifiable from the build session** (no `fly` CLI). **No new key type is invented by this story**; it reuses the one the repo already knows. Until a key is present, `POST …/arturita/transcribe` answers a clean **503 `not_configured`** — the endpoint, auth, and guard rails are live and correct, but nothing transcribes. Verify with `fly secrets list -a 7ei-backend`.

---

## 4. Auth / endpoint reality per surface

The good news dominates: **the phone's Clerk JWT reaches every surface's REST API unchanged.** Native `fetch` sends no `Origin`, so CORS never gates it (`DESIGN-mobile-expo.md` §2.3). No SSE/WebSocket anywhere means no transport surprises. The exceptions:

| Surface | Exception | Impact |
|---|---|---|
| **Command Center** | The `deferAnswer` path (`arturita-converse.ts:131-138`) returns a *prompt* for the **browser to stream directly to the operator's local Ollama** (`web/lib/ollama.ts`). A phone cannot reach that machine. | **Low.** Mobile already sends `deferAnswer:false` and gets a buffered server-side answer. Just never enable it. |
| **Command Center (voice)** | Web Speech + `localhost:8790` Whisper — both unreachable from a phone. | ~~**The MOB-5 blocker.**~~ **Cleared by MOB-5a**: `POST …/arturita/transcribe` is the phone's STT destination (§3.4). |
| **Connectors** | OAuth is a `window.location` redirect. | Needs `expo-web-browser` + a redirect URI; the callback lands on the *web* origin. **Read-only connector status is trivial; initiating OAuth is a real story.** Defer. |
| **Agents (avatar), Settings (ingest)** | Raw `fetch` + `FormData` multipart, bypassing `lib/api.ts`. | RN `FormData` works, but `apps/mobile/src/api.ts` sets `Content-Type: application/json` whenever a body exists — **it would need a multipart escape hatch.** Both are write paths; skip in v1. |
| **Memory graph, Org chart** | `d3-force` → `<svg>`, and hand-rolled `<svg>` + drag. | Not an auth problem — a rendering problem. §5. |
| **Sidebar collapse** | localStorage. | Irrelevant — mobile has its own nav. |

**Net: no web tab is unreachable by the phone's auth.** Everything is the same gated REST API. The only true blocker was voice-STT — a missing endpoint, not an auth mismatch — and **MOB-5a has built it** (§3.4).

---

## 5. The heavy views — recommended mobile treatment

Do **not** pixel-port these.

- **Memory vault graph (`VaultGraph.tsx`, d3-force → svg, drag).** A force-directed graph on a 390pt screen is unreadable and unpannable, and porting d3-force means either `react-native-svg` (a native dep → dev build) or a WebView. **Recommendation: native list/tree, not a graph.** The valuable mobile job is *read a vault note* — `…/memory/tree` → a collapsible native list → `…/memory/file` → rendered markdown. That's phone-shaped, uses zero new deps, and covers the actual remote use case. **A WebView of the web graph is the escape hatch if the operator specifically wants the graph** — but it needs `react-native-webview` (bundled in Expo Go, so it *is* Expo-Go-viable) and a Clerk session in the webview, which is real work for a view nobody will pan on a phone. **Defer the graph; ship the tree.**
- **Org chart (`OrgChart.tsx`, svg + drag, `lib/orgLayout.ts`).** Same logic. `…/orgchart` returns hierarchy data; render it as an **indented native tree** (the drag exists to rearrange a desktop canvas — meaningless on a phone). `lib/orgLayout.ts` is pure and testable but computes *canvas coordinates* we don't need. **Simplified native tree.**
- **Agent detail (6 sub-tabs, 11 files).** Don't port all six. Dashboard + Runs + Budget are the remote-glance value; Configuration/Instructions/Skills are desktop editing surfaces. **Port 3 tabs read-only.**
- **Tasks / TaskDrawer (22KB).** Port the list + a read-only detail. The drawer's execute/recovery/watchdog writes are desktop work.

**Standing rule:** every heavy view answers "what would I actually want at a distance?" — which is almost always *read + one action*, never *edit the canvas*.

---

## 6. Staged plan

### MOB-5 — voice in the Command Center

| Story | What | Endpoints | Effort | Dev build? |
|---|---|---|---|---|
| **MOB-5a** | ✅ **SHIPPED** (`mob-5a-stt-endpoint`) — **Backend: hosted STT.** `POST /api/orgs/:orgId/arturita/transcribe`, multipart field `file` → `{ transcript, text }`, fronting an OpenAI-compatible Whisper (cloud) or the local daemon (self-host), behind one provider interface. Mirrors the daemon contract so the web client can repoint by URL. **No longer blocks 5c.** ⚠️ Needs `OPENAI_API_KEY` on Fly to actually transcribe — **§3.5**. Contract: **§3.4**. | `…/arturita/transcribe` | **M** | No |
| **MOB-5b** | **TTS-only voice.** `expo-speech` speaks the converse reply; a speaker toggle. Ships *before* STT and is independently useful. | none new | **S** | No |
| **MOB-5c** | **Push-to-talk.** `expo-av` record → `POST …/arturita/transcribe` → existing `…/arturita/converse` → 5b speaks the reply. Mic permission + a hold-to-talk button. Closes the loop. | MOB-5a + converse | **M** | No |
| **MOB-5d** | **Voice pipeline config.** Mobile view of `GET/PUT …/arturita/pipeline`. | pipeline | **S** | No |
| **MOB-5e** | **Wake word / hands-free.** Native recognizer + background audio. | — | **L** | **YES** |

**5a→5b→5c is the whole useful loop and none of it needs a dev build.** Only 5e does. **5a is now shipped**, so 5b and 5c are both unblocked.

### MOB-6 — the menus

| Story | Screen | Endpoints | Effort | Dev build? |
|---|---|---|---|---|
| **MOB-6a** | ✅ **SHIPPED** (`mob-6a-nav-shell`) — **Nav shell.** See §6.1 for the as-built. | — | **M** | No |
| **MOB-6b** | **Agent detail** — the biggest gap next to voice; Agents is already there but dead-ends. Dashboard + Runs + Budget, read-only. | `…/agents/:aid/overview`, `…/runs`, `…/budget` | **M** | No |
| **MOB-6c** | **Tasks** — list + read-only detail. Its nav home is already folded under Inbox (§6.2); this story builds the screen behind it. | `…/tasks`, `/api/tasks/:id`, `…/timeline` | **M** | No |
| **MOB-6d** | **Costs + Budgets** — spend at a glance. Pure numbers, no viz needed. | `…/usage`, `…/budgets`, `…/preflight` | **S** | No |
| **MOB-6e** | **Memory** — vault **tree + note reader** (§5). Not the graph. | `…/memory/tree`, `…/memory/file` | **M** | No |
| **MOB-6f** | **Activity + Overview** — timeline + the summary cards. | `…/timeline`, `…/cockpit` | **S** | No |
| **MOB-6g** | **Org chart** — indented native tree (§5). | `…/orgchart` | **S** | No |
| **MOB-6h** | **Governance** — read-only policies/trust/revisions. Writes stay on desktop. | `…/policies`, `…/agents/:aid/trust`, `…/revisions` | **M** | No |
| **MOB-6i** | **Projects, Skills, Goals, Workspaces, Usage** — five thin read-only lists; batch them. | `…/projects`, `/api/skills`, `…/goals`, `…/workspaces`, `…/usage` | **S** | No |
| **MOB-6j** | **Settings + Secrets** — read-only org info + secret *refs* (never values). | `/api/orgs/:id`, `…/secrets` | **S** | No |
| **MOB-6k** | **Connectors** — status read-only. OAuth initiation deferred (§4). | `…/connectors` | **M** | No |

**Not ported:** the 7 placeholders (no UI exists), `comms`/`plugins` (thin, fold into 6i/6k), Evals (no web surface), and every desktop-editing write path (avatar upload, doc ingest, policy editing, canvas drag).

**Sequence:** `MOB-6a` first (nothing scales past 4 tabs without it), then `5a → 5b → 5c` in parallel with `6b → 6c → 6d`, then the long tail (6e–6k) in any order — each is additive and independently auditable.

### 6.1 MOB-6a — as built

**Pattern: a 5-slot bottom tab bar + a pushed section stack.**

```
RootStack  (@react-navigation/native-stack)
  ├── Tabs      Command · Inbox · Agents · Status · More   (@react-navigation/bottom-tabs)
  └── Section   any destination pushed from More — real screen or placeholder
```

**The drawer this plan suggested was rejected.** A drawer is a desktop metaphor: it costs `react-native-reanimated` + `react-native-gesture-handler`, and it *hides* the sections we're trying to make discoverable. A pushed list screen is one tap in, one swipe back, scrolls to any length, and reads correctly under VoiceOver with no extra work. The "recents" list is dropped too — with 26 rows on one scrollable screen there's nothing to shortcut yet; revisit if the list gets unwieldy.

The tab bar holds **5**: iOS collapses a 6th tab into its own, worse "More". Membership is data (`primary` in the model), not a decision baked into the navigator.

**Files (all new except `App.tsx`):**

| File | Role |
|---|---|
| `apps/mobile/src/navModel.ts` | **The port + the only surface list in the app.** Pure data, no React. |
| `apps/mobile/src/navigation.tsx` | The navigator + the `SCREENS` id→component registry. |
| `apps/mobile/src/screens/MoreScreen.tsx` | Grouped list of every non-tab destination. |
| `apps/mobile/src/screens/PlaceholderScreen.tsx` | Where unbuilt destinations land. |
| `apps/mobile/src/navModel.test.ts` | Port-parity tests vs the live web model (12/12). |
| `apps/mobile/App.tsx` | Reduced to a shell: auth gate → push provider → navigator. |

**What the port keeps and what it changes.** Ids, labels, and group order are the web's — one surface, one name, in both clients. The web's rail/hosted-tab/hidden split is **flattened** (a 390pt screen has no rail to fold; a hosted tab is just another row), but recorded in `webHosted`/`webHidden` so the mapping stays auditable. The one mobile-only axis is `status`, three-valued on purpose:

- **`ready`** (4) — a real screen ships today: `assistant`, `inbox`, `agents`, `status`.
- **`planned`** (19) — the web has it and the phone's Clerk JWT already reaches the data (§4). A named `MOB-6x` builds it; the placeholder says which.
- **`gap`** (7) — unbuilt on the web too (the Epic-P placeholders). Nothing to port; waiting won't help. Asserted ≡ the web's `kind:'placeholder'`.

A flat "coming soon" would blur `planned` and `gap` — the two states make very different promises to the operator.

**The arithmetic, in one place** (it was wrong in three docs before the audit caught it, because no line ever showed the sum):

```
30 destinations = 4 ready + 19 planned + 7 gap
                = 4 tab bar  + 26 More rows
26 placeholders = 19 planned + 7 gap          (every non-tab row today)
29 web surfaces = 30 − 1 phone-only (Status)  (§1: 18 rail + 5 hosted + 6 hidden)
```

Recompute rather than trust the prose — `allNavItems()`, `primaryItems()`, `moreItems()` are the source:

```bash
cd apps/mobile && node --experimental-strip-types -e "
const m = await import('./src/navModel.ts')
const n = (s) => m.allNavItems().filter(i => i.status === s).length
console.log({ total: m.allNavItems().length, ready: n('ready'), planned: n('planned'),
              gap: n('gap'), tabs: m.primaryItems().length, more: m.moreItems().length })"
```

**Adding a screen in 6b+ is two lines:** flip `status: 'ready'` in `navModel.ts`, add the component to `SCREENS` in `navigation.tsx`. A missing registry entry falls through to the placeholder — never a crash. (A test pins the `ready` set, since `navigation.tsx` imports react-native and can't load under `node --test`.)

**The 4 shipped screens are byte-for-byte unchanged.** `App.tsx` lost its hand-rolled header (the navigator draws it now); no screen file was touched.

**Two regressions caught while wiring:**
- `ConnectScreen` had no `SafeAreaView` of its own — it relied on `App.tsx`'s, which the navigator replaced. The pre-nav gate keeps one, or Connect renders under the notch.
- A **cold start from a notification tap** resolves before `NavigationContainer` mounts, so routing straight at the ref would silently drop exactly the deep link that matters most. The target is buffered and flushed in `onReady`.

**Deferred:**
- **Push vocabulary seam.** MOB-3's `PushRouteTarget` says `'command'`; the model uses the web's id `'assistant'`. Translated by one map in `navigation.tsx` rather than renaming MOB-3's file or diverging from the web.
- **No `linking` config.** Push taps route in-process; sections aren't URL-addressable. Worth doing if a push ever needs to open a non-tab section.
- **Nav state isn't persisted** across reloads — matching the web, which loses its tab on reload.
- **CI doesn't run `apps/mobile`** (no workflow references it), so `npm test` here is a local/audit gate, not a merge gate. Wiring it in would mean touching `.github/workflows/`, which is out of scope by the root guide.

### 6.2 MOB-PAR-1 — the first parity mirror (web #284/#285/#286 → phone)

**The first application of the standing parity rule** (root `CLAUDE.md` § *Web ⇄ mobile parity*): three web changes landed, and this story carries them to the phone rather than letting the gap age.

| Web change | Mirrored? | What shipped on the phone |
|---|---|---|
| **#285 — CC-ATT document attach** | ✅ **Mirrored** | 📎 in the Command Center composer → `expo-document-picker` → the **same two-step contract the web uses**: `POST …/arturita/attachments/extract` (multipart, field `file`) on **pick**, then the extracted text rides `POST …/arturita/converse` as `attachment`. Removable chip (name · size · truncated). |
| **#286 — Tasks folded under Inbox** | ✅ **Mirrored (nav model only)** | `tasks` moved to the **Overview** group beside `inbox`/`comms`, relabelled **Issues → Tasks**, `webHosted: 'inbox'`, `webHidden` dropped. **The screen itself stays MOB-6c** — see *Deferred*. |
| **#284 — black light-theme honeycomb** | ⛔ **N/A — nothing to mirror** | That fix is the *web reactor's* honeycomb fill on the light theme. The phone has **no reactor, no honeycomb, and no 7Ei logo anywhere** (zero matches for `logo`/`honeycomb`/`7Ei` in `apps/mobile/src`; `assets/` holds only the launcher icon + splash), and its theme is dark-surface only — there is no light theme for a fill to disappear into. **Inventing a reactor to have something to fix would be the bug.** Re-mirror only if the phone ever grows a logo surface. |

**How the attach mirror matches the web, precisely** — the contract is the web's, not a re-interpretation:
- **Extract on PICK, not on send** (the web's deliberate choice): an unreadable file — a scan with no text layer — is reported while the operator is still choosing it, not after they've typed a question. On a phone that also means the upload happens before Send, not during it.
- **The document itself never reaches `/converse`** and is never stored; only extracted text, fenced by the backend into that one turn (never into history, so it can't re-enter or re-bill later turns).
- **Limits are the web's** (10 MB, the 14 parser-readable extensions) — and not on trust: `apps/mobile/src/attach.ts` is hand-copied (Metro can't reach outside `apps/mobile`), but **`attach.test.ts` imports `web/app/dashboard/assistant.logic.ts` directly and asserts the two agree** on the type list, the byte cap, the size wording, the rejection message, and the send gate. Drift fails the build. Same tripwire shape as `navModel.test.ts`.
- **Nothing logs document content** — client or server (the route logs name + byte count only, because officeparser errors can carry file content).

**Two platform deviations, both forced and both narrow:**
- **The picker opens `type: '*/*'`** where the web sets an `accept` filter. iOS filters by MIME/UTI, and several readable types (`.md`, `.log`, `.tsv`) have no reliable MIME there — a filter would grey out files the office reads fine. The **type gate is unchanged**, just applied a moment later, with the web's wording.
- **iOS doesn't always report a file size.** Unknown size **skips the size check** (the server is the enforcer and answers with the same 413 wording) and drops the size from the chip rather than inventing one. The type gate never skips.

**One trap worth recording:** `api.ts`'s `headers()` set `Content-Type: application/json` for **any** non-null body. A `FormData` body must *not* carry a hand-set content type — the runtime writes `multipart/form-data; boundary=…`, and the boundary is the only thing making the parts parseable. Left alone, every extract would have failed as a malformed multipart against a perfectly healthy endpoint. Same family as the empty-JSON-body 400.

**Deferred (deliberately, not forgotten):**
- **The Tasks screen** — `tasks` stays `status: 'planned'`, `story: 'MOB-6c'`, so tapping it opens the honest placeholder naming MOB-6c. The fold is a **grouping/labelling** change; building a screen here would have smuggled MOB-6c into a parity PR. Nothing contradicts itself in the meantime: the row reads *Tasks*, sits under Inbox, and says it isn't built yet.
- **Attachments on a delegated turn.** The backend already tells the operator the doc stays with the conversation and isn't attached to the task; the phone inherits that reply verbatim. Persisting an attachment onto a task is its own story, on both clients.
- **Voice + attach together** — voice isn't on the phone yet (MOB-5c).

> **`apps/mobile` still isn't in CI** (§6.1). That is exactly how the #286 nav drift reached `main` unnoticed: `navModel.test.ts` was **already failing on `main`** before this PR (`label drift on "tasks"` + `webHosted wrong on "tasks"`) — the tripwire worked, but nothing was watching it. **The parity rule is only as strong as someone running `npm test` in `apps/mobile`.** Wiring it into CI means touching `.github/workflows/`, out of scope by the root guide — **recommend it as its own operator-approved story.**

---

## 7. Expo Go now vs operator-gated

**Doable in Expo Go today — no Expo/EAS account, no operator action:** **every MOB-6 story (6a–6k)** and **MOB-5b, 5c, 5d** (5c gated on the *backend* story 5a, not on a dev build).

**Gated on the operator setting up an Expo/EAS account + dev build:** **MOB-5e only** (wake word / hands-free / background audio). Plus, from the existing epic, **production remote APNs push** and lock-screen "Approve" notification actions (`DESIGN-mobile-expo.md` §5/§14 — already staged behind `EXPO_PUBLIC_EAS_PROJECT_ID`).

**The honest headline: the dev build gates almost nothing you want.** One voice story. The real prerequisite for voice is a backend endpoint (MOB-5a) that the existing design doc assumed already existed. Everything else — all ~12 menus, push-to-talk, spoken replies — ships in stock Expo Go against the SDK 54 pin.
