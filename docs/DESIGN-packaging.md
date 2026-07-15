# DESIGN — Epic H: Packaging & Distribution (a replicable, installable Mission Control)

> **Status:** Design + story plan · **H0 spike BUILT (2026-07-15, PR #268) → H1 build pipeline BUILT (2026-07-15)** — see §15 (H0) + **§16 (H1)**. The design below is the RESEARCH pass; H0 proved the bundling recommendation and H1 hardened it to a production-grade, reproducible **unsigned** `.app`/`.dmg` (compiled backend; sign/notarize wired-but-inert behind a one-env-flip). **H1 STOPS for an independent audit.** · **Date:** 2026-07-15 · **Owner:** operator (arturito@7ei.ai)
> **Companions:** `docs/DESIGN-agent-onboarding.md` §8 (the deployment-profile + config-bundle foundation this epic picks up), `docs/SECURITY-posture.md` (the model a packaged instance must preserve), `GO-LIVE.md` (the operator console/secret actions), `docs/PLAN-arturita.md` §0 (Epic H rows H0–H6). Verify claims against the repo before acting.

The goal: **a replicable, installable product** — a macOS `.dmg` that stands up a full local "packaged/loopback" Mission Control instance on someone else's Mac (backend + web UI + local LLM/STT + the host adapters), plus an iPhone remote surface. The heavy foundations — the two-profile abstraction, the secret-free config bundle, the encrypted secret store, the launchd-supervised adapters, and a DB layer that **already** speaks to a local file — are shipped. So this epic is mostly the **installer + first-run experience + the macOS platform specifics that trip packaging projects up** (signing, notarization, TCC, per-install key generation, auto-update).

This document is deliberately joint with Epic ONB: the `packaged` profile *is* the installer's target, and H4 seeds a fresh machine from the **same** config bundle ONB1 shipped — not a second config format (`DESIGN-agent-onboarding.md` §8.2).

---

## 0. TL;DR

- **Bundling approach — recommend an Electron shell that supervises bundled sidecar services**, with **Tauri v2 as the documented runner-up**. The app is not one JS runtime; it is *a supervisor + a webview over a small service mesh* (Fastify backend on a local libSQL file · the Next.js UI · opt-in host daemons: Ollama, the Whisper bridge, the OpenClaw/Claude-Code adapters). Electron wins on **stack-fit**: its bundled Node runs the Fastify backend as a child with **one runtime and one signature chain**, Chromium parity means the Next.js UI renders exactly as it does in dev, and `electron-builder` + `electron-updater` automate the notarization gauntlet that eats packaging schedules. Tauri is smaller and has a cleaner security posture but forces a Rust toolchain **and** a bundled-Node sidecar anyway (negating much of the size win), so it is the fallback, not the default. **This choice is an operator decision — H0 is a throwaway spike to de-risk it before H1 commits.**
- **The load-bearing net-new piece is not the installer — it's loopback identity (H6).** Clerk is cloud, multi-tenant auth; a single-tenant loopback instance can't use it as-is. The packaged profile needs a **single-operator local auth** that replaces the Clerk JWT on `127.0.0.1`. Everything else is ~70% reuse.
- **Secrets are generated per-install into the macOS Keychain, never baked into the image.** `SECRETS_ENC_KEY` / `RUN_TOKEN_SECRET` are `openssl rand`-equivalent at first boot; the config bundle carries **shape and posture, never credentials** (`assertNoSecrets()` is already a hard throw).
- **Signing/notarization/TCC** are well-trodden but mandatory: Apple **Developer ID Application** cert → hardened runtime + entitlements → `notarytool` submit → staple → Gatekeeper-clean `.dmg`. TCC grants (Mic, Accessibility, Full Disk, Automation) **cannot be granted silently** — a first-run wizard *guides* the user into System Settings panes; it replaces the ad-hoc terminal steps we did for Ollama/Whisper.
- **iPhone:** v1 = the existing Telegram channel (Epic D) — zero new mobile surface; v2 = a **PWA** remote (design this wave, build later). Recommend the v1→v2 path; a native app is a v3 only if push/Shortcuts demand it.
- **Phased plan: H0 (spike) → H1 (bundle+sign+notarize) → H6 (loopback auth) → H2 (TCC wizard) → H4 (config/secret bootstrap) → H3 (auto-update) → H5 (iPhone).** H1–H4, H6 each **stop for an independent audit** (they touch signing, permission grants, per-install secrets, and the remote-code update path).

---

## 1. What already exists (so we design onto it, not around it)

| Foundation | Where | What it gives Epic H |
|---|---|---|
| **Two deployment profiles** | `backend/src/services/deployment-profile.ts` | `packaged` = loopback-trusted, exactly Paperclip's `local_trusted`; `hosted` = today's Fly backend. `resolveDeploymentProfile(env)` safe-defaults to `hosted` (the harder posture). The installer sets `MC_DEPLOYMENT_PROFILE=packaged`. |
| **Config bundle (secret-free)** | `backend/src/services/config-bundle.ts` | `buildConfigBundle()` / `validateConfigBundle()` + `assertNoSecrets()` (hard throw on any secret-shaped key). H4 **seeds a fresh machine from this**, not a new format. Version-gated (`CONFIG_BUNDLE_VERSION`). |
| **Portability slices** | `backend/src/services/portability.ts` | `buildExport()` / `remapImport()` already move org · agents · goals · budgets · routines between machines, secret-scrubbed by construction. These fold into the bundle under H4. |
| **DB already speaks local file** | `backend/src/db/client.ts` | `createClient({ url: process.env.DATABASE_URL ?? 'file:./dev.db' })`. **A packaged instance just points `DATABASE_URL` at a local libSQL file — Turso is not required.** libSQL is embedded SQLite; zero extra runtime. |
| **Encrypted secret store** | `backend/src/services/secrets.ts` | AES-256-GCM keyed by `SECRETS_ENC_KEY`. Already the single home for adapter/pipeline/LLM keys. Packaged: same store, local DB, per-install key. |
| **launchd-supervised, zero-dep adapters** | `adapters/*` | `arturita-host` + `arturita-stt` are **Node stdlib, zero deps**; `claude-code`/`openclaw`/`cursor` are **Python stdlib**. Each already ships a `setup.sh` that writes a chmod-600 `mc.env` and loads a launchd keep-alive. The installer *becomes* the GUI front-end to these same scripts. |
| **Onboarding posture is profile-derived** | `deployment-profile.ts` `onboardingPosture()` | On `packaged`, the join/claim/doc surface is loopback-open by default (invariant #1). A packaged instance onboards its own local adapters without `MC_ENABLE_REMOTE_ONBOARDING`. |

**Consequence:** the backend and DB need **no architectural change** to run packaged — they need a *local file DB URL, a per-install key, and a supervisor to start them*. The web app needs **one** real change: **loopback auth (H6)**.

---

## 2. Architecture recommendation — the bundling approach

### 2.1 The shape of the thing

Mission Control packaged is a **small service mesh behind a menubar + webview**, not a monolith:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Mission Control.app  (Developer-ID signed, notarized, hardened RT)  │
│                                                                       │
│  ┌────────────────┐   supervises (child procs / launchd)             │
│  │  Shell + Tray  │──┬────────────────────────────────────────────┐  │
│  │  (Electron)    │  │                                             │  │
│  │  • menubar     │  ▼                    ▼                  ▼      │  │
│  │  • 1st-run     │  Fastify backend      Next.js UI        Host   │  │
│  │    TCC wizard  │  (bundled Node)       (standalone or    daemons│  │
│  │  • BrowserWin  │  • DATABASE_URL=      static, served    (opt-in)│  │
│  │    → localhost │    file:~/Library/…   by Fastify)       • Ollama│  │
│  │  • updater     │  • local libSQL       localhost:3000    • Whisper│ │
│  └────────────────┘  • secret store                        • adapters│ │
│         │              localhost:8080                       (launchd) │  │
│         ▼                    │                                        │  │
│   macOS Keychain ◄───────────┘  SECRETS_ENC_KEY / RUN_TOKEN_SECRET    │  │
│   (per-install keys)            read at boot, never in the image      │  │
└─────────────────────────────────────────────────────────────────────┘
        ▲                                              ▲
        │ Gatekeeper / notarization                    │ iPhone remote
        │ verifies on first open                       │ v1 Telegram · v2 PWA
```

Everything binds to `127.0.0.1`. Nothing listens on a routable interface. This is the whole security model of the `packaged` profile: **loopback is the trust boundary** (§8).

### 2.2 The three candidate shells (and why Electron)

| | **Electron** (recommend) | **Tauri v2** (runner-up) | **Menubar + launchd only** (no webview) |
|---|---|---|---|
| Runtime | Bundles Chromium + Node | Rust core + system WKWebView; **must still bundle a Node sidecar** for the backend | Small Swift/Tauri menubar; UI opens in the user's default browser |
| Backend hosting | Fastify runs as a **child of Electron's own Node** (`utilityProcess`/`fork`) — one runtime, one signature | Fastify runs from a **bundled Node sidecar binary** (SEA / pkg) — a second thing to sign | Fastify runs as a **launchd service** (exactly today's adapter pattern) |
| UI parity | **Chromium — identical to our dev/Chrome target**; zero Next.js/WebKit risk | WKWebView — Next.js 15 App Router can hit WebKit quirks | Whatever browser the user has (Clerk in a plain tab, etc.) |
| Bundle size | ~150 MB (Chromium) | ~60 MB (WKWebView + Node sidecar) | ~10 MB (but no bundled UI) |
| Sign + notarize | `electron-builder` **automates** Developer-ID sign + hardened runtime + `notarytool` + staple | `tauri` CLI supports it; more hand-rolled for the sidecar | Hand-rolled `productbuild`/`create-dmg` + manual `notarytool` |
| Auto-update | `electron-updater` (Squirrel.Mac), mature, static feed | Tauri updater, built-in, good | Sparkle (mature, but you own the wiring) |
| Menubar | `Tray` | `SystemTray` | native |
| Team fit | **Node/TS everywhere already** | **adds Rust** | adds Swift or Rust |
| Toolchain risk | low | medium (Rust + sidecar packaging) | medium |

**Recommendation: Electron.** The deciding factors, in order:

1. **The backend is Node; Electron *is* Node.** Fastify + `@libsql/client` (which has a native binding) run as a child of Electron's bundled Node. One runtime, one code-signature chain, one notarization. Tauri's "small" advantage is real only until you remember the backend still needs a Node runtime shipped alongside — a sidecar you then have to sign and update separately.
2. **Chromium parity kills UI risk.** The Next.js 15 App Router UI is built and tested against Chrome. Electron renders it in the same engine. WKWebView (Tauri) is a new variable in an epic that already has enough.
3. **`electron-builder` automates the single biggest packaging time-sink.** Developer-ID signing + hardened runtime + entitlements + `notarytool` submission + stapling + `.dmg` layout are one config block. This is where packaging projects lose weeks.

**Pick Tauri instead only if** bundle size / native memory footprint becomes a hard product constraint *and* the team accepts a Rust toolchain. **Pick menubar-only** if the operator decides the UI living in the system browser is acceptable and wants the absolute smallest artifact — but then loopback auth (H6) is more exposed (any browser tab on the machine can reach it) and we lose the app-like first-run wizard. **This is an operator decision; H0 spikes it before H1 commits any of it.**

### 2.3 How the web UI ships in a packaged instance

Two viable modes, decided in H0:
- **(a) Next.js standalone server as a child** (`next build` → `.next/standalone` → `node server.js` on `:3000`). Keeps SSR/route handlers working unchanged. Simplest correctness story.
- **(b) Static-served by Fastify.** Where the UI can be exported/static, Fastify serves it on the same origin as the API, collapsing to one port and one process. Cleaner, but only if no server-only Next feature is load-bearing in packaged mode.

Recommend **(a) for H1** (lowest risk, ship it), with (b) as a later consolidation if the UI proves fully static-able. Either way the shell's `BrowserWindow` just points at `http://127.0.0.1:<port>`.

### 2.4 Host daemons (Ollama · Whisper · adapters) — supervised, opt-in, reuse the setup scripts

The installer does **not** re-implement daemon management. It becomes a **GUI front-end to the `adapters/*/setup.sh` scripts that already exist** and the launchd keep-alive pattern already in use (`mac-mini/setup.sh`, `com.7ei.mc-adapter.plist`):

- **Ollama** — bundled as an optional download (it's GBs; do not put it in the `.dmg`). First-run offers "Install local AI (Ollama + a default model)" → runs the vendor installer or `brew`, sets `OLLAMA_ORIGINS` for the loopback UI (GO-LIVE §10).
- **Whisper bridge** — `adapters/arturita-stt` (zero-dep Node) started as a launchd service; whisper.cpp is the host engine (GO-LIVE §10).
- **OpenClaw / Claude-Code adapters** — the existing `setup.sh` writes a chmod-600 `mc.env` and loads launchd; in packaged mode the token is a **local loopback agent token**, and (per Epic ONB, packaged profile) the adapter can self-onboard against the loopback join surface.

Each daemon is **opt-in** in the first-run wizard — a fresh packaged instance is useful with browser-only STT/TTS and a cloud LLM key, and *becomes* fully local as the user adds engines. This mirrors the honest-degradation posture the Arturita stack already ships.

---

## 3. Code-signing, notarization & Gatekeeper — what's actually required

To ship a `.dmg` a stranger can open with **no warning**, all of the following are mandatory (there is no shortcut; ad-hoc/unsigned = Gatekeeper block or a scary right-click-Open dance):

1. **Apple Developer Program membership** (operator action — $99/yr). Yields the ability to create signing certs. *Not something the assistant can do.*
2. **A "Developer ID Application" certificate** (for the `.app`) and, if we ship a `.pkg`, a **"Developer ID Installer"** cert. Created in the Apple Developer portal / Xcode, private key in the login Keychain.
3. **Hardened Runtime** enabled on the `.app`, with a minimal **entitlements** set. Electron needs at least:
   - `com.apple.security.cs.allow-jit` + `allow-unsigned-executable-memory` (V8/JIT),
   - `com.apple.security.cs.disable-library-validation` **only if** we load a non-bundled dylib (libSQL's native binding is bundled, so aim to avoid this),
   - plus the **TCC usage entitlements/Info.plist strings** (§4).
   Keep the set **minimal and justified** — this is an audited surface (H1 stage→audit): every entitlement is an attack-surface widening.
4. **Code-sign every nested binary**, deep. Electron's Helper apps, the bundled Node, the libSQL native module, and any sidecar must all carry the signature (`electron-builder` does this with `--deep`-equivalent per-file signing).
5. **Notarization** — submit the signed artifact to Apple with `notarytool` (an App-Store-Connect API key or app-specific password; operator provides once). Apple scans for malware, returns a ticket.
6. **Staple** the ticket to the `.dmg`/`.app` (`stapler staple`) so Gatekeeper validates **offline**.
7. **Gatekeeper flow the user sees:** double-click `.dmg` → drag to Applications → first open → Gatekeeper checks the stapled notarization → **opens, no warning.** Without notarization the user gets "cannot be opened because Apple cannot check it for malicious software" and must right-click→Open (unacceptable for a product).

**What the operator must supply (H1 open questions):** Apple Developer account, the signing identity (Developer ID Application, and Installer if `.pkg`), and a notarization credential (API key preferred over app-specific password). The **build/sign/notarize pipeline** (electron-builder config, entitlements, the `notarytool` step) is engineering and can be fully scripted; the **certs and account** are operator-only, same boundary as the Clerk/Fly console actions in `GO-LIVE.md`.

> **CI note:** signing in CI needs the cert `.p12` + password and the notarization key as encrypted secrets. Per repo convention we **do not touch `.github/workflows/` unless a story requires it** — H1 explicitly will, and that's the one place it's sanctioned. Local signed builds are the H1 fallback if CI signing is deferred.

---

## 4. First-run permission wizard (TCC) — guiding, never granting

macOS **TCC** (Transparency, Consent & Control) protects Microphone, Accessibility, Full Disk Access, and Automation (Apple Events). **None can be granted silently or programmatically** — the OS shows its own consent UI, and Full Disk Access / Accessibility can't even be *prompted* by an app; the user must toggle them in **System Settings → Privacy & Security**. The wizard's job is to **explain, deep-link, and verify** — replacing the ad-hoc terminal steps we did for Ollama/Whisper.

| Grant | Who needs it | How the wizard handles it | Silent? |
|---|---|---|---|
| **Microphone** | Arturita voice (STT capture, C-epic) | Standard `AVCaptureDevice` prompt on first mic use; `NSMicrophoneUsageDescription` in Info.plist. Wizard triggers it intentionally with a "Test your mic" step. | Prompted (OS UI) |
| **Accessibility** | The host daemon driving other apps / keystrokes (Arturita C-epic machine control) | **Cannot be prompted.** Wizard deep-links `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`, shows a GIF/steps, then **polls `AXIsProcessTrusted()` until granted** and advances. | No — user toggles |
| **Full Disk Access** | Only if a host action reaches TCC-protected paths (Mail, Messages, Safari data). Likely **not needed for v1** — scope it out unless a real action requires it. | Same deep-link + poll pattern; gated behind an explicit "Enable advanced file operations" opt-in, off by default. | No — user toggles |
| **Automation (Apple Events)** | Host daemon scripting another app (e.g. "put this in Calendar") | First Apple Event to a target app triggers the per-target prompt; `NSAppleEventsUsageDescription` string. Wizard requests only for apps the operator opts into. | Prompted per target |

**Design rules for the wizard (H2):**
- **Least privilege, opt-in, staged.** A fresh install asks for **Microphone only** (the one thing the default voice loop needs). Accessibility / Full Disk / Automation are behind explicit "enable machine control" toggles, off by default — mirroring the shell-OFF-by-default and A2-gated posture the rest of the app already holds (`SECURITY-posture.md` §8).
- **Verify, don't assume.** After a deep-link, poll the actual API (`AXIsProcessTrusted`, a mic-capture probe) and only advance on a real grant. Never record "granted" from the user clicking "I did it."
- **Honest degradation.** Every un-granted permission maps to a **disabled feature with a plain reason**, not a broken app — same contract as the Arturita STT/LLM fallback chain.
- **Re-entrant.** The wizard is reachable later from the Tray (permissions drift; users revoke). It is not a one-shot.

**Security note (H2 audit):** the permission grants are the most sensitive thing the installer touches — Accessibility + Full Disk Access are effectively "control the whole machine." The wizard must (a) request the *minimum*, (b) map each grant to a **named capability the operator turned on**, and (c) never bundle grants ("click here to enable everything"). This is why H2 stops for an independent audit.

---

## 5. Local data & secrets on a packaged instance

### 5.1 Where data lives
- **Database:** a local libSQL file at `~/Library/Application Support/7Ei Mission Control/mc.db` — set `DATABASE_URL=file:…/mc.db`. No Turso, no network DB. The existing idempotent migration convention (`backend/src/db/setup.ts`) runs on first boot to create the 26 tables. **Optional later:** libSQL embedded replica → Turso sync for backup, but v1 is purely local.
- **Encrypted secret store:** the **same** `secrets.ts` AES-256-GCM store, now in the local DB. Adapter keys, LLM keys, vault tokens all live here exactly as hosted — no new mechanism.

### 5.2 Per-install key generation (the rule: never baked in)
`SECRETS_ENC_KEY` and `RUN_TOKEN_SECRET` **must be unique per install and never present in the `.dmg`** (a baked key means every copy of the app can decrypt every other install's secrets). Flow:

1. **First boot, no key present** → the shell generates two 32-byte random keys (`crypto.randomBytes(32).toString('hex')`, the `openssl rand -hex 32` equivalent from GO-LIVE §1).
2. **Store them in the macOS Keychain** (`security`/`keytar`-equivalent), not a plaintext env file. The backend reads them from the Keychain at boot via the shell, injected as env — the backend code is unchanged (it already reads `process.env.SECRETS_ENC_KEY`).
3. **Fail closed on the default.** The GO-LIVE §1 engineering follow-up — *"`NODE_ENV=production` refuses to start on the default key"* — is **shipped as part of H6/H4**: a packaged instance that somehow reaches boot with `SECRETS_ENC_KEY === 'dev-7ei-mc-secrets-key'` **refuses to start** rather than silently using the world-readable default. This closes the single highest-risk line in GO-LIVE for the packaged path.

### 5.3 What the config bundle seeds vs. what's generated vs. re-supplied
The three-way split is the heart of H4 and is **already enforced by `assertNoSecrets()`**:

| Class | Examples | Source on a fresh machine |
|---|---|---|
| **Seeded from the config bundle** (shape/posture) | deployment profile, the four locked invariants, adapter availability, org/agents/goals/budgets/routines/trust/pipeline **structure** | Imported from the bundle the operator ships (or a default "starter" bundle in the `.dmg`). Carries **no secrets** — `assertNoSecrets()` throws otherwise. |
| **Generated per-install** | `SECRETS_ENC_KEY`, `RUN_TOKEN_SECRET`, local agent tokens, `WEBHOOK_SIGNING_SECRET` | Random at first boot, into Keychain. Never travels. |
| **Re-supplied by the operator** | LLM API keys (NVIDIA/Groq/Gemini/Anthropic), vault PAT, Telegram bot token | Entered once on the new machine via the same Cockpit → Secrets UI; land in the encrypted store. The bundle *names which secrets a slice needs*, so the wizard can prompt for exactly those — but never carries the values. |

---

## 6. The packaged-profile boot sequence

What happens, in order, the first time and every time the app opens:

```
FIRST RUN                                   EVERY RUN
─────────                                   ─────────
1. Gatekeeper verifies stapled notarization (offline)
2. Shell starts, reads MC_DEPLOYMENT_PROFILE=packaged
3. Keychain: keys present?                  Keychain: read keys → env
   → no  → generate SECRETS_ENC_KEY,
           RUN_TOKEN_SECRET, WEBHOOK_…,
           store in Keychain
   → FAIL CLOSED if key === dev default
4. DB present at ~/Library/…/mc.db?
   → no  → create, run idempotent migrations run idempotent migrations (no-op if current)
5. Import config bundle (starter or operator's) —  (skip; already seeded)
   assertNoSecrets() must pass or abort
6. Fork Fastify backend (localhost:8080)    fork backend
   Fork Next.js UI (localhost:3000)         fork UI
7. First-run TCC wizard (Mic; opt-in more)  (skip unless a grant was revoked)
8. Loopback auth: establish the single       loopback session (H6) — no Clerk
   operator identity (H6)
9. Prompt for re-supplied secrets the        (skip)
   bundle's slices name (LLM key, etc.)
10. Offer host daemons (Ollama/Whisper)      supervise enabled daemons (launchd)
11. Open BrowserWindow → 127.0.0.1:3000
```

Fail-closed at every step: no key → generate-or-refuse; bundle carries a secret → abort import; a daemon absent → feature disabled with a reason, never a crash. This is the same discipline catalogued in `SECURITY-posture.md` §6, applied to boot.

---

## 7. Auto-update channel

- **Mechanism: `electron-updater` (Squirrel.Mac).** Ships with Electron, integrates with the notarized `.dmg`/`.zip` flow, reads an update feed (a static `latest-mac.yml` + artifacts on **GitHub Releases** or an S3/R2 bucket). Sparkle is the equivalent if we go menubar-only; Tauri's built-in updater if Tauri.
- **Signed + notarized deltas only.** Every update artifact is itself Developer-ID-signed, notarized, and stapled. `electron-updater` **verifies the signature before applying** — an update is a remote-code path, so this is non-negotiable and is why **H3 stops for an audit**.
- **Feed hosting:** GitHub Releases (private or public repo) is the low-friction choice — the repo already lives on GitHub, and releases give free CDN + versioned artifacts. The update `.yml` points at the release assets.
- **Operator controls:** channel (`stable` / `beta`), check-on-launch + periodic, and a "download → notify → user clicks Restart to apply" UX (never silent-restart during a live session). A packaged instance is the operator's own machine; respect that it may be mid-task.
- **Rollback:** keep the prior `.app` until the new one boots healthy (backend `/api/health` green post-update); a failed health check reverts. The config bundle version gate (`validateConfigBundle` refusing a newer bundle) already protects against a downgrade reading a forward-incompatible bundle.

---

## 8. The iPhone remote surface

### v1 — the existing Telegram channel (reuse, no new mobile surface)
Epic D already specifies Arturita's iPhone/remote surface as **Telegram** (voice notes, text, files, one-tap inline approvals) — `GO-LIVE.md` §9, PLAN §0 D1/D2. For a **packaged** instance this needs:
- The Telegram bot token in the local encrypted store (operator supplies once).
- `WEBHOOK_SIGNING_SECRET` — **generated per-install** (§5.2), not operator-set as it is on hosted.
- **The reachability wrinkle:** a packaged instance is loopback-only, so Telegram's webhook can't reach `127.0.0.1`. v1 packaged Telegram therefore uses **long-polling** (`getUpdates`) from the backend outbound, **not** an inbound webhook — no tunnel, no exposed port, consistent with the loopback trust boundary. (Hosted uses the webhook; the receiver code is shared, the transport differs by profile.)
- **Recommend v1 = Telegram long-poll** as the packaged iPhone surface. It ships with Epic D's work plus a transport switch; zero new UI.

### v2 — a PWA remote (design now, build later)
- **A Progressive Web App** served by the packaged backend, reachable from the operator's iPhone **on the same LAN or over a Tailscale/loopback tunnel** the operator controls. Installable to the home screen, offline-capable shell, push via the Web Push API where the transport allows.
- **Why PWA over native first:** it reuses the Next.js UI (responsive → installable) with no App Store review, no separate codebase, no Apple mobile-dev cert dance. The Staff grid / approvals inbox / Arturita tab are already the surfaces a remote wants.
- **The honest constraint:** a loopback packaged instance isn't reachable from a phone off-LAN without a tunnel — so v2 pairs with an operator-controlled reachability story (LAN bind opt-in, or Tailscale), which is itself a posture decision (binding off `127.0.0.1` widens the trust boundary — audited).
- **v3 native** only if Web Push / Shortcuts / background audio prove insufficient. Not scoped this wave.

**Recommended path: v1 Telegram long-poll (ships with D + a transport switch) → v2 PWA (design H5 now, build post-H4) → v3 native only on demand.**

---

## 9. Reuse-vs-new inventory

**~70% reuse — the installer is mostly a supervisor + a GUI over scripts that already exist.**

| Area | Reuse (already shipped) | Net-new (Epic H) |
|---|---|---|
| **Deployment profile** | `deployment-profile.ts`, `packaged` posture, profile-derived onboarding | Set `MC_DEPLOYMENT_PROFILE=packaged` in the bundle; fail-closed-on-default-key guard |
| **Config bundle** | `config-bundle.ts`, `assertNoSecrets`, version gate, `portability.ts` slices | **H4:** fold org/agent/budget/routine/pipeline/trust slices into the bundle; the "seed a fresh machine" apply-path |
| **Database** | libSQL client **already speaks `file:`**, idempotent migrations | Local file path under Application Support; first-boot migration run |
| **Secret store** | `secrets.ts` AES-256-GCM, Cockpit → Secrets UI | **Per-install key generation into Keychain**; the fail-closed-on-default guard |
| **Host daemons** | `adapters/*/setup.sh`, launchd keep-alive, zero-dep adapters, Ollama/Whisper host-engine story | **GUI front-end** to the setup scripts; opt-in daemon toggles in the wizard |
| **Web UI** | The whole Next.js app, Staff grid, approvals, Arturita tab | **H6: loopback auth** replacing Clerk on `127.0.0.1`; Next standalone-as-child packaging |
| **iPhone** | Epic D Telegram receiver, inline approvals | **v1:** long-poll transport for packaged; **v2:** PWA (design) |
| **The shell itself** | — | **All net-new:** Electron shell, Tray, first-run wizard, updater, sign/notarize pipeline (H0–H3) |
| **Identity** | Clerk (hosted) | **H6: single-operator loopback identity** — the load-bearing net-new piece |

The genuinely net-new, load-bearing work is: **the shell (H1), loopback auth (H6), the TCC wizard (H2), per-install key gen (H4), and the signed-update path (H3).** Everything else is wiring existing pieces into a supervised bundle.

---

## 10. Security implications (a packaged instance is a different threat model)

A packaged instance **inverts** the hosted threat model, and the design must hold both honestly:

1. **Loopback is the trust boundary.** On `packaged`, everything binds `127.0.0.1`; there is no public attack surface, so onboarding is loopback-open (invariant #1) — *exactly* Paperclip's `local_trusted`. This is **only** safe as long as nothing binds a routable interface. Any "reach it from my phone on the LAN" feature (v2 PWA) is a **deliberate, audited widening** of that boundary, off by default.
2. **Secrets are per-install and machine-local.** No baked key (§5.2); keys in Keychain, not a plaintext env; `assertNoSecrets()` keeps them out of the bundle and the `.dmg`. The GO-LIVE §1 fail-closed-on-default guard ships here — a packaged build **cannot** run on the world-readable dev key.
3. **The installer's permission grants are the most sensitive thing it does.** Accessibility + Full Disk Access = whole-machine control. The wizard requests the **minimum** (Mic only by default), maps every grant to a named capability the operator turned on, and never bundles grants (§4). This is the machine-exec/shell posture (`SECURITY-posture.md` §8) extended to the OS-permission layer.
4. **The update path is remote code.** Signature + notarization verification before apply is mandatory (§7); an unsigned update is a code-injection vector. Health-check rollback bounds a bad update.
5. **Single-tenant, single-operator.** Loopback auth (H6) is not "no auth" — it's a single-operator local identity, so a shared Mac's other accounts don't silently drive the instance. The multi-tenant membership gate (`SECURITY-posture.md` §4) is a hosted concern; packaged replaces it with the OS user boundary + loopback + the local session.
6. **What does NOT change:** the A2 dangerous-action gate, low-trust-by-default for onboarded agents, the wallet no-custody posture, the command denylist — all ride the backend and apply identically packaged. Packaging must not become a back door around any of them. (An audit acceptance criterion for H1/H6: prove the gate chain is intact in `packaged`.)

---

## 11. Phased Epic H story plan

One PR per story, squash-merged `--admin`, invariant green each merge. Stories marked **stage→audit** ship then **stop for an independent audit** by a session that did not write them (the `SECURITY-posture.md` §1 protocol), because they touch signing, permission grants, per-install secrets, or the remote-code update path.

| Story | Title | Scope | Acceptance criteria | Audit? | Deps |
|---|---|---|---|---|---|
| **H0** ✅ **DONE (#268)** | **Packaging spike + shell decision** | Throwaway PoC: Electron (and, if the operator wants a bake-off, Tauri) shell that forks the Fastify backend on a local libSQL file + serves the Next UI + opens a loopback window. Decide: shell, UI-ship mode (§2.3), Node-child vs sidecar, loopback-auth approach (§H6). | ✅ **MET** — a built, **unsigned** `.app`/`.dmg` (`apps/desktop/`) boots the backend + Next UI on `127.0.0.1` against a local libSQL file with `MC_DEPLOYMENT_PROFILE=packaged`; `/api/health` green from the **built app** (not `npm run`). Decision recorded in §15: **Electron confirmed**, **Node-child via `tsx` (H1 → compiled bundle)**, **web = Next standalone-as-child (§2.3 option a)**. Three *minimal, additive* prod edits were needed (not "zero" as originally scoped) — all no-ops for hosted, verified (§15). H1 unblocked. | no (spike) | — |
| **H1** ⏳ **BUILD PIPELINE BUILT (2026-07-15) — sign/notarize RUN cert-gated; STOPPED for audit** | **macOS installable bundle (sign + notarize)** | The real shell: supervise backend (local libSQL file) + Next UI as children, `electron-builder` config, **hardened runtime + minimal entitlements**, Developer-ID sign, `notarytool` notarize + staple, `.dmg` layout. Sets `MC_DEPLOYMENT_PROFILE=packaged`. | ⏳ **PARTIAL — build pipeline MET (§16):** compiled esbuild backend (no dev toolchain), reproducible release-quality **unsigned** `.app` (463 MB) + `.dmg` (157 MB), correct appId/name/version/icon, boots backend+UI on loopback with `/api/health` green + fresh-DB migrations from the built app; **hardened runtime + minimal entitlements + afterSign notarize hook WIRED but inert** (one-env-flip). **PENDING (operator-gated):** the actual Developer-ID sign + notarize run → the *no-Gatekeeper-warning* criterion (H-Q1/H-Q2); Tray menubar (deferred to follow-on); the A2-gate-chain-in-`packaged` audit assertion (belongs to the H1 audit). | **stage→audit** (entitlements, hardened runtime, signing surface) — **STOPPED HERE** | H0 |
| **H6** | **Packaged-profile identity & loopback auth + fail-closed boot** | Single-operator local identity replacing Clerk on `127.0.0.1` (a local session bound to the OS user / first-run pairing); **fail-closed on default `SECRETS_ENC_KEY`/`RUN_TOKEN_SECRET`** (GO-LIVE §1 follow-up); posture derivation verified `packaged`. | On packaged, the UI authenticates without Clerk; a second local account can't silently drive the instance; boot **refuses** on the dev-default key; onboarding posture reads loopback-open; hosted profile unaffected (Clerk path unchanged). | **stage→audit** (auth + fail-closed secrets) | H1 |
| **H2** | **First-run TCC permission wizard** | Guided Mic (prompt) + Accessibility/Full-Disk/Automation (deep-link + poll-verify), least-privilege/opt-in/staged, re-entrant from the Tray, honest degradation per un-granted permission. Info.plist usage strings. | Mic requested by default and verified by a real capture probe; advanced grants behind explicit off-by-default toggles; each grant maps to a named capability; app fully usable with only Mic; wizard re-openable. | **stage→audit** (permission grants are whole-machine sensitive) | H1 |
| **H4** | **Fresh-machine config/secret bootstrap** | Fold org/agent/budget/routine/pipeline/trust slices into the config bundle (extend `config-bundle.ts` using `portability.ts`); the **apply-path** that seeds a clean instance; **per-install key generation into Keychain**; the wizard prompts for exactly the re-supplied secrets a slice names. | Importing a starter/operator bundle seeds a working instance with **zero secrets in the bundle** (`assertNoSecrets` holds end-to-end); keys are generated per-install into Keychain, never in the image; two installs have different keys; the bundle version gate refuses a forward-incompatible bundle. | **stage→audit** (per-install secrets, no baked keys — highest-value audit in the epic) | H1, H6 |
| **H3** | **Auto-update channel** | `electron-updater` + a static feed (GitHub Releases); signed+notarized+stapled update artifacts; **signature verification before apply**; channel + check cadence; download→notify→user-Restart UX; health-check rollback. | An older install detects, downloads, verifies, and applies a newer signed release; an **unsigned/tampered** artifact is **refused**; a failed post-update `/api/health` rolls back; no silent restart mid-session. | **stage→audit** (update = remote-code path) | H1 |
| **H5** | **iPhone remote surface (v1 Telegram, v2 PWA)** | **v1:** wire the packaged Telegram surface as **long-poll** (loopback-safe, no inbound webhook), reusing Epic D's receiver + inline approvals, `WEBHOOK_SIGNING_SECRET` generated per-install. **v2:** design a PWA remote (this wave design-only) — installable UI, reachability/tunnel posture, push. | v1: a packaged instance takes voice/text/approvals over Telegram with **no exposed inbound port**; degrades honestly without a bot token. v2: a written PWA design (surfaces, reachability, push, the LAN-bind posture decision) in this doc / a follow-up. | v1 **stage→audit** (remote auth surface); v2 design | H1; D1/D2 |

**Sequencing:** H0 → H1 → H6 → H2 → H4 → H3 → H5. H6 lands right after H1 because the bundle isn't *usable* without loopback auth; H4 depends on both (it seeds an authenticated instance); H3 and H5 are independent tails.

**Cross-references to PLAN §0:** the existing tracker rows are H1–H5. This plan **adds H0 (spike)** and **H6 (loopback auth — the load-bearing net-new gap)**, and refines H1/H4/H5 semantics. The PLAN §0 Epic H rows are updated to match (see §13).

---

## 12. Open questions / decisions the operator must make

These block or shape specific stories; none can be resolved by engineering alone.

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| **H-Q1** | **Apple Developer account** — enroll ($99/yr). | H1 (sign/notarize) — hard blocker. | Enroll; it's the price of a warning-free `.dmg`. Same operator-only boundary as the Clerk/Fly console actions. |
| **H-Q2** | **Signing identity** — create the Developer ID Application (and Installer, if `.pkg`) cert; provide a notarization credential (App-Store-Connect API key preferred). | H1. | API key over app-specific password (revocable, CI-friendly). Assistant can script the pipeline but **cannot** create certs or enter the account. |
| **H-Q3** | **Electron vs Tauri** (vs menubar-only). | H0 → H1. | **Electron** (stack-fit, Chromium parity, `electron-builder` automation). H0 spikes it; operator confirms before H1. |
| **H-Q4** | **Local DB choice** — pure local libSQL file (v1) vs libSQL embedded-replica syncing to Turso (backup). | H1/H4. | **Pure local file for v1** (Turso not required); add embedded-replica backup later if data-loss risk matters. |
| **H-Q5** | **Distribution channel** — GitHub Releases (private/public) vs S3/R2 vs a direct download page. | H3 (update feed) + how users get the first `.dmg`. | **GitHub Releases** — free CDN, versioned, already on GitHub; private repo if the `.dmg` isn't public yet. |
| **H-Q6** | **Loopback auth model** — OS-user-bound local session vs a first-run pairing code vs a bundled single-tenant Clerk. | H6. | **OS-user-bound local session** (simplest, matches the loopback trust boundary); avoid dragging Clerk into a single-tenant loopback app. |
| **H-Q7** | **TCC scope** — ship Mic-only by default? Gate Accessibility/Full-Disk/Automation behind explicit machine-control opt-in? | H2. | **Yes — Mic only by default**, the rest opt-in/off (least privilege; matches shell-OFF + A2 posture). |
| **H-Q8** | **PWA reachability** (v2) — stay loopback-only, opt-in LAN bind, or Tailscale? | H5 v2. | Design for **loopback-only + opt-in tunnel**; a LAN bind is a deliberate, audited posture change, off by default. |
| **H-Q9** | **Ollama/model distribution** — bundle a default model, or download on first run? | H1/H4 wizard. | **Download on first run** (models are GBs; never in the `.dmg`); offer a curated default. |

---

## 13. PLAN §0 updates (Epic H rows)

The Epic H rows in `docs/PLAN-arturita.md` §0 are refreshed to this plan: H1–H5 semantics refined, **H0 (spike)** and **H6 (loopback auth)** added, each `todo` with "design/plan this wave" cleared to the acceptance criteria above, and an Epic-H summary paragraph added (mirroring the Epic ONB / CC summaries). See PLAN §0.

---

## 14. Verdict

Packaging Mission Control is **mostly assembly, not invention** — the two-profile abstraction, the secret-free config bundle, the local-file-capable DB, the encrypted secret store, and the launchd-supervised zero-dep adapters were built (in Epic ONB and the adapter epics) *anticipating* this exact installer. The real net-new work is a supervising **Electron shell**, a **loopback identity** to replace Clerk on `127.0.0.1`, a **least-privilege TCC wizard**, **per-install key generation**, and a **signed-update path** — five focused stories plus a de-risking spike, four of which stop for an independent audit because they touch the machine's permission, secret, and update surfaces.

**One line:** *a signed, notarized `.dmg` that boots the packaged profile on loopback, generates its own keys, seeds itself from the secret-free config bundle, guides the user through the minimum macOS grants, and updates itself over a signature-verified channel — reusing ~70% of what Epic ONB already shipped, with loopback auth as the one genuinely load-bearing new piece.*

---

## 15. H0 spike — RESULTS (built 2026-07-15, PR #268)

The H0 spike is **built and landed** in `apps/desktop/` (it becomes the H1 seed, not throwaway). It is an Electron shell that supervises the **packaged/loopback mesh as ONE app** and was verified **from the built, unsigned `.app`** — not just `npm run`.

### 15.1 What the spike PROVES (all goals met)

- **The packaged mesh boots on a local file DB inside a built Electron app.** Launching `dist/mac-arm64/7Ei Mission Control.app` starts, as children of Electron's own Node:
  1. the **Fastify backend** — `MC_DEPLOYMENT_PROFILE=packaged`, `DATABASE_URL=file:~/Library/Application Support/@7ei/mission-control-desktop/mc.db`, idempotent migrations run on first boot (479 KB DB created), bound `127.0.0.1:8787`;
  2. the **Next.js UI** from its `standalone` server, `127.0.0.1:8788`, built with `NEXT_PUBLIC_API_URL` baked to the loopback backend;
  3. a **BrowserWindow** on the local Next server once `/api/health` is green.
- **`/api/health` returns `{status:"ok", db:"connected"}` from the built app** in ~3 s; the deployment profile resolves to **`packaged`** (env set by the shell; the resolver is pure + unit-tested); the UI renders (the landing route).
- **Artifacts:** an **unsigned** `.app` (619 MB) and `.dmg` (195 MB) via `electron-builder` (code-signing skipped by `identity: null`, as designed — H1/Apple-account-gated).
- **Runs with no dev toolchain on the host:** `tsx`, the backend source + `node_modules` (incl. the **libSQL native addon**), and the Next standalone server all ship inside `Contents/Resources/` (unpacked, outside `asar`).

### 15.2 Surprises / gotchas found (the point of a de-risk spike)

1. **`@clerk/fastify`'s `clerkPlugin` installs a GLOBAL request hook that 500s EVERY request — including the public `/api/health` — when no publishable key is present.** The packaged profile ships no Clerk keys, so a keyless boot was dead on arrival until fixed. Resolved by gating the plugin on `CLERK_PUBLISHABLE_KEY` (the web already degrades the same way). This is also the **H6 direction** (Clerk is replaced by loopback identity on `127.0.0.1`). **Note:** skipping the plugin is an auth *bypass*, not auth — the per-route `clerkAuth` hook still 401s tenant data; the packaged profile is **not security-complete** until H6.
2. **`next build` does NOT copy `.next/static` or `public/` into the standalone output.** The build step must copy them next to `server.js`, or the UI serves unstyled/404s assets. (Handled in `apps/desktop/scripts/build-desktop.mjs`.)
3. **Plain `tsc` output is not directly runnable** (`moduleResolution: "bundler"` + extensionless ESM imports → Node can't resolve them). The spike therefore forks the backend via **`tsx`** (dev-parity, lowest risk). Trade-off: the `.app` is heavy (619 MB) because the whole backend `node_modules` + `tsx` ship uncompiled. **H1 should compile/bundle + prune the backend** (esbuild single-file, native deps external) to shrink it.
4. **The libSQL native addon (`@libsql/darwin-arm64/*.node`) loads cleanly under Electron's bundled Node 20 ABI** (it's N-API/ABI-stable). This was the top native-module risk and it is a **non-issue** — no `nodeGypRebuild`/`electron-rebuild` needed for it. (Shipped unpacked outside `asar` so the `.node` loads from a real path.)
5. **Monorepo standalone nesting** (Next sometimes nests `server.js` under a workspace-relative path) is handled by recording the built `server.js` location in a manifest the shell reads. Here `web/` is its own npm root (no root `workspaces` field), so it landed at the standalone root — the simplest case.
6. **`userData` nests under `@7ei/`** because the desktop `package.json` name is scoped (`@7ei/mission-control-desktop`) → `~/Library/Application Support/@7ei/mission-control-desktop/`. Cosmetic; H1 can set an explicit `productName`-derived path.

### 15.3 Decisions CONFIRMED for H1

- **Shell: Electron** (H-Q3) — stack-fit held: the backend runs as a child of Electron's own Node with one runtime; Chromium renders the Next UI with zero WebKit risk; `electron-builder` produced the bundle in one config. **No reason found to bake off Tauri.**
- **Backend hosting: Node-child** (§2.2) — forked from Electron's Node (`ELECTRON_RUN_AS_NODE` + `--import tsx`); **H1 swaps `tsx`-of-source for a compiled/pruned bundle**, same supervision shape.
- **UI ship mode: Next standalone-as-child** (§2.3 **option (a)**) — SSR/route handlers work unchanged; the window just points at `http://127.0.0.1:<port>`.
- **DB: pure local libSQL file** (H-Q4) — confirmed; migrations run on boot; no Turso.
- **Signing structure:** `electron-builder.yml` is written so H1 is a **config addition** (flip `identity`/`hardenedRuntime`, add an entitlements plist + `notarize` block) — **not a rearchitecture**.

### 15.4 Minimal production edits made (all additive, hosted verified no-op)

The spike scope said "no production code paths changed"; in practice **three minimal, additive edits** were required to boot the packaged profile, each a no-op for hosted:

- `backend/src/index.ts` — register `clerkPlugin` only when `CLERK_PUBLISHABLE_KEY` is set (§15.2 #1); bind `host = process.env.HOST || '0.0.0.0'` so packaged can bind loopback (Fly sets no `HOST` → unchanged).
- `web/next.config.ts` — `output: 'standalone'` only when `DESKTOP_BUILD=1` (Vercel never sets it → byte-identical hosted build).

**Hosted proven untouched:** backend **1263/1263** tests · **11/11** evals · backend + web typecheck clean · the hosted `web` build (no `DESKTOP_BUILD`) emits **no standalone**. The Fly backend + Vercel web build/deploy exactly as before; the desktop shell is purely additive (`apps/desktop/`).

### 15.5 Dev + build commands

```bash
cd apps/desktop && npm install     # electron + electron-builder (first time)
npm run desktop                    # DEV: build web standalone, launch Electron against repo backend (tsx)
npm run pack:mac                   # unsigned .app  → dist/mac-arm64/
npm run dist:mac                   # unsigned .app + .dmg → dist/
```

**Verdict: the approach is confirmed. H1 (the real signed/notarized bundle) is unblocked** — its remaining blockers are operator-only (Apple Developer account + signing identity, H-Q1/H-Q2), not engineering.

---

## 16. H1 — RESULTS (built 2026-07-15) — production-grade build pipeline, minus the cert

H1 hardened the H0 spike into a **production-quality build pipeline**, everything **up to the Apple-account-gated signing/notarization run**. The signing surface is fully **wired but inert**: turning it on is a config/env change, not a rearchitecture. **This stage STOPS for an independent audit** (entitlements, hardened runtime, signing surface — §11). All work is confined to `apps/desktop/`; the hosted Fly/Vercel build is untouched (verified below).

### 16.1 The compiled-backend approach (H1 goal #1)

H0 shipped `backend/src` + the **entire** `backend/node_modules` (incl. `tsx`, `typescript`, `drizzle-kit`) and forked it with `--import tsx` → a 619 MB `.app`. H1 replaces that with a **compiled bundle**:

- **`scripts/build-desktop.mjs`** now bundles `backend/src/index.ts` with **esbuild** → one tree-shaken **ESM `index.js`** (5.1 MB) with the pure-JS deps inlined (Fastify, `@fastify/*`, drizzle-orm, `@clerk/*`, zod, `@anthropic-ai/sdk`, redis, dotenv). A `banner` supplies a real Node `require`/`__dirname`/`__filename` so any bundled CJS dep resolves at runtime.
- **Externals kept out of the bundle** = exactly the two packages carrying native/wasm payloads that must load from a real filesystem path and cannot be bundled:
  - `@libsql/client` → `@libsql/darwin-arm64/*.node` (the DB native addon, ABI-verified under Electron's Node in H0);
  - `officeparser` → `tesseract.js` / `pdfjs-dist` / `@napi-rs/canvas` (OCR/PDF native + wasm).
  These two are re-installed as a **minimal, PINNED (`@libsql/client@0.14.0`, `officeparser@7.1.0`), prod-only** `node_modules` beside the bundle, so their full transitive closure (incl. platform natives) ships intact (51 packages).
- **`src/main.cjs`** forks the **compiled `backend/index.js`** in packaged mode (no `tsx`, no TS source, no dev toolchain); dev mode (`npm run desktop`) still runs the repo TS source via `--import tsx` for parity + fast iteration. Web ships unchanged as the **Next standalone-as-child** (§2.3 option a).
- **Verified in the built app:** `Contents/Resources/backend/` contains `index.js` + the pruned `node_modules` only — **no `src/`, no `tsx`, no `typescript`, no `drizzle-kit`** — and the libSQL `.node` is present.

### 16.2 Sizes (unsigned, arm64)

| Artifact | H0 | **H1** | Δ |
|---|---|---|---|
| `.app` | 619 MB | **463 MB** | −156 MB (−25%) |
| `.dmg` | 195 MB | **157 MB** | −38 MB (−19%) |

Where the H1 `.app` weight lives: **Electron frameworks 233 MB** (irreducible for Electron) · **backend resources 164 MB** · **web standalone 67 MB**. The compiled `index.js` is only **5.1 MB** — the remaining backend weight is `officeparser`'s OCR/PDF native stack (`tesseract.js-core` ~43 MB, `pdfjs-dist` ~40 MB, `@napi-rs/canvas` ~25 MB), a **real runtime dependency** of document ingestion, kept intact for correctness rather than trimmed. The dev-toolchain fat (`tsx`/`typescript`/`drizzle-kit`/tests/TS source, ~90 MB+) is the win that's gone. Further shrink (making `officeparser` lazy/optional) is a **feature-behaviour** decision, out of the build-pipeline scope of H1.

### 16.3 Boots the packaged mesh (H1 goal #3, verified from the built `.app`)

Launching `dist/mac-arm64/7Ei Mission Control.app` on a **cleared** userData dir:
- **backend** `/api/health` → `{status:"ok", db:"connected"}` on `127.0.0.1:8787` (a fresh 468 KB `mc.db` created, idempotent migrations ran on first boot, `MC_DEPLOYMENT_PROFILE=packaged`);
- **web** → HTTP 200 on `127.0.0.1:8788`;
- exactly the H0 behaviour, now from the compiled bundle.

`npm run dist:mac` is reproducible and produces a release-quality unsigned `.app` + `.dmg` with the correct `appId` (`ai.7ei.missioncontrol`), `productName` (`7Ei Mission Control`), **version from `package.json`** (`0.1.0` → `7Ei Mission Control-0.1.0-arm64.dmg`), and an **icon** (`build/icon.png`, the 1024² 7Ei mark, auto-converted to `icon.icns`).

### 16.4 Signing + notarization: WIRED but INERT (H1 goal #2)

Everything the sign/notarize run needs is present and structured so enabling it is **config/env only**:

| Piece | State in H1 | What the flip does |
|---|---|---|
| `mac.hardenedRuntime: true` | set now (a no-op until signing occurs) | takes effect on the first signed build |
| `mac.entitlements` / `entitlementsInherit` → `build/entitlements.mac.plist` | present; **minimal** (`allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables` only) | applied during the deep sign |
| `afterSign: scripts/notarize.cjs` | present; **self-skips** when unsigned or no notarytool creds (logged: `[notarize] skipped…`) | submits to Apple notary + electron-builder staples |
| `mac.identity` | not forced; `CSC_IDENTITY_AUTO_DISCOVERY=${CSC_IDENTITY_AUTO_DISCOVERY:-false}` in the `dist:mac`/`pack:mac` scripts defaults to a deterministic unsigned build | export `CSC_IDENTITY_AUTO_DISCOVERY=true` → electron-builder discovers + deep-signs with the Developer ID |
| `@electron/notarize` | present (transitive via electron-builder); lazily required only when notarizing | — |

**Deliberately NOT included** (correct per §3.3): `disable-library-validation` — the libSQL `.node` is bundled and gets **re-signed with the same Developer ID** during the deep sign, so library validation passes without weakening it. **TCC usage strings** (`NSMicrophoneUsageDescription`, …) are Info.plist keys owned by the **H2** first-run wizard, not this build stage.

### 16.5 EXACTLY what the Apple-account step adds (so it's a config flip, not a rebuild)

Once the operator has enrolled (H-Q1) and created a **Developer ID Application** certificate + a notarytool credential (H-Q2), enabling a Gatekeeper-clean `.dmg` is:

1. **Provide the cert** — `export CSC_LINK=<base64 of the .p12>` + `CSC_KEY_PASSWORD=<pw>` (or import the identity into the login Keychain).
2. **Provide notarytool creds** — either the App-Store-Connect **API key** (preferred): `APPLE_API_KEY=/path/AuthKey_XXXX.p8` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`; or an Apple-ID app-specific password: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
3. **Export `CSC_IDENTITY_AUTO_DISCOVERY=true`** for the run so electron-builder discovers the identity and deep-signs. The `dist:mac` script reads `CSC_IDENTITY_AUTO_DISCOVERY=${CSC_IDENTITY_AUTO_DISCOVERY:-false}` — it defaults to a deterministic unsigned build but honours the exported override, so no script edit is needed. (H1-audit fix: the script previously hard-set `=false` inline, which shadowed any exported override — an operator following the "override inline" runbook would have silently shipped an unsigned build.)
4. Run `npm run dist:mac`. electron-builder signs (hardened runtime + the entitlements already wired) → `scripts/notarize.cjs` submits to Apple → electron-builder staples → a **signed, notarized, Gatekeeper-clean** `.dmg`.

No YAML rearchitecture, no `main.cjs`/staging change. The only source edit is removing one env guard; everything else is credentials the assistant cannot create (same operator-only boundary as the Clerk/Fly console actions). This is mirrored in `GO-LIVE.md`.

### 16.6 Scope discipline + honest flags

- **Strictly the build pipeline.** No TCC wizard (H2), auto-update (H3), config seeding (H4), or loopback auth (H6) were built. Tray/menubar and dynamic ports were also left for a follow-on (the H0 fixed ports remain).
- **Packaged auth is STILL the temporary bypass.** No Clerk keys → `clerkPlugin` is skipped; the per-route `clerkAuth` still 401s tenant data, but this is **not** security-complete. **H6** builds the single-operator loopback identity + fail-closed-on-default-key. `main.cjs` still injects the throwaway `SECRETS_ENC_KEY` default — clearly flagged, do not treat as a secret.
- **The signed/notarized artifact does not exist yet** — the sign/notarize *run* is Apple-account-gated (H-Q1/H-Q2). H1 delivers everything up to that run.
- **Reproducibility caveat:** the pruned-externals install (`npm install` of the two pinned packages) resolves their transitive OCR/PDF deps fresh at build time; this needs registry access (or a warm cache via `--prefer-offline`). Pinning the two roots keeps the app code deterministic; a lockfile for the externals could be added if strict transitive pinning is later required.

### 16.7 Hosted build proven untouched

All changes live in `apps/desktop/` (+ docs). Verified: backend **1263/1263** tests · **11/11** evals · backend + web **typecheck clean** · the hosted `web` build (**no `DESKTOP_BUILD`**) compiles and emits **no `standalone`** dir. The Fly backend + Vercel web build/deploy exactly as before.

**Verdict: H1 delivers a reproducible, release-quality UNSIGNED `.app`/`.dmg` that boots the packaged mesh from a compiled backend, with the entire sign/notarize surface wired inert behind a one-env-flip. STOPPED for the independent H1 audit.**
