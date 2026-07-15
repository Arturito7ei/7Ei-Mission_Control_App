# `apps/desktop` — Mission Control desktop shell (Epic H · H0 spike)

> **Status: H0 de-risk spike.** This proves the *bundling approach* end-to-end —
> an Electron shell that boots the **packaged/loopback** Mission Control mesh
> (Fastify backend + Next.js UI) on a **local file database** as ONE app. It is
> the seed for H1, not throwaway. It is **not** signed, and **not** security-
> complete: the packaged profile here runs with an **auth bypass** (no Clerk
> keys). Real single-operator loopback auth is **H6**.

## What it does

On launch, `src/main.cjs` (the Electron main process) supervises:

1. **Fastify backend** — forked as a child of Electron's own Node
   (`ELECTRON_RUN_AS_NODE=1` + `--import tsx`), with:
   - `MC_DEPLOYMENT_PROFILE=packaged`
   - `DATABASE_URL=file:<userData>/mc.db` (a local libSQL file; migrations run on boot)
   - bound to `127.0.0.1:8787`
2. **Next.js UI** — forked from its `standalone` server build, `127.0.0.1:8788`,
   built with `NEXT_PUBLIC_API_URL` baked to the loopback backend.
3. A **BrowserWindow** pointed at the local Next server once `/api/health` is green.

Everything binds `127.0.0.1` — loopback is the trust boundary of `packaged`.

## Commands

```bash
cd apps/desktop
npm install            # electron + electron-builder (first time)

npm run desktop        # DEV: build the web standalone, then launch Electron
                       #      against the repo backend (tsx) + repo web build
npm run pack:mac       # BUILD: unsigned .app only        → dist/mac-arm64/
npm run dist:mac       # BUILD: unsigned .app + .dmg       → dist/
```

The built app launches with **no dev toolchain** on the host: `tsx`, the backend
source, its `node_modules` (incl. the libSQL native addon), and the Next
standalone server are all shipped inside `Contents/Resources/` (unpacked, outside
`asar`).

## The one landing route

The window opens the **landing page** (`/`) — it renders without Clerk. The
`/dashboard` route uses Clerk hooks and needs the H6 loopback identity, so it is
out of scope for this spike (it would white-screen without auth).

## Not in this spike (later Epic H stories)

- Signing + notarization (**H1** — blocked on the Apple Developer account)
- Tray/menubar, dynamic ports (**H1**)
- First-run TCC permission wizard (**H2**)
- Auto-update (**H3**)
- Config/secret bootstrap + per-install Keychain keys (**H4**)
- Real single-operator loopback auth + fail-closed-on-default-key (**H6**)

## Adding signing later (H1) is a config addition, not a rearchitecture

`electron-builder.yml` is structured so H1 flips `identity`/`hardenedRuntime`,
adds an entitlements plist + a `notarize` block, and provides the Developer-ID
cert + notarytool credential. Nothing in `main.cjs` or the staging step changes.
