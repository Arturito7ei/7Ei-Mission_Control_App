# Runbook — Onboarding an external agent (Epic ONB)

The operator's end-to-end guide to inviting, approving, and standing up an external
agent on Mission Control. This is the DX/operations companion to the design
(`docs/DESIGN-agent-onboarding.md`) and the security model (`docs/SECURITY-posture.md`).

Owner: Arturito · Last updated: 2026-07-15 (Epic ONB Stage 7 — go-live + docs) · Status: **onboarding CORE (ONB1–ONB4) + UI/CLI (ONB6) shipped; the audit trail is on; ONB5 deferred (gateway/webhook only)**

> **The one-sentence model.** The operator creates an **invite** and pastes one
> ~40-line prompt into any agent's chat. The agent onboards *itself* — reads a
> per-invite document, picks its runtime, probes for a reachable base URL, submits
> a **join request** describing its own capabilities, **waits for a human to
> approve it on the board**, and only then **claims its API key, once**. The
> credential is minted *after* approval and is read *only* by the agent that will
> use it — never through the operator's clipboard or a log. This "inverted token
> lifecycle" is the whole point: self-describe first, human approves second, the
> key is minted and claimed last. (Contrast the legacy `7ei-mc onboard`, which
> mints an `mca_` token *before* any human decision and hand-carries it into an
> `mc.env`.)

---

## 0. ON vs OFF today — read this first

| Surface | State today | Lever |
|---|---|---|
| `GET /api/adapters` (adapter taxonomy) | **ON** (public, read-only) | none — always available |
| Per-invite onboarding document (`…/onboarding[.txt]`) | **OFF in hosted prod** | `MC_ENABLE_REMOTE_ONBOARDING` (see §6) |
| Public join (`POST …/join`) | **OFF in hosted prod** | `MC_ENABLE_REMOTE_ONBOARDING` |
| One-time claim (`POST …/claim-api-key`) | **OFF in hosted prod** | `MC_ENABLE_REMOTE_ONBOARDING` |
| Audit trail (records onboarding + sensitive writes) | **ON** (90-day retention) | `MC_AUDIT_RETENTION_DAYS` |
| Per-IP rate limit on join/claim | **ON** (wired; 10/min) | code-level, always on |
| Invite-agent trust level | **`low_trust_review`** always | invariant — not a switch |
| Shell execution for new agents | **OFF** by default | per-agent opt-in checkbox / `MC_ALLOW_SHELL` |

**Bottom line for a hosted deployment (what we run at `7ei-backend.fly.dev`):** the
onboarding *machinery* is fully built and tested, but the public join/claim/document
surfaces answer a **flat 404 until you set `MC_ENABLE_REMOTE_ONBOARDING`** (§6). A
**packaged/loopback** deployment (the future `.dmg`) has them open by default,
because it is single-tenant and loopback-trusted. Nothing you do here can enable the
join surface before the controls that make it safe exist — the posture is *derived*,
not asserted (see `docs/SECURITY-posture.md`).

> **Two ways to onboard, and when to use each.**
> - **Invite-based (this runbook, the safe default):** the agent self-describes and
>   a human approves before any credential exists. Use for any external/BYO agent,
>   especially on a hosted backend.
> - **Manual (legacy `Add agent` / `Hire` wizard, or `7ei-mc onboard`):** the
>   operator mints a token up front and pastes the run-block into an `mc.env`. Still
>   supported and unchanged; it is how the **live OpenClaw ops agent** and the first
>   **Claude Code** agent were stood up. It skips the approval gate, so prefer the
>   invite flow for anything new.

---

## 1. The lifecycle at a glance

```
OPERATOR                         AGENT (self-onboarding)             BOARD (human)
────────                         ───────────────────────             ─────────────
1. Create invite ──────────────▶ token + pastable prompt
   (Cockpit ✉ / 7ei-mc)
                                 2. Read onboarding.txt
                                    (adapter taxonomy, probe rule)
                                 3. Probe GET <candidate>/api/health
                                    → pick a reachable mcApiUrl
                                 4. POST …/join  ─────────────────▶  5. 🤝 card lands in
                                    (self-declared capabilities,        the Inbox / approvals
                                     runtime config; NO token minted)    queue
                                 ◀── { requestId, claimPath,          6. Owner approves
                                       claimSecret (once) }              → agent created
                                                                          low_trust_review,
                                                                          api_token_hash = NULL
                                 7. Poll claim until approved
                                 8. POST …/claim-api-key ─────────────▶  (mints mca_ token
                                    { claimSecret }                        under CAS, once)
                                 ◀── { agentToken }  (once, to the claimer only)
                                 9. Write chmod-600 mc.env, start adapter
```

Every failure along the join/claim path collapses to **one identical flat 404** — no
enumeration oracle. The claim is single-use (two atomic compare-and-set statements);
two simultaneous claims yield exactly one token.

---

## 2. Supported runtimes (the adapter registry)

The server-side adapter registry (`backend/src/services/adapter-registry.ts`) is the
single source of truth. `GET /api/adapters` returns it; the onboarding document and
the invite dialog both render *from* it, so a runtime is one table row and never
described twice. **Declared ≠ available**: an unavailable runtime is described
honestly in the doc but a join request naming it is **refused with the reason**.

| `adapterType` | Runtime | Available? | Invitable? | Onboard via | Notes |
|---|---|---|---|---|---|
| `openclaw_local` | openclaw | ✅ **available** | ✅ | this runbook §4a | The local poll-loop adapter that ships today. Shell OFF by default. |
| `claude_code` | claude_code | ✅ **available** | ✅ | §4b + `GO-LIVE.md` item 6 | Plan-mode (propose-and-approve) by default; registers contained (CC3). |
| `cursor` | cursor | ✅ **available** | ✅ | §4c | File-inbox model; skills must be materialized as files on the host. |
| `openai_generic` | custom | ✅ **available** | ✅ | §4d | The map-any-runtime escape hatch — any OpenAI-chat-compatible endpoint. |
| `openclaw_gateway` | openclaw | ⛔ not built | ✅ | — | WebSocket gateway; the MC→gateway dispatch half is unbuilt. |
| `http_webhook` | custom | ⛔ not built | ✅ | — | Push model; needs **ONB5** (SSRF-hardened reachability) before it can go available. |
| `hermes_gateway` | custom | ⛔ not built | ✅ | — | Hermes HTTP gateway; no Hermes install exists. `apiKey` is the **Hermes** key, never the MC token. |
| `hermes_local` | custom | ⛔ not built | ✅ | — | MC-started local process — only meaningful on a self-hosted/packaged MC, not on Fly. |
| `grok_local` | custom | ⛔ not built | ✅ | — | Grok local CLI; declared for the taxonomy, dispatch unbuilt. |
| `internal` | internal | ✅ | ⛔ **never invitable** | — | Mission-Control-run agents; not an onboarding target. |

**Fields marked `secret` never travel in a plaintext config column.** The registry
splits them out (`x-openclaw-token`, `apiKey`, `webhookAuthHeader`) and they go to
the encrypted store. An *undeclared* key that merely looks like a secret is **rejected
outright** (fail-closed) — a hostile payload cannot smuggle a credential into config.

---

## 3. Create the invite

### 3a. From the UI

**Cockpit → "✉ Invite an agent"** (owner-gated — a non-owner gets a 403).

1. Pick the allowed runtime(s) — the picker renders from `GET /api/adapters` and
   only lists `invitable && available` (never `internal`).
2. Choose **single-use** (the default) or a bounded **multi-use** count.
3. Set a **TTL**.
4. On create, the dialog shows — **exactly once, unrecoverable** — the **invite
   token** and the **copy-able onboarding prompt** (with copy buttons + the document
   URL). If hosted-join is closed, it says so honestly.

The dialog **never** reveals a claimed agent key — only the invite token and the
prompt. There is no code path from the operator UI to a claimed credential.

### 3b. From the CLI

```bash
# Operator side (Clerk-authed): prints the invite token + the pastable prompt.
7ei-mc invite create --org <orgId> --runtime claude_code --single-use --ttl 24h
```

`invite create` prints the invite token and the onboarding prompt — **never a
claimed agent token**. Paste the prompt into the target agent's chat.

---

## 4. The agent onboards itself

Give the agent the pasted prompt (or just the invite token + base URL). It will read
the onboarding document, probe `/api/health` against the server-supplied candidate
list to find a reachable `mcApiUrl` (if none answer, it escalates to you — it never
guesses a URL), then submit its join request. You can also drive the agent side with
the CLI:

```bash
# Agent side: join → poll for approval → claim once → write chmod-600 mc.env.
7ei-mc onboard --invite <inviteToken> --workdir /path/to/checkout
```

`onboard --invite` writes a **chmod-600 `mc.env`** containing only `MC_BASE_URL`,
`MC_AGENT_TOKEN`, `MC_WORKDIR` (+ flags) — **never an LLM key** (that is served from
the encrypted store at run time). The token is written to the file and **never
printed**.

### Per-runtime install (after the claim mints the token)

Once the claim returns the `mca_` token (and `mc.env` is written), start the adapter
for the chosen runtime:

**4a. OpenClaw (`openclaw_local`)** — the local poll-loop adapter.
- Fields: `workdir` (required), `pollSeconds` (20), `executor` (`auto`), `allowShell`
  (**false** by default), `mcApiUrl`.
- Install: `adapters/mac-mini/setup.sh` (see `GO-LIVE.md`) or run
  `adapters/openclaw/mc_adapter.py` against the written `mc.env`.
- The LLM key is pulled from the encrypted store via `GET /api/agent/secrets` — never
  in the payload or `mc.env`.
- Shell execution is client-gated: `MC_ALLOW_SHELL` in the local `mc.env` decides.
  New agents ship `MC_ALLOW_SHELL=0`; tick the advanced opt-in only if the agent must
  run host commands.

**4b. Claude Code (`claude_code`)** — the office engineering agent.
- Fields: `workdir` (required), `model`, `permissionMode` (**`plan`** by default —
  autonomy is NOT selectable here), `manageWorktree` (false), `timeoutSeconds` (900).
- Install: `cd adapters/claude-code && MC_AGENT_TOKEN=mca_… MC_WORKDIR=/checkout ./setup.sh`.
- Registers **contained** (`secureRegistration`, CC3): `low_trust_review` + an
  explicit capability list + a boundary from the target workspace. Plan mode →
  nothing runs on the host without an A2 `machine_exec` approval (verbatim argv +
  step-up). Autonomous host exec stays OFF behind two guards + the CC5 denylist — see
  `GO-LIVE.md` item 6 and `adapters/claude-code/README.md`.

**4c. Cursor (`cursor`)** — file-inbox model.
- Fields: `inbox` (required, default `./coordination/inbox`), `pollSeconds` (20).
- Install: `adapters/cursor`. Skills must be materialized as files on the host (the
  only adapter that needs it).

**4d. Generic OpenAI-compatible (`openai_generic`)** — the escape hatch.
- Fields: `baseUrl` (required), `model` (required), `apiKey` (**secret** → encrypted
  store), `headers` (no credentials).
- Any OpenAI-chat-compatible endpoint. `adapters/presets/*.env` are already exactly
  this shape.

**Gateway / webhook runtimes (`openclaw_gateway`, `http_webhook`, `hermes_gateway`,
`hermes_local`, `grok_local`)** are **not available today** — the MC→agent dispatch
half is unbuilt, and the push/webhook ones additionally need **ONB5** (SSRF-hardened
reachability). A join naming one is refused with that reason. They are on the roadmap,
not in this runbook.

---

## 5. Approve on the board

A join request creates **no agent and no credential** — it lands a **🤝 "Agent wants
to join"** card in the Cockpit **Inbox** (the shipped tri-state approvals queue). The
card is machine-generated: every agent-authored value is labelled **self-declared,
unverified**, and it shows **which** secret fields were supplied by name, never a
secret value.

1. Open **Cockpit → Inbox** (or the owner API).
2. Review the self-declared capabilities, runtime, and boundary.
3. **Approve** (owner-gated — the decide route enforces owner for agent-minting
   types) → the agent is created **contained**: `low_trust_review` regardless of
   runtime, an explicit non-empty capability list, an explicit boundary, and
   `api_token_hash = NULL`. **No token is minted at approval.**
4. **Reject** → nothing is minted and the secrets the agent supplied are deleted.

A double-approve is a **409**, never a second agent. The Inbox card and the owner API
run the *same* decision path, so an approved card cannot exist without the agent
actually being created.

---

## 6. Go-live switches (exact env vars)

All of these are **Fly secrets** on `7ei-backend` unless noted. See `GO-LIVE.md` for
the single consolidated pre-launch checklist; this section is the onboarding-specific
subset.

### 6a. `MC_ENABLE_REMOTE_ONBOARDING` — open the public join surface (the big one)

The onboarding document, the join route, and the claim route all derive their exposure
from the deployment profile:
- **`packaged`** (`MC_DEPLOYMENT_PROFILE=packaged`) → open (single-tenant,
  loopback-trusted).
- **`hosted`** (the default; unset resolves to `hosted`) → **closed unless
  `MC_ENABLE_REMOTE_ONBOARDING` is explicitly set**.

To open remote onboarding on the hosted backend:
```bash
flyctl secrets set MC_ENABLE_REMOTE_ONBOARDING=1 --app 7ei-backend
```
Do this **only after** the prerequisites in `docs/SECURITY-posture.md` are true (they
are, as of ONB4): approval gate, single-use default, short TTL, per-IP rate limit,
low-trust containment, no-oracle failures. Until you set it, hosted prod answers
join/claim/document with a flat 404 — which is the safe default.

### 6b. `SECRETS_ENC_KEY` + `RUN_TOKEN_SECRET` — must be set before storing any secret

The at-rest secret store and the per-run HMAC tokens fall back to a **hard-coded
public default** when unset. In production that means every encrypted secret is
decryptable with a key that lives in the source, and run-tokens are forgeable. Set
both **before** storing any real secret (including any invite/claim secret material):
```bash
flyctl secrets set \
  SECRETS_ENC_KEY=$(openssl rand -hex 32) \
  RUN_TOKEN_SECRET=$(openssl rand -hex 32) \
  --app 7ei-backend
```
⚠️ Anything already encrypted under the dev default won't decrypt under a new key —
re-enter it via Cockpit → Secrets after rotating. **Status: still to set on Fly.**

### 6c. Per-IP rate limit — already wired

`perIpRateLimit()` (10/min, keyed on the fixed socket / `Fly-Client-IP`) is wired onto
both the join and the claim. It is a **checked hardening control** — a regression closes
the posture rather than opening an unlimited door. No operator action; it is on.

### 6d. `WEBHOOK_SIGNING_SECRET` — inbound receiver HMAC (relevant to webhook runtimes + Telegram)

Not strictly part of the invite flow, but a prerequisite before any push/webhook
runtime (ONB5) or the Telegram remote surface goes live. Until set, inbound receivers
are open in dev. Set it and re-register integrations. **Status: still to set on Fly.**

### 6e. `MC_AUDIT_RETENTION_DAYS` — audit trail tuning (already ON)

The audit trail records the onboarding surfaces (invite/join/approval) plus every
sensitive write, with **90-day** retention by default. Set a whole number of days ≥ 1
to change it; junk / 0 / negative / sub-one-day safe-defaults to 90 so a typo can't
wipe the table. See `GO-LIVE.md` §audit and `docs/SECURITY-posture.md`.

---

## 7. Two deployment profiles

| | **hosted** (today) | **packaged / loopback** (future `.dmg`) |
|---|---|---|
| Config | `MC_DEPLOYMENT_PROFILE=hosted` (or unset — safe default) | `MC_DEPLOYMENT_PROFILE=packaged` |
| Tenancy | multi-tenant | single-tenant |
| Onboarding document | closed unless `MC_ENABLE_REMOTE_ONBOARDING` | open (loopback-trusted) |
| Public join / claim | closed unless `MC_ENABLE_REMOTE_ONBOARDING` + hardening | open (loopback-trusted) |
| Where it runs | Fly `7ei-backend` (fra) | operator's Mac (Epic H installer) |

The posture is **derived from the profile, never hardcoded**. An unset profile resolves
to the *harder* one. The hardening checklist is *computed* — `PUBLIC_JOIN_IMPLEMENTED`
was `false` while ONB3/ONB4 were unbuilt, so **no env var could open the join surface
before the controls that make it safe existed**. Epic H (packaging) seeds a fresh
machine from the same declarative config bundle ONB1 introduced; **secrets never travel
in the bundle or the package** — they stay in the encrypted store and are re-supplied
per machine.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Join / claim / document returns 404 in prod | `MC_ENABLE_REMOTE_ONBOARDING` unset (hosted default) | §6a — set it once the security prerequisites are met |
| Agent can't find a reachable base URL | none of the candidates answered `GET /api/health` | give it the correct `mcApiUrl`; don't let it guess |
| Join refused naming a runtime | that `adapterType` is `available: false` | pick an available runtime (§2); gateway/webhook need ONB5 |
| "invalid" on an obviously-correct invite | expired / revoked / exhausted — all collapse to the same 404 (no oracle) | create a fresh invite |
| Claim returns 404 after approval | already claimed (single-use), wrong secret, or expired | re-issue the invite; the claim is single-use by design |
| Encrypted secret won't decrypt after key rotation | `SECRETS_ENC_KEY` changed after the secret was stored | re-enter the secret via Cockpit → Secrets (§6b) |
| Onboarded agent won't run host commands | shell OFF by default for new agents | tick the advanced shell opt-in / set `MC_ALLOW_SHELL=1` in its local `mc.env` |

---

## 9. Reference

- Design: `docs/DESIGN-agent-onboarding.md` (§8 addendum = the operator-locked defaults)
- Security model: `docs/SECURITY-posture.md`
- Go-live checklist: `GO-LIVE.md`
- Adapter registry (source of truth): `backend/src/services/adapter-registry.ts`
- Audits: `docs/AUDIT-ONB1.md` … `AUDIT-ONB6.md`, `AUDIT-audit-trail.md`, `AUDIT-shell-default.md`
- Claude Code agent: `docs/DESIGN-claude-code-agent.md`, `adapters/claude-code/README.md`
- Story tracker: `docs/PLAN-arturita.md` §0 (ONB1–ONB7)

**PRs:** ONB1 [#244] · ONB2 [#246] · pre-ONB3 hardening [#248]/[#249] · ONB3 [#250] +
H-1 fix [#252] · ONB4 [#253] · ONB6 [#255] · audit-trail enable [#257]/[#258]/[#259] ·
shell-default OFF [#260] · membership R-4 [#262] · membership HIGH-1 [#264].
