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
| GitHub (PAT) + Jira (basic) real at agent scope via env injection | **SHIPPED** — backend CONN-4a (keys `GITHUB_TOKEN` / `JIRA_BASE_URL`+`JIRA_EMAIL`+`JIRA_API_TOKEN`), web+mobile UI rows CONN-4b |
| Per-agent OAuth (agentId scope, encrypted tokens, PKCE + single-use state) | **SHIPPED** — CONN-5 (`agent_oauth_tokens` + `agent_oauth_states`; web full flow, mobile config-only) |
| Communication connectors (Telegram / WhatsApp / Google Chat) at agent scope | **SHIPPED** — CONN-6 (config + credential storage via env injection; keys `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `WHATSAPP_ACCESS_TOKEN`+ids / `GOOGLE_CHAT_WEBHOOK_URL`; web+mobile forms; `test` is a stub; **Signal out of scope**). WhatsApp/GoogleChat env names flagged for operator confirmation |
| Accordion UI, web + mobile | **SHIPPED both** — web CONN-2 + mobile CONN-3, each a local expandable (no shared Accordion primitive), parity-pinned |
| Backend MCP/tool invocation | **New, separate epic** (CONN-8) |

_End of plan. **CONN-1 (backend) and CONN-2 (web accordion tab) are SHIPPED**; CONN-3
(mobile mirror) is next, then CONN-4… per the roadmap above._
