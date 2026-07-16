# DESIGN — Mobile parity: bringing the full web Mission Control to `apps/mobile/`

> **Status:** PLAN + **MOB-6a shipped** (the nav shell — §6.1) + **MOB-5a shipped** (hosted STT — §3.4/§3.5) + **MOB-PAR-1 shipped** (the first parity mirror: document attach + the Tasks fold — §6.2) + **CI-MOB-1 shipped** (the parity tripwires now RUN on every PR and go red on drift — §6.3; becoming a *blocking* gate needs an operator action, see there) + **MOB-6b shipped** (agent detail + the Task Log — §6.4; the roster no longer dead-ends) + **MOB-6d shipped** (Costs · Budgets · Activity — §6.5; Delivery's cost pair and the event feed, all read-only) + **MOB-6e shipped** (Memory + Org — §6.6; the two *heavy* web views as native trees: the vault reader without the d3 graph, the reporting tree without the canvas. Absorbed MOB-6g) + **MOB-6f shipped** (Governance · Settings · Connectors — §6.7; the last three operator menus, all read-only: each web panel is an editor wrapped around a reading, and only the reading travels. Re-scoped — it absorbed 6h + 6k + the Settings half of 6j, and **displaced Overview to MOB-6l**). Everything else below is still plan. **Date:** 2026-07-16 · **Owner:** operator (arturito@7ei.ai)
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
| **MOB-6b** | ✅ **SHIPPED** (`mob-6b-agent-detail-tasks`) — **Agent detail + the Task Log.** The roster no longer dead-ends, and `tasks` is a real screen. Read-only; Runs/Budget/Instructions/Skills/Config tabs and the write actions deferred to **MOB-6b2**. As-built: **§6.4**. | `/api/agents/:aid`, `…/agents/:aid/overview`, `…/tasks`, `…/approvals` | **M** | No |
| **MOB-6c** | **Task detail** — the read-only drawer behind a log row (the web's `TaskDrawer`). The Tasks *list* shipped in 6b (§6.4); this is what a row opens. | `/api/tasks/:id`, `…/timeline` | **S** | No |
| **MOB-6d** | ✅ **SHIPPED** (`mob-6d-costs-activity`) — **Costs + Budgets + Activity.** Spend at a glance, the caps beside it, and the event feed. All read-only. Also fixed the roster-glyph drift the 6b audit flagged. As-built: **§6.5**. | `…/tasks`, `…/agents`, `…/budgets`, `…/timeline` (**not** `…/usage` / `…/preflight` — this row guessed wrong; see §6.5) | **S** | No |
| **MOB-6e** | ✅ **SHIPPED** (`mob-6e-memory-org`) — **Memory + Org.** The vault **tree + note reader** (not the graph) and the **indented org tree** (not the canvas). Both read-only. **Absorbed MOB-6g**: the two are the same problem — a heavy web view whose value is a hierarchy rather than its canvas — so they shipped as one story. As-built: **§6.6**. | `…/memory/tree`, `…/memory/file`, `…/orgchart` | **M** | No |
| **MOB-6f** | ✅ **SHIPPED** (`mob-6f-gov-settings-connectors`) — **Governance + Settings + Connectors.** The three remaining operator-facing menus, all read-only. **Re-scoped and absorbed 6h + 6k + the Settings half of 6j**: the three are one problem — a web panel that is an *editor wrapped around a reading*, where only the reading travels — so they shipped as one story. ⚠️ **This row previously read "Overview"; that screen was NOT built** and moves to **MOB-6l**. As-built: **§6.7**. | `…/policies`, `…/agents`, `…/revisions`, `…/connectors`, `/api/orgs` | **M** | No |
| ~~**MOB-6g**~~ | ✅ **Org chart** — **shipped inside MOB-6e** (§6.6). Row kept so the id doesn't dangle in older plans/links. | `…/orgchart` | — | — |
| ~~**MOB-6h**~~ | ✅ **Governance** — **shipped inside MOB-6f** (§6.7). Row kept so the id doesn't dangle in older plans/links. | `…/policies`, `…/agents`, `…/revisions` | — | — |
| **MOB-6i** | **Projects, Skills, Goals, Workspaces, Usage** — five thin read-only lists; batch them. | `…/projects`, `/api/skills`, `…/goals`, `…/workspaces`, `…/usage` | **S** | No |
| **MOB-6j** | **Secrets** — secret *refs* (never values). ⚠️ **Re-scoped:** the Settings half shipped in MOB-6f (§6.7); `secrets` is what's left, and it is NOT a tab of the web's Settings — it's its own surface inside the Cockpit shell (see §6.7). | `…/secrets` | **S** | No |
| ~~**MOB-6k**~~ | ✅ **Connectors** — **shipped inside MOB-6f** (§6.7). Row kept so the id doesn't dangle in older plans/links. | `…/connectors` | — | — |
| **MOB-6l** | **Overview** — the Dashboard summary cards, and **Operations** (the cockpit shell). Displaced from the old 6f row when MOB-6f was re-scoped to the three menus; neither screen is built. | `…/cockpit`, `…/agents`, `…/tasks`, `…/projects` | **S** | No |

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
- ~~**CI doesn't run `apps/mobile`**~~ — **RESOLVED by CI-MOB-1 (§6.3).** `.github/workflows/ci.yml` now has a `mobile` job, so `npm test` here **runs automatically on every PR and turns the check red on drift** — it is no longer only a local/audit gate. ⚠️ **Red does not yet BLOCK a merge**: `main` has no branch protection, so every check on this repo is advisory. Making it blocking is an operator action — §6.3 + `GO-LIVE.md` item 18.

### 6.2 MOB-PAR-1 — the first parity mirror (web #284/#285/#286 → phone)

**The first application of the standing parity rule** (root `CLAUDE.md` § *Web ⇄ mobile parity*): three web changes landed, and this story carries them to the phone rather than letting the gap age.

| Web change | Mirrored? | What shipped on the phone |
|---|---|---|
| **#285 — CC-ATT document attach** | ✅ **Mirrored** | 📎 in the Command Center composer → `expo-document-picker` → the **same two-step contract the web uses**: `POST …/arturita/attachments/extract` (multipart, field `file`) on **pick**, then the extracted text rides `POST …/arturita/converse` as `attachment`. Removable chip (name · size · truncated). |
| **#286 — Tasks folded under Inbox** | ✅ **Mirrored (nav model only)** | `tasks` moved to the **Overview** group beside `inbox`/`comms`, relabelled **Issues → Tasks**, `webHosted: 'inbox'`, `webHidden` dropped. **The screen itself was deferred** — see *Deferred*; **MOB-6b has since built it** (§6.4). |
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
- **The Tasks screen** — `tasks` stayed `status: 'planned'` here, so tapping it opened an honest placeholder naming the story. The fold was a **grouping/labelling** change; building a screen would have smuggled a separate story into a parity PR. Nothing contradicted itself in the meantime: the row read *Tasks*, sat under Inbox, and said it wasn't built yet. **Closed by MOB-6b** (§6.4), which flipped it to `ready` and put the real log behind it.
- **Attachments on a delegated turn.** The backend already tells the operator the doc stays with the conversation and isn't attached to the task; the phone inherits that reply verbatim. Persisting an attachment onto a task is its own story, on both clients.
- **Voice + attach together** — voice isn't on the phone yet (MOB-5c).

> **`apps/mobile` still isn't in CI** (§6.1). That is exactly how the #286 nav drift reached `main` unnoticed: `navModel.test.ts` was **already failing on `main`** before this PR (`label drift on "tasks"` + `webHosted wrong on "tasks"`) — the tripwire worked, but nothing was watching it. **The parity rule is only as strong as someone running `npm test` in `apps/mobile`.** Wiring it into CI means touching `.github/workflows/`, out of scope by the root guide — **recommend it as its own operator-approved story.**
>
> **✅ CLOSED — that story was approved and built: CI-MOB-1, §6.3.** The tripwire now has someone watching it.

---

### 6.3 CI-MOB-1 — the parity tripwires start running on every PR (as built)

**The problem this closes:** every parity tripwire in `apps/mobile` was firing into the void. `navModel.test.ts` sat **red on `main`** after #286 and nothing failed, because **no workflow referenced `apps/mobile`** — the shipping app was the one workspace CI couldn't see. A rule nothing runs is a suggestion.

> #### ⚠️ What this does and does NOT do — read before trusting it
>
> **It DOES:** run the tripwires on every PR to `main`, automatically, and turn the **`Mobile (apps/mobile)`** check **red** on drift. That is a **visible signal** where previously there was silence. *(Proven, not assumed: injecting a one-word label change into `web/lib/navModel.ts` fails the mobile suite with `label drift on "tasks"` — the exact error that sat unseen on `main`.)*
>
> **It does NOT (yet): block a merge.** `main` has **no branch protection and no rulesets** (verified: `GET /branches/main/protection` → 404 *"Branch not protected"*; `GET /rulesets` → `[]`). **Every check on this repo is advisory today** — a red mobile job can still be merged straight past, and this repo's convention is `--squash --admin` anyway.
>
> **So the honest state is: someone still has to look — but now there is something to look at.** The gap CI-MOB-1 closes is *"the test never ran"*, not *"a human might ignore red"*.
>
> **Making it a real gate is one operator action** (GitHub Settings → Branches → protect `main` → require **`Mobile (apps/mobile)`**): **operator-only**, not something a builder can do from the CLI. Tracked as **`GO-LIVE.md` item 18**.
> **⚠️ If you do that, do NOT add `npm audit` to the required list** — it fails on every PR by design and is knowingly non-blocking; requiring it would wedge every merge. Require `Mobile (apps/mobile)`, `Install check (backend/web/app)`, and `Backend unit tests`.

**The change is one file, one new job, 48 added lines, 0 removed:** `.github/workflows/ci.yml` gains a `mobile` job. *(Operator-approved exception to the root guide's "don't touch `.github/workflows/`" — this is the change that makes the standing parity rule real.)*

| Step | Command | Why this and not the obvious alternative |
|---|---|---|
| Install | `npm ci` | **Not `npm install --legacy-peer-deps`** (what the `check` matrix uses). This app's react/react-dom **exact pins** resolve cleanly on their own; `--legacy-peer-deps` would paper over exactly the ERESOLVE regression we want CI to catch, and `install` (vs `ci`) would ignore the committed lockfile. |
| Typecheck | `npm run typecheck` | The app's own `tsc --noEmit` — **not** the matrix's `npx tsc --noEmit --skipLibCheck`, which would silently skip the RN/Expo type surface. |
| Test | `npm test` | **37 tests, incl. the three parity tripwires** (nav model · attach · status — MOB-6b added the third) **and the heartbeat call-site guard** (§6.4). This is the gate the story exists for. |
| Export | `npm run export` | `expo export --platform ios` — proves the app still **bundles**. Pure Metro/Hermes JS: **no Xcode, no native toolchain**, ~7s. Cheap enough to be non-negotiable. |

**Added alongside the legacy `app`, not in place of it.** The root guide calls `app/` "LEGACY/frozen; do not build new features here" — but **frozen ≠ dead**, and no doc anywhere says it's safe to stop building. Dropping it from CI would be a silent coverage cut smuggled into a story about *adding* coverage. `check`'s matrix is still exactly `[backend, web, app]`.

**Why a separate job rather than a fourth matrix entry** (`workspace: [backend, web, app, apps/mobile]`): the matrix's shape is wrong for this app in three ways at once — its install command defeats the pins, its typecheck command is the wrong one, and it has **no test or build step at all**. Bending the matrix around one member with conditionals would have put the other three jobs at risk to save a few lines. A standalone job touches nothing that already works.

**The tripwires need no `web/` install.** They import `../../../web/lib/navModel.ts`, `../../../web/app/dashboard/assistant.logic.ts`, and `../../../web/app/dashboard/status.ts` (MOB-6b) **by relative path**, and all three of those modules are pure data with **zero imports of their own** — so `node --test --experimental-strip-types` loads them straight from the checkout. The mobile job installs `apps/mobile` only. *(This is load-bearing: if any of those web modules ever grows an import, this job breaks and the fix is to keep the module pure, not to install web here.)*

**Untouched on purpose:** the `check` matrix, `test.yml`, `deploy.yml`, and **`security.yml` — the known-noisy `npm audit` job keeps its exact semantics** and stays non-blocking. This story adds a gate; it doesn't renegotiate existing ones.

### 6.4 MOB-6b — agent detail + the Task Log (as built)

**Two screens, three placeholders' worth of promise kept, zero backend change.** The phone is a thin REST client to the same hosted backend, so both screens are client work only — every endpoint below already served the web.

| Screen | Endpoints (identical to the web's) | Mirrors |
|---|---|---|
| **Agent detail** (`AgentDetailScreen.tsx`) — pushed from a roster row | `GET /api/agents/:agentId` (identity/status/config) · `GET /api/orgs/:orgId/agents/:agentId/overview` (latest run, recent tasks, distributions, costs) | `web/app/dashboard/agent/AgentDetail.tsx` + its `DashboardTab.tsx` — the same two calls, in the same order, reading the same fields. |
| **Tasks** (`TasksScreen.tsx`) — the `tasks` destination, under the Inbox grouping | `GET /api/orgs/:orgId/tasks` · `GET /api/orgs/:orgId/agents` (the names it joins) · `GET /api/orgs/:orgId/approvals?status=pending` (the affordance) | `web/app/dashboard/page.tsx` `{tab === 'tasks'}` — the same log, the same 100-row cap, the same approvals link. |

**Roster → detail.** `AgentsScreen` rows became `Pressable` and call `onOpenAgent`, a new `AgentDetail` **stack route** (`{ agentId, name }`) pushed above the tabs — back button and iOS swipe-back for free. `name` is carried for the header only; the screen re-fetches the agent and trusts nothing from the params.

**Why the agent detail is NOT in `navModel.ts`.** It isn't a surface on either client: the web reaches it by drilling into the Agents area (a hash route under the same `agents` tab), not from the rail. Registering it as a destination would have invented an IA the web doesn't have — which is the exact failure `navModel.test.ts` exists to catch. `agents` stays one destination; the detail is a route beneath it. **Only `tasks` flipped `planned → ready`.**

**The third tripwire (`status.test.ts`).** `status.ts` ports the web's status table — the synonym map (`in_progress → active`, `stale → failed`, …) and the glyphs. Metro can't import from `web/`, so it's a hand-copy, and a hand-copy without a tripwire is silent drift: teach the web a new synonym and the phone quietly files it under `idle`, showing a ○ where the desk shows ✕ — *"nothing happening"* on a failed run. The test imports **both** modules and asserts the canonicalisation and every glyph agree. `statusColor()` is deliberately **not** compared: it returns CSS `var()` strings, the one part of the table that cannot cross into react-native, so the tone is resolved against our own palette instead. The **glyph** is what the colorblind rule rests on, and the glyph is pinned. `taskLog.ts` has no web module to compare against (the web renders those rules inline in JSX) — which makes them *easier* to drift, so its tests assert the web's literal behaviour (5dp cost, the 60-char cut, the em-dash-not-zero rule) with the mirrored web expression named in each test.

**Deferred, and why each is a deferral rather than a gap:**

- **Editing / the write actions** (Assign Task, Run Heartbeat, Pause/Resume) — the story is read-only by scope. The phone shows state; the desk changes it. → **MOB-6b2**.
- **The web's five other agent tabs** (Instructions, Skills, Configuration, Runs, Budget) — Instructions is owner-gated markdown editing and Configuration is the agent's editable surface: desk work. Runs + Budget are read-only and are the natural next slice. → **MOB-6b2**.
- **Task detail** — a log row doesn't open yet (the web has `TaskDrawer`). → **MOB-6c**, rescoped from "the Tasks screen" to "what a row opens", since the list shipped here.
- **The four 14-day day-column charts** — the only place this screen is deliberately not pixel-parity. Run Activity and Success Rate are 68px of 14 unlabelled bars; at 390pt that's a smudge that reads as decoration. The two **distributions** (by status, by priority) survive because they're label + count + bar. **No data is lost** — the same numbers are on the Costs strip and the task rows.

**Graceful degradation is per-call, not per-screen.** Both screens use `Promise.allSettled`: a failed *overview* must not blank the identity the operator navigated to see, and a failed *agents* fetch must not cost them the task log (an unnamed agent still shows its task). A failed **approvals** fetch drops the affordance entirely rather than claiming "0 pending" — a false all-clear is worse than no claim.

**⚠️ Caught by the independent audit — the heartbeat had its own vocabulary and the screen ignored it.** `AgentDetailScreen` passed the raw `heartbeatStatus` field into `statusIcon`/`statusTone`. Those resolve the **task/run** table, where `green` and `amber` appear in neither `ICON` nor `ALIAS` — so both collapsed onto `idle` and rendered **○ / neutral**: a healthy agent looked identical to one that had never checked in, and amber lost its warning entirely. `stale` survived only by coincidence (it happens to be an `ALIAS` key), which is exactly why the chip read as working.

**The lesson is about where the test pointed, not how hard it tested.** `heartbeatStatus()` was already written, already exported, and already covered — the call site simply never called it. Testing the helper harder would not have caught this. The fix adds `heartbeatIcon()` / `heartbeatTone()` (the only correct way to glyph a heartbeat), points the screen at them, and adds a **source-level guard**: the screens import react-native and can't load under `node --test` — the same constraint `navModel.test.ts` works around with a hand-kept list — so the guard greps the screen sources and fails if a raw heartbeat is ever handed back to the status table. *Verified by reintroducing the defect and watching it go red*, not assumed. This is the colorblind rule's own failure mode: the glyph **is** the signal, so a heartbeat that glyphs wrong is precisely what this vocabulary exists to prevent.

**Verified:** `npm test` 37/37 · `npm run typecheck` clean · `npm run export` bundles (3.54 MB) · `npm install` clean, no ERESOLVE, react/react-dom pins and **SDK 54 untouched** (no dependency added). Additive: `apps/mobile/**` + docs only.

---

### 6.5 MOB-6d — Costs · Budgets · Activity (as built)

**Three screens, zero backend change, no new dependency.** Every endpoint below already served the web.

| Screen | Endpoints (identical to the web's) | Mirrors |
|---|---|---|
| **Costs** (`CostsScreen.tsx`) | `GET /api/orgs/:orgId/tasks` (**every figure**) · `GET /api/orgs/:orgId/agents` (the roster the breakdown iterates) | `web/app/dashboard/page.tsx` `{tab === 'costs'}` — the same four stats, the same 4dp, the same roster-ordered breakdown. |
| **Budgets** (`BudgetsScreen.tsx`) — the web's hosted tab under Costs | `GET /api/orgs/:orgId/budgets` (policies + the server's own `spend`/`state`/`pct`) | `web/app/dashboard/cockpit/BudgetsSection.tsx` — the same rows, the same verdict, minus the create/delete. |
| **Activity** (`ActivityScreen.tsx`) | `GET /api/orgs/:orgId/timeline` (the 24h swimlane) | `web/app/dashboard/CockpitPanel.tsx` → `cockpit/TimelineSection.tsx` — the same payload, flattened into a feed. |

**The §6 plan row above guessed the endpoints wrong, in three ways.** Worth recording, because each guess was reasonable and each was false:

- **`…/usage` is not Costs.** It's the *Usage & Limits* tab — rate limits and quotas, its own nav surface (`usage`, still `planned`, MOB-6i). Not spend.
- **`…/preflight` is not Budgets.** It's a separate cockpit section with no nav id of its own. The `budgets` blurb had been promising "Budget caps **and preflight checks**"; the row opens caps, so the blurb now says caps. A row shouldn't advertise a surface it doesn't open.
- **`…/costs` exists — and the web never calls it.** `backend/src/routes/costs.ts` serves a purpose-built, server-aggregated `/api/orgs/:orgId/costs` (`groupBy=agent|day`, `period=7d|30d|90d`) plus `/costs/summary` and `/costs/export`. It is dead code as far as both clients are concerned.

**The one deliberate divergence, and why it went the way it did.** That unused `/costs` endpoint is exactly what you'd want on a phone: aggregation server-side, a few rows over cellular instead of 200 task objects. We call `/tasks` anyway. The reason is that `/costs` is **windowed** (30d by default) and the web's sum **isn't**, so the same org would report a different total depending on which device you picked up — the operator reading `$0.4213` on the desk and `$0.3887` on the phone has been told two stories about one number. Mirroring the web's *contract* beats optimising the phone's *transport*: the parity rule's whole point is that a surface means one thing on both clients. If the windowed aggregate is the better product answer, that's a **web** change first, and the phone follows it — which is the direction this rule always runs.

**A capped total is not a lifetime total, and the phone says so.** `/tasks` is capped at **200 rows server-side** (`backend/src/routes/tasks.ts` `.limit(200)`), so "Total Spend" means *across the 200 most recent tasks* — on **both** clients. The web presents it unqualified, which quietly reads as all-time. Rather than copy that, the phone prints the scope under the figure (`SPEND_SCOPE_NOTE`). This is the one place the phone is *more* honest than the desk, and it's additive: same number, more truth. **The web should do the same** — logged below as a web-side follow-up, not fixed here (this PR is additive to `apps/mobile/**` by scope).

**"Activity" is not an audit log — and the obvious source would have rendered empty forever.** The name invites an actor/action/target feed, and there **is** an `audit_logs` table. It is also **a no-op**: the plugin that writes it records nothing. A feed built on the obvious source would have looked deliberate, shipped, and shown an empty list permanently. The web's Activity is instead a **24h heartbeat swimlane** — lanes per agent, blocks per run/task. That's where the data lives, so that's what the phone reads.

**What the phone keeps and what it drops.** A swimlane is a chart, and 24h across ~340 usable points makes a 20-minute run about four pixels wide. So the feed keeps the **data** and drops the **projection**: `startPct`/`widthPct` are ignored (they're the only part of the payload that assumes a wide canvas), the lanes are flattened back into the event list they were built from, and it's sorted newest-first — the left edge of a chart is the bottom of a list. Each row still carries who · what · which · when, plus the cost the web puts in the block's tooltip.

**Two tripwires, both of which earned it.** `costs.ts` and `activity.ts` are pure modules with the rules lifted out of the web's inline JSX (the `taskLog.ts` pattern):

- **`activity.test.ts` imports the backend's real `buildHeartbeatTimeline`/`mergeActivity`** and feeds our reader a payload built by the code that actually serves it — a hand-written fixture would pass forever while the wire drifted. **It caught a real trap on first run:** a run block's cost comes from the **run** row (`run.costUsd`), *not* the task it points at, so a run can report `0` while its task cost real money. The screen therefore **omits** a zero rather than printing `$0.00000` — a zero there means "not recorded here", not "free". Both facts are now pinned.
- **`costs.test.ts`** pins the precision split the two web views genuinely have — the Cost Centre renders **4dp**, the Task Log **5dp** — so the mirror can't get "tidied" into one and silently change a number on one screen. It also pins roster ordering (not spend-ranked: re-ranking would make one org read as a different league table on each client), the `?? 0`-in-a-sum vs em-dash-for-one-task split, and that no budget state can collapse into another without colour.

**Budgets is read-only on purpose.** The web's section can also create a policy and delete one. A hard-stop that can halt the org's spending is a desk decision — it wants the dialog, the scope picker, and the second look that a 390pt screen makes worse. The phone answers *"am I near the cap?"*, which is the question you have when you're away from the desk. The empty state drops the web's "add one" call to action rather than promising an affordance that isn't there.

**`state` is a third vocabulary.** Budget states (`ok`/`warn`/`breach`) are in neither the status table nor the heartbeat map, so feeding them to `statusTone` would collapse all three onto `idle` — a **BREACH** rendering identically to a healthy budget. This is the same trap the 6b audit found in heartbeats, so it got the same treatment: an explicit mapping (`budgetChip`), label + glyph, and a test asserting no two states share a glyph. An unknown state degrades to neutral and **never** to `ok` — a state we don't recognise must not claim the budget is fine.

**⚠️ The 6b audit's roster nit — fixed, and it was three bugs, not one.** `AgentsScreen` hand-rolled its own status mapping, and every part of it had drifted from `status.ts`:

1. **Status compared `=== 'active'` literally**, so the aliases the table exists to collapse never landed: a `running` agent fell through to the ○/neutral *idle* chip on the roster while the detail screen showed ⬡/active — one agent, two states, depending on the screen. `failed`/`stopped`/`terminated` all read as plain idle too: **the roster could not show you a dead agent.**
2. **The glyphs were invented locally** (`●`/`○`), so even where the two agreed on the state they disagreed on the mark. ●-vs-⬡ isn't a style difference when the glyph *is* the signal that survives colorblindness.
3. **A local `heartbeatTone` painted an active heartbeat green** — undoing DESIGN_SYSTEM v2's rule that active is the **accent**, never green, precisely because green/red is the pair the operator cannot see.

Both chips now route through `status.ts` (`statusIcon`/`statusTone`, and `heartbeatIcon`/`heartbeatTone` for the separate heartbeat vocabulary). **The generalisation matters more than the fix:** this is the *second* time a correct, well-tested helper was simply not called — the same shape as the 6b heartbeat defect. So `status.test.ts` gains a sibling **source-level guard**: no screen may re-declare a canonical helper of its own. A local copy of a mapping is drift with a delay built in — right the day it's written, wrong the first time the table changes. *Verified by reintroducing the original defect and watching it go red*, then restoring.

**Deferred, each a deferral rather than a gap:**

- **The per-agent proportional bars** — the web draws each agent's share as a bar; at phone width a 3% bar is ~10 points, indistinguishable from 1% and from zero. The share is **printed as a number** instead: same fact, legible, readable to a screen reader, and not leaning on hue. **No data lost.** (Note the web floors its bar width at 1% so a hairline stays visible — `formatShare` deliberately does *not* copy that floor, since printing it would round a real 0.2% up to "1%": a rendering hack turned into a lie.)
- **The swimlane itself** — see above. The feed is the phone's form of it.
- **Cost period/groupBy controls and CSV export** (`/costs`, `/costs/export`) — the web has no period control either, so building one here would invent a surface the desk lacks. Export is a desk action (a file download).
- **Creating or deleting a budget** — desk work, as above.
- **A task detail from an Activity row** — a row doesn't open yet; that's `TaskDrawer`'s mirror. → **MOB-6c**, the same drawer the Task Log rows want.

**Follow-up logged (web-side, not this PR):** the web's Cost Centre presents a 200-task-capped "Total Spend" as if it were all-time. Either qualify it as the phone now does, or have it call the `/costs` endpoint that already exists — at which point the phone follows the web, in that order.

**Verified:** `npm test` **62/62** · `npm run typecheck` clean · `npm run export` bundles (3.56 MB) · `npm install` clean, no ERESOLVE, react/react-dom pins and **SDK 54 untouched** (no dependency added). Additive: `apps/mobile/**` + docs only — no backend, web, or desktop file touched.

---

### 6.6 MOB-6e — Memory + Org: the two heavy views, as native trees (as built)

**Two screens, zero backend change, no new dependency.** Both endpoints already served the web. This is the story where the parity rule's "mirror the decision, don't re-invent it" meets its hardest case: **both** of these web surfaces are listed *Heavy* in §1, and both are heavy for the same reason — a canvas. Neither canvas came. Both hierarchies did.

| Screen | Endpoints (identical to the web's) | Mirrors |
|---|---|---|
| **Memory** (`MemoryScreen.tsx`) | `GET …/memory/tree?path=` (**one directory**) · `GET …/memory/file?path=` (one note's markdown) | `web/app/dashboard/MemoryPanel.tsx` — the same two calls, the same entries, the same markdown subset. |
| **Org** (`OrgScreen.tsx`) | `GET …/orgchart` → we read `agents`, the flat roster | `web/app/dashboard/cockpit/OrgChart.tsx` — the same roster, the same tree derivation (`web/lib/orgLayout`), minus the geometry. |

**The §6 plan row guessed the endpoints exactly right — and the *shape* of one of them wrong.** `…/memory/tree` is **not** a vault tree. It lists **one directory**: it's a GitHub Contents call per folder (`backend/src/services/vault-connector.ts`), and there is no whole-vault endpoint at any depth. The plan's phrase "vault tree + note reader" reads like one fetch renders a tree; it can't. So the collapsible tree **fetches per expand**, and `memory.ts` models the vault as a map of `path → children` that fills in as the operator opens folders. That turned out to be the right shape anyway — the phone never fetches the vault it isn't looking at, which on cellular is the difference between a screen and a stall — but it was a correction, not a plan.

**What each screen keeps, and what it drops.**

- **Memory keeps the vault and drops the graph.** The web's ⬡ Graph view (`VaultGraph.tsx`) is a `d3-force` simulation over `…/memory/graph` — the app's only npm dep beyond Next/React/Clerk. A force-directed map of a whole vault is a canvas-and-pointer artefact; at 390pt it's a hairball you can't hit-test. **Dropped, not deferred**, and the screen says so itself (`MEMORY_GRAPH_NOTE`) rather than leaving the operator hunting for a view that isn't coming.
- **Memory's tree is collapsible, where the web's is a *browser*.** The web's left pane shows **one** directory at a time: clicking a folder **replaces** the list and a breadcrumb walks you back. That's fine for a 280px column beside a reader; on a phone, replacing the whole screen to peek inside a folder costs you the context you opened it for. So expanding **splices children in beneath their folder** and the rest of the vault stays put. Same endpoint, same entries, same order — a different traversal, which is the trade this rule exists to license.
- **Org keeps the hierarchy and drops the canvas.** `layoutOrgTree`/`fitToView`/`zoomAbout`/`NODE_W` answer *"where on a 2000px canvas does this card sit"* — a question a 390pt column never asks. Indentation says the same thing about depth. So `org.ts` is deliberately **half** of `web/lib/orgLayout.ts`: the half that is about the org, not about the canvas. **Dropped, not deferred** (`ORG_CANVAS_NOTE`).
- **Both are read-only, and both drop a write the web has.** Memory drops the vault **picker** ("Change vault…", a `PUT …/connectors/obsidian/config`): repointing the org's shared vault is a config change with an org-wide blast radius, and it isn't a phone gesture. Org drops **Import/Export company**: import creates a whole organisation from a JSON file. The vault is still *labelled* — from the tree response, so the label cannot disagree with the tree it's labelling.

**Neither client reads the backend's org `tree`.** `…/orgchart` returns `{ tree, agents, count }` — a pre-nested tree **and** the flat roster. The web ignores `tree` and derives its own from `agents` so the cycle-breaking is testable client-side. The phone does the same. Leaving `tree` unread on **both** clients is what stops a second answer to "who reports to whom" from existing.

**Three tripwires, and the one place there isn't one.**

- **`org.test.ts` imports the web's real `buildOrgTree`** and diffs our tree against it — orphans, self-references, and a genuine `a → b → a` cycle. This is the tripwire that most earns its keep: a cycle reaching a hand-rolled walk is an **infinite loop**, and an infinite loop on a phone is a hang with no console to explain it. (If that rule ever regresses, the test doesn't fail — it hangs, which is exactly the symptom.)
- **`memory.test.ts` imports the backend's real `isMarkdownPath`/`isSafeVaultPath`** and diffs `isNotePath` extension-for-extension. `isNotePath` decides what the tree offers as **tappable**; drift means the phone either hides notes the desk reads, or offers ones the server 400s on. It also pins `VAULT_DEFAULT` against the backend's `defaultVaultConfig()`, since the phone prints that label before the first response lands.
- **`navModel.test.ts`'s ready-set** caught the flip honestly: both ids were added to its expected list only after the screens were registered in `SCREENS`.
- **⚠️ `RUNTIME_BADGE` is the one web-copied constant here with no import tripwire.** `web/app/dashboard/cockpit/shared.tsx` contains JSX, so `node --test --experimental-strip-types` **cannot** load it — there is no way to import it from a test that runs outside Metro. (`orgLayout.ts` and `vault-connector.ts` are plain `.ts`, which is why the tree rules and the path rules *are* pinned.) `org.test.ts` pins the **shape** instead — the fallback, the `internal` special case, the model suffix — so only the map's **values** can drift, which is cosmetic when they do: a wrong glyph beside a correct word, on a line whose meaning the word already carries. **This is not hypothetical: the first draft of this file guessed all five badges wrong** (`🔌`/`⚙️`/`🖱️` vs the real `📎`/`🧠`/`⌨️`) and invented an `external` key that doesn't exist. A hand-check against `shared.tsx:41` caught it. If you change the web's map, change this copy — the check is a grep, not a test.

**The markdown reader is a parser, not an HTML pipe — and that's a security improvement, not just a port.** The web's `mdToHtml` escapes the note and hands the string to `dangerouslySetInnerHTML`. React Native has no innerHTML and no DOM, so the **same subset** (h1–h4, list item, fenced code, rule, paragraph, and the inline run: code/bold/italic/link/`[[wikilink]]`) is parsed into a **block tree** and rendered with `<Text>`. Note content is **untrusted** — any agent with a vault token can write to the vault — and the web has to escape first and get it right. The phone has nowhere for a `<script>` to *go*: it can only ever become a Text string. Pinned by a test. The subset is deliberately the web's, including its limits: `#####` is a **paragraph** on both, because the web matches `#{1,4}` only — a note must not grow a heading level on the phone that the desk doesn't have.

**Both trees are flattened, never nested.** `flattenTree`/`flattenOrg` produce a flat row array with `depth` as a **number**, fed to one `FlatList`. Depth becomes indentation, not component nesting. A nested render would build one React subtree per folder and re-render the lot on every toggle; flat means FlatList recycles rows and only mounts what's on screen — a 2,000-note vault scrolls like a 20-note one. Memory's walk only visits **expanded** folders, so rows are `O(visible)`, not `O(vault)`. Pinned by tests, including that a row's payload carries no `children` key (which would ship a whole subtree to every list item and defeat the point).

**The defaults are opposite, on purpose.** Memory tracks **expanded** (a vault opens closed — you're looking for one note); Org tracks **collapsed** (an org chart opens *open* — you're looking at the shape). Same flattening, inverted default, because the question each screen answers is different.

**Failure states got the attention they usually don't.**
- **A folder that fails to load must not blank the tree you're standing in.** One `loadDir` rejection reports itself, leaves that folder closed, and **keeps everything already fetched**.
- **"Still fetching" and "this folder is empty" are different facts**, and showing the second during the first is a lie that resolves. `flattenTree` takes the in-flight set and rows report `loading` distinctly from empty. Pinned.
- **A pull-to-refresh re-reads what's *open***, not the whole vault — collapsing the tree under someone who pulled to refresh would lose their place.

**Colorblind rule held, twice.** Org's status is `statusIcon` + `statusTone` from `status.ts` (never a local mapping — that's the drift `status.test.ts`'s source-guard now forbids after 6d found it twice). Memory's rows are `▸`/`▾`/`📄`/`📎`: a folder's open state and a note's readability are **glyphs**, never hue. A non-note (`.png`) is visibly a different thing *and* isn't tappable, so the tree never offers a tap the backend would reject.

**Deferred, each a deferral rather than a gap:**
- **The vault graph** and **the org canvas** — see above. Dropped, not deferred: there is no phone form of either worth building.
- **Editing a note.** `PUT …/memory/file` exists (it's how agents write to the vault) and both clients decline it — the *web* has no editor either, so building one here would invent a surface the desk lacks.
- **Tappable `[[wikilinks]]`.** Resolving one means searching the vault for a title; the web renders a plain `<span>` too. Styled, not tappable — a link that looks tappable and isn't is worse than one that doesn't pretend.
- **Opening an external link from a note.** Read-only screen; opening a URL from untrusted note content is a different decision than reading it. The label is shown in link colour and the note stays put.
- **The vault picker** and **Import/Export company** — desk writes, above.

**⚠️ One Low caught by the independent audit and fixed in-branch: a fetch inside a state updater.** `MemoryScreen` called `loadDir(path)` from **inside** the `setExpanded` updater. React deliberately **double-invokes** updaters under StrictMode precisely to surface impurity, so opening a folder would have fired **two GETs** — and on a slow link, two responses racing into `dirs`. The rule it broke is small and absolute: an updater computes the next state and does nothing else; the side effect belongs to the **event**, not to the state transition. Fixed by computing `willExpand` in the handler body, keeping the updater pure, and fetching after it (`expanded` joins the `useCallback` deps, since a stale closure would flip the wrong way *and* mis-decide the fetch).

The interesting part is the guard, not the fix. No unit test can reach it — the screens import react-native and can't load under `node --test` (the constraint `navModel.test.ts` and `status.test.ts` both work around), so it gets a **source-level guard** in the shape `status.test.ts` already established: brace-match every `setX(…)` **functional** updater in `screens/*.tsx` and reject `loadDir(`/`Api.`/`fetch(`/`await` inside one. Two details keep it honest — it asserts it actually **found** updaters (a scan that silently matches nothing passes forever), and a sibling test feeds the scan the **original defect verbatim** plus the shipped fix, so a broken regex fails rather than waving the defect through. **Proven by reintroducing the defect and watching it go red**, then restoring — not assumed. (The first draft of the scan was in fact wrong: it started the brace-walk at the arrow's parameter list and stopped dead on `(x)`.)

**Verified:** `npm test` **105/105** · `npm run typecheck` clean · `npm run export` bundles (3.6 MB, 1131 modules) · `npm install` clean, no ERESOLVE, react/react-dom pins and **SDK 54 untouched** (no dependency added). Additive: `apps/mobile/**` + docs only — no backend, web, or desktop file touched.

---

### 6.7 MOB-6f — Governance · Settings · Connectors: the readings travel, the writes don't (as built)

**Branch `mob-6f-gov-settings-connectors`.** The last three operator-facing menus, all **read-only**. Re-scoped from the plan above: this row used to say *Overview*, and Governance/Settings/Connectors were 6h/6j/6k. They shipped together because they are **one problem**, not three: each web panel is *an editor wrapped around a reading*, and only the reading travels to a phone. **Overview was not built** — it moves to **MOB-6l**, and the `overview`/`cockpit` placeholders now name that story instead of pointing at this shipped one.

| Screen | Endpoints (all GET) | Mirrors | Deferred |
|---|---|---|---|
| **Governance** | `…/policies`, `…/agents`, `…/revisions` | All four of the web panel's readings: execution policies, per-agent permissions, trust tier + boundary, config revisions | add/remove policy · save permissions · trust tier + boundary (**owner-only**) · model profile · **rollback** |
| **Settings** | `/api/orgs` | The org's Description / Mission & Vision / Culture & Principles | edit the three fields (`PATCH /api/orgs/:id`) · document-summarise upload |
| **Connectors** | `…/connectors` | The connector list grouped by category, each with connected status + account label | **connect / OAuth** · test · disconnect · token rotation · Google toggles · gear sheets |

**The web's fourth Governance call, `…/available-models`, is deliberately NOT made.** It exists only to populate the model-profile `<select>`. No editor, no select, nothing to populate — fetching it would be asking for data to render nothing.

**Why Governance is read-only, stated plainly:** this is the surface that decides *what an agent is allowed to do*. Every control deferred above is destructive-by-mis-tap in a way no other mobile screen is — a "Remove" beside a policy, a one-tap rollback, a trust tier one scroll-flick from Standard to Low-trust. None has an undo, and several are owner-only for exactly that reason. The **readings** carry none of that risk and all of the value away from a desk. Deferred, not dropped; the screen says so in a banner rather than showing dead controls.

#### The trap this story existed to not fall into

**An empty permission list means _allow all_, not _allowed nothing_.** The backend treats `permissions == null/[]` as legacy allow-all (`services/code-executor.ts`) and the web says so in its hint (*"Empty = allow all"*) and its placeholder (*"allow all (empty)"*). A read-only list that rendered `[]` as "none" would tell the operator an agent is **locked down** while it is in fact **unrestricted** — the single most dangerous thing this screen could get backwards, and the easy mistake, since "empty list → show nothing" is the obvious code. So the empty case is a **label, not a blank**: `capsLabel()` returns `⚠ Allow all (unrestricted)`, and a test pins it across `null`, `undefined`, `''`, `'[]'`, `'{}'` and garbage.

#### ⚠️ Found while building: the org payload carries live credentials — two of them

`GET /api/orgs` is `db.select().from(organisations)` (`backend/src/routes/orgs.ts`) — **the whole row** — and that row carries:

1. **`telegramBotToken`** — a bot token (`backend/src/db/schema.ts`).
2. **`deployConfig`** — a JSON blob holding **LLM API keys**, and org creation writes `deployConfig[`${provider}_api_key`] = body.llmApiKey` **in plaintext** (`routes/orgs.ts`). The executor still reads a "legacy plaintext `<slug>_api_key`" beside the newer AES-256-GCM `<slug>_api_key_enc` (`services/custom-model.ts`, `services/agent-executor.ts`), so the plaintext path is live, not vestigial.

**The phone has received this payload since MOB-1** (`ConnectScreen` lists orgs with it); MOB-6f neither introduces nor worsens it, and narrowing the projection is a **backend** change, out of scope for an `apps/mobile`-only story. **Reported as a follow-up, not silently absorbed.**

**`deployConfig` is why the guard is a deny-list and not just a regex** (audit nit, #293). A name-based check catches a field that *announces* itself — `telegramBotToken` does; **`deployConfig` does not**, and it is the one carrying plaintext API keys. That's the blind spot exactly where it costs most: a column that **is** a credential without being **named** one. So `CREDENTIAL_BEARING_FIELDS` names it explicitly, a test proves the **deny-list** (not the regex) is what catches it, and another asserts every denied column **still exists** — a deny-list entry pointing at nothing is a dead guard that also hides that the credential moved.

What this story owes is that none of it reaches a pixel, and that's a **structural** guarantee rather than a promise: `SettingsScreen` renders a fixed **allow-list** (`SETTINGS_FIELDS` — three prose fields), never a spread of the org, never a key walk, and nothing is logged. `OrgSettingsLite` types only the five harmless fields, so a future `{...org}` doesn't typecheck its way onto the screen. **No secret value is rendered on any of the three screens, and no screen fetches one.**

#### Settings is short because the web surface is short — reported, not padded

The web's Settings tab is **a form and almost nothing else**: three inputs, an upload chip, Save. Its only *reading* is the current value of those three fields, which arrive with the org itself. So the phone's Settings is a small screen **by the web's shape, not by our trimming**, and it was not padded out to look like a peer of Governance. It's still worth having — Mission and Culture are read by every agent, so *"what did we tell them we are?"* is a real question to answer from a phone.

**`secrets` is not part of it.** The nav model lists `secrets` as a tab `webHosted: 'settings'`, but the web's Settings tab **does not render it** — Secrets is its own surface, fed by `…/secrets` inside the Cockpit shell. The bookkeeping records the web's IA intent; the code is the authority. MOB-6f reads nothing from that endpoint, and MOB-6j is now **Secrets only**.

#### Tripwires — pinned to the server where possible, honest where not

Three new pure modules (`governance.ts`, `connectors.ts`, `settings.ts`) — React-free so `node --test` can load them **and** their sources. **+37 tests.**

- **Governance → `web/lib/trust.ts` (import).** `parseTrustMode` / `isLowTrust` / `trustBadge` / `isContainedToNothing` are asserted **equal to the web's** across every value a TEXT column can hold (casing, padding, `null`, garbage) × 8 boundary shapes. Whether an agent reads as *contained* must not depend on which device you picked up — that sentence **is** the screen.
- **Connectors → `backend/src/services/connectors.ts` (import).** Stronger than the usual mirror test: the registry is dependency-free, so the phone is pinned to the **server** rather than to a copy of the web's copy. `CATEGORY_ORDER` must **cover** every category the backend ships (and carry no stale one), every backend connector must land in a group, and the Google trio is asserted against the backend's derived `GOOGLE_MEMBERS` rather than the web's hard-coded `['gmail','gcal','gdrive']`. A connector added or re-categorised server-side now fails CI instead of vanishing from the phone's list.
- **Settings → `backend/src/db/schema.ts` (SOURCE SCAN, not an import).** A cross-workspace tripwire may *import* another workspace's source only if that source is **dependency-free**; `schema.ts` imports drizzle, and the Mobile CI job runs `npm ci` inside `apps/mobile` only — so the import passed locally and **silently dropped the whole file's tests in CI** (132 vs 142). Scanning the source as text keeps the tripwire and drops the dep, with the idiom's two guards: assert the scan **found** columns, and a sibling test proving the scanner **bites** on controlled input. Every rendered field must be a real `organisations` column; and the guard test asserts the **hazard is real** — `telegramBotToken` still exists — *and* that the allow-list excludes it. `assertNoSensitiveField` is proven to bite (`llmApiKey`, `token`, `Secret sauce`, `adminPassword` all throw), because a guard that never fires is indistinguishable from no guard.
- **Honestly NOT import-tripwirable (JSX-bound, pinned as literals next to a comment naming the source):** `CAP_HINTS` and the `CATEGORY_ORDER` *ordering* both live inside component modules (`GovernancePanel.tsx`, `ConnectorsPanel.tsx`), and Settings' three labels are inline JSX in `page.tsx` with no `Org` type to import. Cosmetic if they drift — none is a rule the backend enforces — and for `CATEGORY_ORDER` the *coverage* (the part that can hide a row) **is** pinned to the backend.
- The `navModel.test.ts` ready-set tripwire **fired as designed** when the three statuses flipped, and was updated with them.

**No mutating call exists anywhere in this PR** — all five new `Api` helpers are bare GETs, and no `method:` appears in any MOB-6f file.

**Verified:** `npm test` **147/147** (+42) · `npm run typecheck` clean · `npm run export` bundles (3.63 MB) · `npm install` clean, no ERESOLVE, react/react-dom pins and **SDK 54 untouched** (no dependency added). Additive: `apps/mobile/**` + docs only — no backend, web, or desktop file touched.

**Remaining placeholders after 6f:** `overview` + `cockpit` (**MOB-6l**), `tasks` detail (6c), `comms` + `projects` + `skills` + `goals` + `workspaces` + `usage` (6i), `secrets` (6j), `plugins` — plus the 7 `gap` surfaces that don't exist on the web either.

---

## 7. Expo Go now vs operator-gated

**Doable in Expo Go today — no Expo/EAS account, no operator action:** **every MOB-6 story (6a–6k)** and **MOB-5b, 5c, 5d** (5c gated on the *backend* story 5a, not on a dev build).

**Gated on the operator setting up an Expo/EAS account + dev build:** **MOB-5e only** (wake word / hands-free / background audio). Plus, from the existing epic, **production remote APNs push** and lock-screen "Approve" notification actions (`DESIGN-mobile-expo.md` §5/§14 — already staged behind `EXPO_PUBLIC_EAS_PROJECT_ID`).

**The honest headline: the dev build gates almost nothing you want.** One voice story. The real prerequisite for voice is a backend endpoint (MOB-5a) that the existing design doc assumed already existed. Everything else — all ~12 menus, push-to-talk, spoken replies — ships in stock Expo Go against the SDK 54 pin.
