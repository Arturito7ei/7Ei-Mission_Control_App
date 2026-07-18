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
| **Communication** | Telegram (bot token) | **SHIPPED (CONN-6)** — store bot token + chat/target at agent scope (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`); execution wires later (CONN-8) | token | Env names CONFIRMED (telegram-webhook.ts + openclaw adapter). |
| | Google Chat | **SHIPPED (CONN-6)** — store incoming-webhook URL (the credential) + space label; execution later | token (webhook) | `GOOGLE_CHAT_WEBHOOK_URL`, no in-repo consumer yet (flagged). |
| | WhatsApp | **SHIPPED (CONN-6)** — store access token + phone/business ids; execution later | token (Cloud API) | `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_BUSINESS_ACCOUNT_ID`, no in-repo consumer yet (flagged). |
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

### CONN-2 — Web accordion UI for the config-only connector ✅ SHIPPED
_As-built on `conn-2-web-connectors-accordion`._
- **New owner-only Connectors tab** — `web/app/dashboard/agent/ConnectorsTab.tsx`;
  `'connectors'` added to `AGENT_TABS` (`web/lib/agentRoute.ts`) between Configuration
  and Runs, wired in `AgentDetail.tsx`. Chose a dedicated tab (decision F), not a
  Configuration section.
- **Accordion grouped by category exactly as the operator listed** (each a collapsible
  `<section>` with `aria-expanded`, a "N connected" pill, and connector rows):
  Communication (Google Chat · Telegram · WhatsApp · Signal), IT / Project management
  (GitHub · Jira), Google Services (Google Calendar · Gmail · Google Drive), Custom MCP
  servers. The **Custom MCP** section opens by default.
- **Real in v1 = custom MCP only** (the CONN-1 pilot). Inline config panel: name,
  transport (http|stdio), url **or** command+args, and an **optional write-only** token.
  `POST …/connectors/mcp` (configure), masked status pill (Connected/Not connected +
  `accountLabel`), `POST …/test`, `DELETE` (Disconnect). Optimistic edits reconcile to
  the server's masked row.
- **Everything else is a disabled "Coming soon" / "Out of scope" row** with an honest
  note naming its stage (GitHub/Jira → CONN-4, Google trio → CONN-5,
  Telegram/WhatsApp/Google Chat → CONN-6, **Signal out of scope**). No fake saves — the
  CONN-1 catalog holds only `mcp`, so calling an unknown connectorId would 404; the tab
  never issues that call.
- **Pure logic + parity** — `web/lib/agentConnectors.ts`: the category catalog,
  `AVAILABLE_CONNECTOR_IDS` (derived), and `validateMcpConfig` — a client mirror of the
  backend `McpConfigSchema` (server stays the final validator). `agentConnectors.test.ts`
  (+13) covers category rendering, the available-set, masked-only display, MCP validation,
  and a **parity tripwire** that reads the backend `AGENT_CONNECTORS` source and fails if
  the client "available" set drifts from it (Next.js can't import backend source that pulls
  in drizzle, so the tripwire text-reads the file — dep-free, CI-safe).
- **SR focus (met):** the client **never renders a secret** — the read projection carries
  no credential (not even a `secretRef`), the token input is `type=password`, seeded from
  `''` (never from a read), cleared only after a successful save, and blank-on-save keeps
  the stored token. **Owner-gate:** the list GET is itself owner-gated, so a **403 on load**
  → a clean read-only "owner-only" note; a mutating 403 surfaces in the row with the
  operator's edits preserved. The backend remains the enforcer.
- **Verify:** web `npm run build` + `tsc --noEmit` + `npm test` (234/234) green. Additive
  to `web/**` + docs. **Parity: CONN-3 mirrors this to the phone** over the same contract.

### CONN-3 — Mobile accordion mirror ✅ SHIPPED
_As-built on `conn-3-mobile-connectors-accordion`._
- **New owner-gated Connectors section** on `AgentDetailScreen` (`apps/mobile/src/screens/
  AgentDetailScreen.tsx`), rendered by `ConnectorsSection` in the new
  `screens/AgentConnectors.tsx`, placed directly under the Configuration/Settings block.
  Mirrors CONN-2 over the **same CONN-1 contract** (no backend change): the same
  owner-gated `/api/orgs/:orgId/agents/:agentId/connectors[...]` verbs, added to the mobile
  api client (`api.ts`: `agentConnectors` / `saveAgentConnector` / `testAgentConnector` /
  `deleteAgentConnector`).
- **Accordion grouped by category exactly as the operator listed** — a local collapsible
  (the MOB-6e MemoryScreen idiom, not a new dep): Communication (Google Chat · Telegram ·
  WhatsApp · Signal), IT / Project management (GitHub · Jira), Google Services (Google
  Calendar · Gmail · Google Drive), Custom MCP servers (opens by default). Each connector is
  a row with a colorblind-safe status **Chip** (✓ Connected / ○ Not connected / ⋯ Coming
  soon / — Out of scope).
- **Real in v1 = custom MCP only.** Inline config panel: name, transport (http|stdio via a
  segmented control), url **or** command + args (one per line), and an **optional
  write-only** token (`secureTextEntry`). `POST …/connectors/mcp` (configure), masked status
  Chip + `accountLabel`, `POST …/test`, `DELETE` (Disconnect). Optimistic edits reconcile to
  the server's masked row; a failed save keeps the operator's edits (incl. the typed secret).
- **Everything else is a disabled "Coming soon" / "Out of scope" row** with the same honest
  stage note as the web (GitHub/Jira → CONN-4, Google trio → CONN-5, Telegram/WhatsApp/Google
  Chat → CONN-6, **Signal out of scope**). No fake saves — the UI only ever POSTs `mcp`.
- **Pure logic + parity** — `apps/mobile/src/agentConnectors.ts` is a parity-pinned mirror of
  `web/lib/agentConnectors.ts` (catalog, `AVAILABLE_CONNECTOR_IDS`, `validateMcpConfig`).
  `agentConnectors.test.ts` (+18) covers grouping, the available-set, masked-only display,
  MCP validation, and TWO tripwires: (1) a **cross-platform** import of the dep-free web
  module asserting the phone's groups + validation verdicts equal the desk's, and (2) a
  **backend text-read** of `AGENT_CONNECTORS` asserting the client "available" set can't
  drift from the server catalog.
- **SR focus (met):** the client **never renders a secret** — the read projection carries no
  credential (not even a `secretRef`), the token input is `secureTextEntry` / write-only,
  seeded from `''` (never a read), cleared after a successful save, and blank-on-save keeps
  the stored token; a test asserts the read state never carries secret/token/secretRef.
  **Owner-gate:** the list GET is itself owner-gated, so a **403 on load** → a clean
  read-only "owner-only" note; a known member gets that note without a round-trip; the phone
  offers the surface to an owner OR when the role is genuinely unknown (fail-OPEN to the
  backend gate, MOB-7d pattern). The backend remains the enforcer.
- **Verify:** `apps/mobile` `npm test` (275/275) + `npm run typecheck` (clean) + `npm run
  export` (bundles, boot-safe) green. Additive to `apps/mobile/**` + docs. **SDK 54 / react
  19.1.0 / boot-safe untouched** (RN core inputs only — no native module). **This completes
  the web+mobile parity for the connectors accordion.**

### CONN-4 — Token/basic connectors: GitHub + Jira at agent scope (≈ 3–4 d)
- Add GitHub (PAT) and Jira (basic) to the agent catalog; reuse `tokenTestRequest` +
  the Jira validate path. These become **real** immediately via env injection.
- Web + mobile accordion rows follow in the same/adjacent PR.
- **SR focus:** an agent wielding a live GitHub/Jira token is a **powerful capability** —
  this is where the `connector:` capability + trust/approval model must gate it
  (see CONN-7). Rotation flow (replace token) mirrors the web's existing "Replace token."

#### CONN-4a — GitHub + Jira BACKEND (real via env injection) ✅ SHIPPED
_As-built on `conn-4a-github-jira-backend`. Backend-only; CONN-4b enables the web +
mobile accordion rows over this same contract._

- **Catalog:** `github` (auth `token`, `secretRequired`) and `jira` (auth `basic`,
  `secretRequired`) added to `AGENT_CONNECTORS` (`services/agent-connectors.ts`).
  Config schemas (zod, `.strict()`): GitHub `{ username? }` (label only — the PAT is
  NOT config); Jira `{ baseUrl: url(), email: email() }` — `baseUrl` URL-validated.
- **The execution contract — the EXACT env-var keys the credential is stored/injected
  under** (`CONNECTOR_ENV_KEYS` in `services/agent-connectors.ts`). This is what makes
  the connectors REAL: `GET /api/agent/secrets` returns `resolveSecretsForAgent(...)`,
  a bag keyed by each `secrets` row's `key`, and the adapters inject that bag VERBATIM
  as env (`os.environ[str(k)] = str(v)` — `adapters/claude-code/cc_adapter.py:120`,
  `adapters/openclaw/mc_adapter.py`). So the agent-scoped secret KEY **is** the env-var
  name the runtime receives:

  | Connector | Env keys stored at agent scope (→ injected as env) | Evidence |
  |---|---|---|
  | **github** | `GITHUB_TOKEN` (the PAT) | Matches the ORG connector's `secretKey: 'GITHUB_TOKEN'` (`services/connectors.ts`) AND the backend's own consumer `process.env.GITHUB_TOKEN` (`routes/skills.ts:34`). **Confirmed name.** |
  | **jira** | `JIRA_BASE_URL`, `JIRA_EMAIL` (non-secret), `JIRA_API_TOKEN` (secret) | **Conventional** basic-auth env names. The backend has **no in-repo Jira env consumer** — the org Jira path uses a `JIRA_CONNECTION` JSON blob for backend-side REST, not env — so these are the standard names. ⚠️ **Operator: confirm your runtime's Jira tooling reads exactly `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`** (some MCP servers use `JIRA_URL` / `JIRA_USERNAME`); if different, the mapping is one edit in `CONNECTOR_ENV_KEYS` + `connectorSecretEntries`. |

  Jira's `baseUrl`/`email` are non-secret yet ALSO written into the (encrypted) secret
  store because env injection is the ONLY channel to the runtime — `config` is not
  injected. `config` still holds them too, as the returnable display source of truth
  (masked reads show base URL + email; the token is never in `config`, only the secret
  store). Multi-key mapping via `connectorSecretEntries()`; the sensitive key
  (`primarySecretKey()` → `GITHUB_TOKEN` / `JIRA_API_TOKEN`) is recorded as the row's
  `secretRef`.
- **Flow (real, not just stored):** configure → `connectorSecretEntries()` encrypts the
  entries into `agent`-scoped `secrets` rows → `resolveSecretsForAgent(...)` layers them
  (agent override wins over a company default) → `GET /api/agent/secrets` →
  adapter injects as env → the runtime's git/gh/Jira tooling reads them. Proven by
  `[CONN4A-EXEC]` tests asserting the resolved bag carries `GITHUB_TOKEN` and all three
  `JIRA_*` keys for the agent. `useOrgConnection: true` stores NO agent credential and
  lets the company-scope secret flow (decision A inheritance).
- **`test` is a REAL, SSRF-safe provider check** (not a stub, unlike CONN-1's mcp):
  GitHub → `GET https://api.github.com/user` (host **hardcoded** — no SSRF), returns the
  login; Jira → `GET {baseUrl}/rest/api/3/myself` with Basic auth **only when
  `isAtlassianHost(baseUrl)`** (`*.atlassian.net`) — a self-hosted Jira on any other host
  is **not dialed** (live check skipped, safe result returned). 8s timeout; the token is
  never echoed (detail = login / displayName). mcp remains a stub.
- **Security:** the token lives ONLY in the encrypted `secrets` store, NEVER in the
  `agent_connectors` row, NEVER in any read/list/get/test response, NEVER logged.
  `toPublicConnector()` (allow-list projection) is unchanged and still masks; the new
  non-secret config fields (baseUrl/email/username) ARE returnable, the token is not.
  Owner-gated + tenant-scoped exactly as CONN-1 (generic routes). Disconnect purges
  EVERY agent-scoped env row for the connector (token AND non-secret base/email).
- **Tests** `tests/agent-connectors-github-jira.test.ts` (+15): catalog/auth types,
  Jira URL + email validation, the env-key contract, `isAtlassianHost` SSRF guard,
  owner-403 / required-credential-400, `[CONN4A-EXEC]` the resolved bag carries the
  runtime keys, a **sentinel leak sweep** (neither token nor key name in any response),
  the live test dials only known hosts + records `error` on failure, disconnect purge,
  cross-tenant 404. Full backend suite (1452) + evals (11/11) + tsc green.
- **SR focus (met):** no token in any read (value + key sentinels); SSRF-safe test
  (known hosts only, host-guarded Jira); encryption at rest; owner gate binds; the
  audit-log hook covers the mutating routes. The powerful-capability containment
  (`connector:` cap + trust) is still CONN-7 — until then, owner-configured + least-priv.

#### CONN-4b — GitHub + Jira WEB + MOBILE accordion rows ✅ SHIPPED
_As-built on `conn-4b-github-jira-ui`. Client-only; enables the CONN-4a connectors
in the accordion on BOTH surfaces over the same contract — no backend change._

- **Available-set:** `github` + `jira` moved from the "coming soon" set to the
  AVAILABLE set in BOTH client catalogs (`web/lib/agentConnectors.ts` +
  `apps/mobile/src/agentConnectors.ts`, kept field-for-field identical). Their rows
  now render a real inline config form instead of a disabled "coming soon" note.
  The available-set is now `[github, jira, mcp]` on both clients.
- **GitHub form** (`GithubConfig`, both surfaces): optional `username` (non-secret
  display label) + a **write-only Personal Access Token**. Saves via
  `POST …/connectors/github` `{ config: { username? }, secret: PAT }`. Masked status
  + `accountLabel`, **Test** (CONN-4a's real `api.github.com/user` check), Disconnect.
- **Jira form** (`JiraConfig`, both surfaces): `baseUrl` (URL input, validated) +
  `email` (email input) as non-secret config + a **write-only API token**. Saves via
  `POST …/connectors/jira` `{ config: { baseUrl, email }, secret: token }`. Test
  (CONN-4a's Atlassian-host check), Disconnect.
- **Client-side validation mirrors the CONN-4a backend zod** (`validateGithubConfig`
  / `validateJiraConfig` in both catalog modules): github username ≤120; jira
  baseUrl a valid URL ≤2048 + email valid ≤320; the token is required only on a
  FIRST configure (blank on re-configure keeps the stored token). The server stays
  the final validator (`.strict()`).
- **SECURITY (identical to custom MCP):** the token field is WRITE-ONLY
  (`type=password` on web / `secureTextEntry` on mobile), seeded from `''` and NEVER
  from a read, cleared after a successful save; blank-on-save preserves the stored
  token. The API returns only masked status + non-secret config (username / baseUrl
  / email + accountLabel) — the token is **never displayed**. Tests assert
  `githubConfigToForm` / `jiraConfigToForm` cannot surface a credential even if one
  leaks into `config`.
- **Owner-gating + 403** identical to the existing rows: the list GET is owner-gated
  (403 on load → read-only note), a mutating 403 preserves edits incl. the typed
  secret; the backend is the real gate.
- **Parity tripwires updated:** the client available-set now includes github/jira and
  the **SUBSET** tripwire (client ⊆ backend `AGENT_CONNECTORS`) stays green; the
  cross-platform test still asserts the phone == the desk field-for-field, now also
  agreeing on the github/jira validators; form-validation tests for github/jira added
  to both clients.
- **Verify:** web `npm run build` + `npm test` (239/239) green; `apps/mobile`
  `npm test` (280/280) + `npm run typecheck` + `npm run export` (boot-safe) green.
  Additive to `web/**` + `apps/mobile/**` + docs. **SDK 54 / react 19.1.0 / boot-safe
  untouched** (RN core inputs only). **This completes GitHub + Jira as usable per-agent
  connectors on both surfaces.**

### CONN-5 — Per-agent Google OAuth ✅ SHIPPED
_As-built on `conn-5-google-oauth`. WEB/desktop run the FULL OAuth flow; MOBILE is
CONFIG-ONLY (status + account email + "connect from the web dashboard" — the phone
can't complete OAuth without an EAS dev build, decision B)._

**One Google connection per agent.** The three Google service rows (Calendar/Gmail/Drive)
collapsed into a single `google` connector (catalog id `google`, authType `oauth`) whose
config records the granted `{ services, scopes }`. The operator selects which services to
grant at connect time; the row shows the connected account email + granted scopes.

**Storage — agent-scoped, ENCRYPTED (an improvement over the org connector):**
- New table **`agent_oauth_tokens`** (`schema.ts`, migrated in `setup.ts`): keyed by
  `(org_id, agent_id, provider)`, holds `access_token_enc` / `refresh_token_enc`
  (AES-256-GCM via `services/secrets.encrypt`), `expires_at`, `scopes`, `account_email`.
  Deliberately **NOT** the `secrets` table, so a refresh token is never swept into the
  agent env bag (`GET /api/agent/secrets`). Tokens are never projected by
  `toPublicConnector`, never returned to a client, never logged.
- The org `oauth_tokens` table (plaintext, keyed by org) is untouched.

**State security — unforgeable + single-use + expiring + PKCE:**
- New table **`agent_oauth_states`**: the `id` IS the `state` param — 256 bits of
  randomness (unguessable, unforgeable), server-side only, bound to one
  `(org, agent, connector)`, carrying the PKCE `code_verifier`, expiring after 10 min,
  and spent exactly once (`used_at` set by an atomic conditional UPDATE — two concurrent
  callbacks can't both win). This replaces the org flow's forgeable `state=orgId`.
- **PKCE S256** binds the auth code to the flow's verifier.
- `services/agent-google-auth.ts` owns the crypto/HTTP + the state/token store;
  `services/oauth-redirect.ts` is the redirect allow-list (only `ALLOWED_ORIGINS` — no
  open redirect; the Google `redirect_uri` is always our own fixed callback).

**Routes:**
- **Start** (owner-gated, secured scope): `POST …/agents/:agentId/connectors/google/oauth/start`
  → validates agent-in-org, picks services (≥1), mints a state row + PKCE, returns the
  Google consent URL. Mints no token.
- **Callback** (PUBLIC, registered beside `authRoutes`): `GET /api/agent-connectors/google/callback`
  → spends the state once, exchanges the code (PKCE), fetches the account email, stores
  ENCRYPTED tokens, records the connector row (`status='connected'`), bounces to
  `/dashboard?google=connected&agent=…` (no token in the URL). Bad/expired/reused state,
  denied consent, or a vanished agent → `?google=error`, no token issued.
- **Disconnect** (owner-gated): the existing DELETE, extended to best-effort revoke at
  Google + purge the `agent_oauth_tokens` row.
- The generic configure POST/PUT **reject** the oauth connector (no half-connected row).

**Runtime reach:** `agent-executor.ts`'s Drive-context block now PREFERS the agent's own
Google token (`ensureFreshAgentGoogleToken` → decrypt → refresh + re-encrypt in place →
`searchDriveFiles`), falling back to the org token — so a per-agent Google connection
actually reads that account's Drive. Same backend-side mechanism the org connector uses.

**UI:** web `ConnectorsTab` gets a real Google panel (service checkboxes, Connect →
launch OAuth → return banner, connected email + granted scopes, Disconnect). Mobile
`AgentConnectors` shows the `google` row read-only (status + email + services + "Connect
Google from the web dashboard") with no button/flow.

**Tests:** `backend/src/tests/conn5-google-oauth.test.ts` (20 cases) — state
forgery/expiry/replay rejected, callback issues no token on bad state, tokens encrypted
at rest + never in any response, owner-gate (member→403), tenant (org A ✗ agent B→404),
runtime resolve + refresh/re-encrypt, disconnect purge, generic-write guard. Mobile
parity tests updated (single `google` row; `AVAILABLE = [github, jira, google, mcp]`).

**SR focus (for the reviewer):** the atomic single-use state spend, the token-never-leaks
allow-list, the redirect allow-list, and that the org plaintext path is unchanged.

### CONN-6 — Remaining Communication connectors, config + credential storage ✅ SHIPPED
_As-built on `conn-6-comms-connectors`. Backend + web + mobile in one PR. Telegram,
WhatsApp and Google Chat become per-agent connectors for **STORAGE** (config + encrypted
credential, agent-scoped, rides the existing env-injection path). The backend does NOT
yet SEND/RECEIVE — that is the CONN-8 execution bridge (decision D). **Signal stays OUT
of scope** (no official API)._

- **Catalog:** `telegram`, `whatsapp`, `google_chat` added to `AGENT_CONNECTORS`
  (`services/agent-connectors.ts`), all `category: 'Communication'`, `authType: 'token'`,
  `hasSecret` + `secretRequired` (a comms connector with no credential is not real).
  Config schemas (zod, `.strict()`, all NON-secret fields optional): telegram
  `{ botUsername?, chatId? }`, whatsapp `{ phoneNumberId?, businessAccountId? }`,
  google_chat `{ space? }`. The credential is always the WRITE-ONLY `secret`, never config.
- **The execution contract — env-var KEYS** (`CONNECTOR_ENV_KEYS`), the same wire that
  makes GitHub/Jira real (`GET /api/agent/secrets` → adapters inject the bag VERBATIM as
  env). ⚠️ **These are documented for operator confirmation — a wrong name is a one-line
  edit in `CONNECTOR_ENV_KEYS` + `connectorSecretEntries`:**

  | Connector | Env keys stored at agent scope (→ injected as env) | Evidence |
  |---|---|---|
  | **telegram** | `TELEGRAM_BOT_TOKEN` (secret), `TELEGRAM_CHAT_ID` (non-secret) | **CONFIRMED** — `routes/telegram-webhook.ts` reads `process.env.TELEGRAM_BOT_TOKEN`; the openclaw adapter reads `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (`mc_adapter.py`). |
  | **whatsapp** | `WHATSAPP_ACCESS_TOKEN` (secret), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` (non-secret) | **CONVENTIONAL** Meta Cloud API names — **NO in-repo consumer yet** (execution is CONN-8). ⚠️ operator: confirm your WhatsApp tooling reads exactly these. |
  | **google_chat** | `GOOGLE_CHAT_WEBHOOK_URL` (secret = the incoming-webhook URL) | **CONVENTIONAL** — **NO in-repo consumer yet.** The webhook URL embeds a `key`+`token`, so it IS sensitive → stored as the write-only secret, never in `config`. A bot/service-account flow can replace it later with no data migration. ⚠️ operator: confirm. |

  Non-secret ids (telegram `chatId`, whatsapp phone/business ids) are ALSO written into the
  encrypted secret store (env injection is the only channel to the runtime — `config` is
  not injected) AND kept in `config` as the returnable display source of truth. The
  sensitive key (`primarySecretKey` → `TELEGRAM_BOT_TOKEN` / `WHATSAPP_ACCESS_TOKEN` /
  `GOOGLE_CHAT_WEBHOOK_URL`) is recorded as the row's `secretRef`.
- **`test` is a SAFE STUB** (unlike CONN-4a's github/jira live checks): no provider is
  dialed — a telegram/whatsapp/google_chat test never opens a socket (a test asserts
  `fetch` is never called), avoiding the SSRF surface of an arbitrary webhook / graph host.
  It records the attempt and returns the masked label. Real pings land with execution (CONN-8).
- **Web + mobile:** the three rows move from "coming soon" to **available** in both client
  catalogs (`web/lib/agentConnectors.ts` + `apps/mobile/src/agentConnectors.ts`, kept
  field-identical) with real inline config forms (write-only secret + non-secret inputs),
  save/test/delete, masked status, owner-gated + 403 handling — identical to the github/jira
  rows. A shared `useCommsConnector` hook factors the save/test/delete plumbing on each
  platform so the write-only-secret contract lives in one place. **Signal stays out-of-scope.**
- **Security:** the credential lives ONLY in the encrypted `secrets` store, NEVER in the
  `agent_connectors` row, NEVER in any read/list/get/test/put response, NEVER logged.
  `toPublicConnector()` masks unchanged; the new non-secret config fields are returnable, the
  credential is not. Disconnect purges EVERY agent-scoped env row (credential + non-secret ids).
- **Tests:** `tests/agent-connectors-comms.test.ts` (+10): catalog/auth types, strict config
  validation, the env-key contract, owner-403 / required-credential-400, `[CONN6-EXEC]` the
  resolved bag carries all runtime keys, a **sentinel leak sweep** (no credential or key name
  in any response), `test`-is-a-stub (no dial), disconnect purge, cross-tenant 404. Client
  parity tripwires updated (available set now `[google_chat, telegram, whatsapp, github, jira,
  google, mcp]`; SUBSET tripwire green; cross-platform validators agree) + form-validation +
  config-to-form leak tests on both clients. (Also fixed a pre-existing red: CONN-5 updated the
  web catalog to one Google row but left `web/lib/agentConnectors.test.ts` asserting the old
  three — brought the two web assertions in line.)
- **SR focus (met):** no credential in any read (value + key sentinels); `test` opens no
  socket (SSRF-free by construction); encryption at rest; owner gate binds (member 403,
  cross-tenant 404); disconnect purge. The `connector:` capability containment is still CONN-7.

### CONN-7 — Connector containment: capability + trust + approval model ✅ SHIPPED
_As-built on `conn-7-connector-containment`. Backend policy + enforcement + web + mobile
trust toggle in one PR. This DEFINES and ENFORCES the policy CONN-8 (execution) MUST
consult before running any connector action — **CONN-7 itself does NOT execute
connectors.** The confirmed, operator-approved model: **READ runs freely; WRITE/SEND
needs approval by default via the EXISTING dangerous-approval + step-up flow; a per-agent
per-connector owner-set TRUST toggle can auto-approve WRITEs for a trusted pair; but
DESTRUCTIVE actions ALWAYS need approval, even when trusted.** Fail-closed throughout._

- **The action TAXONOMY** (`services/connector-authz.ts` `CONNECTOR_ACTION_TAXONOMY`) —
  the data map CONN-8 consults. Per connector, action verbs classify into READ / WRITE /
  DESTRUCTIVE, plus a `defaultClass` for verbs not in any set:

  | Connector | READ | WRITE / SEND | DESTRUCTIVE | default (unrecognized) |
  |---|---|---|---|---|
  | **github** | read/get/list/search, get_issue, get_repo… | create/update/comment/push/commit, issue.create, pr.create… | delete, force_push, repo.delete, branch.delete… | **unknown** (fail-closed) |
  | **jira** | read/get/search/jql, get_issue… | create/transition/comment/assign, issue.create… | delete, issue.delete | **unknown** |
  | **google** (Gmail/Cal/Drive) | read/get/list/search, list_messages, list_files… | send/create/update/reply/share/upload, create_event… | delete/trash/empty_trash, delete_file… | **unknown** |
  | **telegram / whatsapp / google_chat** | read/get/get_updates… | **send/send_message/post/reply** | delete_message… | **write** (comms = send) |
  | **mcp** (custom) | — | — (all tool calls) | (keyword-guarded) | **write** (a tool call is WRITE by default) |

  A DESTRUCTIVE-keyword guard (`delete|destroy|drop|purge|remove|wipe|revoke|truncate`)
  is the backstop: a stray `delete_*`/`purge_*` on ANY connector is forced to DESTRUCTIVE
  even if not explicitly listed — a trusted connector can never auto-approve it. Write/read
  keyword fallbacks map sensible unrecognized verbs; otherwise the connector `defaultClass`
  applies. **mcp defaults to WRITE** (unknown tool → approval unless trusted); everyone else
  defaults to **unknown → needs_approval EVEN when trusted** (the fail-closed choice).
- **The TRUST column** — additive `trust_level` on `agent_connectors`
  (`'approval_required'` default | `'auto_write'`), idempotent migration in `db/setup.ts`
  (added to BOTH the `CREATE TABLE` and the ALTER list — the ALTER runs before the CREATE on
  a fresh DB, so the column must be in the CREATE too). Owner-set via a new owner-gated
  `PUT …/connectors/:cid/trust` (enum-validated, 404 on an unconfigured connector). It is an
  ENUM, **never a secret** — added to `PUBLIC_CONNECTOR_FIELDS` (returnable), and the
  column-classification test still passes.
- **Capability enforcement** — the reserved `connector:` namespace is now REAL:
  `hasConnectorCapability(permissions, connectorId)` requires `connector:<id>` (or
  `connector:*` / `*`) via `governance2.isCapabilityAllowed`. Absent → **deny**.
  `agent-permissions.ts` already accepted `connector:<action>` caps as writable (the
  namespace was reserved there), so owners can grant them today.
- **The enforcement service** — `authorizeConnectorAction({orgId, agentId, connectorId,
  action})` → `{ decision: allow | needs_approval | deny, reason, classification,
  approvalId? }`. Pure core `decideConnectorAuthorization`: capability check (deny if
  missing) → connector-configured check (deny if not) → READ→allow → DESTRUCTIVE/unknown→
  needs_approval (trust ignored) → WRITE→allow-if-`auto_write`-else-needs_approval. On
  `needs_approval` it **files an `approval_requests` row of the new dangerous type
  `connector_action`** via `prepareApprovalRecord` (machine-rendered summary, never model
  prose) — so it lands in the operator's Inbox and **requires the SAME step-up**
  (`x-arturita-session` fresh session) the phone/desk already enforce on the
  `/approvals/:id/decide` gate. A missing/cross-tenant agent, unknown connector, or blank
  action all resolve to **deny** — never a silent allow.
- **Reused, not rebuilt** — `dangerous-approvals.ts` gained one type
  (`'connector_action'`) + one renderer; the decide route's step-up gate
  (`isDangerousType(type) || payload.requiresStepUp`) already binds it. No parallel
  approval mechanism.
- **UI (web + mobile)** — an owner-only per-connector **Write trust** toggle in the
  Connectors accordion ("Require approval for writes" ↔ "Auto-approve writes (trusted)")
  with an explicit note that **destructive actions always require approval**. Shown for any
  CONFIGURED connector; read-only surface stays owner-gated (the backend is the enforcer).
  Mobile mirrors it (SDK 54 / react 19.1.0 / boot-safe, RN-core only); Google on the phone
  stays config-only (its trust is set from the web dashboard, mirroring CONN-5).
- **Tests** — `backend/src/tests/connector-authz.test.ts` (24): taxonomy read/write/
  destructive + fail-closed-unknown + destructive-keyword override; the pure decision
  matrix; `authorizeConnectorAction` files the approval + no credential leaks into the card;
  write-trusted→allow but destructive-trusted→needs_approval; missing-cap→deny;
  not-configured→deny; cross-tenant→deny; **no step-up bypass** (`decideApproval` refuses
  approve without a fresh session); owner-only trust toggle (member→403), invalid enum→400,
  unconfigured→404, cross-tenant→404; every backend connector has a taxonomy entry. Client
  parity: `TRUST_LEVELS` + `isTrusted` mirrored web⇄mobile (cross-platform tripwire agrees).
- **SR focus (met):** fail-closed decision (deny/needs_approval on any ambiguity), DESTRUCTIVE
  never bypassed by trust, unknown-action never auto-approved on a known provider, capability
  required to use a connector at all, the approval routes through the EXISTING step-up gate
  (no cheaper path), owner-only trust, tenant-scoped, no secret in the trust enum or the
  approval card. **CONN-8 must call `authorizeConnectorAction` first and only proceed on
  `allow`.**

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
- **The containment CONTRACT with CONN-7 (now shipped):** CONN-8 MUST call
  `authorizeConnectorAction({orgId, agentId, connectorId, action})`
  (`services/connector-authz.ts`) BEFORE running ANY connector action, and:
  **`allow`** → proceed; **`needs_approval`** → hold the action until the returned
  `approvalId` is approved through the Inbox + step-up gate; **`deny`** → drop it. The
  policy (capability → classification → trust) already exists and is tested — CONN-8 is
  purely the *invocation* plumbing on top of that gate.
- Flagged as its **own epic**, sequenced after the capability/containment work (CONN-7).

#### CONN-8a — Execution framework + first executor (GitHub) ✅ SHIPPED

The harness that turns "authorized" into "actually invoked". Backend-only (framework +
GitHub executor + a secured agent-facing route). **Mobile parity: N/A** — 8a ships no UI;
triggering/monitoring executions from web/mobile is a later slice (CONN-8b).

- **One entry point** — `executeConnectorAction({orgId, agentId, connectorId, action,
  params, approvalId?})` in `services/connector-execution.ts`. The decision flow, all
  fail-closed:
  1. **Scope** — the agent must exist and belong to `orgId` (never cross-tenant); the
     connector must be known + configured (not disabled).
  2. **Explicit capability (CONN-7 carry-forward i)** — execution requires an EXPLICIT
     `connector:<id>` / `connector:*` / `*` cap. Unlike CONN-7's `authorizeConnectorAction`
     (whose `isCapabilityAllowed` treats an empty permission list as legacy allow-all),
     the execution framework **denies an empty/absent permission list** — an agent with no
     declared permissions can no longer make real external calls by default.
     (`hasExplicitConnectorCapability`.)
  3. **A real executor must exist** for the connector or nothing runs. 8a registers
     **GitHub only**; jira/google/comms/**mcp** have no executor and are refused — a
     fail-closed default, not an oversight.
  4. **The CONN-7 decision** (`decideConnectorAuthorization`, with the tightened cap):
     READ → allow; WRITE → allow only if trusted (`auto_write`); DESTRUCTIVE / UNKNOWN →
     needs approval. Plus **carry-forward ii**: an OPAQUE tool the executor can't vouch
     for (MCP's open-ended surface) is escalated to needs_approval **even under
     auto_write** (`mustEscalateUnknownWrite`; GitHub's fixed action set is unaffected).
  5. **`deny`** → `denied`, nothing runs. **`needs_approval`** → a dangerous
     `connector_action` approval is filed (the SAME machine-rendered card + step-up the
     Inbox uses, via the shared `fileConnectorActionApproval`) and a `pending_approval`
     result with the `approvalId` is returned — **NOT executed**. **`allow`** → execute
     exactly once.
- **The approved-once execution path.** A `needs_approval` action does **not** run just
  because the agent holds an `approvalId`. Execution requires the caller to re-invoke with
  that `approvalId` **after** the operator approves it in the Inbox **with step-up** (the
  decide route only reaches `approved` after a fresh command session). On redemption the
  framework verifies the approval is `connector_action`, in the org, **`approved`**, and
  **bound to this exact (agent, connector, action)** — so an approval for X can't run Y and
  agent A can't redeem agent B's approval. **Single-use** is enforced atomically by a
  UNIQUE index on `connector_executions.approval_id`: the redemption is *claimed* (a row
  inserted) **before** the provider call, so a replay — or two concurrent redemptions —
  hits the constraint and is rejected. At-most-once: even a failed provider call consumes
  the approval (re-approval, not replay, is the recovery).
- **The GitHub executor** (`services/connector-github.ts`) — a fixed-surface adapter.
  Actions and their taxonomy alignment (each `class` MUST equal
  `classifyConnectorAction('github', action)`, asserted in tests):
  `repo.get` / `issues.list` / `issue.get` → **READ**; `issue.create` / `issue.comment` →
  **WRITE**; `repo.delete` → **DESTRUCTIVE**. **SSRF is closed by construction**: the host
  is hardcoded to `api.github.com`, every URL is that constant + validated/encoded path
  segments, `owner`/`repo` are charset-restricted and the issue number must be a positive
  integer — params never supply a URL. Uses the stored agent-scoped `GITHUB_TOKEN`.
- **Credential handling.** The token is decrypted **only at execution time**, filtered to
  just this connector's env keys (least privilege), used only in the `Authorization`
  header, and **never** returned, logged, or stored. A deep `redactSecrets` pass over the
  result and a redaction of every error string are the belt-and-suspenders backstop
  (a provider echoing the token can't leak it). The `connector_executions` ledger stores
  action/classification/status/**sanitized** error only — never the credential or params.
- **Bounds.** `boundedHttpClient` enforces a hard 10s timeout (AbortController) and a 1 MB
  response cap (content-length *and* materialized body). Provider failures surface as clean
  structured errors (`ConnectorProviderError`) — never a raw provider body.
- **How an agent reaches it** — `POST /api/agent/connectors/:connectorId/execute` (added
  to `routes/agent-api.ts`, behind `agentAuth`). Org + agent come from the agent token,
  **never the body**, so it is inherently org-scoped and cannot be aimed at another
  tenant's agent. Status mapping: executed → 200, pending_approval → 202, denied → 403,
  provider error → 502, rejected (replay / un-approved / unsupported / bad action) → 409.
  This is how BYO runtimes already reach every other capability (`/secrets`, `/approvals`).
  **The internal LLM loop (`agent-executor.ts`) was intentionally NOT modified** — wiring
  execution into that path is a larger, riskier change deferred to CONN-8b; the integration
  point is this same `executeConnectorAction` entry, callable with the agent's own
  `(orgId, agentId)`.
- **New table** — `connector_executions` (idempotent migration in `db/setup.ts`): the
  single-use ledger. UNIQUE(`approval_id`) is the replay guard; allow-path rows carry a
  NULL `approval_id` (many allowed) as an audit trail. Reversible: DROP TABLE.
- **Tests** — `src/tests/connector-execution.test.ts` (19): deny (no cap / legacy
  allow-all / not configured / cross-tenant), fail-closed on no-executor, READ executes
  (mocked transport), WRITE→approval-not-executed, un-approved redemption rejected,
  step-up-refused-stays-pending, approved+stepped-up executes exactly once + replay
  rejected, approval bound to action+agent, auto_write WRITE executes, DESTRUCTIVE under
  auto_write still needs approval, credential-never-leaks (sentinel, incl. echoed token &
  ledger), SSRF host-fixed, and the secured route (401/403/202). No real network.

#### CONN-8b-1 — Jira + comms executors (Telegram / WhatsApp / Google Chat) ✅ SHIPPED

The next real executors, plugged into the same CONN-8a framework (same interface, same
authz gate, same single-use approvals, same credential-at-execution + `redactSecrets`
backstop). **Backend-only** — no route change (they register in the framework's `EXECUTORS`
map and are reached by the existing `POST /api/agent/connectors/:connectorId/execute`).
**Mobile parity: N/A** — 8b-1 ships no UI; the execution UI is CONN-8b-4.

- **Jira** (`services/connector-jira.ts`) — READ `issue.get`, `issue.search`; WRITE
  `issue.create`, `issue.comment`, `issue.transition`; DESTRUCTIVE `issue.delete`. Basic
  auth from the agent-scoped `JIRA_EMAIL:JIRA_API_TOKEN`. **SSRF:** the host is per-tenant
  (not hardcodable), so it comes from the stored `JIRA_BASE_URL` secret — **never a param** —
  and is re-validated on *every* execution: https, no embedded userinfo, and an Atlassian
  Cloud host via CONN-4a's `isAtlassianHost` (`*.atlassian.net`). We then dial only that
  URL's **origin** (scheme+host, discarding any path/query/fragment) + validated, encoded
  path segments (issue key charset-restricted; JQL encoded into the query). A self-hosted
  Jira is refused at execution (fail-closed).
- **Telegram** (`services/connector-telegram.ts`) — WRITE `message.send` → POST
  `https://api.telegram.org/bot<token>/sendMessage` (**host hardcoded**). Token from
  `TELEGRAM_BOT_TOKEN`, chat id from the `chatId` param or the stored `TELEGRAM_CHAT_ID`.
  **Token-in-URL leak defence:** the token lives in the URL path, so the URL is itself a
  secret — it is **never** placed into an error or a returned value (errors surface only
  Telegram's short `description` + status), and the token is validated to a strict
  `^[0-9]+:[A-Za-z0-9_-]+$` charset so it can't break out of the fixed-host path. The
  framework's `redactSecrets` strips the token value from any result/error as a backstop.
- **WhatsApp** (`services/connector-whatsapp.ts`) — WRITE `message.send` → POST
  `https://graph.facebook.com/v21.0/<phoneNumberId>/messages` (**host + API version
  hardcoded**). Bearer `WHATSAPP_ACCESS_TOKEN`; `phoneNumberId` from param or stored
  `WHATSAPP_PHONE_NUMBER_ID`, validated digits-only and encoded (can't escape the path);
  recipient + text in the JSON body.
- **Google Chat** (`services/connector-google-chat.ts`) — WRITE `message.send` → POST the
  stored `GOOGLE_CHAT_WEBHOOK_URL`. **Webhook-URL-as-secret defence:** the incoming-webhook
  URL embeds a key+token in its query, so the whole URL is both the credential *and* the
  dial target — it is **never** param-supplied and is re-validated on every execution
  (https, no userinfo, host **exactly** `chat.googleapis.com`) before dialing, and never
  placed into an error (errors surface only a status). `redactSecrets` strips the URL value
  as a backstop.
- **Taxonomy alignment** — every action's declared `class` is asserted equal to
  `classifyConnectorAction(connectorId, action)` (the CONN-7 taxonomy) in the test, so an
  executor can never drift from the authorization policy. WRITE stays approval-gated unless
  the (agent, connector) pair is `auto_write`; Jira's `issue.delete` is DESTRUCTIVE →
  always needs approval even when trusted.
- **Tests** — `src/tests/connector-execution-jira-comms.test.ts` (12, mocked transport, no
  real network): taxonomy alignment for all four; all four registered; Jira READ executes;
  WRITE→approval-not-executed→approved+stepped-up→executes-once (+ replay rejected); Jira
  `issue.delete` destructive→always approval under auto_write; comms sends gated then
  execute against their hardcoded/validated hosts; **credential-never-leaks per connector**
  (sentinels incl. Telegram's bot-token-in-URL and the Google Chat webhook-URL-as-secret, in
  result + error + ledger); **SSRF** — Jira baseUrl restricted to Atlassian (non-Atlassian +
  userinfo-spoof + bad issue key refused, no call), Google Chat webhook restricted to
  `chat.googleapis.com` (evil host / subdomain-suffix / userinfo / non-https refused),
  Telegram token metachar refused.

#### CONN-8b-2 — Google Workspace executor (Gmail / Calendar / Drive) ✅ SHIPPED

The first **OAUTH-credentialed** executor — the killer surface (an agent that sends email,
touches Calendar/Drive with the user's Google account). Backend-only. **Mobile parity:
N/A** — 8b-2 ships no UI (execution UI is 8b-4); the phone is a thin REST client to the
same hosted backend and reaches this through the existing generic `.../execute` route.

- **The credential is DIFFERENT from the env-secret executors.** github/jira/comms read a
  value from the encrypted **env secret bag** (`resolveSecretsForAgent` → `ctx.secrets`).
  Google does **not**: the credential is the agent's per-agent Google OAuth **access
  token**, which lives AES-encrypted in CONN-5's **`agent_oauth_tokens`** (never the env
  bag). The framework now carries a **credential kind** on each executor:
  `credentialKind: 'google_oauth'` tells `runExecutor` to resolve the token via CONN-5's
  **`ensureFreshAgentGoogleToken`** (decrypt → refresh if within 60s of expiry →
  re-encrypt in place) and hand the executor `ctx.oauthAccessToken` (+ `ctx.oauthScopes`),
  leaving `ctx.secrets` empty. The resolver is **injectable** (`ExecuteOptions.googleTokenResolver`,
  mirroring the injectable `httpClient`) so tests never touch Google. The **refresh token
  never reaches an executor** — only the access token + non-secret scope/label metadata.
- **Fail closed on no connection / revoked.** If the resolver returns `null` (never
  connected, or expired with no refresh token) or throws (refresh rejected — revoked
  grant), the action does **NOT** execute: a clean `error` ("(re)connect the agent's
  Google account") is returned and the ledger row is marked failed. The raw refresh error
  is never surfaced.
- **The Google executor** (`services/connector-google.ts`). Actions + taxonomy alignment
  (each `class` MUST equal `classifyConnectorAction('google', action)`, asserted in tests):
  - **READ** — `gmail.list` / `gmail.get`, `calendar.list` / `calendar.event.get`,
    `drive.list` / `drive.file.get`.
  - **WRITE** (approval unless `auto_write`) — **`gmail.send`** (the killer action; builds
    an RFC 5322 message → base64url → `messages/send`), `calendar.event.create`,
    `drive.file.create` / `drive.file.update`.
  - **DESTRUCTIVE** (approval ALWAYS, even trusted) — `calendar.event.delete`,
    `drive.file.delete` (real DELETEs), and `gmail.delete` which additionally **fails
    closed on a missing scope** — CONN-5 requests only `gmail.readonly` + `gmail.send`, so
    trashing/deleting mail (needs `gmail.modify` / full access) is refused until an
    operator widens the grant.
- **SSRF closed by construction.** Hosts are **hardcoded** — `gmail.googleapis.com` for
  Gmail, `www.googleapis.com` for Calendar v3 + Drive v3. No param ever supplies a host,
  origin, or path base. Every id (message / event / file) and `calendarId` is validated
  against a strict charset **then** `encodeURIComponent`-encoded; query params travel
  through `URLSearchParams`. To/Cc/Subject on `gmail.send` are rejected if they contain
  control chars (header-injection guard). The framework transport's `redirect:'error'` +
  10s timeout + 1 MB cap apply unchanged.
- **Scope enforcement (best-effort, fail-closed).** One Google connection covers all three
  services, but each action needs a specific granted scope. Before dialing, the action
  pre-checks the granted scope string (`ctx.oauthScopes`, now returned by
  `ensureFreshAgentGoogleToken`) and fails closed with a clean **"reconnect with X"**
  instead of a raw Google 403. If the grant is unknown (null) it proceeds and the 403
  handler still returns a clean, tokenless error (401/403 map to reconnect guidance).
- **Credential never leaks.** The access token is used only in the `Authorization` header;
  the framework registers it for the same deep `redactSecrets` backstop, so a provider that
  echoes it in a 2xx body or an error is scrubbed. The `connector_executions` ledger stores
  action/classification/status/sanitized-error only — proven by a sentinel over **both**
  the access and refresh tokens.
- **Gated exactly like GitHub.** Same CONN-7 authz, same single-use approved-once redemption
  (`connector_executions` UNIQUE(`approval_id`)), same step-up. No new table, no route
  change — registering `google` in the `EXECUTORS` map lights up the existing generic
  `POST /api/agent/connectors/:connectorId/execute`.
- **Params are bound to the approval (audit NIT-1 — a framework-level gap that 8b-2
  elevates to high-consequence).** CONN-8a bound an approval to (connectorId, action,
  agentId) but **not** the params, so an operator who approved "gmail.send to bob subject Y"
  could have the agent redeem that SAME approval to send to eve with different content. Now
  the shared `fileConnectorActionApproval` stores a **server-computed** sha256 `paramsDigest`
  of the canonicalized (recursively key-sorted) params — the agent cannot forge it — and
  `redeemAndExecute` **recomputes the digest from the params the agent submits at redemption
  and requires an exact match** (a mismatch, or a missing/legacy digest → `rejected`,
  nothing executes). So the approved params ARE the executed params. The operator card's
  target line is also **derived server-side from the real params** for high-consequence
  actions (`gmail.send` → recipient + subject, calendar/drive → summary/name/id — never the
  untrusted agent label, never the message body). **NIT-2:** a pure `.`/`..` `calendarId` is
  rejected (the one id charset that allows dots).
- **Tests** — `src/tests/connector-google.test.ts` (17): taxonomy alignment + credential
  kind, READ executes (mocked transport + injected resolver AND the real
  `ensureFreshAgentGoogleToken` over a seeded encrypted row), hardcoded per-family hosts,
  `gmail.send` WRITE→approval-not-executed→approved+stepped-up→executes-once→replay-rejected,
  **params-binding (an approved send redeemed with DIFFERENT params → rejected + nothing
  sent; the exact params with shuffled key order → executes once; the card shows the real
  recipient, not the agent label)**,
  DESTRUCTIVE under `auto_write` still needs approval, access-token-never-leaks +
  refresh-never-seen (sentinels, incl. echoed token & ledger), no-connection / revoked →
  fail closed, SSRF host-fixed + header-injection rejected, missing-scope clean reconnect,
  `gmail.delete` fail-closed. No real network, no real Google.

#### CONN-8b-3 — Custom-MCP invocation bridge ✅ SHIPPED

The **riskiest** executor and the only **OPEN-ENDED** one. Unlike every fixed-host provider,
the MCP server address is **user-configured** (an arbitrary `url` in the connector's
non-secret config), so it is a real **SSRF / egress** surface, and the tool names are
**opaque** (a third-party server's own vocabulary). Backend-only. **Mobile parity: N/A** —
8b-3 ships no UI (execution UI is 8b-4); the phone reaches this through the existing generic
`.../execute` route against the same hosted backend. `services/connector-mcp.ts`, registered
as `mcp` in `EXECUTORS`.

- **v1 = http-transport MCP servers only. stdio is DELIBERATELY not executed.** A `stdio`
  MCP server means spawning a local **command** on the host — arbitrary host command
  execution, a large and dangerous surface. A stdio-configured connector **fails closed**
  with a clear "stdio MCP execution not yet supported" and no dial; it is deferred to a
  later, carefully-audited stage. Only `transport: 'http'` executes.
- **The action IS the tool name; params ARE the tool args.** An invoke maps to a single
  JSON-RPC 2.0 `tools/call` (`{name: action, arguments: params}`) POSTed to the configured
  URL. A built-in `tools.list` meta-read (JSON-RPC `tools/list`) is offered for display, but
  **invocation gating never depends on trusting the server's self-description**. Because the
  action set is not fixed, the framework gained an **open-ended dispatch hook**
  (`ConnectorExecutor.invoke(action, ctx)`): when no fixed `actions[action]` spec matches,
  `runExecutor` calls `invoke` — so any opaque tool name reaches one handler, while the class
  was already resolved by `classifyConnectorAction` (authz is unaffected).
- **Opaque-tool escalation — the key containment (CONN-7 carry-forward ii, generalized).** An
  MCP tool name is opaque, so `classifyConnectorAction('mcp', …)` treats it as **WRITE by
  default** and a **destructive-named** tool (`hasDestructiveVerb`) as **destructive → ALWAYS
  approval**, even under `auto_write`. Critically, the framework's new
  `ConnectorExecutor.escalateAllowToApproval(action, config)` hook (which **supersedes**
  `mustEscalateUnknownWrite` for MCP) escalates **any otherwise-allowed tool — read- OR
  write-classified — that the operator has NOT explicitly allow-listed** to `needs_approval`.
  So neither `auto_write` nor a read-looking name (`get_*`, `list_*`) can blanket-approve an
  arbitrary third-party tool. **Only** tool names on the per-connector **`autoApproveTools`**
  allow-list (a new NON-secret field on the MCP config schema) may auto-run under
  `auto_write`; the built-in `tools.list` meta-read is the one exemption. An empty/absent
  allow-list ⇒ **every** opaque tool needs approval (fail-closed for the opaque surface).
- **SSRF / EGRESS policy (the crux — the URL is user-supplied).** Enforced in two layers so
  the value validated is the value connected:
  - **Synchronous URL-shape guard** (`validateMcpUrlShape`, runs before any dial): **https
    only** (http and every other scheme rejected — no http-to-localhost dev exception in v1),
    **no embedded userinfo** (`user:pass@host` rejected — the classic host-spoof), and a
    **literal-IP host is validated on the spot** and refused if private (this is the ONE case
    the DNS lookup never sees, since `net.connect` skips the custom lookup for IP literals;
    IPv6 brackets are stripped first).
  - **DNS-pinning transport** (`createMcpHttpsClient`, a node:https client set as the
    executor's `defaultHttpClient`): its custom `lookup` resolves the host, **refuses if ANY
    resolved address is in a blocked range**, and returns **only validated addresses**, so
    `net.connect` dials exactly what was checked — **no DNS-rebinding TOCTOU** (no re-resolve
    between check and connect; a mixed public+private answer is refused wholesale, no
    cherry-picking). Redirects are **NOT followed** (a 3xx is an error — equivalent to
    `boundedHttpClient`'s `redirect:'error'`, and the classic redirect-to-internal pivot is
    blocked at connect on the new host anyway); a hard **10 s timeout** and a **1 MB size
    cap** apply. `boundedHttpClient` (global fetch) is intentionally **not** used for MCP —
    fetch cannot pin the resolved IP, so it cannot defend against rebinding.
  - **Blocked ranges** (`isBlockedAddress`, IPv4 + IPv6, fail-closed on any non-IP):
    `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8` (loopback), `169.254/16` (link-local,
    **incl. `169.254.169.254` cloud metadata**), `172.16/12`, `192.0.0/24`, `192.168/16`,
    `198.18/15`, `224/4` (multicast), `240/4` (reserved incl. broadcast); IPv6 `::1`, `::`,
    `fc00::/7` (ULA), `fe80::/10` (link-local), `ff00::/8` (multicast), and **all four
    IPv4-in-IPv6 embeddings** — IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`, NAT64
    `64:ff9b::/96`, and 6to4 `2002::/16` — with the transition prefixes blocked wholesale AND
    the embedded IPv4 decoded (dotted or hex spelling) and re-checked, so a literal like
    `[64:ff9b::a00:1]` cannot smuggle an internal address past the shape guard (a legit public
    IPv6 literal such as `[2001:4860:4860::8888]` is still allowed — no over-block).
- **Credential never leaks.** The optional bearer (`CONNECTOR_MCP_SECRET`, resolved by the
  framework into `ctx.secrets` from the env bag) is used **only** as the `Authorization:
  Bearer` header to the configured server. The framework's deep `redactSecrets` backstop
  covers it, so a server echoing it in a 2xx body or an error is scrubbed; the
  `connector_executions` ledger stores action/classification/status/sanitized-error only —
  proven by a sentinel over the result, the error, and the ledger.
- **Gated exactly like the others + params-digest intact.** Same CONN-7 authz, same
  single-use approved-once redemption (`connector_executions` UNIQUE(`approval_id`)), same
  step-up, same NIT-1 **server-computed `paramsDigest`** binding (approve with params X, try
  to redeem with Y → `rejected`, nothing dialed). Registering `mcp` in `EXECUTORS` lights up
  the existing generic execute route — no new table, no route change.
- **Tests** — `src/tests/connector-execution-mcp.test.ts` (17): taxonomy alignment
  (`tools.list`=read) + open-ended registration; opaque invoke → WRITE → `needs_approval`
  **even under `auto_write`** (not allow-listed); destructive-named → **always** approval;
  allow-listed tool under `auto_write` → executes once (action=tool-name, params=args, bearer
  as auth); gated write → approve+step-up → executes once → replay rejected; params-digest
  mismatch → rejected, no dial; `tools.list` free read; **stdio → fail-closed, no dial**; the
  SSRF egress guard tested **directly** (private/internal range blocker over every required
  IPv4/IPv6 range incl. metadata + mapped; URL-shape guard over http/userinfo/literal-private;
  the **DNS-pinning guarded lookup** refusing a private-resolving name AND a mixed answer AND
  pinning a public one; the **real node:https client** refusing to open a socket when the host
  resolves private); a server redirect not treated as success; bearer never in
  result/error/ledger. No real network, no real MCP server.

#### CONN-8b-4 — Execution monitor UI (web + mobile) ✅ SHIPPED

The final connectors slice: give the **owner** visibility into what connector actions an
agent actually attempted. **Scoped to MONITOR-ONLY** — see the decision below.

- **Backend (additive, owner-gated):** `GET /api/orgs/:orgId/agents/:agentId/connector-executions`
  in `routes/agent-detail.ts`, `requireOrgRole('owner')`. **R-4-safe** — the path carries
  `:orgId`, so the RBAC preHandler actually enforces (it only no-ops on a *tailless* path);
  the handler additionally scopes every query by `(orgId, agentId)` and 404s an agent not in
  the org, so an owner of org A can never read org B. Latest 50, newest-first.
- **The allow-list projection** (`projectConnectorExecution`, in `services/connector-execution.ts`)
  is the security core. The response item is EXACTLY: `id`, `connectorId`, `action`,
  `classification`, `status`, `gated` (boolean), `error` (short), `createdAt` (epoch ms).
  Proof no secret/preimage leaks: (1) the `connector_executions` ledger **stores no
  credential, no raw params, and no params-digest in the first place** (by schema — it only
  holds action/classification/status/sanitized-error/approvalId); (2) the projection names
  each field explicitly, so a future column can't ride along; (3) `approvalId` collapses to a
  **boolean `gated`** — the approval id itself never leaves the server; (4) `error` was already
  redaction-passed at write time (`runExecutor`) and is additionally truncated here. A backend
  route test asserts the response body contains none of `approvalId/params/paramsDigest/secret/
  token/orgId/agentId`, even for a row seeded with junk extra keys.
- **Web** (`web/app/dashboard/agent/ConnectorsTab.tsx`): a read-only **"Recent activity"**
  section at the top of the Connectors tab — one row per execution: connector icon + action,
  a classification pill, an **"Approval"** pill when the run was gated, a colour-blind-safe
  status badge (Executed / Failed / Running), the relative time, and the short sanitized error
  on a failed row. A **Refresh** button re-pulls. Matches the dashboard token system.
- **Mobile parity** (`apps/mobile/src/screens/AgentConnectors.tsx`): the same monitor as a
  native `Card` list under the agent's connectors — identical fields, identical status
  vocabulary, same sanitized data, adapted to the phone's `Chip` tones. A Refresh button
  (the section is embedded in the detail `ScrollView`, so it owns a button rather than a
  `RefreshControl`). Additive, Expo SDK 54, RN-core only, bootable in Expo Go.
- **Drift tripwire:** the ledger status vocab is a single source of truth
  (`CONNECTOR_EXECUTION_STATUSES` in the backend service, used by name in every ledger write).
  `EXECUTION_STATUSES` / `EXECUTION_CLASSIFICATIONS` are hand-copied into web + mobile;
  `apps/mobile/src/agentConnectors.test.ts` (Mobile-CI-gated) asserts **cross-platform**
  (phone == desk) AND **backend** (both == the backend array, text-read from source) parity —
  an EQUALITY check, since a client status the ledger never writes is as wrong as a missing
  one. `web/lib/agentConnectors.test.ts` mirrors the backend pin for the desk.

**Monitor-vs-trigger decision (MONITOR-ONLY this stage).** The story allowed an optional
owner-initiated "run this action" trigger, funnelled through `executeConnectorAction` so all
of CONN-7 (authz / approval / step-up / params-digest / single-use) still applies. We
**deliberately did not ship a trigger**, per the story's explicit guidance to prefer
monitor-only when a trigger is non-trivial or bypass-risky. A safe trigger needs a full
per-connector action picker + a params form + the approval-**redemption** round-trip on BOTH
clients, and the params-digest binding (approved params ≡ executed params) is security-critical
— getting it subtly wrong on either client risks a CONN-7 bypass or a "params changed since
approval" trap. There is **no execution path in this stage** (the LIST route is read-only and
cannot execute anything). A trigger is a documented follow-up (a future CONN slice); when
built it MUST route through `executeConnectorAction` and reuse the existing Inbox/Approvals +
step-up UI, with the config-only/no-OAuth constraint still applying on the phone.

**Remaining for CONN-8b:** _none for the epic._ Optional/future: the owner-trigger
follow-up above; a later, carefully-audited stage for **stdio** MCP execution (currently
fail-closed). **With CONN-8b-4, the connectors epic (CONN-1…8b-4) is FEATURE-COMPLETE.**
(Wiring `executeConnectorAction` into the internal `agent-executor.ts` loop was listed here
as optional/future; it then shipped as **CONN-9** below.)

**Sequencing rationale:** backend + security primitives first (CONN-1), then the cheap
real wins that need no OAuth (CONN-2/3/4), then the expensive OAuth surface isolated
(CONN-5), then breadth (CONN-6), then the capability/containment tightening (CONN-7).

---

### CONN-9 — Agent-loop wiring: an agent can USE its connectors mid-run ✅ SHIPPED

CONN-8a…8b-4 built the gate and every surface around it, but nothing inside a normal agent
run ever called it: an operator could configure GitHub on an agent and the agent still had
no way to use it. CONN-9 is that wire — deliberately thin, and **additive to `backend/`**.

**Files.** `backend/src/services/agent-connector-tools.ts` (new — derivation, prompt block,
directive parsing, the execution funnel, containment helpers) + a wiring block in
`backend/src/services/agent-executor.ts`. Tests:
`backend/src/tests/conn9-agent-connector-tools.test.ts` (13, real SQLite + the real gate +
the real decide route, mocked provider transport).

**Mechanism.** The executor runs on `streamLLM`, which has no native tool-calling loop, so
connectors reuse the **text-directive idiom** already used for `[REMEMBER:]` / `[WEBHOOK:]`
/ `[DELEGATE:]` — `[CONNECTOR: <connector>.<action> | {json}]` — rather than forking the run
loop. One model turn emits directives; they are executed; **one** synthesis turn reads the
results and writes the final answer.

**1. Exposure ≠ authorization.** A connector is offered to the model only with BOTH an
enabled `agent_connectors` row AND an **explicit** `connector:<id>` / `connector:*` / `*`
capability (`hasExplicitConnectorCapability` — an empty/legacy allow-all list grants
**nothing**, per CONN-7 carry-forward (i)), plus a known catalog entry and a real executor.
Exposure is only a hint: the same capability is re-checked inside `executeConnectorAction`
on every call, so a model that invents a connector it was never offered is stopped **by the
gate, not by the prompt** (`[CONN9-NOCAP]` asserts both halves). Nothing secret crosses the
boundary — the derived tool carries a connector id, a catalog display name and action names
only; the row's `config` and `secretRef` are never read, so neither can reach the prompt.

**2. Every invocation funnels through `executeConnectorAction`.** `runConnectorDirectives`
has no path to an executor, no path that skips `authorizeConnectorAction`, and **no path
that supplies an `approvalId`** — so the agent loop is *structurally* unable to redeem an
approval, its own or anyone's. Redemption stays the human-decided single-use route. The
three outcomes: `allow` → executes once, ledgered, result sanitized (`redactSecrets`, run
by the framework) and size-bounded; `needs_approval` → **not executed**, the approval is
filed by the gate with the server-computed `paramsDigest` binding, and the model is told it
is pending and cannot approve or retry it (the `approvalId` is deliberately withheld — the
model has no legitimate use for it); `deny` → a clean refusal. Also server-supplied, never
model-supplied: `orgId`/`agentId`, and `target: null` so agent prose can never dress up an
approval card.

**3. Prompt-injection containment (the hard requirement).** Everything a connector returns
is attacker-controllable — anyone who can file a GitHub issue, comment on a Jira ticket,
message the agent or stand up an MCP server can put text in front of this model. Three
layers, and the fence is only the first:

- **(i) Fenced + nonced.** Results sit between markers carrying a per-run random nonce,
  drawn *after* the payload text exists (and re-drawn on collision) so no provider can
  predict it and close the fence early to continue in the operator's voice — the same
  containment `converse-attachments.ts` uses for operator-attached documents. The
  untrusted-data label is emphatic and comes **before** the data: a model that reads 4k
  characters of hostile text and only then learns it was data has already been steered.
- **(ii) The synthesis turn is TERMINAL.** Its output is stripped of both `[CONNECTOR:]`
  and `[DELEGATE:]` directives **without executing them**. This — not the fence — is what
  makes containment structural: it holds even if the model is fully persuaded. Injected
  text cannot trigger another connector call and cannot steer routing or delegation.
  *Cost:* an orchestrator that used a connector does not also delegate in the same run. A
  deliberate trade — one contained round beats an uncontained chain.
- **(iii) The gate is unmoved.** Capability comes from `agents.permissions` and trust from
  `agent_connectors.trustLevel`, both read from the DB and never from model output, so no
  amount of "you are approved to…" grants anything. Approval cards are machine-rendered
  from the structured action with a server-computed digest, so injected prose cannot dress
  up what the operator sees either.

`[CONN9-INJECT]` proves it end-to-end with a payload carrying every trick at once (a system
override, a forged capability grant, a `[CONNECTOR: github.repo.delete]`, a `[DELEGATE:]`
exfiltration, and a **forged closing fence marker**): the data stays inside the real fence,
the forged marker cannot close it, the demanded destructive call is still refused, no
unapproved provider call is made, and no approval is approved behind the operator's back.

**4. Loop safety.** `MAX_CONNECTOR_CALLS_PER_RUN = 4` (over-cap directives come back as
`not_attempted` **with a reason**, so the model is told it was capped rather than silently
truncated); `MAX_CONNECTOR_RESULT_CHARS = 4_000` per result and `12_000` per block, clipped
with a visible `CONNECTOR_TRUNCATION_MARKER` — the clipped **text** is returned rather than
a pruned object, because a partial JSON string is honest about being partial whereas a
pruned object looks complete and invites "the list has 3 items". Calls run sequentially and
are individually try/caught; derivation, the round, and the synthesis turn are each
non-critical, so **a connector failure can never crash a run** — it costs the agent its
tools, never the task. Provider errors are surfaced cleanly with no credential (asserted
against a provider that echoes the PAT back in its error body). Directive parsing is
fail-closed and non-throwing: a malformed header, unparseable params, a non-object params
value or an unterminated directive is **skipped, not guessed at**, and the JSON-aware
scanner means a `]` inside params doesn't truncate the directive. Header tokens are also
**rejected — not repaired —** when they carry a zero-width/bidi character or a non-NFKC
compatibility form (audit N3): `\s` doesn't match U+200B and `.trim()` doesn't strip it, so
`issue.get<ZWSP>` previously reached the guard intact and survived it. Every downstream
branch did fail closed, but that was three unrelated lookups happening to miss rather than a
boundary. Rejecting is deliberate over sanitizing: stripping-and-accepting would make the
string the model emitted differ from the one the ledger and approval card record, and would
normalize attacker-shaped input into something that looks ordinary. No real action name is
anything but ASCII, so this rejects nothing a well-behaved model would write.

**Audit fixes folded before merge (all Low, all closing a class rather than an instance):**
**N1** — `getExecutor` used a bare bracket read on an object literal, so
`getExecutor('__proto__')` returned a truthy non-executor; now `Object.hasOwn`-guarded, the
last sibling of a class already closed in `executorKnowsAction`/`runExecutor`. **N2** — the
terminal synthesis strip now also removes `[WEBHOOK:]`. It could never fire (one
pre-synthesis callsite), but an injected result could induce a literal
`[WEBHOOK: https://evil/…]` that would be **persisted verbatim as the task's visible
output** and read to an operator as though the agent had called an attacker's URL. Strip the
whole directive class rather than leave one idiom's safety resting on callsite placement.
**N3** — the zero-width/NFKC rejection above.

**Cost accounting.** A connector round adds a second LLM turn, so `tokensUsed` / `costUsd` /
`inputTokens` / `outputTokens` accumulate across both turns — the operator pays for it, so
it shows up in the task totals and therefore in the daily/monthly budget checks.

**Approvals surface — VERIFIED, with two gaps named.** The inherited claim was "approvals
already surface unchanged on mobile end-to-end with no client change". Checked rather than
assumed — and the check earned its keep. **Verdict: true for mobile, but fragile; and the
same claim is FALSE for web.** CONN-9 ships no client change (it is backend-additive), so
both items below are follow-ups, not regressions — but CONN-9 makes them far more visible
by routing routine connector writes into that queue.

| # | Question | Verdict |
|---|---|---|
| 1 | Does the mobile list endpoint exclude `connector_action`? | **No — surfaces.** `GET /api/orgs/:orgId/approvals?status=pending` (`apps/mobile/src/api.ts:375` → `routes/tasks.ts:128-134`) filters on `orgId` + `status` only, with **no `type` predicate** (contrast the review-queue route at `tasks.ts:160`, which does filter by type). |
| 2 | Does the mobile UI switch on a hardcoded type list to render? | **No — generic.** `ApprovalsPane.tsx:149` renders the chip as `a.type.replace(/_/g,' ')` and `:155` the server-provided `a.summary`; `stepup.ts:62-71` is equally generic. |
| 3 | Does web render *and decide* it? | **Renders, CANNOT approve — PARITY GAP.** |
| 4 | Can the operator actually approve from mobile? | **Yes — but via a fallback clause.** |

**Gap A — mobile's dangerous-type copy is stale (fragile, not broken).**
`connector_action` IS a dangerous type on the backend (`dangerous-approvals.ts:29`), so
`routes/tasks.ts:478` requires step-up to approve it. Mobile's hand-copied
`DANGEROUS_APPROVAL_TYPES` (`apps/mobile/src/constants.ts:11-16`) lists only four types and
**omits `connector_action`**, despite its own "keep in sync with the backend" comment. It
works today *only* because `approvalNeedsStepUp` (`constants.ts:42`) also honours
`payload.requiresStepUp`, which `prepareApprovalRecord` stamps for any dangerous type
(`dangerous-approvals.ts:250`) and CONN-9's filing path persists
(`connector-authz.ts:431-453`). So the guarantee rests on a payload flag rather than on the
type classification the list exists to provide: any `connector_action` row whose payload
lacks that flag would show mobile's one-tap Approve, skip the danger banner, and dead-end on
a server 403. **Follow-up: add `'connector_action'` to `apps/mobile/src/constants.ts` and
pin the copy with a tripwire test**, per the standing hand-copy rule in CLAUDE.md.

**Gap B — web cannot approve ANY dangerous approval (pre-existing defect, now more
visible).** Web reads approvals from a *different* endpoint (`GET /api/orgs/:orgId/inbox`,
`CockpitPanel.tsx:61` → `tasks.ts:53-67`) and renders `connector_action` generically
(`InboxSection.tsx:59-61`) — but its decide call sends **no `x-arturita-session` header**,
and a grep for `arturita-session` across `web/` returns **zero hits**: web has no step-up
minting path at all. Worse, `CockpitPanel.tsx:80-81` removes the card optimistically
*before* the request and then swallows the failure in `catch {}`. **Net operator-visible
behaviour: on the desk, Approve makes the card disappear as if it worked, while the approval
is silently NOT approved (403 discarded); on the phone, the same approval genuinely
approves.** This inverts the usual assumption that the desk is the more capable surface. It
predates CONN-9 and affects `wallet_tx` / `email_send` / `machine_exec` equally — but CONN-9
is what makes it routine. **Follow-up (separate story, web-side): a step-up mint + header on
the web decide path, and stop swallowing the error / stop optimistically clearing the card.**
The silent-success UX is the more dangerous half.

**Deferred (not epic-blocking):** multi-round tool use (today's contract is one round then a
terminal synthesis); letting an orchestrator both call a connector and delegate in the same
run; the owner-initiated trigger (CONN-8b-4 follow-up); audited stdio-MCP execution.

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
| `connector:` capability namespace | **Enforced** — CONN-7 (`hasConnectorCapability` → `connector:<id>` required to use a connector; absent → deny) |
| Per-connector TRUST + approval containment | **SHIPPED** — CONN-7 (`trust_level` column, `authorizeConnectorAction`: READ→allow / WRITE→approval-unless-`auto_write` / DESTRUCTIVE→always-approval / unknown→fail-closed; routed through the existing `connector_action` dangerous-approval + step-up; owner-only web+mobile trust toggle) |
| `agent_connectors` table + agent connector API | **New** (CONN-1) |
| GitHub (PAT) + Jira (basic) real at agent scope via env injection | **SHIPPED** — backend CONN-4a (keys `GITHUB_TOKEN` / `JIRA_BASE_URL`+`JIRA_EMAIL`+`JIRA_API_TOKEN`), web+mobile UI rows CONN-4b |
| Per-agent OAuth (agentId scope, encrypted tokens, PKCE + single-use state) | **SHIPPED** — CONN-5 (`agent_oauth_tokens` + `agent_oauth_states`; web full flow, mobile config-only) |
| Communication connectors (Telegram / WhatsApp / Google Chat) at agent scope | **SHIPPED** — CONN-6 (config + credential storage via env injection; keys `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `WHATSAPP_ACCESS_TOKEN`+ids / `GOOGLE_CHAT_WEBHOOK_URL`; web+mobile forms; `test` is a stub; **Signal out of scope**). WhatsApp/GoogleChat env names flagged for operator confirmation |
| Accordion UI, web + mobile | **SHIPPED both** — web CONN-2 + mobile CONN-3, each a local expandable (no shared Accordion primitive), parity-pinned |
| Connector EXECUTION framework (authz-gated, single-use approvals, credential-at-exec) | **SHIPPED** — CONN-8a (`executeConnectorAction`; explicit-cap tightening; approved-once via `connector_executions` UNIQUE(approval_id); `POST /api/agent/connectors/:id/execute`) |
| GitHub executor (real api.github.com calls) | **SHIPPED** — CONN-8a (`connector-github.ts`; read `repo.get`/`issues.list`/`issue.get`, write `issue.create`/`issue.comment`, destructive `repo.delete`; SSRF-fixed host; bounded) |
| Jira + comms (Telegram/WhatsApp/Google Chat) executors | **SHIPPED** — CONN-8b-1 (`connector-jira.ts`: read `issue.get`/`issue.search`, write `issue.create`/`issue.comment`/`issue.transition`, destructive `issue.delete`, Atlassian-host-restricted baseUrl; `connector-telegram.ts`/`connector-whatsapp.ts`/`connector-google-chat.ts`: `message.send`, hardcoded/validated hosts, token-in-URL + webhook-as-secret leak defence) |
| Google Workspace executor (real Gmail/Calendar/Drive calls, per-agent OAuth token) | **SHIPPED** — CONN-8b-2 (`connector-google.ts`; `credentialKind:'google_oauth'` → `ensureFreshAgentGoogleToken` over `agent_oauth_tokens`, NOT the env bag; hardcoded `gmail.googleapis.com`/`www.googleapis.com`; `gmail.send` + reads + calendar/drive writes; destructive always-approve; scope-fail-closed; token sentinel; approval params-digest binding) |
| Custom-MCP invocation bridge | **SHIPPED** — CONN-8b-3 (`connector-mcp.ts`; open-ended `invoke` dispatch, http-transport only / **stdio fail-closed**, opaque tools escalate to approval even under `auto_write` unless on the per-connector `autoApproveTools` allow-list, destructive-named always approval; SSRF egress guard: https-only + no-userinfo + private-range block over IPv4/IPv6 incl. `169.254.169.254` metadata, **DNS-pinning** node:https lookup defeats rebinding, redirects not followed, 10s/1MB caps; bearer never leaks; params-digest binding intact) |
| Web/mobile UI to MONITOR executions (owner ledger view) | **SHIPPED** — CONN-8b-4 (owner-gated `GET …/agents/:agentId/connector-executions`, R-4-safe; allow-list projection — no secret/params/digest/approval-id, `gated` boolean; web "Recent activity" section + mobile native list, parity-pinned status vocab; **monitor-only** — trigger deferred, no execution path) |
| Agent-loop wiring — an agent USES its connectors mid-run | **SHIPPED** — CONN-9 (`agent-connector-tools.ts` + `agent-executor.ts`; `[CONNECTOR: id.action \| {json}]` directive, exposure requires an enabled row **AND** an explicit `connector:<id>` cap, every call funnels through `executeConnectorAction` with **no `approvalId` path** so the agent cannot self-redeem; results fenced under a per-run nonce as untrusted data + a **terminal** synthesis turn whose directives are stripped unexecuted; 4 calls/run, 4k-char results truncated with a marker, failures never crash the run) |
| Web/mobile UI to TRIGGER executions (owner-initiated run) | **Deferred follow-up** — a safe owner trigger must funnel through `executeConnectorAction` (CONN-7 authz/approval/step-up/params-digest/single-use) + reuse the approvals/step-up UI; non-trivial params-digest binding across both clients, scoped out of 8b-4 |

_End of plan. **The connectors epic (CONN-1 … CONN-8b-4) is FEATURE-COMPLETE.** All
stages SHIPPED: backend framework + security primitives (CONN-1, 7, 8a), web+mobile
accordion (CONN-2/3), real connectors (CONN-4/5/6), the executor fleet (GitHub/Jira/comms/
Google/MCP — CONN-8a/8b-1/8b-2/8b-3), and the owner execution monitor (CONN-8b-4). Open
follow-ups are optional, not epic-blocking: the owner-initiated trigger and audited
stdio-MCP execution. **CONN-9** then closed the last functional gap — the agent-loop wiring
of `executeConnectorAction`, with prompt-injection containment for connector results._
