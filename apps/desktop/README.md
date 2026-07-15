# `apps/desktop` — Mission Control desktop shell (Epic H · H1)

> **Status: H1 — production-quality build pipeline, up to the Apple-cert gate.**
> An Electron shell that boots the **packaged/loopback** Mission Control mesh (a
> **compiled** Fastify backend + the Next.js UI) on a **local file database** as
> ONE app, packaged as a release-quality but **UNSIGNED** `.app`/`.dmg`. Signing +
> notarization are fully **wired but inert** until the operator supplies an Apple
> Developer ID (H-Q1/H-Q2).
>
> It is **not** security-complete: the packaged profile still runs with the
> temporary **auth bypass** (no Clerk keys). Real single-operator loopback auth is
> **H6**.

## What it does

On launch, `src/main.cjs` (the Electron main process) supervises:

1. **Fastify backend** — forked as a child of Electron's own Node
   (`ELECTRON_RUN_AS_NODE=1`), with:
   - `MC_DEPLOYMENT_PROFILE=packaged`
   - `DATABASE_URL=file:<userData>/mc.db` (a local libSQL file; migrations run on boot)
   - bound to `127.0.0.1:8787`
   - **packaged:** runs the **compiled** `backend/index.js` (esbuild bundle) —
     no `tsx`, no TS source, no dev toolchain. **dev (`npm run desktop`):** runs
     the repo TS source via `--import tsx` for parity + fast iteration.
2. **Next.js UI** — forked from its `standalone` server build, `127.0.0.1:8788`,
   built with `NEXT_PUBLIC_API_URL` baked to the loopback backend.
3. A **BrowserWindow** pointed at the local Next server once `/api/health` is green.

Everything binds `127.0.0.1` — loopback is the trust boundary of `packaged`.

## How the backend is compiled (H1)

`scripts/build-desktop.mjs` bundles `backend/src/index.ts` with **esbuild** into a
single tree-shaken ESM `index.js` (Fastify + drizzle-orm + @clerk/* + zod +
@anthropic-ai/sdk + redis, all inlined), and keeps external ONLY the two packages
that carry native/wasm payloads that must load from a real path:

- `@libsql/client` → `@libsql/darwin-arm64/*.node` (the DB native addon)
- `officeparser` → `tesseract.js` / `pdfjs-dist` / `@napi-rs/canvas` (OCR/PDF)

Those two are re-installed as a minimal, **pinned**, prod-only `node_modules`
beside the bundle, so their transitive closure (incl. platform natives) is exact.
This replaces H0's wholesale `node_modules` + `tsx` copy — see the size table below.

## Commands

```bash
cd apps/desktop
npm install            # electron + electron-builder + esbuild (first time)

npm run desktop        # DEV: build the web standalone, then launch Electron
                       #      against the repo backend (tsx) + repo web build
npm run pack:mac       # BUILD: unsigned .app only        → dist/mac-arm64/
npm run dist:mac       # BUILD: unsigned .app + .dmg       → dist/
```

The built app launches with **no dev toolchain** on the host: the compiled backend
bundle + its pruned native `node_modules` and the Next standalone server all ship
inside `Contents/Resources/` (unpacked, outside `asar`).

## The one landing route

The window opens the **landing page** (`/`) — it renders without Clerk. The
`/dashboard` route uses Clerk hooks and needs the H6 loopback identity, so it is
out of scope here (it would white-screen without auth).

## Signing is a config/env flip (H1 wired it; the operator turns it on)

The signing surface is **present but inert**:

- `electron-builder.yml` sets `hardenedRuntime: true`, `entitlements:` +
  `entitlementsInherit:` → `build/entitlements.mac.plist` (minimal JIT entitlements),
  and `afterSign: scripts/notarize.cjs`.
- `build/entitlements.mac.plist` — the minimal hardened-runtime entitlements.
- `scripts/notarize.cjs` — the notarize hook, which **self-skips** unless the build
  is signed AND notarytool credentials are in the env.
- The `dist:mac`/`pack:mac` scripts export `CSC_IDENTITY_AUTO_DISCOVERY=false` to
  force a deterministic unsigned build.

**The flip** (once enrolled — H-Q1/H-Q2): provide the Developer ID cert
(`CSC_LINK`/`CSC_KEY_PASSWORD` or the login Keychain), drop
`CSC_IDENTITY_AUTO_DISCOVERY=false`, and provide notarytool creds
(`APPLE_API_KEY`/`_ID`/`_ISSUER`, or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`).
Nothing in `main.cjs`, the staging step, or the YAML structure changes — see
`GO-LIVE.md` "Packaged app — when you have the Apple Developer ID".

## Not in this stage (later Epic H stories)

- The actual Developer-ID sign + notarize run (**H1 remainder** — needs the Apple account)
- Tray/menubar, dynamic ports (**H1 follow-on / H2**)
- First-run TCC permission wizard + Info.plist usage strings (**H2**)
- Auto-update (**H3**)
- Config/secret bootstrap + per-install Keychain keys (**H4**)
- Real single-operator loopback auth + fail-closed-on-default-key (**H6**)
