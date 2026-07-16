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
4. In the app, **sign in** — two paths:
   - **Clerk (recommended, MOB-2)** — set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (below)
     and the app shows a real **Sign in** screen: your 7Ei email + password, or
     "Email me a sign-in code". Same account as the web dashboard; tokens
     auto-refresh, so no more 401-on-expiry. After sign-in, pick your org if you
     belong to more than one.
   - **Token paste (fallback / escape hatch)** — with no Clerk key set, the app
     shows a paste screen; or tap **"Use a token instead"** under the Clerk form.
     Paste a Clerk session token from the web dashboard (`app.7ei.ai`) — in the
     browser devtools console:
     ```js
     await window.Clerk.session.getToken()
     ```
     Leave **API URL** as `https://7ei-backend.fly.dev` (the default).

You're now driving the hosted backend from your phone.

> **Token lifetime.** A *pasted* Clerk session token is short-lived (~1 min) — fine
> for a smoke test; re-paste if a call 401s. **Clerk sign-in avoids this entirely**
> (auto-refresh). Prefer it.

## Configuration (env)

`EXPO_PUBLIC_*` vars are read at bundle time. Create `apps/mobile/.env` (gitignored):

```bash
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…            # SAME key as the web app → enables Clerk sign-in
EXPO_PUBLIC_API_URL=https://7ei-backend.fly.dev        # backend base URL (default)
```

- **`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`** — the same publishable key the web app
  uses (`pk_test_…` on the dev instance, `pk_live_…` once production Clerk lands).
  Publishable keys are **non-secret** (they ship in the web bundle already), so
  it's fine to inline into the Expo bundle. When present, Clerk becomes the primary
  sign-in; when absent, the app falls back to token-paste and still boots.
- Nothing here is a secret. The session token is stored in the iOS Keychain via
  `expo-secure-store` (Clerk's token cache in Clerk mode; the pasted bearer in
  paste mode) — never in the bundle, never logged.

## Scope / limits (honest)

- **Auth: real Clerk sign-in (MOB-2)** with token-paste kept as a fallback. The
  SDK-57 peer conflict is resolved by pinning `react-dom@19.2.3` (see
  `docs/DESIGN-mobile-expo.md` §13) — a plain `npm install` is clean, no dev build.
- **Approving a *dangerous* action** (`file_destructive`, `wallet_tx`,
  `email_send`, `machine_exec`) needs a step-up session token this client doesn't
  mint yet → the **Approve button is disabled** on those with a clear "needs
  step-up (MOB-4)" note. **Reject / request-changes always work**, so the remote
  *stop* is reliable. On-device step-up = MOB-4.
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
