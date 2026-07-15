# 7Ei Mission Control — iPhone remote (Expo)

A **thin remote control** for Mission Control that runs on your iPhone. It talks to
the **hosted backend** (`https://7ei-backend.fly.dev`) — the same REST API the web
dashboard uses. Your Mac-mini agents keep reporting to the hosted backend as
always; the phone just reads and controls through that same API. **The phone does
not connect to your Mac mini.**

> Full architecture, auth model, feature roadmap, and the phased story plan:
> [`docs/DESIGN-mobile-expo.md`](../../docs/DESIGN-mobile-expo.md).

## What phase 1 does (runs in Expo Go)

- **Command Center** — text chat to Arturita (`POST …/arturita/converse`); renders
  the reply and a **"via" chip** (which provider/model answered, or that it was
  delegated to a task).
- **Inbox / Approvals** — lists pending dangerous-action approvals and lets you
  **approve / reject / request-changes** from the phone (the killer remote feature).
- **Agents** — the roster with status + heartbeat (read-only).
- **Status** — live connection + backend health.

Colorblind-safe: every status carries a label + glyph, never hue alone.

## Run it (≈2 minutes)

1. **Install Expo Go** on your iPhone (App Store) — it must be the current version
   (this app targets Expo SDK 57).
2. In this repo:
   ```bash
   cd apps/mobile
   npm install
   npx expo start
   ```
3. **Same Wi-Fi** as your Mac → scan the QR in the Expo Go app (iOS: scan with the
   Camera app, it opens Expo Go). **Different networks / locked-down Wi-Fi** → use a
   tunnel:
   ```bash
   npx expo start --tunnel      # or: npm run start:tunnel
   ```
4. In the app, **Connect**:
   - **Bearer token** — paste a Clerk session token from the web dashboard
     (`app.7ei.ai`). In the browser devtools console on the dashboard:
     ```js
     await window.Clerk.session.getToken()
     ```
     Copy the printed string into the app.
   - **API URL** — leave as `https://7ei-backend.fly.dev` (the default).
   - Tap **Connect**. If you belong to more than one org, pick one.

You're now driving the hosted backend from your phone.

> **Token lifetime.** A raw Clerk session token is short-lived (~1 min). That's
> fine for a smoke test; re-paste if a call 401s. Real, auto-refreshing sign-in is
> **Clerk-Expo** (story MOB-2) — see the design doc.

## Configuration (optional env)

`EXPO_PUBLIC_*` vars are read at bundle time. Create `apps/mobile/.env` (gitignored)
to override defaults:

```bash
EXPO_PUBLIC_API_URL=https://7ei-backend.fly.dev        # backend base URL
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…            # only needed once MOB-2 lands
```

Nothing here is a secret — `EXPO_PUBLIC_*` values are inlined into the JS bundle.
The bearer token is stored in the iOS Keychain via `expo-secure-store`, never in the
bundle.

## Scope / phase-1 limits (honest)

- **Auth is token-paste**, not Clerk-Expo — deferred to MOB-2 because
  `@clerk/clerk-expo` does not yet install cleanly against the current Expo Go SDK
  (57 / RN 0.86 / React 19.2). Screens depend only on `getToken()` + `orgId`, so
  Clerk slots in without touching them.
- **Approving a *dangerous* action** (`file_destructive`, `wallet_tx`,
  `email_send`, `machine_exec`) needs a step-up session token this client doesn't
  mint yet → **approve may 403 with a clear message**. **Reject / request-changes
  always work**, so the remote *stop* is reliable. Step-up on mobile = MOB-4.
- **No push notifications** yet (P1 / MOB-3). **No voice** yet (MOB-5, needs a dev
  build for background audio). Both are designed in the doc.
- **Expo Go only** — no native modules that would require an EAS dev build.

## Stays out of the other builds

`apps/mobile` is its **own npm project** (own `package.json`, own `node_modules`).
The repo root has no `workspaces` field, so `npm install`/`build` in `web/`,
`backend/`, or `apps/desktop/` never touch it. Purely additive.

## Commands

```bash
npm run start          # expo start (LAN QR)
npm run start:tunnel   # expo start --tunnel (any network)
npm run typecheck      # tsc --noEmit
npm run export         # metro bundle for iOS (CI/verification)
```
