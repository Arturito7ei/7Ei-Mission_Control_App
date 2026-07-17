# DESIGN — Per-Agent Connectors (epic CONN)

_Decisions A–F are CONFIRMED (operator, 2026-07-17) — see §4, each now marked
**CONFIRMED** with the chosen answer. **CONN-1 is SHIPPED** on branch
`conn-1-agent-connectors-backend`: the secure backend foundation (`agent_connectors`
table + agent-scoped secret storage) and ONE config-only connector end-to-end — a
**custom MCP server** — owner-gated, never leaking a credential. Stages CONN-2…CONN-8
remain as planned below. Verify every claim against the repo before each stage starts._

**Confirmed decisions in one line:** credentials are **agent-owned by default** with an
optional per-connector **"use org connection"** inheritance flag (A); **owner-only**
configuration on the org-scoped path (E); v1 connector set = **Telegram (token), custom
MCP (config), GitHub (PAT), Jira (basic)** — **Google next** (OAuth web/desktop v1 +
config-only on mobile), **Signal out** (C, B); **full tool invocation is planned as
CONN-8** — v1 stores config + rides the existing agent-secrets env-injection, the backend
does not yet *call* MCP/Telegram (D). **CONN-1's pilot is custom MCP** (exercises config +
secret storage without OAuth).

---

## 0. TL;DR for the operator

The feature is **more built than it looks**, and the cheap 80% is a config/credential
surface reusing machinery that already exists; the expensive 20% is per-agent OAuth
(GitHub/Jira/Google) and the phone completing an OAuth flow.

Three findings shape the whole plan:

1. **The `secrets` table already has an `agent` scope.** `scope ∈ {company, agent}`,
   `scopeId = agentId`, AES-256-GCM at rest, and `resolveSecretsForAgent()` already
   layers company secrets then **agent overrides**. Per-agent credential storage needs
   **no new secret primitive** — it needs a table that records *which* connectors an
   agent has and *what* their non-secret config is, pointing at agent-scoped secret rows.

2. **Nothing in the backend executes MCP or tools.** There is no MCP client anywhere
   (`grep -rl mcp backend/` is empty). An agent "has GitHub" by the runtime adapter
   (`claude-code`, `openclaw`, `mac-mini`) calling `GET /api/agent/secrets` at boot and
   injecting the decrypted bag as **env vars**. So for token-type connectors, **execution
   is already solved** by the existing env-injection path — v1 is genuinely "store the
   right secret at agent scope and it flows." "Wire execution later" only applies to
   connectors that need a live MCP/tool bridge (Telegram send, Signal, WhatsApp) the
   product doesn't have yet.

3. **Owner-gating is the shipped convention; the *org* connector routes never got it.**
   Every agent-write route (`config`/`trust`/`model-profile`/`skills`/`permissions`) is
   `requireOrgRole('owner')`. The **org** connector routes (`routes/connectors.ts`) sit
   under `requireOrgMembership` only — any member can configure them today. Per-agent
   connectors must be **owner-gated from line one** (consistent with MOB-7d / SEC-AGENT-PERMS).

The `agent-permissions` vocabulary already reserves a **`connector:` capability
namespace** (`AGENT_CAP_NAMESPACES = ['memory','attachment','connector']`) — scaffolding
for gating what an agent may do with a connector — but it is **not enforced anywhere yet**.

---

## 1. What exists today (grounded inventory)

### 1.1 Connector surface — ORG level, not agent level
- **Registry:** `backend/src/services/connectors.ts` — `CONNECTORS[]`, 7 entries:
  `jira` (basic), `github` (token), `gmail`/`gcal`/`gdrive` (oauth, all one Google
  connection), `huggingface` (token), `obsidian` (basic, GitHub-backed vault).
  Categories: `Dev | Google | Project | AI | Memory`. Pure helpers: `tokenTestRequest`,
  `parseAccount`, `buildStatus`, Google config parse/merge.
- **Routes:** `backend/src/routes/connectors.ts`, all under `/api/orgs/:orgId/connectors`:
  `GET` (status of all), `POST /:id/connect`, `GET/PUT /:id/config`, `POST /:id/test`,
  `DELETE /:id`. Registered on the `secured` scope (`requireOrgMembership`), **no owner gate**.
- **Storage:** token/basic credentials → `secrets` table at **company** scope
  (`GITHUB_TOKEN`, `HUGGINGFACE_TOKEN`, `JIRA_CONNECTION` JSON, `GITHUB_VAULT_TOKEN`).
  Non-secret config → **config-as-secret** (`VAULT_CONFIG`, `GOOGLE_CONNECTOR_CONFIG`).
  Google credentials → `oauth_tokens` row (`provider='google'`, one per org).
- **Status derivation:** presence of the secret/oauth row → `connected`; `detail` is a
  masked/derived label (account login, `email · domain`, `repo · root`). **No secret
  value is returned** — the pattern to preserve.

### 1.2 Secret / credential handling — the secure pattern to reuse
- `backend/src/services/secrets.ts`: AES-256-GCM `encrypt`/`decrypt` (`iv.tag.ciphertext`),
  `maskValue` (last-4), and **`resolveSecretsForAgent(secrets, agentId)`** which already
  merges `company` then `agent`(scopeId===agentId) — **the mechanism per-agent connectors
  layer onto.** `AGENT_RESOLVABLE_SCOPES = ['company','agent']` is an explicit allow-list
  (join-request-scoped secrets are inert by construction).
- `secrets` table (`db/schema.ts:256`): `orgId, scope, scopeId, key, valueEncrypted, …`.
- **Fail-closed boot guard:** `services/secret-keys.ts` refuses to boot the packaged
  profile on a default/missing `SECRETS_ENC_KEY`/`RUN_TOKEN_SECRET`. Any new encrypted
  material inherits this protection for free.
- **Never-leak reference:** `services/org-public.ts` `toPublicOrg()` — an **allow-list**
  projection (the `/api/orgs` leak fix: `telegramBotToken` + `deployConfig` LLM keys were
  shipping in the whole-row select). **CONN adopts the same allow-list discipline: a
  connector row's client projection is an explicit field list, credentials are a separate
  never-projected set, and a test fails if a new column is classified as neither.**

### 1.3 Execution — env injection, no tool runtime
- Adapters pull `GET /api/agent/secrets` at boot (`adapters/claude-code/cc_adapter.py:116`,
  `adapters/openclaw/mc_adapter.py:257`, `adapters/mac-mini/README.md`) → inject as env →
  the runtime's own tools use them. Secrets are **never** put in an LLM prompt.
- Implication: **agent-scoped token connectors need almost no new execution plumbing** —
  writing `GITHUB_TOKEN` at `agent` scope for agent X means agent X's runtime already
  receives it (and it already overrides the company value via `resolveSecretsForAgent`).

### 1.4 OAuth reality
- **Only Google exists**: `services/google-auth.ts` (`buildAuthUrl`/`exchangeCode`/
  `refreshAccessToken`/`ensureFreshToken`) + `routes/auth-google.ts` callback. It is
  **org-scoped** (`state = orgId`, one `oauth_tokens` row per org, **no `agentId`,
  no PKCE**, `client_secret` from env). Callback redirects to the **web** dashboard.
- **No GitHub/Jira OAuth** — those are PAT/basic today (and fine to keep as PAT for v1).
- **No mobile OAuth completion path.** `apps/mobile` has `scheme: "sevenei-mc"` in
  `app.json` (deep link is *possible*) but no `expo-web-browser`/`AuthSession`, no
  callback handling. Completing OAuth on the phone is **net-new** and likely needs an
  **EAS dev build** (see decision B).

### 1.5 Authz + parity conventions
- Owner gate: `requireOrgRole('owner')` on the org-scoped path (`middleware/rbac.ts`;
  the org's `ownerId` is grandfathered as owner). The **tail-path trap** (R-4): a
  `:agentId`-first path makes the org-role hook a no-op — SEC-AGENT-PERMS fixed exactly
  this by moving to `/api/orgs/:orgId/agents/:agentId/...`. **CONN routes must be
  org-scoped-path-first for the owner gate to actually bind.**
- **Parity rule (root `CLAUDE.md`):** every web/desktop UI change is mirrored to
  `apps/mobile/` in the same or immediately-following PR; the phone is a thin REST client
  to the same backend; mirrored lists get a **tripwire test** importing the source module.
- UI today: web `web/app/dashboard/ConnectorsPanel.tsx` (grouped **card grid**, inline
  gear/form expansion — no shared Accordion primitive); mobile
  `apps/mobile/src/screens/ConnectorsScreen.tsx` (**read-only**, category groups, MOB-6f).
  Agent settings live in web `agent/*Tab.tsx` (tab bar) and mobile
  `AgentDetailScreen.tsx` (stacked `<Card>` sections, owner-gated Edit — MOB-7d).

---

## 2. Target architecture

### 2.1 Data model
Introduce **one table**, `agent_connectors`, that records which connectors an agent has
and their non-secret config. Credentials stay in the **existing `secrets` table at
`agent` scope** — do not invent a second secret store.

```
agent_connectors
  id            text pk
  orgId         text  not null            -- tenant scope (every query filters on it)
  agentId       text  not null            -- FK → agents.id
  connectorId   text  not null            -- catalog id: 'github' | 'telegram' | 'mcp:<uuid>' ...
  status        text  not null            -- 'configured' | 'needs_auth' | 'error' | 'disabled'
  config        text  (json)              -- NON-SECRET config only (chat id, calendar id, repo, MCP url/name)
  accountLabel  text                      -- masked/derived display label (never a secret)
  secretRef     text                      -- key name in `secrets` (scope='agent', scopeId=agentId); NULL for oauth/config-only
  lastTestedAt  integer (timestamp)
  lastError     text
  createdAt / updatedAt
  UNIQUE(orgId, agentId, connectorId)      -- one config per (agent, connector); custom MCPs disambiguate via connectorId suffix
```

- **Credentials never live in this table.** `secretRef` names an `agent`-scoped
  `secrets` row (e.g. `AGENT_<agentId>_GITHUB_TOKEN`, or reuse the bare `GITHUB_TOKEN`
  key at agent scope so `resolveSecretsForAgent` overrides company automatically —
  **decision A** picks which).
- **OAuth tokens** (per-agent Google/GitHub-App) need agent scope too. Two options,
  decided later (decision B): add nullable `agentId` to `oauth_tokens` (with a partial
  unique index per `orgId,provider,agentId`), or a dedicated `agent_oauth_tokens` table.
  Keep `oauth_tokens` org-level rows working unchanged.

### 2.2 API surface (all owner-gated, org-scoped path first)
Mirror the org connector verbs, re-homed under the agent:

```
GET    /api/orgs/:orgId/agents/:agentId/connectors           list (catalog × this agent's state, MASKED)
GET    /api/orgs/:orgId/agents/:agentId/connectors/:cid       one connector's status + non-secret config
POST   /api/orgs/:orgId/agents/:agentId/connectors/:cid       connect/configure (token/basic/config/custom-MCP; oauth → { authUrl })
PUT    /api/orgs/:orgId/agents/:agentId/connectors/:cid/config update non-secret config only (token untouched)
POST   /api/orgs/:orgId/agents/:agentId/connectors/:cid/test  live re-test of stored connection
DELETE /api/orgs/:orgId/agents/:agentId/connectors/:cid       disconnect (delete row + agent-scoped secret)
```

- **All under `requireOrgRole('owner')`** on the org-scoped path (decision E — recommended).
- **Reads return a masked projection only** — `toPublicConnector()`, an allow-list twin of
  `toPublicOrg()`: `{ connectorId, name, category, status, accountLabel, config(non-secret),
  lastTestedAt, lastError, authType, fields }`. `secretRef` and any decrypted value are in
  a **never-projected** set with a test asserting the classification, exactly like
  `PUBLIC_ORG_FIELDS`/`SECRET_ORG_FIELDS`.
- **Writes validate** with zod (per-connector field schemas, reusing the catalog), then
  `encrypt()` into an `agent`-scoped `secrets` row and upsert `agent_connectors`.
- Extend the shared registry: `ConnectorMeta` gains `scope: 'org' | 'agent' | 'both'` and
  a `groupKey` for the operator's category grouping (below). The **existing org routes
  stay** for org-wide connectors; the agent routes are additive.

### 2.3 How the accordion UI maps
The operator wants **accordion sections grouped by category**. Both platforms already
group connectors by category; CONN adds an expandable section per **group**, and inside
each, a row per connector with an inline config panel (web already has the inline
gear/form idiom in `ConnectorsPanel`; mobile has the expand/collapse idiom in
`MemoryScreen`). The group → connector → config nesting maps 1:1 to
`groupKey → connectorId → config/secretRef`. **No shared Accordion component exists yet on
either platform** — CONN-2/CONN-3 each build a small local expandable (documented as a
copy with a parity tripwire, per the standing rule).

### 2.4 The connector catalog, grouped exactly as requested

| Group | Connector | v1 realistic capability | Auth | Notes |
|---|---|---|---|---|
| **Communication** | Telegram (bot token) | **Config-only now** — store bot token + chat/target at agent scope; execution wires later | token | Org already has a Telegram bot path (`telegram-bot.ts`, org `telegramBotToken`); per-agent bot token is new but same shape. Lowest-risk first connector. |
| | Google Chat | Config-only → later OAuth/webhook | oauth/webhook | Defer; needs Google Workspace app + webhook or OAuth. |
| | WhatsApp | Config-only (store credentials/phone id) | token (Cloud API) | Execution needs a send bridge that doesn't exist — settings now, wire later. |
| | Signal | **Later / flag as hard** | n/a | No official API; requires `signal-cli` host process. Recommend **out of v1**. |
| **IT / Project** | GitHub | **Real now via PAT** — agent-scoped `GITHUB_TOKEN` flows through `/api/agent/secrets` to the runtime | token (PAT) | Reuse `tokenTestRequest`. Full GitHub-App OAuth is a later upgrade. |
| | Jira | **Real now via basic** (domain/email/apiToken) | basic | Reuse the org Jira validate path at agent scope. |
| **Google Services** | Gmail / Calendar / Drive / other | **OAuth — later stage** (per-agent Google is the big one) | oauth | Reuse `google-auth.ts`; add agent-scoped token storage + `state` carrying agentId + **mobile completion** (decision B). Config-only service toggles can ship earlier. |
| **Custom MCP** | Arbitrary MCP server | **Config-only now** — store name/URL/transport + auth header at agent scope; **no MCP client exists to execute it yet** | token/none | Honest: v1 records the MCP definition and hands it to the runtime as config/env; actually *invoking* MCP tools from the backend is net-new plumbing (a future CONN-EXEC stage). |

**Honesty column, summarized:** *Real in v1* = GitHub (PAT), Jira (basic) — they ride the
existing env-injection path. *Store-settings-now, wire-execution-later* = Telegram,
WhatsApp, Google Chat, custom MCP. *OAuth-heavy, own stage* = Google trio. *Recommend
out of v1* = Signal.

---

## 3. Staged epic (CONN-1 … CONN-8), backend-first, secure-first

Each stage is independently auditable, and every UI stage is replicated web + mobile in the
same or immediately-following PR (parity rule). Estimates are engineering effort for one
developer; "SR focus" = the security review's primary target for that stage.

### CONN-1 — Backend foundation + one config-only connector, end-to-end ✅ SHIPPED
_As-built on `conn-1-agent-connectors-backend`._
- **Data model:** `agent_connectors` table (`db/schema.ts` + idempotent migration in
  `db/setup.ts`): `id, orgId, agentId, connectorId, status, config (json, NON-secret
  only), accountLabel, secretRef, useOrgConnection, lastTestedAt, lastError,
  createdAt, updatedAt` + `UNIQUE(orgId, agentId, connectorId)`. Additive, reversible
  (`DROP TABLE agent_connectors`), nothing backfilled.
- **Pilot connector: custom MCP** (`connectorId = 'mcp'`) — the chosen config-only
  connector because it exercises the full path (agent-scoped secret write, masked read,
  test, delete) **without OAuth**, over both config (`{ name, transport, url|command,
  args }`, zod-validated, `.strict()`) and an **optional** encrypted secret.
- **Service** `services/agent-connectors.ts`: the agent catalog (just `mcp` for now —
  no half-built connector is reachable), per-connector zod config validation,
  `connectorSecretKey()`, and `toPublicConnector()` — an allow-list projection (twin of
  `toPublicOrg`) with a classification test asserting every column is public / secret /
  internal and `secretRef` is never public.
- **API** `routes/agent-connectors.ts`, all `requireOrgRole('owner')` on
  `/api/orgs/:orgId/agents/:agentId/connectors[...]`: list (masked), get one, POST
  configure, PUT config (credential untouched), POST test (a safe stub — does NOT dial
  the arbitrary MCP URL from the backend; SSRF deferred), DELETE (row + agent-scoped
  secret). Registered under the `secured` scope in `index.ts`.
- **Secrets:** any credential is `encrypt()`-ed into the existing `secrets` store at
  `agent` scope (`scopeId = agentId`), referenced by `secretRef` — **never** in the row,
  **never** returned to a client. `resolveSecretsForAgent` already injects it (agent
  override wins over a company default — proven by a test; this is the CONN-8 exec path).
- **Tests** `tests/agent-connectors.test.ts` (member 403 / owner 201 / junk config 400 /
  cross-tenant 404 / credential-never-in-any-response / delete removes the secret /
  agent-override wins / migration idempotent / column classification) + the new module is
  swept by `membership-scoping.test.ts`. Backend suite + evals + tsc green.
- **SR focus (met):** no credential in any read projection (value + key sentinels);
  owner gate binds (member 403, cross-tenant 404, R-4 tail-path avoided by the org-scoped
  path); encryption at rest; the automatic audit-log hook covers the mutating routes.

### CONN-2 — Web accordion UI for the config-only connector (≈ 2–3 d)
- New `ConnectorsTab.tsx` under `web/app/dashboard/agent/` (add `'connectors'` to
  `AGENT_TABS`), or a section in `ConfigurationTab` (decision, minor). Accordion grouped
  by category; inline config panel reusing the `ConnectorsPanel` form idiom; masked status
  pills; owner-only (mirror how sibling tabs already 403 members).
- **SR focus:** the client never renders a secret; error mapping doesn't leak; owner-gate
  reflected in UI but backend is the enforcer.

### CONN-3 — Mobile accordion mirror (≈ 2–3 d)
- `apps/mobile` connectors section on `AgentDetailScreen` (or a dedicated screen) mirroring
  CONN-2 over the **same contract**; local expandable; owner-gated via `orgRole` (MOB-7d
  pattern). Parity tripwire importing the backend registry (as MOB-6f already does).
- **SR focus:** read-only masked data only; no secret in logs; SDK 54 / Expo Go boot-safe.

### CONN-4 — Token/basic connectors: GitHub + Jira at agent scope (≈ 3–4 d)
- Add GitHub (PAT) and Jira (basic) to the agent catalog; reuse `tokenTestRequest` +
  the Jira validate path. These become **real** immediately via env injection.
- Web + mobile accordion rows follow in the same/adjacent PR.
- **SR focus:** an agent wielding a live GitHub/Jira token is a **powerful capability** —
  this is where the `connector:` capability + trust/approval model must gate it
  (see CONN-7). Rotation flow (replace token) mirrors the web's existing "Replace token."

### CONN-5 — Per-agent Google OAuth (its own stage) (≈ 5–8 d)
- Agent-scoped OAuth token storage (decision B: `agentId` on `oauth_tokens` or new table);
  `state` carries `orgId + agentId` (signed/PKCE); reuse refresh/ensure-fresh.
- **Web completion:** callback → redirect back to the agent's connectors tab.
- **Mobile completion:** the hard part — `expo-web-browser` + `AuthSession` + the
  `sevenei-mc` deep link; **likely requires an EAS dev build** (decision B). If deferred,
  ship **config-only Google service toggles** now and gate the OAuth button as
  "desktop-only for now" with an honest banner.
- **SR focus:** token storage/refresh, PKCE + signed `state` (CSRF), redirect allow-list,
  scope minimization, and the mobile deep-link interception risk.

### CONN-6 — Remaining Communication connectors, config-only (≈ 3–5 d)
- Telegram (if not the CONN-1 pilot), WhatsApp, Google Chat as **store-settings** entries;
  Signal explicitly **out** (or spike-only). No execution bridge yet — the row states
  "configured, execution pending."
- **SR focus:** don't imply capability that isn't wired; validate/normalize webhook URLs;
  masked reads.

### CONN-7 — Enforce the `connector:` capability + trust/approval model (≈ 4–6 d)
- Make the reserved `connector:<action>` namespace **real**: gate which connectors an
  agent may actually use behind its capability caps + trust tier (`low_trust_review`
  routes powerful connector use through the existing approvals/`dangerous-approvals` path).
- **SR focus:** this is the "an agent holding a real Gmail/GitHub token is powerful"
  containment stage — the highest-value security review of the epic.

### CONN-8 — Full tool invocation / MCP execution bridge (planned; ≈ larger, own epic)
- **This is where a connected connector becomes CALLABLE at runtime, not just stored.**
  For **token connectors** (GitHub/Jira/Telegram) invocation already rides the existing
  agent-secrets env-injection (the runtime holds the token and calls the API) — so those
  are "real" from CONN-4. For **custom MCP** it is net-new: a backend **MCP client**, a
  per-agent server registry (the `agent_connectors` `mcp` rows CONN-1 records), and a
  **tool-approval** path so an agent invoking an MCP tool is gated by its `connector:`
  capability + trust tier (CONN-7). CONN-1's data model deliberately does not preclude
  this — the `config` already holds `{ name, transport, url|command, args }`, the secret
  is resolvable at agent scope, and nothing here needs migrating to add execution.
- Flagged as its **own epic**, sequenced after the capability/containment work (CONN-7).

**Sequencing rationale:** backend + security primitives first (CONN-1), then the cheap
real wins that need no OAuth (CONN-2/3/4), then the expensive OAuth surface isolated
(CONN-5), then breadth (CONN-6), then the capability/containment tightening (CONN-7).

---

## 4. Key decisions — CONFIRMED (operator, 2026-07-17)

**A. Per-agent vs inherited credentials — CONFIRMED: agent-owned by default, with an
optional per-connector "use org connection" inheritance flag** (the `useOrgConnection`
column on `agent_connectors`; CONN-1 stores it, later stages resolve inheritance).
Rationale: `resolveSecretsForAgent` already layers "company default + agent override,"
so both are cheap; agent-owned isolates blast radius (a rotated org token doesn't affect
every agent) while the opt-in flag keeps org-peer connectors (GitHub/Jira/Google) shareable.

**B. OAuth redirect/callback + phone completion — CONFIRMED: OAuth is web/desktop-only for
v1; the phone gets config-only Google toggles with an honest "connect on desktop" banner**
(option ii). Revisit an `expo-web-browser`/`AuthSession` EAS dev build later — it's the one
place the parity rule and the Expo Go SDK-54 ceiling collide, so it stays a deliberate,
separately-approved step. `state` must carry `agentId` (signed or PKCE) with a tight
redirect allow-list when CONN-5 lands.

**C. v1 connector set — CONFIRMED: Telegram (token), custom MCP (config), GitHub (PAT),
Jira (basic)** as v1; **Google trio next** (CONN-5, OAuth); **Signal out** of v1 (no
official API — spike-only if ever). CONN-1's pilot is **custom MCP**.

**D. Store-settings vs invoke — CONFIRMED: config + env-injection now, backend-side tool
invocation later (CONN-8).** Token connectors ride the existing agent-secrets env path
(already works); comms/MCP store settings in v1. The backend does **not** call Telegram/MCP
in v1 — that's the CONN-8 execution bridge, and CONN-1's data model does not preclude it
(the `mcp` connector's config already records the server definition an executor will need).

**E. Owner-only configuration — CONFIRMED: owner-only**, on the org-scoped path,
matching every sibling agent-write route (permissions/trust/model-profile/config) and
closing (not repeating) the gap the **org** connector routes still have
(member-configurable). Implemented in CONN-1: every write is `requireOrgRole('owner')`.

**F. (Minor) UI home on web — CONFIRMED: a dedicated `ConnectorsTab`** (CONN-2) — connectors
will grow and the accordion wants room.

---

## 5. Risks

- **Credential leakage** (highest). The `/api/orgs` whole-row leak is the cautionary tale.
  Mitigation: `toPublicConnector()` allow-list + never-projected credential set + a
  classification test that fails on an unclassified new column; credentials only ever in
  `secrets` (agent scope), never in `agent_connectors`, never in a read response, never in
  logs (`log-redaction.ts`).
- **OAuth token storage & refresh.** Per-agent multiplies stored refresh tokens. Mitigation:
  encrypt at rest (same AES-GCM), PKCE + signed `state`, tight redirect allow-list, refresh
  via `ensureFreshToken`, revoke-on-disconnect.
- **Per-agent secret sprawl.** Many agents × many connectors = many secret rows. Mitigation:
  `UNIQUE(orgId,agentId,connectorId)`, cascade delete on agent/connector removal, an admin
  view of agent-scoped secrets, and the `AGENT_RESOLVABLE_SCOPES` allow-list keeping stray
  scopes inert.
- **Mobile OAuth completion.** The deep-link return is both a UX gap and an interception
  surface. Mitigation: decision B — prefer web/desktop-only OAuth for v1; if a dev build is
  approved, validate the deep-link `state` server-side and never trust an inbound token.
- **MCP / powerful-token execution.** An agent holding a live GitHub/Gmail token is a real
  capability, and there is no capability enforcement today (`connector:` namespace is
  scaffolding only). Mitigation: **CONN-7** — enforce `connector:<action>` caps + trust
  tier, route powerful connector use through the existing approvals path; until then, keep
  agent connectors owner-configured and prefer least-privilege tokens.
- **Parity drift.** A web-only connector surface silently diverging from the phone.
  Mitigation: the standing tripwire tests importing the shared registry, per CLAUDE.md.

---

## 6. What is real vs new (one-glance)

| Capability | Status |
|---|---|
| Agent-scoped encrypted secret storage | **Exists** (`secrets` scope=agent, `resolveSecretsForAgent`) |
| Env-injection execution for token connectors | **Exists** (`/api/agent/secrets` + adapters) |
| Masked, never-leak read projection pattern | **Exists** (`toPublicOrg` allow-list) |
| Owner-gate on org-scoped agent path | **Exists** (`requireOrgRole('owner')`) |
| Google OAuth (org-level) | **Exists** (`google-auth.ts`) |
| `connector:` capability namespace | **Reserved, not enforced** |
| `agent_connectors` table + agent connector API | **New** (CONN-1) |
| Per-agent OAuth (agentId scope, PKCE, mobile completion) | **New** (CONN-5) |
| Accordion UI, web + mobile | **New** (CONN-2/3; no shared Accordion primitive today) |
| Backend MCP/tool invocation | **New, separate epic** (CONN-8) |

_End of plan. Nothing here has been implemented; CONN-1 starts after decisions A–E._
