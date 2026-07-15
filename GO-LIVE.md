# Mission Control — Go-Live Runbook

Operational steps to take Mission Control from "works for the founder in dev
mode" to a hardened production setup. Each item is a **user action** in a vendor
console (Clerk, Google Cloud, NVIDIA, GitHub, the Mac mini) — the engineering to
make each a one-step change is already shipped; this doc gives the exact steps,
env-var names, and where they're consumed.

Owner: Arturito · Last updated: 2026-07-13 (added item 6 — Claude Code agent, Epic CC)

| # | Item | Risk if skipped | Effort |
|---|------|-----------------|--------|
| 1 | Clerk **production** instance | Dev keys rate-limit + show a dev banner; anyone can sign up | ~20 min |
| 2 | Google consent screen: Gmail/Calendar scopes | Gmail/Calendar connectors can't read data | ~15 min |
| 3 | Rotate exposed tokens (NVIDIA key, vault PAT) | Leaked creds usable by anyone who saw them | ~15 min |
| 4 | Move OpenClaw to the Mac mini | Agent dies when the laptop sleeps/closes | ~10 min |
| 5 | Set `SECRETS_ENC_KEY` + `RUN_TOKEN_SECRET` on Fly | At-rest secret store & run-token HMAC fall back to a **public** default key → encrypted secrets decryptable / run-tokens forgeable | ~5 min |
| 6 | Bring up a **Claude Code** engineering agent (Epic CC) | The office can't assign coding work to Claude Code | ~10 min |

---

## 6. Claude Code engineering agent (Epic CC)

Makes Claude Code a first-class fleet member the office can assign tasks to
(`docs/DESIGN-claude-code-agent.md`; adapter `adapters/claude-code/`). It runs on
any host with the `claude` CLI — **not** the OpenClaw box; it never touches
`~/.openclaw/`.

**Prereqs (on the host that will run the agent):**
1. Install + log in to the **Claude Code CLI** (`claude --version`; `claude` must
   be authenticated — its own login or `ANTHROPIC_API_KEY`).
2. `python3` on PATH (stdlib only; no pip).

**Steps:**
1. **Onboard** a `claude_code` agent (Cockpit → Add agent → 🤖 Claude Code, or
   `npx @7ei/mc onboard --org <id> --runtime claude_code --name "Claude Code"`).
   Copy the one-time `mca_` token. Registration is **secure-by-default** (CC3):
   the agent lands `low_trust_review` with an explicit capability list + a
   boundary from the target workspace — not allow-all.
2. **Install** on the host:
   ```bash
   cd adapters/claude-code
   MC_AGENT_TOKEN=mca_… MC_WORKDIR=/path/to/checkout ./setup.sh
   ```
   This writes a chmod-600 `mc.env`, prints the posture (`--doctor`), smoke-polls
   once, and loads a launchd keep-alive — all **propose-and-approve**.
3. The agent now claims assigned tasks and **proposes** — it runs **no host
   commands without an A2 approval** (verbatim `argv` + fresh-session step-up).

**Enabling autonomous execution (optional, later, OFF by default):**
Autonomy is fail-closed behind **two operator guards + the CC5 command
denylist**. Only when you deliberately choose to, add to `mc.env`:
```
CC_PERMISSION_MODE=bypassPermissions
CC_AUTONOMOUS=1
CC_AUTONOMOUS_CONFIRM=1
```
then `python3 cc_adapter.py --doctor` → posture `AUTONOMOUS`. Even then, every
command passes the CC5 denylist (catastrophic/privilege/exfil/reverse-shell are
**refused**; unknown commands are still **proposed**; only allowlisted read-only
commands run un-attended). Run against an **isolated `cc/` worktree** so file
edits are reviewable as a diff. Remove those three lines to revert; `/panic` or
pausing the agent also stops it. Details: `adapters/claude-code/README.md`.

---

## 1. Clerk production instance

The web app (`app.7ei.ai`, Vercel) currently runs on a Clerk **development**
instance. Production needs its own instance + keys.

**Steps (Clerk dashboard → your app):**
1. Create a **Production** instance (or "Deploy to production").
2. Add `app.7ei.ai` as the production domain; complete the DNS records Clerk
   shows (CNAMEs for `clerk.`, `accounts.`, etc.).
3. Configure the production sign-in/up methods and (optionally) restrict sign-ups
   to the `7ei.ai` domain.
4. Copy the **production** keys.

**Set on Vercel (Project → Settings → Environment Variables, Production):**

| var | value |
|-----|-------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_…` |
| `CLERK_SECRET_KEY` | `sk_live_…` |

Keep `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `NEXT_PUBLIC_API_URL` as-is. Redeploy the
web project so the new env is baked in. Verify: sign out, sign back in on
`app.7ei.ai` — the dev banner is gone and the URL is your Clerk prod domain.

> Prohibited for the assistant: creating the Clerk account/instance and entering
> keys must be done by you. I can't create accounts or enter credentials.

---

## 2. Google OAuth consent screen — Gmail + Calendar scopes

The Google connector already **requests** the full scope set (see
`backend/src/services/google-auth.ts`):

```
openid
.../auth/userinfo.email
.../auth/userinfo.profile
.../auth/drive.readonly
.../auth/drive.file
.../auth/gmail.readonly     ← sensitive
.../auth/gmail.send         ← sensitive
.../auth/calendar.events    ← sensitive
```

Google won't grant the sensitive ones until they're listed on the OAuth consent
screen and (for an External/published app) the app passes verification.

**Steps (Google Cloud Console → the project holding `GOOGLE_CLIENT_ID`):**
1. **APIs & Services → Enabled APIs**: enable **Gmail API** and **Google
   Calendar API** (Drive already enabled).
2. **OAuth consent screen → Data access / Scopes → Add or remove scopes**: add
   `gmail.readonly`, `gmail.send`, `calendar.events` (Drive scopes already there).
3. Fastest path for a small team: keep the app in **Testing** mode and add each
   user (e.g. `arturito@7ei.ai`) under **Test users** — sensitive scopes work
   immediately for listed testers, no Google verification needed.
   - To go fully public later, **Publish** the app and complete Google's
     sensitive-scope verification (privacy policy URL, demo video, etc.).
4. Confirm the **Authorized redirect URI** matches
   `${PUBLIC_URL}/api/auth/google/callback` — i.e.
   `https://7ei-backend.fly.dev/api/auth/google/callback` (or your custom API
   domain if `PUBLIC_URL` differs).

**Backend env (Fly `7ei-backend` — already set, confirm values):**
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`.

Verify: **Connectors → Google → Connect**, approve the consent screen, then hit
**Test** on Gmail and Calendar — both should return data.

---

## 3. Rotate exposed tokens

Two secrets were handled in plaintext during setup and should be rotated. **I
can't rotate these for you** (that means authenticating to vendor consoles and
minting credentials) — do the rotate in each console, then paste the new value
into the app's encrypted store or Fly secrets as noted.

### 3a. NVIDIA NIM API key (the MiniMax brain)
- Rotate: **NVIDIA NGC / build.nvidia.com → API keys → revoke the old key →
  generate a new one** (`nvapi-…`).
- Store it **once**, encrypted, in the app: **Cockpit → Secrets → set
  `MC_LLM_API_KEY`** to the new key. The adapter pulls it at boot via
  `GET /api/agent/secrets` and injects it into its env — so **no plaintext key
  needs to live in `mc.env`** on any adapter host (this is the hardening in
  `adapters/openclaw/mc_adapter.py`: `llm_chat()` and the `auto` executor read
  `MC_LLM_API_KEY` from the environment at call time).
- Remove any lingering `MC_LLM_API_KEY=nvapi-…` line from
  `~/.openclaw/mc-adapter/mc.env` on every host, then restart the adapter.

### 3b. Vault GitHub PAT (agent shared-memory writes)
- Rotate: **GitHub → Settings → Developer settings → Personal access tokens →
  regenerate** the token used for `Arturito7ei/7Ei-MC_TARCO`. Give it **repo
  write** scope (fine-grained: Contents read/write on that repo) so agents can
  commit memory.
- Store it in the app: **Connectors → Obsidian Vault** (or the secret store key
  `GITHUB_VAULT_TOKEN`, part of `VAULT_CONFIG`). Test the connector — the tree
  should list and a write should commit.

> After rotating, the old values in any chat scrollback or local file are dead.
> Don't paste live secrets into chat again — set them directly in the console /
> the app's Secrets UI.

---

## 4. Move OpenClaw to the Mac mini

Run the always-on adapter on the Mac mini instead of the laptop.

1. On the Mac mini, check out the repo (or copy the `adapters/` folder).
2. Mint a fresh agent token: **app → Cockpit → the OpenClaw agent → rotate
   token** (`POST /api/agents/:id/rotate-token`). This also invalidates the
   laptop's token.
3. Install in one command:
   ```bash
   cd 7Ei-Mission_Control_App/adapters/mac-mini
   MC_AGENT_TOKEN=mca_xxx ./setup.sh --preset nvidia-minimax --yes
   ```
   It installs `mc_adapter.py`, writes `~/.openclaw/mc-adapter/mc.env`
   (chmod 600, **no LLM key** — pulled from the secret store per §3a), renders +
   loads the launchd keep-alive, and runs a one-pass smoke test.
4. On the **laptop**, stop the old service so two hosts don't double-claim:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.7ei.mc-adapter.plist
   ```
5. Verify on the Mac mini: `tail -f ~/.openclaw/mc-adapter/adapter.log` and watch
   a heartbeat go green in the app's Cockpit. Assign a test task and confirm it
   reaches **done**.

See `adapters/mac-mini/README.md` for flags and operations.

### Shell-execution default (Epic ONB, audit M5) — new agents are shell-OFF

The shell-execution default was aligned to **OFF for new agents** (the operator's
M5 call). What this means for onboarding:

- **UI-onboarded agents (Cockpit → Add agent / Hire):** the paste-able `mc.env`
  now ships `MC_ALLOW_SHELL=0` — matching the server registry's `allowShell: false`.
  An operator who wants a new agent to run host commands ticks the **"Allow shell
  execution on the host" (advanced)** checkbox on the token screen, which flips the
  block to `MC_ALLOW_SHELL=1`. Enforcement is **client-side only** — the adapter's
  own local `MC_ALLOW_SHELL` decides; the backend never gates shell from the
  registry — so this default change **cannot** affect an already-running agent.
- **The live OpenClaw ops agent is GRANDFATHERED.** Its `mc.env` on its host
  (`~/.openclaw/mc-adapter/`) is untouched; it keeps whatever shell posture it was
  installed with. Nothing about this change reaches a running host.
- **The mac-mini installer (`setup.sh`) still defaults `MC_ALLOW_SHELL=1`** (its
  default preset is `shell` — a deliberate shell-executor setup) and exposes
  `--no-shell` to disable. This was **left as-is on purpose**: it is *this* ops
  agent's installer, and flipping its default would change the §4 re-install path
  above. ⚠️ **Operator/auditor decision:** if you want the CLI installer to also
  default shell-OFF, flip `ALLOW_SHELL="0"` in `adapters/mac-mini/setup.sh`, add a
  `--shell` opt-in, and pass it here for the ops agent. Not done in the M5 PR to
  keep the live-agent path stable.

---

## 5. Set the secret-store & run-token keys on Fly

The at-rest secret store (`backend/src/services/secrets.ts`) derives its AES-256-GCM
key from `SECRETS_ENC_KEY`; the per-run HMAC tokens (`backend/src/routes/agent-api.ts`)
sign with `RUN_TOKEN_SECRET || SECRETS_ENC_KEY`. **Both fall back to a hard-coded
public default** (`'dev-7ei-mc-secrets-key'` / `'dev-7ei-mc-run'`) when unset — which
is fine for dev but means that, in production without them, every encrypted secret in
the DB is decryptable with a key that lives in the source, and run-tokens are forgeable.

**Steps (once — do this BEFORE storing any real secret via Cockpit → Secrets):**
```bash
flyctl secrets set \
  SECRETS_ENC_KEY=$(openssl rand -hex 32) \
  RUN_TOKEN_SECRET=$(openssl rand -hex 32) \
  --app 7ei-backend
```
Verify with `bash scripts/check-secrets.sh` (both are now listed).

> ⚠️ Set `SECRETS_ENC_KEY` **before** encrypting any secret. Anything already stored
> under the dev default won't decrypt under a new key — re-enter those secrets (NVIDIA
> key, vault PAT, custom-model keys) via Cockpit → Secrets after rotating.

Engineering follow-up (tracked in the review report): add a boot-time fail-closed
guard so `NODE_ENV=production` refuses to start on the default key.

---

## 7. Audit trail — ENABLED for sensitive writes (Epic ONB, audit H-1) ✅ DONE

> **DECISION TAKEN (2026-07-15, operator-approved): option (b).** The audit trail is
> now LIVE for the sensitive half — every mutating method (POST/PUT/PATCH/DELETE)
> plus the onboarding/invite/join/approval surfaces — with **90-day retention**. The
> read-only `GET` flood is NOT recorded. **Telemetry was left OFF** (separate concern —
> see the note at the end of this section). Shipped behind the independent audit.
>
> **Tune it:**
> - **Retention window:** set `MC_AUDIT_RETENTION_DAYS` (Fly secret) to a whole
>   number of days **≥ 1**; unset / junk / 0 / negative / any sub-one-day fraction
>   (`0.5`, `.5`, `1e-9`) safe-defaults to **90** — so no typo can collapse the
>   window to 0 and wipe the table on the next prune. Rows older than the window are
>   pruned on a daily scheduler tick (`services/audit-retention.ts`, ~03:00 UTC). No
>   cap on row count — the age window is the bound.
> - **Scope:** edit `shouldAudit(method, path)` in `middleware/audit-log.ts`
>   (`SENSITIVE_METHODS` + `AUDITED_PATH_SEGMENTS`). It is a pure, tested helper.
> - **Recurring-agent-write exclusions (audit M-A):** `isHighFrequencyAgentWrite()`
>   in `middleware/audit-log.ts` is a denylist of high-frequency recurring
>   agent-runtime writes that `shouldAudit` skips even though they are mutating
>   methods — **`POST /api/agent/heartbeat`**, **`POST /api/agent/runs/:id/log`**,
>   **`POST /api/agent/messages`**. These are liveness/telemetry chatter posted on
>   the adapter poll loop or streamed continuously during a run; each was otherwise
>   one Turso INSERT at `active agents × poll cadence`, so heartbeat/run-log traffic
>   could dominate the onboarding events the trail was framed around. Excluding them
>   bounds the **daily insert rate away from the heartbeat cadence** — the write
>   volume is now driven by real actions, not liveness pings. To tune: add a path to
>   that denylist (skip more) or remove one (audit it again); it is a pure, tested
>   helper (`[AUDIT-MA]` tests in `audit-onb-enable.test.ts`). **Kept audited on
>   purpose** (meaningful and not per-poll): task result-posting + claim, approvals,
>   `run-token` minting, memory writes, plugin-job claim/result, workspace runtime,
>   and all org-scoped writes (agent create/config, credentials/secrets, wallet, RBAC).
>   When unsure whether an endpoint is security-relevant, KEEP it — be conservative.
> - **Turn it off again:** revert the hoist in `src/index.ts` (the `auditLogPlugin(app)`
>   call at the top of `start()`) back to an encapsulated `app.register(auditLogPlugin)`
>   — the `[ONB2-H1]` tripwire in `audit-onb2-fix.test.ts` guards the wiring either way.
>
> **Cost, stated honestly:** one fire-and-forget Turso `INSERT` per SENSITIVE request
> (writes + the low-volume onboarding surfaces), **minus the recurring agent-runtime
> writes** (heartbeat / run-log / messages, audit M-A) which are excluded so the daily
> insert rate is bounded away from the heartbeat cadence. The insert is
> `.catch()`-swallowed, so it can never add latency to or fail the request it records.
> The `GET` dashboard-poll flood — the expensive, low-value half — is skipped by
> construction.

**The original problem (now fixed): `audit_logs` recorded nothing.**
`auditLogPlugin` and `telemetryPlugin` added their `onResponse` hooks inside an
encapsulated `app.register()` child, so the hooks never fired for the plugins'
siblings — i.e. for any route in the app (`docs/AUDIT-ONB2.md` H-1, confirmed
empirically). The audit hook is now **hoisted onto the root instance** (a bare
`auditLogPlugin(app)` call before any `register()`, mirroring the `onRoute` hook), so
it fires for every route; `audit-onb-enable.test.ts` proves it records for a sibling.

**The hardening PR (#248), plus the re-audit that followed it, made the trail safe
to enable — and stopped there, on purpose.** The things that had to be true first
are now true: the query routes are Clerk/owner-gated (H-2), `sanitizeBody` recurses
so a secret nested in `agentDefaultsPayload` cannot reach a row (H-3), and the
telemetry span URL is redacted (M-1).

> The **re-audit** (`docs/AUDIT-ONB2-hardening.md`) found #248 had closed two of
> those one layer short, and fixed both — worth knowing before you enable anything:
> the traces route was authenticated but **not tenant-isolated** (now
> `GET /api/orgs/:orgId/traces`, owner-gated, org-filtered), and `sanitizeBody`
> did not redact `http_webhook.webhookAuthHeader` — a **bearer credential the
> adapter registry declares secret** — so the very first row the trail ever recorded
> could have carried a live token in plaintext. The registry is now the source of
> truth for redaction. Enabling the hook **before** that fix would have been the
> exact failure this section exists to prevent.

The prerequisites that made this safe are all in place: the query routes are
Clerk/owner-gated (H-2), `sanitizeBody` recurses over the registry-declared secret
keys so a secret nested in `agentDefaultsPayload` cannot reach a row (H-3, R-2), and
the path is redacted before persistence. The end-to-end proof lives in
`audit-onb-enable.test.ts`: a real join request carrying a nested `apiKey` + a
registry `webhookAuthHeader` bearer + a token in the path is driven through the
now-live hook, and the persisted row has the path redacted and **no** secret anywhere.

**Which option was taken: (b).** Sensitive methods + onboarding/invite/join/approval
surfaces, GET flood skipped, 90-day retention. (Not (a) — the onboarding flow now has a
trail; not (c) — the GET flood stays out.)

**Telemetry was deliberately left OFF.** `telemetryPlugin` is a *separate* concern from
the audit trail: it is an in-memory span ring buffer (no Turso writes, bounded to 1000
spans, so no storage-growth or retention concern), and its `GET /api/orgs/:orgId/traces`
under-reports until `llm.call` spans carry an org id. The operator's H-1 decision was
scoped to the audit trail. Enabling telemetry is its own call — hoist `telemetryPlugin`
the same way if/when you want request spans populated.

> ⚠️ **Historical rows:** `audit_logs` never recorded before this change (H-1 was a
> no-op since the wiring existed), so there is no backlog of rows that were readable
> under the old public query route — the table is empty until the first sensitive
> request after deploy. Nothing to purge.

---

## 8. Multi-tenant membership — ENFORCED surface-wide (R-4 + HIGH-1 record routes) ✅ DONE · NO operator action

> **No console action required.** Org membership is now enforced on every Clerk-authed
> `/api/orgs/:orgId/*` route, the `:agentId`/`:taskId` record-derived tail, **and the ~25
> top-level record routes** (`/api/secrets/:id`, `/api/knowledge/:itemId`,
> `/api/projects/:projectId`, `/api/webhooks/:id`, … — HIGH-1 close, 2026-07-15) by one
> scope-level gate (`requireOrgMembership`, `backend/src/middleware/rbac.ts`). The gate is
> now truly **surface-wide and fail-closed** — a missing/foreign record → 403 — and a
> leak-guard (`membership-scoping.test.ts`) fails CI if any new secured route ships ungated.
> Before this, any logged-in user could act on any org by swapping `:orgId` or an id.
>
> **Your own access is grandfathered automatically.** `enforceOrgRole` honours an org's
> `ownerId` as an implicit owner, so you keep full access to your org(s) with **no
> migration and no backfill** — even for orgs created before membership rows existed.
> Only a non-member (or wrong-org) request newly gets a 403. If you ever add a second
> human user to an org, give them an `org_members` row (org-create already does this for
> the owner). Full design + route inventory: `docs/AUDIT-MCA-membership.md`.

---

## Assistant boundaries (why some steps are yours)

Per the operating rules, I don't create accounts, enter passwords/keys, complete
OAuth consent, change account settings, or rotate/enter credentials on your
behalf. Everything I *can* automate — the adapter hardening, the one-command
installer, this runbook — is done; the four items above are the console actions
that only you can perform.
