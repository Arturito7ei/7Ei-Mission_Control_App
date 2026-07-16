# DESIGN — Epic H5 / MOBILE: an Expo iPhone app that remotely controls Mission Control

> **Status:** Full plan **+ phase-1 app (MOB-1) + real Clerk sign-in (MOB-2) + push client (MOB-3) BUILT & bootable in Expo Go** (`apps/mobile/`) · **Date:** 2026-07-16 · **Owner:** operator (arturito@7ei.ai)
> **MOB-3 (this wave):** the *client* push slice — permission, local notifications, tap→deep-link, and backend token registration — ships in Expo Go with **zero backend change** (the register endpoint already existed). **Remote APNs delivery is staged behind an EAS dev build**, flipped on by one env var (`EXPO_PUBLIC_EAS_PROJECT_ID`) with no code change. See **§14**.
> **Companions:** `docs/DESIGN-packaging.md` §8 (the earlier iPhone-surface stub — this doc **supersedes** its native-app thinking with a hosted-first Expo client; see §10), `docs/SECURITY-posture.md` (the gate chain the phone must not bypass), `docs/RUNBOOK-agent-onboarding.md` (how Mac-mini agents attach to the hosted backend — unchanged by this epic), `web/lib/api.ts` (the API client this mirrors), `apps/mobile/README.md` (run instructions). Verify claims against the repo before acting.

---

## 0. TL;DR

- **The phone is a THIN REMOTE CLIENT to the hosted backend** (`https://7ei-backend.fly.dev`), calling the **same REST API the web app uses**. It is **not** a client of the operator's Mac mini. The Mac-mini/desktop agents keep reporting to the hosted backend over the agent-facing API exactly as today — **this epic touches none of that.** The value is *control at a distance*: approve an action, talk to Arturita, check the roster, from anywhere.
- **Auth: recommend `@clerk/clerk-expo`** authenticating to the **same Clerk org** the web app uses — the phone becomes a first-class Clerk client, tokens auto-refresh, and the backend's existing `clerkAuth` + membership gates apply unchanged. A device-pairing token is evaluated as a runner-up and **not recommended** (§2.4).
- **CORS is a non-issue for the native app.** React Native `fetch` sends **no `Origin` header**, so the backend's `ALLOWED_ORIGINS` allow-list never gates the phone — it reaches the hosted API as-is. (Expo *web* preview at `localhost:8081` is already on the allow-list too.) No backend CORS change needed.
- **P0 feature surface (control remotely):** **Command Center** (text chat to Arturita) · **Inbox/Approvals** (approve/reject/request-changes — the killer remote feature) · **Agents** list · **Tasks**. **P1:** Memory, Costs, **push notifications** (approval-needed / agent-needs-attention — the true at-a-distance payoff). **Fast-follow:** voice (Expo AV record → hosted converse/Whisper).
- **Push needs almost nothing new backend-side.** A device-token **register endpoint already exists** (`notificationRoutes`, `push-notifications` feature) and the backend already POSTs to Expo's push service. The **client push slice (MOB-3) is now built** and wires to that endpoint with **zero backend change** (§14); it runs in Expo Go (permission, local test, tap→deep-link, token registration). **Remote APNs delivery** is staged behind an EAS dev build (one env var, no code change), and emitting a push on *approval-created* is flagged as a separate backend story.
- **Expo Go vs dev-build:** everything in P0/P1 **except background audio and rich native push** runs in **Expo Go** (managed, no native build). Voice-with-background-audio and production APNs push move to an **EAS dev build** (§5). The phase-1 app is deliberately **Expo-Go-only**.
- **Phase-1 shipped this wave:** a runnable `apps/mobile` Expo app (SDK 57, TypeScript) that boots in **Expo Go** and proves remote control against the hosted backend — Command Center chat, Inbox approve/reject, Agents list, health/status — with **token-paste auth** as the guaranteed-bootable fallback while **Clerk-Expo is staged as MOB-2** (§11).

---

## 1. Architecture

### 1.1 The shape

```
        ┌──────────────────────────┐
        │   iPhone — Expo app      │   apps/mobile  (Expo Go now → EAS dev build later)
        │   (thin remote control)  │
        │  • Command Center chat   │
        │  • Inbox / Approvals     │
        │  • Agents / Tasks        │
        │  • (P1) push, voice      │
        └────────────┬─────────────┘
                     │  HTTPS + Clerk bearer JWT
                     │  (no Origin header → CORS N/A)
                     ▼
        ┌──────────────────────────────────────────────┐
        │   HOSTED BACKEND — 7ei-backend.fly.dev (fra)  │   ← same API the web app uses
        │   Fastify · Clerk auth · Drizzle · Turso      │
        │   /api/orgs/:orgId/…  (org-scoped, gated)     │
        └───────▲───────────────────────────▲───────────┘
                │ agent-facing API           │ browser API
                │ (claim/result/heartbeat)   │ (Clerk JWT)
      ┌─────────┴──────────┐        ┌────────┴─────────┐
      │  Mac mini / desktop │        │  Web dashboard   │
      │  adapters (agents)  │        │  app.7ei.ai      │
      │  — UNCHANGED —      │        │  (Vercel, Clerk) │
      └─────────────────────┘        └──────────────────┘
```

**The one load-bearing idea:** the phone and the web app are **peers** — two browser-class clients of the same hosted API. The phone needs **no** direct path to the Mac mini, no tunnel, no local network to the agents. The agents are already decoupled from any UI: they talk to the hosted backend, and *any* authenticated client (web, phone) sees their state and can act on it.

### 1.2 Why hosted-first (not a packaged/loopback client)

`DESIGN-packaging.md` §8 framed the iPhone surface around a **packaged, loopback** instance (Telegram long-poll, then a LAN/Tailscale PWA), because *that* epic is about a self-hosted `.dmg`. **This epic is different and simpler:** the operator's real deployment is the **hosted** backend, agents already report to it, so the phone should talk to the hosted API directly. Hosted-first means:

- **No reachability problem.** The hosted backend has a public HTTPS endpoint; the phone reaches it from any network. (A loopback packaged instance is unreachable from a phone off-LAN without a tunnel — the §8 wrinkle. Hosted sidesteps it entirely.)
- **Reuse the web auth + API verbatim.** Clerk org, org-scoped routes, the whole endpoint surface.
- **The Mac mini stays out of the trust path.** Nothing on the phone touches the operator's machine or its OS grants.

The packaged-PWA path (§8) remains valid **for the packaged product**; a later story can point this same Expo app at a packaged instance over a tunnel (§7). Hosted-first is the recommended and built default.

---

## 2. Auth on mobile

### 2.1 Recommended: `@clerk/clerk-expo` against the same Clerk instance

The web app is a Clerk app (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` gates `<ClerkProvider>` in `web/app/layout.tsx`; `clerkMiddleware` protects `/dashboard` + `/api` in `web/middleware.ts`). The backend validates the Clerk JWT on the secured scope (`clerkAuth` → `req.auth.userId`) and then runs `requireOrgMembership`/`requireOrgRole`.

`@clerk/clerk-expo` makes the phone a **native Clerk client of the same instance**:

```tsx
import { ClerkProvider, useAuth } from '@clerk/clerk-expo'
import * as SecureStore from 'expo-secure-store'

const tokenCache = {
  getToken: (k: string) => SecureStore.getItemAsync(k),
  saveToken: (k: string, v: string) => SecureStore.setItemAsync(k, v),
}

<ClerkProvider publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!} tokenCache={tokenCache}>
  …
</ClerkProvider>

// in a screen:
const { getToken } = useAuth()
const jwt = await getToken()          // auto-refreshing session JWT
api(`/api/orgs/${orgId}/…`, { token: jwt })
```

**Why this is right:**
- **Same identity, same org, same gates.** The phone's user *is* the operator's Clerk user; every org-scoped route resolves membership against the same `org_members` rows. Zero backend change.
- **Auto-refreshing tokens.** `getToken()` mints a fresh short-lived JWT per call — no expiry pain (the pain the phase-1 paste fallback has).
- **Secure token cache.** Clerk's `tokenCache` persists the session in the **iOS Keychain** via `expo-secure-store` — not in JS-readable storage.
- **Runs in Expo Go** for email/password + email-code sign-in; Google/OAuth uses `expo-web-browser` + `expo-auth-session` (also in Expo Go).

**The one operator input:** `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` — the **same publishable key** the web app uses (`pk_test_…` on the current dev instance; `pk_live_…` once the production Clerk instance lands, `GO-LIVE.md` §1). Publishable keys are non-secret (they ship in the web bundle already), so putting one in the Expo bundle is fine.

### 2.2 Token storage & the bearer flow

- Clerk holds the session in its `tokenCache` (Keychain). The app calls `getToken()` right before each API call and passes it as `Authorization: Bearer <jwt>` — mirroring the web pattern (panels receive `getToken` and pass the token per call; `web/lib/api.ts`).
- The phase-1 app already stores its bearer + API URL + selected org in `expo-secure-store` (`apps/mobile/src/store.ts`), so the Clerk swap only changes *where the token comes from*, not how screens consume it (they depend on `getToken()` + `orgId` only).

### 2.3 CORS considerations

- **Native app:** `fetch` from React Native sends **no `Origin`** header → the `@fastify/cors` policy (`backend/src/middleware/cors.ts`, `DEFAULT_ORIGINS`) doesn't apply. The phone can call every verb (GET/POST/…) with no preflight. **No change needed.**
- **Expo web preview** (`expo start --web` on `localhost:8081`): already in `DEFAULT_ORIGINS`. So even the browser preview of this app is covered.
- If a future story serves the app from a new web origin, add it to `ALLOWED_ORIGINS` (Fly secret) — a config change, not code.

### 2.4 Runner-up (not recommended): device-pairing token

An alternative is a **first-run pairing code**: the web dashboard mints a long-lived device token (a hashed agent-style token, like the adapter tokens in `agent-api.ts`), the phone stores it, and a new `deviceAuth` hook validates it. **Evaluated and rejected for v1** because:
- It's a **second auth system** to build, gate, rotate, and audit (the backend already has three: Clerk, agent-token, loopback — adding a fourth is cost without benefit here).
- It **loses org/role fidelity** — you'd re-derive membership from the token instead of reusing Clerk's.
- Clerk-Expo already solves "sign in on a phone" with refresh + Keychain + the same identity.

Keep pairing tokens in reserve **only** for a later "point the app at a *packaged* loopback instance" story (§7), where there is no Clerk — that's exactly the H6 loopback-session model, and the phone would present the loopback session secret over a tunnel. Not v1.

---

## 3. Feature surface (prioritized for remote control) → endpoints

Every endpoint below is **org-scoped and Clerk-gated** unless noted (`/api/health` is public; `/api/approvals/:id/decide` derives the org from the approval row). Paths are literal — the backend hard-codes the full `/api/...` string per route (no Fastify prefix). Timestamps serialize as **epoch-ms integers**.

### P0 — the "control remotely" core (all built or wired in phase 1)

| Feature | What the operator does | Endpoint(s) |
|---|---|---|
| **Command Center** (chat to Arturita) | Ask a question / give an instruction; see the reply + a **"via" chip** (which provider/model answered, or that it was **delegated** to a task). | `POST /api/orgs/:orgId/arturita/converse` — body `{ message, history?, explicitDelegate?, deferAnswer:false }` → `{ mode:"answer", reply:{text,provider,model} }` **or** `{ mode:"delegate", taskId, routing:{workMode,destructive} }`. Companion probe: `GET …/arturita/llm-status`. |
| **Inbox / Approvals** (killer remote feature) | See pending dangerous-action approvals; **approve / reject / request-changes**. | List: `GET /api/orgs/:orgId/approvals?status=pending` → `{ approvals:[{id,type,summary,payload,status,requestedByAgentId,createdAt}] }`. Decide (tri-state): `POST /api/approvals/:id/decide` — body `{ decision:"approved"|"rejected"|"revision_requested", note? }` → `{ approval }`. |
| **Agents** (roster) | Glance at who's running, status, heartbeat, trust. | `GET /api/orgs/:orgId/agents` → `{ agents:[…] }` (name, role, runtime, llmModel, status, heartbeatStatus, trustMode, avatarEmoji). Richer roster: `GET …/cockpit`. Detail: `GET /api/agents/:agentId`. |
| **Tasks** | Track what work is in flight / blocked. | `GET /api/orgs/:orgId/tasks?status=&agentId=` → `{ tasks:[…] }` (title, status, kanbanColumn, inboxState, workMode, costUsd, createdAt). Detail: `GET /api/tasks/:taskId`. |
| **Org resolution** (post-sign-in) | Auto-pick the org (or choose if >1). | `GET /api/orgs` → `{ orgs:[…] }` (owned). Membership incl. invited: `GET /api/users/:userId/orgs` → adds `memberRole`. |

**Approval step-up caveat (important, honest):** approving a **dangerous** type (`file_destructive`, `wallet_tx`, `email_send`, `machine_exec`) requires a fresh **Arturita command-session token** (`x-arturita-session` header or `sessionToken` body). A phone that hasn't minted one gets **403 "step-up required"** on *approve*. **Reject and request-changes never need step-up** — so the remote **stop/hold** action is always reliable, and remote *approve* of dangerous actions is a follow-up (MOB-4) that mints the step-up session on device. Non-dangerous approvals (hire, spend, external_action, agent_join_request, low_trust_review) approve directly.

### P1 — the at-a-distance depth

| Feature | Endpoint(s) | Notes |
|---|---|---|
| **Push notifications** | register: existing `notificationRoutes` device-token endpoint; send: backend push service (`push.ts`) | §4 — the real reason to have the app on your phone. Small additive backend story to emit Expo push on approval-needed / agent-needs-attention. |
| **Memory** | `GET /api/agents/:agentId/memory` (memoryRoutes) | Read agent long-term memory. |
| **Costs** | `GET /api/orgs/:orgId/costs`, `…/usage`, `…/limits` | Spend + budget at a glance. |
| **Task actions** | `POST /api/orgs/:orgId/tasks`, task update routes | Nudge/create a task from the phone (write — gate carefully). |

### Fast-follow — voice (§6)
Mic capture (Expo AV) → `POST` audio to the hosted converse/Whisper leg → spoken reply (TTS). Text chat ships first; voice layers on.

---

## 4. Push notifications (Expo push)

**Why it's the payoff:** the whole point of a phone is to be *told* when the office needs you — an approval is pending, an agent went stale/blocked, a task needs attention — without opening the app.

**How Expo push works (managed):** the app calls `Notifications.getExpoPushTokenAsync()` → an **Expo push token** (`ExponentPushToken[…]`), registers it with the backend, and the backend POSTs to Expo's push service (`https://exp.host/--/api/v2/push/send`), which fans out to APNs/FCM. **No raw APNs certs needed for Expo Go / Expo-managed** — Expo brokers it. (A production standalone build via EAS uses your APNs key, configured once.)

**Backend-side (small, additive, flagged — NOT built this wave):**
- **Register:** a device-token endpoint **already exists** (`notificationRoutes` registers "push register"; `push-notifications` is a declared `/api/health` feature; `push.ts` service present). The story is to (a) confirm/extend it to accept an **Expo** push token shape and platform, storing it per user/org, and (b) add a tiny **Expo send** path in `push.ts` alongside whatever web-push it already does.
- **Triggers:** emit a push when an `approval_requests` row is created (approval-needed) and when an agent heartbeat goes `stale` / a task enters `needs_attention`/`blocked`. These are existing state transitions — the push is a fire-and-forget side effect (`.catch()`), never in the request's critical path (matches the backend's Pinecone rule).
- **Scope discipline:** this is one additive story (**MOB-3**), **stage→audit** (it's a remote-notification surface + stores device tokens). Because a register endpoint already exists, no new *public* surface is likely needed — but any change to it is audited. **Not built this wave** per the "push only if trivial + flagged" instruction; flagged here as the recommended next backend story.

**Client-side (Expo Go caveat):** `expo-notifications` **can register + receive** push in Expo Go for a quick test, but Expo has signalled that **remote push in Expo Go is limited/deprecated** for production — real push wants an **EAS dev/standalone build** (§5). So: prototype the token flow in Expo Go, ship production push on the dev build.

---

## 5. Expo Go vs EAS dev build — the testing path

**Runs in Expo Go (managed, zero native build) — the phase-1 target:**
- The entire P0 surface: HTTPS API calls, Clerk-Expo sign-in (email/password/code, and OAuth via `expo-web-browser`), `expo-secure-store`, all the screens.
- Basic `expo-notifications` token registration for a prototype.

**Needs an EAS dev build (`eas build --profile development`) — later phases:**
- **Background audio / long voice capture** (`expo-av`/`expo-audio` recording works in Expo Go for foreground clips, but robust background/interruption handling and some codecs want a dev build) — **voice, MOB-5**.
- **Production remote push** (custom APNs config, notification categories/actions like "Approve" from the lock screen) — **push, MOB-3 production**.
- Any future **native module** (biometric unlock, share extension, widgets).

**Rule for this epic:** phase 1 and the P0 stories stay **Expo-Go-only** so the operator's test loop is *scan-a-QR* with no build account. Voice and production push are explicitly the **dev-build phase** — the operator will need an **Expo/EAS account** (free tier is enough to start) for those (open question H5Q2).

---

## 6. Voice on mobile

Mirrors the Arturita voice loop the web app already has, but with the phone's mic:

1. **Record** — `expo-audio`/`expo-av` captures a clip (M4A/AAC). Request mic permission (`NSMicrophoneUsageDescription` — set once; prompt on first record). Foreground push-to-talk works in Expo Go; hands-free/background wants the dev build (§5).
2. **Transcribe + converse** — POST the audio to the hosted **Whisper/converse** leg (the same STT the web app + `adapters/arturita-stt` use; see `arturita-voice.ts` / the converse pipeline). The phone doesn't run Whisper locally — it uses the hosted STT, consistent with "thin remote client".
3. **Reply + TTS** — render the text reply and, optionally, play spoken audio (`expo-audio` playback of a TTS stream, or the existing TTS pipeline's output). Respect the honest-degradation contract: if no cloud LLM/STT is reachable, fall back to text (the converse endpoint already returns `degraded:true`).

Permissions: **Microphone only**, prompted on first use, with a plain "voice needs the mic" explanation — the same least-privilege posture as the desktop TCC wizard (`DESIGN-packaging.md` §4). Voice is **MOB-5** (dev-build phase).

---

## 7. Connectivity edge cases

| Situation | Behaviour |
|---|---|
| **Phone off the operator's network** (cellular, other Wi-Fi) | **Works** — the hosted backend is public HTTPS. This is the whole advantage of hosted-first. |
| **Hosted backend down / unreachable** | The client distinguishes *dead backend* from *refused write* (mirrors `web/lib/api.ts` `transportError`). Health screen shows OFFLINE; screens show a plain error + pull-to-retry. No crash. |
| **Token expired (paste mode)** | 401 → clear "re-connect with a fresh token" message. Clerk-Expo (MOB-2) removes this by refreshing. |
| **Expo Go dev server unreachable** (phone can't see the Metro QR) | Use `expo start --tunnel` (ngrok-class tunnel) — documented in the README. This is only for *loading the dev bundle*, not for reaching the backend. |
| **Optional later: drive a *packaged* / local instance** | A local/packaged Mission Control is loopback-only; a phone reaches it only over an operator-controlled **tunnel** (Tailscale/LAN-bind, the audited posture from `DESIGN-packaging.md` §8/H-Q8) and would auth with the **loopback session** (not Clerk). **Recommend hosted-first**; this local path is a deliberate, later, audited option — not v1. |

**Offline/caching:** v1 is online-only (a remote control implies connectivity). A later story can cache the last roster/inbox for read-only glances offline.

---

## 8. Phased story plan — Epic H5 / MOB

One PR per story, squash-merged `--admin`, hosted invariant green each merge (`backend`: tests + 11/11 evals; `web build`). Stories touching **auth, push, or credentials stage→audit** (a session that didn't write them audits — the `SECURITY-posture.md` §1 protocol). `apps/mobile` is **additive** — it must never enter the `web`/`backend`/`desktop` build or test paths.

| Story | Title | Scope | Acceptance criteria | Audit? | Deps |
|---|---|---|---|---|---|
| **MOB-1** ✅ **BUILT (this wave)** | **Phase-1 Expo app in Expo Go** | Managed TS Expo app at `apps/mobile`; token-paste auth + org resolution; Command Center chat, Inbox approve/reject/request-changes, Agents list, health/status; colorblind-safe. | ✅ **MET (§11):** boots in Expo Go via `npm install && npx expo start`; typecheck clean; Metro bundles (592 modules → Hermes); calls the **live** hosted backend (`/api/health` green, `/api/orgs` 401-gated); additive (own npm root, not in web/desktop builds). | no (no new backend surface; read + existing decide endpoint) | — |
| **MOB-2** ✅ **BUILT** | **Clerk-Expo real sign-in** | Add `@clerk/clerk-expo` + `<ClerkProvider>` + Keychain `tokenCache`; replace paste with `getToken()`; keep paste as a fallback. Resolve the SDK-57 peer-compat. | ✅ **MET (§13):** `@clerk/clerk-expo@2.19.42` installs **clean** on Expo Go SDK 57 (peer fix: pin `react-dom@19.2.3`); real Clerk email+password / email-code sign-in against the same instance; auto-refreshing `getToken()` (Keychain via `expo-secure-store`, never logged); paste kept as escape hatch; screens use async `getToken()`+`orgId`; hosted backend unchanged (401 gate + no-Origin verified live). | **stage→audit** (auth surface) | MOB-1 |
| **MOB-3** ✅ **CLIENT BUILT (this wave); remote delivery staged** | **Push notifications** | Client (**built**): `expo-notifications` — set handler, request permission, `getExpoPushTokenAsync` (guarded/no-op in Expo Go), register the token with the **existing** backend endpoint using the Bearer path, tap→deep-link (approval → Inbox), local test notification, token lifecycle (register on sign-in/grant, de-register on sign-out). **No backend change** — the register endpoint + Expo-push send path in `push.ts` already exist and already emit on task-complete/routine/budget (fire-and-forget). **Staged (dev build):** production remote APNs delivery via `EXPO_PUBLIC_EAS_PROJECT_ID` + an EAS dev build; and (a *separate* backend story, flagged) emitting an Expo push on **approval-created** / agent-stale. | ✅ **CLIENT MET (§14):** handler + permission + local test + tap-routing run in **Expo Go**; token minted + registered only when a projectId is configured (graceful no-op otherwise); `npm install`/typecheck/`expo export` clean; additive. **Remote push on the phone** still needs the EAS dev build (validated there). | **stage→audit** (remote-notification surface + device-token storage) | MOB-1; (MOB-2 for per-user targeting) |
| **MOB-4** ✅ **BUILT (this wave)** | **Approve dangerous actions (step-up on device)** | Re-enable the dangerous Approve button behind an on-device gate (biometric via `expo-local-authentication`, else typed-APPROVE), then mint a **fresh** Arturita command-session token per approval and attach it on `x-arturita-session` — the step-up the `decide` endpoint requires for `file_destructive`/`wallet_tx`/`email_send`/`machine_exec`. Backend gate/contract **unchanged**. | ✅ **MET (§15):** dangerous approve opens `StepUpModal` → local gate → `POST …/arturita/session` → decide with the header; live backend re-verified (`/api/health` 200; mint + decide **401 without auth**, the auth layer that fronts the 403 step-up gate); `npm install`/typecheck/`expo export` (801 modules) clean; additive to `apps/mobile/**`. Authenticated 403→200 needs an operator Clerk owner token (operator step, recipe in §15.4). | **stage→audit** (approving dangerous actions remotely) | MOB-1 |
| **MOB-5** | **Voice (dev build)** | Mic capture (`expo-audio`) → POST to hosted Whisper/converse → text + optional TTS playback; mic permission prompt + honest degradation. Ships on an **EAS dev build** (background audio). | Push-to-talk produces a transcribed message + a reply; mic-only permission; degrades to text with no LLM/STT; runs on the dev build. | no (reuses hosted STT/converse; no new backend) | MOB-1; MOB-2 |
| **MOB-6** | **Tasks + Memory + Costs depth** | Task detail/actions, agent memory read, costs/budget glance. | Read surfaces render live; any write (task nudge/create) is gated + confirmed. | write-gates reviewed | MOB-1 |
| **MOB-7** *(optional, later)* | **Point at a packaged/local instance over a tunnel** | Loopback-session auth (not Clerk) to a packaged instance via an operator tunnel; the audited LAN-bind/Tailscale posture. | Reaches a packaged instance over a tunnel with the loopback session; hosted-first stays the default. | **stage→audit** (auth + reachability posture) | H5(packaging); MOB-1 |

**Sequencing:** MOB-1 (done) → MOB-2 (real auth) → MOB-3 (push) / MOB-4 (dangerous approve) in parallel → MOB-5 (voice, dev build) → MOB-6 (depth) → MOB-7 (packaged, optional).

---

## 9. Open questions / decisions the operator must make

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| **H5Q1** | **Auth model — Clerk-Expo vs device-pairing token.** | MOB-2 | **Clerk-Expo** (same org, refresh, Keychain, zero backend change). Pairing tokens only for the later packaged-instance path (MOB-7). |
| **H5Q2** | **EAS/Expo account** — needed for dev builds (voice, production push). Free tier starts. | MOB-3 prod, MOB-5 | Create a free Expo account when voice/prod-push start; P0 needs none (Expo Go only). |
| **H5Q3** | **Clerk publishable key for mobile** — the app needs `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (same key as web). Which instance — current dev, or wait for the production Clerk instance (`GO-LIVE.md` §1)? | MOB-2 | Use the current dev key to build MOB-2 now; swap to `pk_live_…` when the production Clerk instance lands. |
| **H5Q4** | **Which features first after P0** — push vs dangerous-approve vs voice? | ordering | **Push first** (the at-a-distance payoff), then dangerous-approve, then voice. |
| **H5Q5** | **App Store distribution later?** — or stay Expo-Go/dev-build/TestFlight for the single operator? | none now | **TestFlight/dev-build is enough** for one operator; App Store only if it goes multi-user. Not scoped this wave. |
| **H5Q6** ✅ **RESOLVED (MOB-2)** | **SDK/Clerk version alignment** — SDK 57 vs `@clerk/clerk-expo` peer conflict. | MOB-2 | **Resolved without a dev build.** The conflict was NOT clerk-expo's own peers (its `react ^18‖^19` / `react-native >=0.73` already accept SDK 57). It was transitive: `@clerk/clerk-expo → @clerk/clerk-react` pulls in `react-dom`, which npm floated to `19.2.7` (peer `react ^19.2.7`), clashing with Expo SDK 57's pinned `react@19.2.3`. **Fix: pin `react-dom` to `19.2.3` (exact, matching `react`).** `@clerk/clerk-expo@2.19.42` (the `latest-v5` tag) then installs clean with no `--legacy-peer-deps`, and the metro/Hermes bundle builds (736 modules) → runs in Expo Go. See §13. |

---

## 10. Relationship to `DESIGN-packaging.md` §8 (reconciliation)

`DESIGN-packaging.md` §8 (H5) proposed the iPhone surface as **v1 Telegram long-poll → v2 PWA → v3 native**, *within the packaged/loopback product*. This document **supersedes the "native app" question for the hosted product** and **reframes** it:

- For the **hosted** deployment (the operator's real, live backend), the right remote surface is a **hosted-first Expo native app** — reachable anywhere, reusing Clerk + the web API, with the Mac-mini agents untouched. That's this epic (H5/MOB), and phase 1 is built.
- The §8 **packaged Telegram long-poll** and **packaged PWA** remain the correct answers **for the packaged `.dmg`**, where loopback reachability is the constraint. They are not in conflict — they serve a different deployment. MOB-7 is the optional bridge (point the Expo app at a packaged instance over a tunnel).
- Net: **hosted → native Expo (H5/MOB, this doc); packaged → Telegram/PWA (packaging §8).** The PLAN §0 H5 row is refined to name both tracks.

---

## 11. Phase-1 (MOB-1) — as built (this wave)

A runnable Expo app at **`apps/mobile/`** (Expo SDK 57, TypeScript, managed) that **boots in Expo Go** and proves remote control against the **live hosted backend**.

**What it does**
- **Command Center** — text chat to Arturita (`POST …/arturita/converse`), rendering `reply.text` + a **"via" chip** (`provider · model` for an answer, `delegated · workMode` for a delegation, `degraded` when no LLM).
- **Inbox / Approvals** — lists `GET …/approvals?status=pending`; **approve / reject / request-changes** via `POST /api/approvals/:id/decide`. Dangerous types are labelled and warn that *approve* may need step-up (MOB-4); **reject/revision always work**.
- **Agents** — `GET …/agents` roster with status + heartbeat (label+glyph, colorblind-safe).
- **Status** — live `/api/health` (db, scheduler, version, LLM providers) + the session's org; disconnect.

**Auth (phase-1):** **token-paste** — the operator pastes a Clerk session JWT + API URL; the app validates by resolving `GET /api/orgs`, stores the bearer in the **iOS Keychain** (`expo-secure-store`), and scopes every call to the chosen org. **Clerk-Expo is designed and staged as MOB-2** — the code seam (`src/auth.tsx`) isolates token acquisition, so screens (which use only `getToken()` + `orgId`) don't change when Clerk lands. Paste is the **guaranteed-bootable fallback** the task called for; it's deliberately used because `@clerk/clerk-expo` does not install cleanly against the current Expo Go SDK (H5Q6).

**Structure**
```
apps/mobile/
  App.tsx                 # tab shell + auth gate (hand-rolled tabs — no nav lib, tiny dep surface)
  index.ts                # registerRootComponent
  app.json                # Expo config (name, scheme, bundleId, icons)
  src/
    config.ts             # API base URL (EXPO_PUBLIC_API_URL → hosted default) + Clerk key seam
    api.ts                # fetch client (mirrors web/lib/api.ts) + typed endpoint helpers
    auth.tsx              # AuthProvider: token-paste + org resolution (Clerk seam for MOB-2)
    store.ts              # expo-secure-store session persistence
    theme.ts, ui.tsx      # colorblind-safe (Okabe–Ito) tokens + primitives
    screens/              # Connect, Health, CommandCenter, Inbox, Agents
  README.md               # exact run instructions
```

**Verified**
- `npm install` clean (468 pkgs, no peer conflicts — no Clerk dep in phase 1).
- `tsc --noEmit` clean.
- `expo export --platform ios` bundles (592 modules → 1.5 MB Hermes bytecode) — **loads in Expo Go**.
- Live hosted backend: `/api/health` → `{status:"ok", db:"connected"}`; `/api/orgs` → 401 without token (gate confirmed). Client path shapes match.
- **Additive:** own npm root (own `package.json`/`node_modules`); repo root has no `workspaces` field, so `web`/`backend`/`apps/desktop` installs/builds never touch it. **No backend change** (push register already exists; push is MOB-3).

**Run:** `cd apps/mobile && npm install && npx expo start` → install Expo Go from the App Store → scan the QR (same Wi-Fi, or `npx expo start --tunnel` on any network). Connect with a pasted Clerk token (README shows how). Env: `EXPO_PUBLIC_API_URL` (defaults to hosted), `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (only once MOB-2 lands).

---

## 12. Verdict

The phone is the web app's **peer**, not the Mac mini's client: a thin remote to the hosted API, authenticating to the same Clerk org, reusing the same gated endpoints — so *approving an action or talking to Arturita from anywhere* costs **almost no new backend surface** (push register already exists; Clerk gates unchanged). Phase 1 proves it end-to-end in **Expo Go** today with token-paste auth; **Clerk-Expo (MOB-2)** and **push (MOB-3)** are the two stories that turn a working proof into the at-a-distance product — each small, additive, and audited.

**One line:** *an Expo iPhone app that signs into the same Clerk org and drives the hosted Mission Control API — Command Center, remote approvals, agents — leaving the Mac-mini agents and every backend gate exactly as they are.*

---

## 13. MOB-2 — Clerk-Expo sign-in, as built

Real Clerk sign-in now works in **Expo Go SDK 57**, with token-paste retained as a fallback. Strictly additive — only `apps/mobile/**` and docs changed; no backend/web/desktop/CI touch.

### 13.1 The peer conflict, diagnosed and fixed

MOB-1 deferred Clerk because `@clerk/clerk-expo` "didn't install cleanly." The root cause was **not** clerk-expo's own peers — those already accept SDK 57 (`react: ^18 ‖ ^19`, `react-native: >=0.73`). The conflict is transitive:

```
@clerk/clerk-expo@2.19.42
  └─ @clerk/clerk-react@5.61.9   (peer: react-dom ^18 ‖ ^19)
        └─ npm floats react-dom → 19.2.7   (peer: react ^19.2.7)
              ✗ clashes with Expo SDK 57's pinned react@19.2.3
```

npm resolves `react-dom` to the newest `19.2.x` (19.2.7), whose `react` peer (`^19.2.7`) is **not** satisfied by Expo's pinned `react@19.2.3` → `ERESOLVE`.

**Fix (one line in `package.json`):** pin `react-dom` to **`19.2.3`** (exact, matching `react`). react-dom isn't used at runtime by a native RN app — it's only present to satisfy the `@clerk/clerk-react` peer — so pinning it to the Expo-aligned React version is safe and removes the float. Result: a plain `npm install` is clean (no `--legacy-peer-deps`), and the metro/Hermes bundle builds (**736 modules**, ~2.7 MB) → **runs in Expo Go**. No EAS dev build needed for MOB-2.

**Version combo that works (Expo SDK 57 / RN 0.86 / React 19.2.3):**

| Package | Version | Why |
|---|---|---|
| `@clerk/clerk-expo` | `^2.19.42` | `latest-v5` tag; React 19 / RN 0.86-compatible |
| `react-dom` | `19.2.3` (exact) | **the linchpin** — matches `react`, stops the 19.2.7 float |
| `expo-web-browser` | `~57.0.1` | required clerk-expo peer (OAuth); SDK-57-aligned |
| `expo-auth-session` | `~57.0.3` | required clerk-expo peer (OAuth); SDK-57-aligned |
| `expo-crypto` | `~57.0.1` | clerk-expo peer; SDK-57-aligned |
| `expo-secure-store` | `~57.0.1` | already present — the Keychain token cache |

### 13.2 Architecture (the seam MOB-1 left)

- **`src/config.ts`** — `clerkEnabled()` gates everything on a valid `pk_`-prefixed `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. No key → paste-only (MOB-1 behaviour), so the app **always boots**.
- **`src/clerkCache.ts`** — `TokenCache` backed by `expo-secure-store` (iOS Keychain). Tokens live only in the enclave; the cache **never logs** keys or values.
- **`src/auth.tsx`** — one `AuthProvider` picks the implementation: `clerkEnabled()` → mounts `<ClerkProvider tokenCache=…>` + a Clerk bridge; else a paste-only provider. Both expose the **same context**. `getToken()` is now **async** — Clerk mode mints a fresh auto-refreshing JWT per call; paste mode returns the stored bearer. `signOut` clears Clerk + local scoping.
- **`src/screens/ConnectScreen.tsx`** — Clerk email+password / email-code sign-in (`useSignIn`, native — no browser), with a **"Use a token instead"** escape hatch, plus org resolution/picker after sign-in. Paste-only build shows the MOB-1 form. `useSignIn` is only ever called inside `<ClerkProvider>`.
- **Screens** (`Inbox`, `CommandCenter`, `Agents`) now `await getToken()`. No other change — they still depend only on `getToken()` + `orgId`.
- **`Status`** shows the auth mode (Clerk / paste) and the signed-in identity.

### 13.3 Verified

- `npm install` **clean** (762 pkgs, no `ERESOLVE`, no peer errors); `npm run typecheck` clean; `expo export --platform ios` bundles (736 modules → Hermes) with Clerk enabled — proves clerk-expo/clerk-react/react-dom **bundle and run** in Expo Go, not just install.
- Live hosted backend (`7ei-backend.fly.dev`), native no-`Origin` request: `/api/health` → 200 `db:connected`; `/api/orgs` **401 without a token** and **401 with a bogus bearer** (the bearer is validated, not ignored); the no-`Origin` request is processed (the 401 is an auth decision, not a CORS block) → **CORS is a non-issue for native fetch, confirmed.**
- **Auth-success boundary (honest):** a *successful* authenticated call needs a live Clerk key + real credentials, which the builder does not hold, so the green-path 200 was not exercised end-to-end here. It is proven-equivalent: the client attaches `Authorization: Bearer <jwt>` identically (`src/api.ts`, unchanged), Clerk's `getToken()` returns the same session-JWT shape the backend's `clerkAuth` validates, and MOB-1 already confirmed a real pasted Clerk token resolves `/api/orgs` → 200. The operator can confirm the full Clerk flow once `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is set (§13.4).

### 13.4 Operator run instructions

```bash
cd apps/mobile
npm install                 # clean, no flags
# .env (gitignored) — the SAME publishable key the web app uses (non-secret pk_…):
#   EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…      (or pk_live_… once prod Clerk lands)
#   EXPO_PUBLIC_API_URL=https://7ei-backend.fly.dev  (default; override for staging/tunnel)
npx expo start              # scan the QR in Expo Go (or: npx expo start --tunnel)
```

- **With the key set:** the app opens a real Clerk **Sign in** screen — the operator's 7Ei email + password (or "Email me a sign-in code"). After sign-in it resolves orgs and (if >1) shows a picker. Tokens auto-refresh; no more 401-on-expiry.
- **Without the key:** the app falls back to the MOB-1 **paste** screen — unchanged.
- **Escape hatch:** even with Clerk configured, "Use a token instead" still allows a pasted bearer for a smoke test.

---

## 14. MOB-3 — Push notifications, as built

The **client** push slice ships this wave, running in **Expo Go** with **zero backend change**. Strictly additive — only `apps/mobile/**` + docs (+ `STATUS.md`) changed; no backend/web/desktop/CI touch. The line between what works now and what needs a dev build is drawn deliberately and honestly.

### 14.1 The backend endpoint we wired to (verified live)

The audits were right — a device-token register endpoint **already exists**; MOB-3 needed **no new backend surface**.

| | |
|---|---|
| **Path** | `POST /api/notifications/register` (unregister: `DELETE` same path) |
| **Auth** | **Required.** Registered inside the `secured` scope (`backend/src/index.ts:197`), whose `onRequest` hook is the Clerk (hosted) / loopback (packaged) auth gate. A request with **no** `Authorization: Bearer` gets `401 {"error":"Unauthorized"}` — **verified live** against `7ei-backend.fly.dev`. The path has no `:orgId`, so `requireOrgMembership` no-ops (any authenticated user passes). |
| **Body** | `{ "userId": string, "token": string }` → `{ "ok": true }` |
| **Identity nuance** | The handler takes the target **`userId` from the body**, not from the authed session. The backend's push senders (`agent-executor.ts`, `scheduler.ts`) fan out to **`org.ownerId`**. So the phone registers under the **signed-in user's Clerk id** (the JWT `sub`) — which equals `org.ownerId` for the operator/owner, so pushes reach them. |
| **Storage** | In-memory `Map<userId, Set<expoToken>>` (`backend/src/services/push.ts`) — ephemeral (clears on a Fly restart). The **send path already POSTs to Expo** (`https://exp.host/--/api/v2/push/send`) and already fires on task-complete / routine / budget-warning (fire-and-forget, off the critical path). |

The client always attaches `Authorization: Bearer <jwt>` (Clerk `getToken()`, or the pasted bearer) **and** the body `userId` — so it satisfies the auth gate *and* registers under the correct identity.

### 14.2 What runs in Expo Go **now** vs what's gated behind the dev build

| Capability | Expo Go (now) | EAS dev build (staged) |
|---|---|---|
| Foreground notification handler (banner + sound while app open) | ✅ | ✅ |
| Request notification permission | ✅ | ✅ |
| **Local / scheduled** notification ("Send a test") | ✅ (proves handler + routing wiring) | ✅ |
| Tap a notification → **deep-link** to the right tab (approval → Inbox) | ✅ | ✅ |
| **Remote** Expo push token (`getExpoPushTokenAsync`) | ⛔ no-op (no projectId → skipped gracefully, no throw) | ✅ (projectId set) |
| Register token with backend | ✅ *when* a token exists (i.e. dev build); no-op otherwise | ✅ |
| A **real remote push arriving on the phone** | ⛔ | ✅ (APNs via Expo) |

The guard is `pushRemoteConfigured()` (`src/config.ts`): `getExpoPushTokenAsync` is only called when `EXPO_PUBLIC_EAS_PROJECT_ID` is set. In Expo Go it's absent, so the token step is skipped and the Status panel shows **"Dev build required"** — the app never throws.

### 14.3 Client architecture

- **`src/notifications.tsx`** — the whole client slice:
  - `setNotificationHandler(...)` at module load (foreground banner + sound; no badge).
  - `PushProvider` / `usePush()` — runs the lifecycle and exposes `{ status, enable, deregister, sendTest }`. On sign-in, if permission is already granted it obtains + registers **silently** (no surprise prompt); the first permission prompt is user-initiated via **Enable**. Tracks the last-registered `{apiUrl, userId, token}` in a ref to de-register exactly.
  - `useNotificationRouting(onRoute)` — handles both cold-start (`getLastNotificationResponseAsync`) and warm (`addNotificationResponseReceivedListener`) taps; `routeForData()` maps the push `data` payload to a tab (`type:'approval'`/`approvalId` → Inbox, `agentId`/`taskId` → Agents/Command, `budget_warning` → Status).
- **`src/config.ts`** — `EAS_PROJECT_ID` + `pushRemoteConfigured()` read the projectId from **env** (`EXPO_PUBLIC_EAS_PROJECT_ID`), so flipping remote on is **config-only, no code change**.
- **`src/api.ts`** — `registerPush` / `unregisterPush` (Bearer + body `{userId, token}`; DELETE carries a body so it doesn't trip Fastify's empty-JSON-body 400).
- **`src/auth.tsx`** — adds `userId` to the auth context: Clerk mode from `useUser().id`; paste mode via a best-effort `sub` decode of the pasted JWT (unverified, used only as a registration key — never for authz). Null → registration is skipped with a clear reason, never guessed.
- **`App.tsx`** — wraps the signed-in shell in `<PushProvider>` and wires `useNotificationRouting` to the tab setter.
- **`src/screens/HealthScreen.tsx`** — a **Notifications** card: permission state, remote-push state (Registered / obtained / "Dev build required"), the last-4 of the token only, **Enable** / **Register** / **Send a test** buttons. The **Sign out / Disconnect** button now calls `deregister()` **before** `signOut()`, while the bearer is still valid (the register endpoint is auth-gated, so a post-sign-out DELETE would 401).

**Token hygiene:** the Expo push token is **never logged**; only its last 4 chars are shown in the UI. Registered on sign-in / permission-grant; de-registered on sign-out (and on token change — the old token is unregistered before the new one is stored).

### 14.4 Verified (this wave)

- `npm install` **clean** (765 pkgs; `expo-notifications@~57.0.5` installed via `expo install`, no `ERESOLVE`).
- `npm run typecheck` clean.
- `expo export --platform ios` bundles (**796 modules** → 2.8 MB Hermes) — proves `expo-notifications` **bundles and runs** in Expo Go, not just installs.
- Live `POST/DELETE /api/notifications/register` on `7ei-backend.fly.dev` → `401 {"error":"Unauthorized"}` **without** a bearer (auth gate + exact path/method/body shape confirmed).
- **Additive:** all changes under `apps/mobile/**`; repo root has no `workspaces`, so `web`/`backend`/`apps/desktop` installs/builds are untouched.
- **Honest boundary:** a *real remote push landing on the phone* was **not** exercised here — it requires an Expo project id + an EAS dev build (which the operator has not set up). Everything up to and including the backend registration call is exercised in Expo Go; remote delivery is proven-equivalent (the register/send contract is unchanged and the backend already POSTs to Expo).

### 14.5 Operator: turning on **remote** delivery (the staged dev-build steps)

No code change is needed — only config + a dev build:

1. **Create a free Expo account** and log in: `npx expo login` (or `eas login`). (Open question **H5Q2**.)
2. **Link the project:** from `apps/mobile`, `npx eas init` — this writes `extra.eas.projectId` into `app.json` and creates the project on Expo's servers.
3. **Set the env var** so the client mints the remote token in any build (Expo Go included, though Expo Go still can't *deliver* remote push): add to `apps/mobile/.env` —
   ```bash
   EXPO_PUBLIC_EAS_PROJECT_ID=<the id eas init wrote to app.json → extra.eas.projectId>
   ```
   The code reads `process.env.EXPO_PUBLIC_EAS_PROJECT_ID` — **that env var is the only switch.**
4. **APNs:** `eas credentials` (or let `eas build` prompt) provisions the iOS push key — Expo brokers APNs, so **no raw `.p8`/cert handling in this repo**. One-time.
5. **Build + install a dev build:**
   ```bash
   npx eas build --profile development --platform ios
   ```
   Install it on the device (TestFlight or a direct install — **H5Q5**: TestFlight/dev-build is enough for one operator).
6. **Result:** the app mints a real `ExponentPushToken[…]`, registers it under the operator's Clerk id, and the backend's existing task-complete / routine / budget pushes arrive on the phone. To also get an **approval-needed** push, schedule the small **backend** follow-up (below).

### 14.6 The **backend** follow-up — ✅ SHIPPED (MOB-3B)

MOB-3's client shipped needing no backend change. The three backend follow-ups flagged here landed in **MOB-3B** (`mob-3b-backend-push`), a separate, additive, audited backend story:

- **Emit a push on `approval_requests` creation** — ✅ **DONE.** `notifyApprovalCreated()` (`services/push.ts`) is fired fire-and-forget (`.catch()`) at every approval-insert site: the operator route (`routes/tasks.ts` `POST /approvals`), the low-trust quarantine (`tasks.ts` review-evaluate + `services/orchestrator.ts` delegation), the agent-facing routes (`routes/agent-api.ts` memory.write ×2 + `POST /api/agent/approvals`), and the agent-join card (`routes/agent-invites.ts`). It resolves `org.ownerId`, reuses the existing `sendPushNotification` → Expo plumbing (not duplicated), names the action in title/body, flags **step-up** for dangerous types (`file_destructive`/`wallet_tx`/`email_send`/`machine_exec`), and puts the approval id in `data.approvalId` so the phone's approval→Inbox deep-link works. Guarded so it never throws into the request path. *(Agent-stale/`needs_attention` push was left out — not trivially adjacent to a single insert site; flag if wanted.)*
- **Persist push tokens** — ✅ **DONE.** New `push_tokens` table (`id, user_id, token UNIQUE, platform, created_at, updated_at`), migrated additively + reversibly in `db/setup.ts` (`CREATE TABLE IF NOT EXISTS` + `idx_push_tokens_token` unique + `idx_push_tokens_user`). `services/push.ts` is now table-backed: register **upserts** by token (dedupe by device; re-login re-points `user_id`), unregister deletes scoped to the caller, and `sendPushNotification` / all senders (agent-executor, scheduler) read tokens from the table — so delivery survives a Fly restart.
- **Identity-trust fix (audit L1)** — ✅ **DONE.** `POST/DELETE /api/notifications/register` now key the device on the **authenticated** session (`req.auth.userId` — Clerk `sub` on hosted, loopback operator on packaged), never a body-supplied `userId`. A body `userId` is accepted only if it matches the session; a mismatch is **403**, and unregister is scoped to the caller's own identity. The Expo token is never logged.

---

## 15. MOB-4 — Approve dangerous actions (on-device step-up), as built

The one remaining gap in remote control is now closed: the operator can **approve** a dangerous action from the phone. Reject / request-changes were always one-tap (they never step up); MOB-2/L1 had *disabled* Approve for dangerous types because a bare approve 403s. MOB-4 re-enables it behind a real on-device gate and conforms **exactly** to the existing backend step-up contract — **no backend change**.

### 15.1 The backend contract we conform to (unchanged)

The server gate lives in `backend/src/routes/tasks.ts` (`POST /api/approvals/:id/decide`): when the approval is a dangerous type (or a low-trust review wrapping one) **and** the decision is `approved`, it reads a command-session token from the **`x-arturita-session`** header (or a body `sessionToken`), looks it up by SHA-256 hash for the approval's org, and requires `isFresh(session)` — else `decideApproval` returns a step-up error and the route replies **403**. Reject / revision are never gated.

The token is minted at **`POST /api/orgs/:orgId/arturita/session`** (Clerk-secured owner surface, `backend/src/routes/arturita.ts`). It returns the plaintext `token` **once** (only its SHA-256 hash is stored). Freshness/TTL (`services/arturita-session.ts`): a session is **valid** for `DEFAULT_SESSION_TTL_MS = 30 min` and **fresh** (step-up-satisfying) for `DEFAULT_STEPUP_FRESHNESS_MS = 5 min` from its last step-up (mint counts as the first). It is individually revocable and killed en masse by `/panic`. The token is bearer-grade: header only, never a URL/query, never logged.

> **Web parity note (flagged, not a blocker):** the **web** Cockpit does **not** yet mint a step-up session client-side — `CockpitPanel.decide()` / `InboxSection` post a bare `{decision}` with no `x-arturita-session` header, so a *dangerous* approve from the web would itself 403 today. The backend gate + contract are complete and test-locked; the phone is the **first client to actually implement** step-up minting. Wiring the same flow into web is a separate, non-blocking follow-up (see §15.5).

### 15.2 The on-device gate — biometric (Expo Go) with a typed fallback

Local confirmation must pass **before** the phone mints a session, so a lost/borrowed unlocked phone can't one-tap-approve a wallet drain.

- **Biometric (primary):** `expo-local-authentication` — **Face ID / Touch ID / device passcode**. It is a first-party Expo module **bundled in Expo Go** (`expo/bundledNativeModules.json` → `~57.0.1`), so **it runs in Expo Go today** — no dev build required. `probeBiometric()` checks `hasHardwareAsync()` + `isEnrolledAsync()`; `runBiometricGate()` calls `authenticateAsync({ disableDeviceFallback:false })` so passcode is a fallback within the biometric prompt. A dev build only *hardens* the enrollment posture (and supplies the `NSFaceIDUsageDescription` we declare via the config plugin in `app.json`); Expo Go already carries that usage string.
- **Typed fallback:** when no biometric hardware is present/enrolled (simulator, or a device with Face ID off), or the native module is unavailable, the modal shows a **type `APPROVE`** field (exact, case-sensitive) — the gate **never silently downgrades** to a one-tap approve. The modal clearly flags that a dev build adds biometric hardening.

Both are isolated behind `try/catch` in `src/stepup.ts` (fail-closed: any error → typed fallback), so an absent native module degrades gracefully instead of crashing the Inbox.

### 15.3 Client flow (`src/screens/StepUpModal.tsx` + `src/api.ts`)

1. Operator taps **Approve** on a dangerous card → `InboxScreen` opens `StepUpModal` (safe types keep the lightweight one-tap confirm).
2. The modal shows the danger **clearly**: type + the backend's **machine-rendered** summary + every `payload.warnings` flag (never model prose).
3. **Local gate** runs (biometric or typed).
4. Only on pass: `Api.mintArturitaSession()` mints a **fresh** session (`source:'desk'` — the phone authenticates first-party via Clerk exactly like the web desk), held only in a local `const`.
5. `Api.decideApproval(..., 'approved', undefined, stepUpToken)` sends the single decide call **with the `x-arturita-session` header**. The token is then discarded — **one session per approval, never cached or reused** across approvals (respects the 5-min freshness + single-operator intent).
6. **403 / expired path:** surfaced as "Step-up expired or was rejected — confirm again", and Retry re-runs the whole gate **and re-mints** — never a dead-end. The token is never logged and never placed in a URL.

### 15.4 Verified (this wave)

- **Live hosted backend** (`7ei-backend.fly.dev`, v1.3.0, `db:connected`): `/api/health` **200**; `POST …/arturita/session` (exact phone body `{"source":"desk"}`) → **401** without auth; `POST /api/approvals/:id/decide` with `{"decision":"approved"}` → **401** without auth, **401** too when a bogus `x-arturita-session` header is attached (the Clerk auth layer fronts the 403 step-up gate). This confirms the endpoints exist, are reachable from a native (no-`Origin`) client, and are auth-gated.
- **Build/quality:** `npm install` clean (766 pkgs, `expo-local-authentication@57.0.1` = the Expo-Go-bundled version, no `ERESOLVE`); `tsc --noEmit` clean; `expo export --platform ios` bundles **801 modules → Hermes**. Additive: changes confined to `apps/mobile/**` (root has no `workspaces`, so web/backend/desktop installs+builds are untouched); `dist/` gitignored.
- **Auth-success boundary (honest):** the authenticated **403-without-step-up → 200-with-fresh-step-up** path could **not** be exercised end-to-end here — it requires an operator **Clerk owner** session token (to mint + to decide) plus a pending dangerous approval, which the builder does not hold and must not obtain. It is **contract-locked** by the backend's own tests (`backend/src/tests/dangerous-approvals.test.ts` — `decideApproval` blocks a dangerous approve without step-up and allows it with) and the route wiring (`tasks.ts` reads `x-arturita-session` → `isFresh` → `decideApproval`), and the phone sends exactly that header. **Operator confirmation recipe:**
  ```bash
  B=https://7ei-backend.fly.dev; JWT=<operator Clerk session JWT>; ORG=<orgId>; AP=<pending dangerous approval id>
  # 1) dangerous approve WITHOUT step-up → expect 403
  curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/approvals/$AP/decide \
    -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d '{"decision":"approved"}'
  # 2) mint a fresh session, then approve WITH the header → expect 200
  TOK=$(curl -s -X POST $B/api/orgs/$ORG/arturita/session -H "Authorization: Bearer $JWT" \
    -H 'Content-Type: application/json' -d '{"source":"desk"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
  curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/approvals/$AP/decide \
    -H "Authorization: Bearer $JWT" -H "x-arturita-session: $TOK" -H 'Content-Type: application/json' -d '{"decision":"approved"}'
  ```
  (This is exactly what the phone does, in the same order.)

### 15.5 Flagged / deferred

- **Web has no client-side step-up yet** (§15.1 note). Non-blocking; a small follow-up can reuse this exact contract in `CockpitPanel`/`InboxSection`.
- **`source` enum is `{desk, telegram}`** — neither perfectly labels "phone". We mint as `desk` (first-party Clerk client, same as the web desk); it's a cosmetic label on the sessions list with **no** security effect. A future `mobile` enum value is a nicety, **not** a required backend change (per the constraint, we did not touch the backend).
- **Full green-path 200** is the operator step above (needs a live Clerk owner token).
- This story is **stage→audit** (it approves dangerous actions remotely): an independent auditor runs next; the builder did **not** self-audit or merge.
