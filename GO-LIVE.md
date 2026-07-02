# Mission Control — Go-Live Runbook

Operational steps to take Mission Control from "works for the founder in dev
mode" to a hardened production setup. Each item is a **user action** in a vendor
console (Clerk, Google Cloud, NVIDIA, GitHub, the Mac mini) — the engineering to
make each a one-step change is already shipped; this doc gives the exact steps,
env-var names, and where they're consumed.

Owner: Arturito · Last updated: 2026-07-02

| # | Item | Risk if skipped | Effort |
|---|------|-----------------|--------|
| 1 | Clerk **production** instance | Dev keys rate-limit + show a dev banner; anyone can sign up | ~20 min |
| 2 | Google consent screen: Gmail/Calendar scopes | Gmail/Calendar connectors can't read data | ~15 min |
| 3 | Rotate exposed tokens (NVIDIA key, vault PAT) | Leaked creds usable by anyone who saw them | ~15 min |
| 4 | Move OpenClaw to the Mac mini | Agent dies when the laptop sleeps/closes | ~10 min |

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

---

## Assistant boundaries (why some steps are yours)

Per the operating rules, I don't create accounts, enter passwords/keys, complete
OAuth consent, change account settings, or rotate/enter credentials on your
behalf. Everything I *can* automate — the adapter hardening, the one-command
installer, this runbook — is done; the four items above are the console actions
that only you can perform.
