# Mission Control — Go-Live checklist

The single authoritative list of everything pending to take Mission Control from
"works for the founder in dev mode" to a hardened production setup. Most items are a
**user action** in a vendor console (Clerk, Google Cloud, NVIDIA, GitHub, Fly, the Mac
mini) or a **Fly secret** — the engineering to make each a one-step change is already
shipped; this doc gives the exact steps, env-var names, and where each is consumed.

Owner: Arturito · Last updated: 2026-07-15 (Epic ONB Stage 7 — consolidated; added remote-onboarding, wallet mainnet, local stack, Telegram, apex DNS, Jira-epics tracking)

> Companions: `docs/RUNBOOK-agent-onboarding.md` (how to onboard an agent), `docs/SECURITY-posture.md` (the security model), `STATUS.md` (what's shipped), `HANDOFF.md` (state of the app).

---

## The list

| # | Item | Category | Status | Risk if skipped | Effort |
|---|------|----------|--------|-----------------|--------|
| 1 | **`SECRETS_ENC_KEY` + `RUN_TOKEN_SECRET`** on Fly | Fly secret | ⏳ **pending** | Encrypted secrets decryptable with a source-visible key; run-tokens forgeable | ~5 min |
| 2 | Clerk **production** instance | Vendor console | ⏳ pending | Dev keys rate-limit + dev banner; anyone can sign up | ~20 min |
| 3 | Google consent screen — Gmail/Calendar scopes | Vendor console | ⏳ pending | Gmail/Calendar connectors can't read data | ~15 min |
| 4 | Rotate exposed tokens (NVIDIA key, vault PAT) | Vendor console | ⏳ pending | Leaked creds usable by anyone who saw them | ~15 min |
| 5 | Move OpenClaw to the Mac mini | Host | ⏳ pending | Agent dies when the laptop sleeps/closes | ~10 min |
| 6 | **`GITHUB_VAULT_TOKEN`** (shared-memory writes) | Fly secret / Connector | ⏳ pending | Memory-bus features stay dormant | ~5 min |
| 7 | **`WEBHOOK_SIGNING_SECRET`** on Fly | Fly secret | ⏳ pending | Inbound webhook receivers open in dev; blocks Telegram + webhook runtimes | ~5 min |
| 8 | **`MC_ENABLE_REMOTE_ONBOARDING`** (open public join) | Fly secret | ⏳ pending (safe OFF) | Remote invite-onboarding stays 404 on the hosted backend | ~2 min |
| 9 | Telegram bot token (D-epic remote surface) | Vendor console + Fly | ⏳ pending | No iPhone/Telegram remote control | ~15 min |
| 10 | Local LLM/STT/TTS stack (Ollama · whisper.cpp · Piper) | Host | ⏳ pending | Arturita voice/answer path falls back to cloud (or fails off-Mac) | ~20 min |
| 11 | **`WALLET_MAINNET_ENABLED`** — wallet is testnet-only | Fly secret | ⏳ pending (intentionally OFF) | (leaving OFF is the safe state) — enable only deliberately | ~5 min |
| 12 | Apex DNS for `7ei.ai` → the `llms.txt` mirror | DNS | ⏳ pending | `llms.txt` discovery only at the app subdomain | ~10 min |
| 13 | Bring up a **Claude Code** engineering agent (Epic CC) | Host | ⚪ optional | The office can't assign coding work to Claude Code | ~10 min |
| 14 | File the epics as Jira (MCA) issues | Tracking | ⏳ pending | Epics A–H + ONB have no issue numbers | ~30 min |
| 15 | Audit trail — **ON** (tuning only) | — | ✅ done | — | — |
| 16 | Multi-tenant membership — **ENFORCED** (no action) | — | ✅ done | — | — |
| 17 | **Packaged desktop app — Apple Developer ID** (sign + notarize the `.dmg`) | Vendor console + build env | ⚪ optional (Epic H) | The `.dmg` opens only via right-click→Open (Gatekeeper warns "cannot check for malware") | ~30 min + $99/yr |
| 18 | **Branch protection on `main`** — make the CI checks actually block | Vendor console (GitHub) | ⏳ **pending** | **Every check is advisory today**: a red build — incl. the mobile parity tripwires — can be merged straight past | ~5 min |

**Legend:** ⏳ pending · ⚪ optional · ✅ done. Items 1–12 + 14 + 18 are the real pending
list; 13 + 17 are optional (17 only matters once you distribute the desktop app); 15–16
are shipped and here only for completeness.

---

## 1. `SECRETS_ENC_KEY` + `RUN_TOKEN_SECRET` on Fly — do this FIRST

> 🛑 **Read [`docs/RUNBOOK-secrets-golive.md`](docs/RUNBOOK-secrets-golive.md) before running the command below.**
> This section is correct but incomplete in one dangerous way: if the secret store is **already
> populated** under the fallback key, setting a new key **orphans** every existing row (there is no
> re-encryption path — `decrypt()` only ever tries the current key). The runbook has the read-only
> count query that tells you which case you are in, and the ordered wipe-and-re-enter procedure for
> when you are in the bad one. It also covers `agent_oauth_tokens` (per-agent Google **refresh**
> tokens, CONN-5), which the re-entry list below predates and does not mention.

The at-rest secret store (`backend/src/services/secrets.ts`) derives its AES-256-GCM
key from `SECRETS_ENC_KEY`; the per-run HMAC tokens (`backend/src/routes/agent-api.ts`)
sign with `RUN_TOKEN_SECRET || SECRETS_ENC_KEY`. **Both fall back to a hard-coded public
default** (`'dev-7ei-mc-secrets-key'` / `'dev-7ei-mc-run'`) when unset — fine for dev,
but in production it means every encrypted secret in the DB is decryptable with a key
that lives in the source, and run-tokens are forgeable.

```bash
flyctl secrets set \
  SECRETS_ENC_KEY=$(openssl rand -hex 32) \
  RUN_TOKEN_SECRET=$(openssl rand -hex 32) \
  --app 7ei-backend
```
Verify with `bash scripts/check-secrets.sh` (both now listed).

> ⚠️ Set these **before** encrypting any secret via Cockpit → Secrets. Anything already
> stored under the dev default won't decrypt under a new key — re-enter those secrets
> (NVIDIA key, vault PAT, custom-model keys) after rotating.
>
> Engineering follow-up: a boot-time fail-closed guard on the default key. **Shipped for
> the PACKAGED profile (Epic H / H6)** — `backend/src/services/secret-keys.ts`
> `assertSecretKeysSafe()` refuses to boot a `packaged` instance whose `SECRETS_ENC_KEY`
> / `RUN_TOKEN_SECRET` / `MC_LOOPBACK_SESSION_SECRET` is missing or a known default, so a
> `.dmg` install can never encrypt a real secret under the source-visible key (the
> Electron shell generates real per-install keys into the macOS Keychain). It is a
> **no-op on hosted** — hosted still relies on setting the Fly secrets above (a hosted
> instance runs with a real key by construction, so the guard has nothing to catch).

---

## 2. Clerk production instance

The web app (`app.7ei.ai`, Vercel) runs on a Clerk **development** instance. Production
needs its own instance + keys.

**Steps (Clerk dashboard → your app):**
1. Create a **Production** instance ("Deploy to production").
2. Add `app.7ei.ai` as the production domain; complete the DNS records Clerk shows
   (CNAMEs for `clerk.`, `accounts.`, etc.).
3. Configure the production sign-in/up methods and (optionally) restrict sign-ups to the
   `7ei.ai` domain.
4. Copy the **production** keys.

**Set on Vercel (Project → Settings → Environment Variables, Production):**

| var | value |
|-----|-------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_…` |
| `CLERK_SECRET_KEY` | `sk_live_…` |

Keep `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `NEXT_PUBLIC_API_URL` as-is. Redeploy the web
project. Verify: sign out, sign back in on `app.7ei.ai` — the dev banner is gone.

> Prohibited for the assistant: creating the Clerk account/instance and entering keys is
> yours — I can't create accounts or enter credentials.

---

## 3. Google OAuth consent screen — Gmail + Calendar scopes

The Google connector already **requests** the full scope set (`backend/src/services/google-auth.ts`):
`openid`, `userinfo.email`, `userinfo.profile`, `drive.readonly`, `drive.file`,
`gmail.readonly` ←sensitive, `gmail.send` ←sensitive, `calendar.events` ←sensitive.

**Steps (Google Cloud Console → the project holding `GOOGLE_CLIENT_ID`):**
1. **APIs & Services → Enabled APIs:** enable **Gmail API** and **Google Calendar API**
   (Drive already enabled).
2. **OAuth consent screen → Data access → Add or remove scopes:** add `gmail.readonly`,
   `gmail.send`, `calendar.events`.
3. Fastest path for a small team: keep the app in **Testing** mode and add each user
   (e.g. `arturito@7ei.ai`) under **Test users** — sensitive scopes work immediately for
   listed testers, no Google verification needed. (To go fully public later, **Publish**
   and complete sensitive-scope verification.)
4. Confirm the **Authorized redirect URI** matches `${PUBLIC_URL}/api/auth/google/callback`
   (i.e. `https://7ei-backend.fly.dev/api/auth/google/callback`).

**Backend env (Fly `7ei-backend` — already set, confirm):** `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`. Verify: Connectors → Google → Connect, approve, then
**Test** Gmail and Calendar.

---

## 4. Rotate exposed tokens

Two secrets were handled in plaintext during setup and should be rotated. **I can't
rotate these for you** — do the rotate in each console, then paste the new value into the
app's encrypted store or Fly secrets.

**4a. NVIDIA NIM API key (the MiniMax brain / hosted Chatterbox TTS)**
- Rotate: NVIDIA NGC / build.nvidia.com → API keys → revoke the old → generate a new
  `nvapi-…`.
- Store it **once**, encrypted: Cockpit → Secrets → set `MC_LLM_API_KEY`. The adapter
  pulls it at boot via `GET /api/agent/secrets` and injects it — so **no plaintext key
  lives in `mc.env`** on any host.
- Remove any lingering `MC_LLM_API_KEY=nvapi-…` from `~/.openclaw/mc-adapter/mc.env` on
  every host, then restart the adapter.

**4b. Vault GitHub PAT (agent shared-memory writes) — see also item 6**
- Rotate: GitHub → Settings → Developer settings → PATs → regenerate the token for
  `Arturito7ei/7Ei-MC_TARCO`. Give it **Contents read/write** on that repo.
- Store it: Connectors → Obsidian Vault (secret-store key `GITHUB_VAULT_TOKEN`, part of
  `VAULT_CONFIG`). Test the connector.

> After rotating, old values in chat scrollback / local files are dead. Don't paste live
> secrets into chat again.

---

## 5. Move OpenClaw to the Mac mini

Run the always-on adapter on the Mac mini instead of the laptop.

1. On the Mac mini, check out the repo (or copy `adapters/`).
2. Mint a fresh agent token: app → Cockpit → the OpenClaw agent → rotate token
   (`POST /api/agents/:id/rotate-token`). This invalidates the laptop's token.
3. Install in one command:
   ```bash
   cd 7Ei-Mission_Control_App/adapters/mac-mini
   MC_AGENT_TOKEN=mca_xxx ./setup.sh --preset nvidia-minimax --yes
   ```
   Installs `mc_adapter.py`, writes `~/.openclaw/mc-adapter/mc.env` (chmod 600, **no LLM
   key** — pulled from the store per §4a), loads the launchd keep-alive, runs a smoke test.
4. On the **laptop**, stop the old service:
   `launchctl unload ~/Library/LaunchAgents/com.7ei.mc-adapter.plist`
5. Verify on the Mac mini: `tail -f ~/.openclaw/mc-adapter/adapter.log`, watch a heartbeat
   go green, assign a test task to **done**.

See `adapters/mac-mini/README.md`.

### Shell-execution default (Epic ONB, audit M5) — new agents are shell-OFF

The shell default is **OFF for new agents** (the operator's M5 call). Enforcement is
**client-side only** — the adapter's local `MC_ALLOW_SHELL` decides; no server gate reads
a stored `allowShell` — so this **cannot** affect an already-running agent.

- **UI-onboarded agents:** the paste-able `mc.env` ships `MC_ALLOW_SHELL=0`. Tick the
  advanced **"Allow shell execution on the host"** checkbox to flip it to `=1`.
- **The live OpenClaw ops agent is GRANDFATHERED** — its `mc.env` is untouched; it keeps
  whatever posture it was installed with.
- **The mac-mini installer (`setup.sh`) still defaults `MC_ALLOW_SHELL=1`** (its `shell`
  preset — a deliberate shell-executor setup; `--no-shell` disables). Left as-is on
  purpose so the §5 re-install path stays stable. ⚠️ To also default the CLI installer
  shell-OFF: flip `ALLOW_SHELL="0"` in `adapters/mac-mini/setup.sh`, add a `--shell`
  opt-in, and pass it here for the ops agent.

---

## 6. `GITHUB_VAULT_TOKEN` — shared memory / vault writes

Memory-bus features (agent shared-memory writes to the Obsidian vault, the in-app Memory
graph) stay **dormant until `GITHUB_VAULT_TOKEN` is set**. This is the same token as §4b
(rotate + store). Set it via Connectors → Obsidian Vault or the secret store. Without it,
the zero-auth static vault-graph preview (`app.7ei.ai/vault-graph.html`) still renders,
but live memory reads/writes don't.

---

## 7. `WEBHOOK_SIGNING_SECRET` on Fly

Inbound webhook receivers verify a per-org HMAC shared secret (`services/webhook-auth.ts`),
gated on `WEBHOOK_SIGNING_SECRET`. Until set, receivers are **open in dev**. It is a hard
prerequisite for the Telegram remote surface (§9) and any future push/webhook runtime
(ONB5). Set it, then **re-register integrations** so they carry the signature.

```bash
flyctl secrets set WEBHOOK_SIGNING_SECRET=$(openssl rand -hex 32) --app 7ei-backend
```

---

## 8. `MC_ENABLE_REMOTE_ONBOARDING` — open the public join surface

The invite-based onboarding machinery (Epic ONB) is fully built and tested, but on the
**hosted** backend the onboarding document, join, and claim routes answer a **flat 404
until this is set** — the safe default. (A **packaged/loopback** deployment has them open
by default.) Full flow: `docs/RUNBOOK-agent-onboarding.md`.

```bash
flyctl secrets set MC_ENABLE_REMOTE_ONBOARDING=1 --app 7ei-backend
```

> Set this **only after** the onboarding security prerequisites are true — they are, as
> of ONB4: approval gate, single-use invites, short TTL, per-IP rate limit (wired, on),
> low-trust containment, no-oracle flat-404 failures. See `docs/SECURITY-posture.md` §2.
> Leaving it OFF is a valid, safe posture — the manual Add-Agent/Hire wizard and legacy
> `7ei-mc onboard` still work without it.

---

## 9. Telegram bot token (D-epic remote surface)

Arturita's iPhone/remote surface v1 is Telegram-only (voice notes, text, files, one-tap
approvals). Blocked on two things:
1. **`WEBHOOK_SIGNING_SECRET`** (§7) — a hard prerequisite for the HMAC Telegram receiver.
2. A **Telegram bot token** from @BotFather, stored in the encrypted store / Fly secret,
   with the webhook pointed at the backend receiver.

D1/D2 are otherwise `todo` in the tracker (`docs/PLAN-arturita.md` §0). Until both are in
place, remote control degrades honestly.

---

## 10. Local LLM / STT / TTS stack (Arturita voice + answer path)

Arturita is **local-first** by default (`DEFAULT_LLM_CHAIN` is Ollama-first; STT is
whisper-first). To make the fully-local path work on the operator's machine:

- **LLM (Ollama):** set `OLLAMA_ORIGINS=https://app.7ei.ai` and restart Ollama, so the
  browser-direct local streaming path can reach it (real tokens, on-device, $0; cloud
  fallback if absent). Off the operator's Ollama machine, live talk falls back to a cloud
  key — set optional `GROQ_API_KEY` / `GEMINI_API_KEY` (free-tier) as fallbacks.
- **STT (local Whisper):** "Speech Error: network" in Brave = the browser disabled Web
  Speech STT. Start the zero-dep local Whisper bridge — `adapters/arturita-stt` (one
  command) — for a working local STT leg. whisper.cpp is the host engine.
- **TTS:** browser `SpeechSynthesis` is the zero-install default; Piper / local-Chatterbox
  are the local host engines; NVIDIA-hosted Chatterbox uses `MC_LLM_API_KEY` (§4a).

> Per-org overrides can pin a cloud key even when the default is local — reset via the
> Arturita ⚙ Pipeline config if live talk unexpectedly needs cloud. Invariants (local-first
> LLM + whisper-first STT) are test-locked.

---

## 11. `WALLET_MAINNET_ENABLED` — wallet is testnet-only (leave OFF unless deliberate)

The wallet ships **read / prepare / simulate + testnet-only signing**. The policy engine
allows bounded autonomous signing (**< $100** per-tx from a dedicated capped burner;
**≥ $100 → A2 approval**), but **mainnet signing is blocked** — `wallet-policy.ts` returns
`signing blocked: mainnet disabled this wave (WALLET_MAINNET_ENABLED=false)`.

To enable mainnet (a deliberate, high-consequence step — not part of a routine go-live):
1. Set `WALLET_MAINNET_ENABLED=true` on Fly.
2. Fund the dedicated **capped burner** wallet (never a primary wallet).
3. Confirm the WalletConnect id + the live testnet signer wiring first (E2 follow-up).
4. Re-verify the per-tx caps and the A2 approval threshold in `wallet_policy`.

See `docs/WALLET-KEYSTORE-arturita.md` and `docs/DECISIONS-arturita.md` (S4). **No mainnet
signing, no key in code today** — every dangerous path stays behind the A2 gate.

---

## 12. Apex DNS for `7ei.ai` → the `llms.txt` mirror

The self-describing `llms.txt` (MCA-85 D2) is served at the app subdomain. To also serve
it at the apex (`7ei.ai/llms.txt`) for discovery, add the apex DNS record pointing at the
mirror. Cosmetic/discovery only — the app-subdomain copy already works.

---

## 13. Claude Code engineering agent (Epic CC) — optional

Makes Claude Code a first-class fleet member the office can assign coding work to
(`docs/DESIGN-claude-code-agent.md`; adapter `adapters/claude-code/`). Runs on any host
with the `claude` CLI — **not** the OpenClaw box; never touches `~/.openclaw/`.

**Prereqs (on the host):** `claude` CLI installed + authenticated (its own login or
`ANTHROPIC_API_KEY`); `python3` on PATH (stdlib only).

**Steps:**
1. **Onboard** a `claude_code` agent — via an invite (`docs/RUNBOOK-agent-onboarding.md`
   §4b, the safe path) or Cockpit → Add agent → 🤖 Claude Code / `npx @7ei/mc onboard
   --runtime claude_code`. Registration is **secure-by-default** (CC3): `low_trust_review`
   + explicit capability list + workspace boundary.
2. **Install** on the host:
   ```bash
   cd adapters/claude-code
   MC_AGENT_TOKEN=mca_… MC_WORKDIR=/path/to/checkout ./setup.sh
   ```
   Writes a chmod-600 `mc.env`, prints posture (`--doctor`), smoke-polls, loads a launchd
   keep-alive — all **propose-and-approve**.
3. The agent claims assigned tasks and **proposes** — **no host commands run without an A2
   approval** (verbatim `argv` + fresh-session step-up).

**Enabling autonomous execution (optional, later, OFF by default):** fail-closed behind
**two operator guards + the CC5 denylist**. Only when you deliberately choose to, add to
`mc.env`:
```
CC_PERMISSION_MODE=bypassPermissions
CC_AUTONOMOUS=1
CC_AUTONOMOUS_CONFIRM=1
```
then `python3 cc_adapter.py --doctor` → posture `AUTONOMOUS`. Even then, every command
passes the CC5 denylist (catastrophic/privilege/exfil/reverse-shell **refused**; unknown
**proposed**; only allowlisted read-only commands run un-attended). Run against an isolated
`cc/` worktree. Remove those three lines (or `/panic`) to revert. Details:
`adapters/claude-code/README.md`.

---

## 14. File the epics as Jira (MCA) issues

Several epics were designed and shipped in build sessions where Atlassian Rovo OAuth is
unavailable, so they have **no MCA issue numbers**: the Arturita epics **A–G**, packaging
epic **H**, and **Epic ONB** (invite-based onboarding). File them interactively in Jira
(projects MCA + OS, cloudId `5dadc567-085a-4cd8-99a3-c0bd9886fee9`) and back-fill the
numbers into `docs/PLAN-arturita.md` §0. Also pending: Jira transitions on shipped work.

---

## 15. Audit trail — ✅ ON (tuning only)

The audit trail is **LIVE** for the sensitive half — every mutating method (POST/PUT/
PATCH/DELETE) plus the onboarding/invite/join/approval surfaces — with **90-day
retention**. The read-only `GET` flood is not recorded; high-frequency agent-runtime writes
(heartbeat/run-log/messages) are excluded. Telemetry is deliberately **OFF** (a separate
in-memory concern). Full model: `docs/SECURITY-posture.md` §5.

**Tune it:**
- **Retention:** `MC_AUDIT_RETENTION_DAYS` (Fly secret), a whole number ≥ 1; junk / 0 /
  negative / sub-one-day safe-defaults to **90** so a typo can't wipe the table. Rows older
  than the window are pruned on a daily scheduler tick (~03:00 UTC).
- **Scope:** edit `shouldAudit(method, path)` in `middleware/audit-log.ts`. When unsure
  whether an endpoint is security-relevant, KEEP it (be conservative).
- **Recurring-write exclusions:** `isHighFrequencyAgentWrite()` denylists heartbeat /
  run-log / messages. Add a path to skip more; remove one to audit it again.
- **Turn off:** revert the `auditLogPlugin(app)` hoist in `src/index.ts` back to an
  encapsulated `app.register(auditLogPlugin)` — the `[ONB2-H1]` tripwire guards either way.

**Cost, honestly:** one fire-and-forget Turso `INSERT` per sensitive request (writes + the
low-volume onboarding surfaces), minus the recurring agent-runtime writes. The insert is
`.catch()`-swallowed, so it can never add latency to or fail the request it records.

> The hardening that made this safe (query routes owner-gated + tenant-isolated,
> `sanitizeBody` recurses over the registry secret detector, path/telemetry redaction) is
> all on main. Details + history: `docs/AUDIT-audit-trail.md`, `docs/AUDIT-ONB2-hardening.md`.

---

## 16. Multi-tenant membership — ✅ ENFORCED surface-wide (no operator action)

Org membership is enforced on every Clerk-authed `/api/orgs/:orgId/*` route, the
`:agentId`/`:taskId` record-derived tail, **and the ~25 top-level record routes** (R-4 +
HIGH-1) by one scope-level gate (`requireOrgMembership`). Fail-closed — a missing/foreign
record → 403 — and a leak-guard fails CI if any new secured route ships ungated.

**Your own access is grandfathered automatically** — `enforceOrgRole` honours an org's
`ownerId` as an implicit owner, so you keep full access with no migration or backfill. Only
a non-member/wrong-org request newly gets a 403. If you add a second human to an org, give
them an `org_members` row. Full model: `docs/SECURITY-posture.md` §4, `docs/AUDIT-MCA-membership.md`.

---

## 17. Packaged desktop app — when you have the Apple Developer ID

> Only relevant if you distribute the **desktop app** (Epic H, `apps/desktop/`). The
> build pipeline is done (H1): `npm run dist:mac` already produces a reproducible,
> release-quality **UNSIGNED** `.app` + `.dmg` that boots the packaged mesh. This step
> makes that `.dmg` open on someone else's Mac with **no Gatekeeper warning**. Nothing
> in the repo needs rearchitecting — signing is fully wired and inert; this is a
> credential + one-env-flip step. (`docs/DESIGN-packaging.md` §16.)

**Why it's yours, not mine:** enrolling in the Apple Developer Program, creating a
certificate, and generating a notarytool credential are vendor-console + payment actions
— the same boundary as the Clerk/Fly/Google steps above. The assistant scripted the whole
build/sign/notarize pipeline; it cannot create the account or the cert.

**One-time setup (operator):**
1. **Enroll** in the Apple Developer Program ($99/yr) — https://developer.apple.com/programs/ (H-Q1).
2. Create a **"Developer ID Application"** certificate (Apple Developer portal → Certificates, or Xcode → Settings → Accounts → Manage Certificates). Export it as a password-protected `.p12`, or leave it in your login Keychain (H-Q2).
3. Create a **notarytool credential** — preferred: an **App Store Connect API key** (Users and Access → Integrations → App Store Connect API → generate a key with the *Developer* role; download the `AuthKey_XXXX.p8`, note the Key ID + Issuer ID). Alternative: an **app-specific password** for your Apple ID (appleid.apple.com → Sign-In and Security → App-Specific Passwords).

**Each release (the flip — no code change beyond dropping one env guard):**
```bash
cd apps/desktop

# 1. The Developer ID cert (either export the .p12 + set these, or rely on the login Keychain)
export CSC_LINK="$(base64 -i /path/to/DeveloperIDApplication.p12)"
export CSC_KEY_PASSWORD="<the .p12 password>"

# 2. notarytool creds — API key (preferred)…
export APPLE_API_KEY="/path/to/AuthKey_XXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#    …or an Apple-ID app-specific password instead of the three above:
# export APPLE_ID="you@apple.id"
# export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
# export APPLE_TEAM_ID="TEAMID"

# 3. Enable signing. The dist:mac script defaults CSC_IDENTITY_AUTO_DISCOVERY to
#    `false` (a deterministic UNSIGNED build) but honours an exported override, so
#    export it true for this run — no script edit needed:
CSC_IDENTITY_AUTO_DISCOVERY=true npm run dist:mac
#    (After signing, VERIFY: `spctl -a -vv "dist/mac-arm64/7Ei Mission Control.app"`
#     must report `source=Notarized Developer ID` — a bare "accepted" or an
#     "unsigned" result means the flip did not take and you'd otherwise ship an
#     unsigned/unnotarized app that Gatekeeper blocks on other Macs.)
```
electron-builder deep-signs the app with your Developer ID (hardened runtime + the
already-wired `build/entitlements.mac.plist`), `scripts/notarize.cjs` submits it to Apple's
notary service, and electron-builder staples the ticket → a **signed, notarized,
Gatekeeper-clean `.dmg`**. Verify with `spctl -a -vv "dist/mac-arm64/7Ei Mission Control.app"`
(expect `accepted / source=Notarized Developer ID`).

**Runtime auth vs distribution trust — both now handled:** sign/notarize is about
*distribution trust* (Gatekeeper accepts the download); *runtime auth* is a separate thing
and is now built. **H6 (2026-07-15) landed real packaged auth** — a single-operator
**loopback identity** replaces Clerk on `127.0.0.1`, per-install `SECRETS_ENC_KEY` /
`RUN_TOKEN_SECRET` / `MC_LOOPBACK_SESSION_SECRET` are generated into the **macOS Keychain**
(never baked into the `.dmg`), and boot **fails closed** on any default/missing key. The
packaged app is no longer an unauthenticated bypass — it enforces an authenticated local
operator that gates the same write routes Clerk gates on hosted. **No operator action is
required for H6** — the shell generates the keys on first boot; the only packaged
operator step remains the Apple Developer ID above (for a Gatekeeper-clean download).

---

## 18. Branch protection on `main` — make the CI checks actually block

**Status today: there is none.** Verified against the live repo:

```bash
gh api repos/Arturito7ei/7Ei-Mission_Control_App/branches/main/protection   # → 404 "Branch not protected"
gh api repos/Arturito7ei/7Ei-Mission_Control_App/rulesets                   # → []
```

**So every check in this repo is advisory.** CI runs, CI reports, CI goes red — and the
merge proceeds anyway. `CI-MOB-1` (2026-07-16) added the **`Mobile (apps/mobile)`** job so
that mobile parity drift finally *shows up* (before it, the tripwires never ran and #286's
nav drift sat red on `main` unseen). But **visible ≠ blocked**: that job is only a true gate
once `main` is protected and the check is marked required.

**The steps (GitHub Settings — yours, not mine):**

1. **Settings → Branches → Add branch protection rule**, branch name pattern `main`.
2. Tick **Require status checks to pass before merging** (+ *Require branches to be up to date*).
3. In the search box, add these as **required** — the names must match the job names exactly:
   - `Mobile (apps/mobile)` ← the parity tripwires
   - `Install check (backend)` · `Install check (web)` · `Install check (app)`
   - `Backend unit tests`
4. Save.

> ### ⚠️ Do NOT require `npm audit`
> The **`npm audit`** check (`security.yml`) **fails on essentially every PR** and is
> knowingly non-blocking — that's why the merge convention here is `--squash --admin`.
> Requiring it would wedge every merge in the repo. Same for `Outdated dependencies`
> (informational, `|| true`). Require only the five functional checks above.

**Note on `--admin`:** the house convention squash-merges with `gh pr merge --admin`, which
*bypasses* protection by design. Protection still earns its keep — it makes the bypass a
**deliberate, logged act** rather than the silent default, which is exactly the difference
between "we chose to ship past a red mobile check" and "nobody noticed it was red."

**Risk if skipped:** the state we're in now — the parity rule is enforced by attentiveness.

---

## Assistant boundaries (why some steps are yours)

Per the operating rules, I don't create accounts, enter passwords/keys, complete OAuth
consent, change account settings, or rotate/enter credentials on your behalf. Everything I
*can* automate — the adapter hardening, the one-command installer, this runbook — is done;
the console/secret actions above are the ones only you can perform.
