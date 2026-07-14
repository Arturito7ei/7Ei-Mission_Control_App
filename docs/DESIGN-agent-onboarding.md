# DESIGN — Invite-based agent onboarding (Epic ONB)

> **Status:** research + design (2026-07-14). Read-only reverse-engineering of the live Paperclip instance; **nothing was built and nothing in Paperclip was modified**. The operator asked for the *needs and functionalities* before we plan the build.
> **Companions:** `docs/TRD-paperclip.md` (whole-app reverse-engineering) · `docs/GAP-paperclip-config.md` (config-surface gaps) · `docs/DESIGN-claude-code-agent.md` (the CC epic; same doc shape) · `docs/PLAN-arturita.md` §0 (story tracker — the **ONB** epic stub lives there) · `backend/CLAUDE.md`, `adapters/CLAUDE.md`.
> **Question answered:** *How does Paperclip onboard an external agent from a single pasted prompt, and what would an equivalent invite-based onboarding cost us in Mission Control?*
> **How Paperclip was read:** live loopback API (`deploymentMode: local_trusted`, `version 2026.626.0`, every call `curl --max-time`, read-only) + the client SPA bundle `/assets/index-Du79WqkB.js` (~4.85 MB — Zod schemas, API-client method table, and the operator prompt template all survive minification as string literals). Every shape below is an **exact read**, not a guess.

---

## 0. TL;DR — verdict

**Paperclip's onboarding is a self-describing, agent-readable contract, not a UI.** The operator creates an invite and copies a ~40-line prompt into *any* agent's chat window. The agent then onboards **itself**: it fetches a machine-and-human-readable `onboarding.txt`, picks its own adapter type, discovers a reachable base URL by probing `/api/health` against a server-supplied candidate list, submits a join request describing its own capabilities and runtime config, **waits for a human board approval**, and only then claims its API key — once. The whole flow needs no operator terminal work beyond the paste.

**We already have ~70% of the machinery — but not the shape.** Our agent identity, token mint/hash, external-agent registration, the per-runtime `mc.env` profile generator, the tri-state approvals queue (which *already* names `agent_create` as a gated action), secure-by-default registration (CC3), and low-trust containment (P1) all exist and are reused wholesale. What does **not** exist is the *invite* itself: there is no invite entity, no unauthenticated join-request endpoint, no board-approval gate before a token is issued, no reachability probe, and no server-side adapter registry. Today onboarding is: operator obtains a Clerk JWT → runs `7ei-mc onboard` → **hand-carries a raw `mca_` token** into an `mc.env` on the host. The token exists *before* any human decision, and it travels through the operator's clipboard.

**The invite flow is a security upgrade, not just DX.** It inverts the token lifecycle: the agent self-describes *first*, a human approves *second*, and the credential is minted and claimed *last*, exactly once, by the party that will use it — never passing through a chat transcript. That is strictly safer than today's mint-then-carry model, and it composes with (never softens) the A2 and P1 gates.

**One-line verdict:** *An invite object + a public join/claim pair + an approval gate + an adapter registry — four net-new pieces bolted onto machinery we already ship — turn our hand-carried token into a self-service, human-approved, single-use onboarding contract.*

---

## 1. How Paperclip's onboarding works, end to end

### 1.1 The five actors

| Actor | Role |
|---|---|
| **Board** (human operator) | Creates the invite, approves/rejects the join request. |
| **Invite** | A short-lived, addressable object (`pcp_invite_hvkwszli`) that carries company identity, what may join, and the URLs of its own instructions. |
| **Onboarding document** | Server-*generated per invite* — the invite id is baked into every URL inside it. Served as JSON (`/onboarding`) and as plain text (`/onboarding.txt`). |
| **Joining agent** | Any runtime that can do HTTP. It reads the doc and drives its own onboarding. |
| **Claim** | The one-time exchange of a `claimSecret` for a real API key, legal only after approval. |

### 1.2 The operator's half: one paste

The SPA's create-invite mutation is `POST /companies/{companyId}/invites` with body `{allowedJoinTypes:"agent", humanRole:null, agentMessage:"<free text>"}`, and the UI immediately generates a **copy-able onboarding prompt** (verbatim from the bundle's template):

> *"You're invited to join a Paperclip company as an agent. First, respond to your user that you understand the request and are going to onboard into Paperclip. Then work through the steps below…"*

followed by the candidate onboarding-doc URLs, connectivity guidance, an 8-step join flow, and per-adapter notes. **That prompt is the entire operator-side product.** It is a text blob pasted into the target agent's chat — the operator never touches the agent's filesystem.

Note step 1 of the template: the agent is told to *tell its user what it is about to do* before it starts. Onboarding is designed to be legible to the human sitting in front of the agent, not silent.

### 1.3 The invite object (exact read)

`GET /api/invites/pcp_invite_hvkwszli` →

```json
{"id":"fce16663-…","companyId":"498342a5-…","companyName":"7Ei",
 "companyLogoUrl":null,"companyBrandColor":null,
 "inviteType":"company_join",            // | "bootstrap_ceo"
 "allowedJoinTypes":"agent",             // enum, default "both" → agent | human | both
 "humanRole":null,
 "expiresAt":"2026-07-17T15:33:31.021Z", // ~3 days out
 "invitePath":"/invite/pcp_invite_hvkwszli",
 "inviteUrl":"http://127.0.0.1:3100/invite/pcp_invite_hvkwszli",
 "onboardingPath":"…/onboarding",  "onboardingUrl":"…",
 "onboardingTextPath":"…/onboarding.txt", "onboardingTextUrl":"…",
 "skillIndexPath":"…/skills/index", "skillIndexUrl":"…",
 "inviteMessage":null, "invitedByUserName":"Board",
 "joinRequestStatus":null, "joinRequestType":null}
```

- **Id format** `pcp_invite_<8 lowercase alnum>` — a public *token*, distinct from the internal UUID `id`. The token is what appears in every URL; the UUID never leaves the payload.
- **Multi-use.** Nothing in the object caps uses. The invite is a *door*, and each walk-through creates its own join request. The list filter enum is `["active","revoked","accepted","expired"]` — so an invite is revocable, and expiry is server-side.
- **`joinRequestStatus`/`joinRequestType` are echoed back** so the same URL renders a live "your request is pending approval" page for whoever is holding it.
- **Un-authenticated read.** In `local_trusted` this is loopback-open; the invite token itself is the bearer.

### 1.4 The onboarding document (fetched in full; summarized)

`GET /api/invites/<token>/onboarding.txt` returns a plain-text doc explicitly framed as *"readable by both humans and agents"*. Its structure:

| Section | Content |
|---|---|
| **Invite** | `inviteType`, `allowedJoinTypes`, `expiresAt`, `companyName`. |
| **Step 0** | *Decide which Paperclip adapter type matches your runtime.* "Use `adapterType` only when there is a matching Paperclip adapter. Put runtime-specific settings in `agentDefaultsPayload`." |
| **Step 1 — submit join request** | `POST /api/invites/<token>/accept` with the body schema + **worked per-adapter payload examples** (OpenClaw, Hermes) + a long Hermes network-topology cookbook (loopback / LAN / Tailscale overlay / Docker / reverse-proxy). Response contains *"request id, one-time `claimSecret`, `claimApiKeyPath`"*. |
| **Step 2 — wait for board approval** | One sentence: *"The board approves the join request in Paperclip before key claim is allowed."* |
| **Step 3 — claim API key (one-time)** | `POST /api/join-requests/{requestId}/claim-api-key` with `{claimSecret}`. Then the security paragraph (§1.7). Invariants restated: *claim secrets expire · claim secrets are single-use · claim fails before board approval.* |
| **Step 4 — install skill** | `GET /api/invites/<token>/skills/paperclip` → returns the actual Markdown skill file (frontmatter + heartbeat protocol). "Install path: runtime-specific." |
| **Connectivity guidance + candidates** | The server enumerates *its own* reachable addresses and tells the agent to probe each. |
| **Connectivity diagnostics** | Server-computed warnings, e.g. `[warn] openclaw_onboarding_api_loopback — Onboarding URL resolves to loopback hostname. Remote OpenClaw agents cannot reach localhost on your Paperclip host.` with a `hint`. |
| **Helpful endpoints** | The four URLs again, flat. |

The JSON twin (`/onboarding`) is the same content as structured data: `{invite, onboarding:{instructions, requiredFields, registrationEndpoint:{method,path,url}, claimEndpointTemplate:{method,path,body}, connectivity:{deploymentMode, deploymentExposure, bindHost, allowedHostnames[], connectionCandidates[], diagnostics[], guidance}, textInstructions}}`. **`requiredFields` is a field-name → human-description map** — the server teaches the agent its own schema.

### 1.5 The join request (`POST /api/invites/<token>/accept`)

Zod schema, lifted verbatim from the bundle:

```ts
{ requestType: enum,                      // "agent" | "human"
  agentName: string().min(1).max(120).optional(),
  adapterType: <adapter enum>,
  capabilities: string().max(4000).nullish(),
  agentDefaultsPayload: record(string(), unknown()).nullish(),
  responsesWebhookUrl: string().max(4000).nullish(),
  responsesWebhookMethod: string().max(32).nullish(),
  responsesWebhookHeaders: record(string(), unknown()).nullish(),
  paperclipApiUrl: string().max(4000).nullish(),
  webhookAuthHeader: string().max(4000).nullish() }
```

Response: `{requestId, claimSecret, claimApiKeyPath, status:"pending_approval", onboarding:{…}}`.

The key design move: **`agentDefaultsPayload` is an open record.** The invite contract is stable; the per-runtime config is a typed-by-adapter bag. That is what lets one endpoint onboard a WebSocket gateway, a local CLI, and an HTTP webhook runtime without schema churn.

### 1.6 The board-approval gate

- `GET /companies/{companyId}/join-requests?status=pending_approval[&requestType=agent]`
- `POST /companies/{companyId}/join-requests/{id}/approve` | `/reject`
- Status enum: `["pending_approval","approved","rejected"]`.

The board UI renders each request as a card (name, capabilities, the invite's `allowedJoinTypes`, submitted-at) with Approve/Reject. **Claim fails before approval** — this is the load-bearing gate: an invite link leaking does not yield a credential, it yields a row in a human's queue.

### 1.7 The token-claim security model

This is the most carefully-written part of Paperclip's onboarding, and it is written *at the agent*, because the threat is the agent's own plumbing. Reproduced in substance from Step 3:

1. **Claim once.** `POST /api/join-requests/{requestId}/claim-api-key` with `{claimSecret}` (schema: `string().min(16).max(256)`). Single-use, expiring, illegal before approval.
2. **Parse the raw HTTP JSON.** *"Store the parsed `token` field from the raw HTTP JSON response before printing or summarizing it."*
3. **Never from chat/transcript/tool preview.** *"Do not copy token values from chat, transcript, or tool-output previews."* — because an agent that reads its own scrollback gets a *rendered* token, not the real one.
4. **Masked previews are detectable.** *"A token value containing literal `...` or `[redacted]` is a masked display preview, not a valid key."*
5. **Never invent or rotate.** *"Do not rotate or invent a Paperclip key manually."*
6. **Write before logging**, then verify with an authenticated call.

This is a genuinely novel control and we should copy it verbatim in spirit: **the onboarding document defends against the agent's own observability layer.**

### 1.8 Reachability — the quiet hard part

An agent that cannot reach the control plane cannot onboard, and a control plane that cannot reach a gateway agent cannot dispatch to it. Paperclip solves both directions:

- **Agent → Paperclip.** The server publishes `connectionCandidates` (loopback, `host.docker.internal`, LAN v4, every global v6) and tells the agent: `GET <candidate>/api/health`, take the first that answers, put it in `agentDefaultsPayload.paperclipApiUrl`. If none answer, escalate to the human with an exact command: `pnpm paperclipai allowed-hostname <host>` → restart → `curl -fsS http://<host>:3100/api/health` → regenerate the prompt. `allowedHostnames[]` (empty on this instance) is the server's allow-list for non-loopback binds.
- **Paperclip → agent.** `GET /api/invites/<token>/test-resolution?url=<urlencoded-agent-url>` — the server resolves and probes a *candidate agent* URL. Probed live: it returns `{"error":"url resolves to a private, local, multicast, or reserved address"}` for both `http://127.0.0.1:3100` and `http://192.168.1.228:3100`. So it is **SSRF-hardened by design** — the endpoint refuses to be used as a scanner of the host's own private network, which also means it is only meaningful for genuinely routable gateway URLs.

### 1.9 The adapter taxonomy (live read of `GET /api/adapters`)

14 built-ins: `acpx_local`, `claude_local`, `codex_local`, `cursor`, `cursor_cloud`, `gemini_local`, `grok_local`, `hermes_gateway`, `hermes_local`, `http`, `openclaw_gateway`, `opencode_local`, `pi_local`, `process`. Each carries capability flags: `supportsInstructionsBundle`, `supportsSkills`, `supportsLocalAgentJwt`, `requiresMaterializedRuntimeSkills`, `supportsModelProfiles`.

Per-adapter `agentDefaultsPayload` contracts, as documented in the onboarding doc:

| adapterType | Shape | Notes |
|---|---|---|
| `openclaw_gateway` | `{url:"wss://…", headers:{"x-openclaw-token":"…"}, paperclipApiUrl, waitTimeoutMs, sessionKeyStrategy:"issue", role:"operator", scopes:["operator.admin"]}` | `ws://`/`wss://` only. `x-openclaw-token` preferred; legacy `x-openclaw-auth` accepted. Explicitly **do not** use `/v1/responses` or `/hooks/*` in this flow. |
| `hermes_gateway` | `{apiBaseUrl:"http://127.0.0.1:8642", apiKey:"<= API_SERVER_KEY>", paperclipApiUrl}` | Paperclip *calls* Hermes. Start Hermes with `API_SERVER_ENABLED=true`, a fresh random `API_SERVER_KEY`, then `hermes gateway run --replace --accept-hooks`. Default API port **8642**. A dashboard root or `/chat` URL on **9119** is accepted and auto-mapped to `/api`. Paperclip tests `/api/health` and starts runs at `/api/v1/runs`. **`apiKey` is the Hermes key, not the Paperclip key** — the doc says so twice, because it is the single most confusable field in the whole flow. |
| `hermes_local` | — | Paperclip *starts* Hermes on the Paperclip host. |
| `cursor` / `cursor_cloud` | — | `cursor` needs materialized runtime skills (`requiresMaterializedRuntimeSkills:true` — the only adapter that does). |
| `grok_local`, `claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `acpx_local`, `pi_local` | — | Local CLI processes; Paperclip owns the process group. |
| `http` / `process` | webhook/exec config | The generic escape hatches — an OpenAI-standard or arbitrary runtime maps here (`responsesWebhookUrl` + `responsesWebhookMethod` + `responsesWebhookHeaders` + `webhookAuthHeader` on the join request are exactly this). |
| *(internal)* | — | Not an adapter — agents Paperclip runs itself. |

---

## 2. Mapping to Mission Control — reuse vs. net-new

### 2.1 What we already have

| Concern | Where | Fit |
|---|---|---|
| Agent identity + org scoping | `agents` table (`backend/src/db/schema.ts:38-68`), every route re-checks `orgId` | ♻️ direct |
| Token mint + **hash-only** storage | `backend/src/middleware/agent-token.ts:14-25` — `mca_` + 32 random bytes, `sha256` → `agents.api_token_hash`; raw token returned exactly once | ♻️ direct |
| Agent-facing API behind that token | `backend/src/routes/agent-api.ts:84` (`agentAuth` onRequest hook) — 20 endpoints: `me`, `secrets`, `tasks`, `claim`, `result`, `heartbeat`, `approvals`, `run-token`, memory, plugin-jobs | ♻️ direct — *this is the whole post-onboarding contract, already built* |
| External-agent registration | `ExternalAgentSchema` + `POST /api/orgs/:orgId/agents/external` (`backend/src/routes/agents.ts:361-408`) | ♻️ the join-request *approve* step calls this |
| Secure-by-default registration | `secureRegistration()` (`backend/src/services/code-executor.ts:64-102`) — CC3 | ♻️ every invite-created agent goes through it |
| Low-trust containment + quarantine queue | `backend/src/services/review.ts` (P1) — and **`agent_create` is already in `LOW_TRUST_GATED_ACTIONS`** | ♻️ an agent inviting another agent is *already* gated |
| A2 dangerous-action approvals + step-up | `backend/src/services/dangerous-approvals.ts`, `prepareApprovalRecord` | ♻️ untouched; the invite flow stacks in front, never around |
| Tri-state approval queue + inbox UI | `approval_requests` + Governance/Inbox panels | ♻️ **the board-approval gate reuses this — no parallel store** |
| Per-runtime `mc.env` + run-block generator | `web/lib/adapterProfile.ts` (`PROFILES`, `mcEnv()`, `runBlock()`) — CC4 | ♻️ becomes the *client half* of the adapter registry |
| Hash + TTL + single-use credential precedent | `arturita_bindings` (`schema.ts:309-319`: `bindCodeHash`, `bindCodeExpiresAt`, `boundAt`, `revokedAt`; cleared on confirm) | ♻️ **copy this exact pattern for the invite + claim secret** |
| Owner-gated writes + config snapshots | `requireOrgRole('owner')` (`backend/src/middleware/rbac.ts`), `config_revisions` | ♻️ invite create/revoke + approve/reject |
| Per-IP rate limiter (written, unwired) | `backend/src/middleware/ratelimit.ts:165` `perIpRateLimit()` — **zero call-sites today** | ♻️ finally gets a caller (see R5) |
| Adapters that would join | `adapters/openclaw`, `adapters/cursor`, `adapters/claude-code`, `adapters/presets/*` | ♻️ each becomes a registry entry |
| Onboard CLI | `cli/onboard.mjs` — plans org+agent create, **prints exports, writes no files**, needs an operator Clerk JWT | ◐ re-pointed at the invite flow (ONB6) |

### 2.2 What is genuinely new

| # | Net-new | Why nothing existing covers it |
|---|---|---|
| N1 | **`agent_invites` table + invite object** (`mci_inv_*`, expiry, revoke, single/multi-use, `allowedRuntimes`, `createdBy`) | No invite entity of any kind exists. Nearest precedent is `arturita_bindings`, which is a 1:1 operator binding, not a company door. |
| N2 | **Public (unauthenticated) join-request endpoint** | Every agent-creating route today is Clerk-secured. There is no "redeem this and describe yourself" path. |
| N3 | **`agent_join_requests` table + board-approval gate before any token exists** | Today the token is minted *at creation*, before any human decision. The gate must sit *between* self-description and credential. |
| N4 | **One-time `claimSecret` → key claim endpoint** | Our token is hand-carried by the operator. There is no claim exchange, no single-use secret, no "claimed_at". |
| N5 | **Server-generated per-invite `onboarding.txt` (+ JSON twin)** | Nothing generates agent-readable onboarding text. `adapterProfile.ts` generates an `mc.env` *for the operator*, client-side. |
| N6 | **Server-side adapter registry** (`adapterType` + capability flags + `agentDefaultsPayload` JSON-schema + defaults) | Runtime is a free-text column with a 4-value enum; per-runtime config lives **client-side only** in `web/lib/adapterProfile.ts`. `docs/GAP-paperclip-config.md` already ranks the missing adapter registry #4. |
| N7 | **Reachability: candidate list + `/api/health` probe guidance + SSRF-hardened `test-resolution`** | Nothing exists. We are a hosted backend (`https://7ei-backend.fly.dev`), so the agent→us direction is *far* easier than Paperclip's (§4.2), but us→gateway-agent still needs the probe. |
| N8 | **Create-invite UI + copy-able onboarding prompt** | `AddAgentWizard` produces a token + run-block; it does not produce a *prompt an agent can act on*. |

### 2.3 The honest asymmetry

Paperclip is a **local, loopback, single-instance, `local_trusted`** control plane with an implicit board identity — its invite links are mostly an intranet convenience, and its hardest problem is *reachability*. We are a **hosted, Clerk-authenticated, multi-tenant** backend on a stable public URL — our reachability problem barely exists (§4.2), and our hardest problem is the inverse: **a public join endpoint on a public backend is a real attack surface.** So we cannot copy Paperclip's posture; we must copy its *shape* and harden the parts it did not need to.

---

## 3. Requirements for OUR invite-based onboarding

### 3.1 F1 — Create invite

- Owner-gated `POST /api/orgs/:orgId/agent-invites` → `{allowedRuntimes?: string[], maxUses?: number (default 1), expiresInHours?: number (default 72, max 168), message?: string, defaultsPayload?: object}`.
- Returns `{token: "mci_inv_<12>", inviteUrl, onboardingUrl, onboardingTextUrl, expiresAt, ...}`.
- **Only the hash of the invite token is stored** (`arturita_bindings` pattern). The raw token is shown exactly once, in the UI, at creation.
- `GET`/`DELETE` (revoke) siblings; list filters `active|revoked|accepted|expired`.
- **Default single-use** (Paperclip's is multi-use; we invert the default — a public backend should not ship a reusable door).

### 3.2 F2 — The copy-able onboarding prompt (the operator's whole product)

The create-invite UI renders a **copy button** yielding a prompt in the shape of the Paperclip template: tell your user what you're doing → read the onboarding doc at `<url>` → submit a join request with your name, capabilities, `adapterType`, `agentDefaultsPayload` → **wait for approval** → claim your key once → store it from the raw JSON, never from a transcript. Plus the per-adapter note for the runtime the operator selected (or all, if unrestricted).

### 3.3 F3 — The onboarding.txt generator

- `GET /api/agent-invites/:token/onboarding.txt` (public, invite-token-bearer) and `/onboarding` (JSON twin).
- **Generated per invite** — the token is baked into every URL in the body; expiry and `allowedRuntimes` are stated in the header block.
- Sections mirror §1.4: Invite · Step 0 adapter choice · Step 1 join request (with a worked `agentDefaultsPayload` example **per allowed runtime**, pulled from the adapter registry) · Step 2 wait for approval · Step 3 claim (with the §1.7 security paragraph **verbatim in spirit**) · Step 4 install the 7Ei skill · connectivity · helpful endpoints.
- Pure generator (`services/onboarding-doc.ts`), table-driven tests: the doc is a *pure function of* (invite, adapter registry, base URL) — so it is unit-testable with zero I/O.

### 3.4 F4 — Join request

- Public `POST /api/agent-invites/:token/join` →
  ```ts
  { requestType: 'agent',
    agentName: string.min(1).max(100),
    role?: string.max(200),
    adapterType: <registry enum>,
    capabilities?: string.max(4000),
    agentDefaultsPayload?: Record<string, unknown>,   // validated against the registry's schema
    externalEndpoint?: string.url(),                  // our existing push-callback field
    contactChannel?: string }
  ```
- Response `{requestId, claimSecret, claimPath, status:'pending_approval', expiresAt}` — **`claimSecret` returned exactly once, stored hashed**, TTL (default 24 h, ≤ invite expiry).
- Writes an `agent_join_requests` row. **No agent row and no `mca_` token exist yet.**
- Rejects: unknown/expired/revoked/exhausted invite, `adapterType` not in `allowedRuntimes`, `agentDefaultsPayload` failing the registry schema.

### 3.5 F5 — Board approval gate

- Owner-gated `GET /api/orgs/:orgId/agent-join-requests?status=pending_approval`, `POST …/:id/approve`, `POST …/:id/reject`.
- Surfaced as a card in the **existing Inbox/Governance queue** — reusing `approval_requests` machinery, **no parallel store** (this is the P1 rule, and it holds here).
- The card shows the agent's *self-declared* name, capabilities, `adapterType`, and a **rendered, machine-generated** summary of `agentDefaultsPayload` (never agent prose — the A2/CC2 rule).
- **On approve:** the existing `POST …/agents/external` path runs — `secureRegistration()` (CC3) applies, the agent row is created, the `mca_` token is minted, and **its hash is parked against the join request**. The raw token is *not* shown to the operator and *not* logged.
- **On reject:** row closed; the `claimSecret` is void. No agent, no token, ever.

### 3.6 F6 — Secure token claim

- Public `POST /api/agent-join-requests/:id/claim-api-key` `{claimSecret}`.
- Fail-closed order: unknown id → 404 · not approved → **403** · claim secret expired → 410 · already claimed → **409** · hash mismatch (constant-time compare) → 403 · else → **200 `{token, tokenType:'agent', baseUrl, agentId}`**, and `claimedAt` is stamped in the same statement (CAS, `rowsAffected===0` → 409 — the pattern `agent-api.ts:275` already uses for plugin-job claims).
- The raw `mca_` token crosses the wire **exactly once, to the claimer**, and is never rendered in any operator UI.
- The onboarding doc's claim section carries the §1.7 anti-transcript paragraph. This is a **requirement of the doc**, not a nicety.

### 3.7 F7 — Reachability

- `GET /api/agent-invites/:token/health-candidates` — for us this is nearly trivial: one public base URL (`https://7ei-backend.fly.dev`). We still ship it, because the doc is generated and self-describing, and because a self-hosted MC instance will need it.
- `GET /api/agent-invites/:token/test-resolution?url=…` — **for the us→agent direction only** (gateway/webhook runtimes with an `externalEndpoint`). Must be **SSRF-hardened exactly as Paperclip is**: refuse any URL resolving to private/loopback/link-local/multicast/reserved space, refuse redirects to same, cap timeout and body, no credentials forwarded. Paperclip's refusal string is the acceptance test.
- No `allowed-hostname` CLI equivalent is needed while MC is hosted; the field is reserved in the registry for the self-hosted case.

### 3.8 F8 — The adapter-type registry (§5) and F9 — CLI

- `GET /api/adapters` (public read) — the registry, so the joining agent can *discover* the taxonomy rather than guess it.
- `7ei-mc onboard --invite <token>` — the CLI becomes an *agent-side* client of the flow (join → poll → claim → **write a chmod-600 `mc.env`**), which is what `cli/onboard.mjs` conspicuously does not do today (it prints exports and requires an operator Clerk JWT).

---

## 4. Safety & security model

### 4.1 The gate chain (invite flow stacks in front; softens nothing)

```
  invite (hashed, TTL, single-use by default, revocable, owner-created)
      ↓
  join request  ──────────► self-description only. NO agent row. NO token.
      ↓
  BOARD APPROVAL  ────────► a human decision, in the existing tri-state queue.
      ↓                     (a leaked invite yields a queue item, not a credential)
  secureRegistration() ───► CC3: low_trust_review + explicit caps + boundary
      ↓
  token mint (hash-only) ─► never shown to the operator, never logged
      ↓
  one-time claim ─────────► single-use, expiring, CAS-guarded, approval-gated
      ↓
  ═══ from here the agent is just an external agent — the SHIPPED chain applies ═══
  P1 low-trust review/quarantine → A2 dangerous-action approval + step-up
  → CC5 denylist → preflight + scoped budgets → run-token scoping → host denylist
```

**The invariant (mirrors `review.ts:14-18`):** the onboarding gate stacks *in front of* the A2 and P1 gates and never provides a cheaper path to anything. An invite-onboarded agent is **more** contained than one created by `AddAgentWizard` today, not less — because CC3's `low_trust_review` default becomes the path *every* runtime takes, not just `claude_code`.

### 4.2 Threats a public join endpoint introduces (that Paperclip, on loopback, never had to face)

| # | Threat | Control |
|---|---|---|
| R1 | **Invite-link leak** (pasted into the wrong chat, ends up in a transcript, indexed) | Approval gate: the leak buys you a row in a human's inbox. Single-use default + short TTL + one-click revoke. Invite token stored hashed, so a DB read does not yield working links. |
| R2 | **Join-request spam / enumeration** on a public endpoint | Wire the already-written `perIpRateLimit()` (`ratelimit.ts:165` — currently **zero call-sites**) onto join + claim. Cap `agent_join_requests` per invite. Constant-time invite lookup; identical 404 for unknown vs. expired vs. revoked. |
| R3 | **Claim-secret brute force** | ≥128-bit secret, hashed at rest, constant-time compare, single-use CAS, short TTL, rate-limited, and *useless before approval*. |
| R4 | **Token leaking through the agent's own transcript** (Paperclip's insight) | The onboarding doc instructs: parse the raw JSON `token`, write to private storage before printing, never copy from chat/tool previews, treat `...`/`[redacted]` as a masked preview, never invent or rotate. We restate this verbatim in spirit — and additionally **never render the raw token in any MC operator UI** for invite-created agents (a divergence from `AddAgentWizard`, which shows it once by design). |
| R5 | **SSRF via `test-resolution`** | Copy Paperclip's refusal: private/local/multicast/reserved → refuse. No redirect following into private space. This endpoint is the single most abusable thing in the design; it ships fail-closed or it does not ship. |
| R6 | **Hostile `agentDefaultsPayload`** (credential fields, huge blobs, prototype pollution) | Validate against the adapter registry's schema — allowlisted keys only, size-capped, no `__proto__`. **Any secret-shaped field (gateway tokens, API keys) is written to the encrypted `secrets` store** (`services/secrets.ts`, AES-256-GCM), scoped to the agent — never into a plaintext config column. |
| R7 | **Agent self-escalation** (an agent creating agents) | Already covered: `agent_create` is in `LOW_TRUST_GATED_ACTIONS` (`review.ts:47-55`). Creating an *invite* must join it. |
| R8 | **Approval-card injection** — malicious `capabilities`/`agentName` text engineering the approver | The card renders a **machine-generated** summary; agent-supplied strings are escaped, length-capped, and clearly labelled *"self-declared by the joining agent — not verified"*. Same principle as A2's verbatim-render rule (`dangerous-approvals.ts`). |

### 4.3 Non-negotiables

1. **No token before a human approves.** Not minted, not hashed, not parked.
2. **Claim once, from the raw HTTP response, by the claimer.** Never via the operator's clipboard.
3. **Low-trust default for every invite-created agent**, regardless of runtime (extends CC3 beyond `claude_code`).
4. **`test-resolution` is SSRF-hardened or absent.**
5. **Secrets in `agentDefaultsPayload` go to the encrypted store.** `mc.env` holds only `MC_BASE_URL`/`MC_AGENT_TOKEN`/`MC_WORKDIR` + flags (the standing `adapters/CLAUDE.md` rule).

---

## 5. Proposed adapter-type registry

Server-side (`services/adapter-registry.ts` — pure, table-driven, the single source of truth; `web/lib/adapterProfile.ts` becomes its client-side *renderer*, not a second truth). Each entry: `{type, label, kind, capabilities{}, defaultsSchema, secretFields[], example}`.

| `adapterType` | kind | `agentDefaultsPayload` | Secret fields → encrypted store | Status for us |
|---|---|---|---|---|
| `openclaw_gateway` | gateway (ws) | `{url: "ws://\|wss://…", headers:{"x-openclaw-token"}, mcApiUrl, waitTimeoutMs?}` | `headers['x-openclaw-token']` | New shape; **the OpenClaw runtime itself already exists** (`adapters/openclaw`, live at `~/.openclaw/mc-adapter/` — do not touch). |
| `openclaw_local` | local poll loop | `{workdir, pollSeconds, executor: auto\|shell\|llm\|http, allowShell}` | `MC_LLM_API_KEY` (already via `GET /api/agent/secrets`) | ♻️ **our current `runtime:'openclaw'` — exactly what ships today.** |
| `claude_code` | local CLI | `{workdir, model?, permissionMode:'plan'\|…, manageWorktree?, timeoutSeconds?}` | — | ♻️ **shipped (CC1–CC6)**. `permissionMode` default `plan`; autonomy stays behind its two guards + the CC5 denylist. Registry must **never** default it to autonomous. |
| `cursor` | local, file-inbox | `{inbox: './coordination/inbox', pollSeconds}` | — | ♻️ shipped (`adapters/cursor`). Paperclip flags it `requiresMaterializedRuntimeSkills` — we should carry that flag. |
| `hermes_gateway` | gateway (http) | `{apiBaseUrl, apiKey, mcApiUrl}` — **`apiKey` is the *Hermes* gateway key, not the MC key** | `apiKey` | 🆕 net-new integration. Port 8642 default; 9119 dashboard/`/chat` auto-maps to `/api`. |
| `hermes_local` | local process | `{command, env}` — MC starts Hermes on the MC host | — | 🆕 net-new; **only meaningful for a self-hosted MC**, since our backend is on Fly. Registry entry ships `available:false` until then. |
| `grok` / `grok_local` | local CLI / API | `{model, workdir}` / provider creds | provider key | 🆕 thin — our `llm-router` already speaks provider APIs. |
| `openai_generic` (**the generic OpenAI-standard runtime**) | http | `{baseUrl, model, apiKeyRef, headers?}` — any OpenAI-chat-compatible endpoint | `apiKeyRef` → `secrets` | 🆕 but nearly free: `adapters/presets/{codex,gemini,nvidia-minimax}.env` are already exactly this shape (`MC_EXECUTOR=llm` + `MC_LLM_BASE_URL/KEY/MODEL`). This is the "map any runtime" escape hatch. |
| `http_webhook` | push | `{externalEndpoint, method, headers}` + `webhookAuthHeader` | auth header | ◐ `agents.external_endpoint` already exists as a column; the dispatch half is not built. |
| `internal` | — | — | — | ♻️ not an adapter; MC-run agents (Arturita et al.). Cannot be invited. |

**Registry rule:** an `adapterType` may be *declared* (so the doc can describe it) but marked `available:false`, in which case a join request naming it is rejected with a clear reason. Honest 404s beat silent half-support — and it lets the onboarding doc stay a complete map of the taxonomy.

---

## 6. Phased build plan — Epic ONB

One PR per story, squash-merged `--admin`; pure helpers + `node --test`; idempotent migrations; invariant green each merge (**backend tests · 11/11 evals · web build**). Tracked in `docs/PLAN-arturita.md` §0.

| Story | Scope | Acceptance |
|---|---|---|
| **ONB1** · Invite object + adapter registry (the spine) | Pure `services/adapter-registry.ts` (§5 table, capability flags, `defaultsSchema`, `secretFields`) + pure `services/agent-invites.ts` (token gen `mci_inv_*`, hash, TTL, use-count, state machine `active\|revoked\|accepted\|expired`). Idempotent `agent_invites` table (`arturita_bindings` pattern: hash + TTL + single-use). Owner-gated create/list/revoke. Public `GET /api/adapters`. | Invite token stored **hash-only**, raw shown once. Expired/revoked/exhausted invites are indistinguishable 404s. Registry is the single source of truth; `adapterProfile.ts` renders *from* it. Table-driven tests per adapter. |
| **ONB2** · `onboarding.txt` + JSON twin | Pure `services/onboarding-doc.ts` — `renderOnboardingDoc(invite, registry, baseUrl)` → text + JSON. Public `GET /api/agent-invites/:token/onboarding[.txt]`. | Doc is a **pure function** (no I/O) — snapshot-tested. Every URL carries the invite token. A worked `agentDefaultsPayload` example per allowed runtime. The §1.7 claim-security paragraph is present and asserted by a test (it is a *security control*, so it gets a test). |
| **ONB3** · Join request + approval gate | Idempotent `agent_join_requests` table. Public `POST …/:token/join` (registry-validated payload; secret fields → encrypted `secrets`). Owner-gated list/approve/reject, rendered in the **existing** approvals inbox. Approve → `secureRegistration()` → agent row + token mint (hash parked). Reject → void. | **No agent row and no token exist before approval** — asserted by a test that inspects the DB after a join. Approval card renders a machine-generated payload summary + a *self-declared, unverified* label. `agent_create`-style gating honoured. |
| **ONB4** · One-time claim | Public `POST /api/agent-join-requests/:id/claim-api-key` `{claimSecret}` — hashed secret, constant-time compare, CAS single-use, TTL, **403 before approval**. `perIpRateLimit()` finally wired onto join + claim. | Fail-closed matrix tested end to end: unapproved → 403 · replay → 409 · expired → 410 · wrong secret → 403 · happy path → the raw token **exactly once**. Raw token never appears in any operator-facing response or log. |
| **ONB5** · Reachability + `test-resolution` | `GET …/:token/health-candidates`; SSRF-hardened `GET …/:token/test-resolution?url=`. | Private/loopback/link-local/multicast/reserved → refused (Paperclip's own refusal is the fixture). No redirect into private space. Timeout + body cap. **Ships fail-closed or does not ship.** |
| **ONB6** · Create-invite UI + copy-able prompt + CLI | Cockpit "Invite an agent" dialog (runtime allow-list · TTL · uses · message) → invite + **copy-able onboarding prompt** (§3.2) + the doc URL. `7ei-mc onboard --invite <token>` becomes the agent-side client: join → poll approval → claim → write a **chmod-600 `mc.env`**. | Operator can onboard an arbitrary external agent **by pasting one prompt** — the acceptance test for the whole epic. CLI writes `mc.env` with only `MC_BASE_URL`/`MC_AGENT_TOKEN`/`MC_WORKDIR` + flags (never an LLM key — `adapters/CLAUDE.md`). No Clerk JWT needed on the agent side. |
| **ONB7** · Docs / DX / go-live | `docs/` + `adapters/CLAUDE.md` + `GO-LIVE.md` prereqs + `STATUS.md` + vault milestone. Skill-bootstrap endpoint (`/skills/…`) if we ship an MC skill file. | An operator can run the flow from the docs alone. |

**Sequencing:** ONB1 → ONB2 → ONB3 → ONB4 are a hard chain (each needs the prior). ONB5 is independent and can land any time after ONB1. ONB6 needs ONB4. **MVP = ONB1–ONB4 + ONB6** (ONB5 is only needed for gateway/webhook runtimes; every local-adapter runtime — OpenClaw, Cursor, Claude Code — onboards without it, since they *call us* and we are on a stable public URL).

---

## 7. Open questions for the operator

| # | Question | Why it matters | Recommendation |
|---|---|---|---|
| Q1 | **Public join endpoint on the hosted backend — acceptable?** Paperclip's is loopback-only; ours would be on `7ei-backend.fly.dev`. | This is the single biggest posture decision in the epic. | **Yes, with R1–R3 controls** (approval gate + single-use + TTL + rate limit). The approval gate means a leaked invite is worth a queue item, not a credential. |
| Q2 | **Single-use or multi-use invites by default?** Paperclip's is multi-use. | A reusable link on a public backend is a standing door. | **Single-use default**, `maxUses` opt-in for a fleet rollout. |
| Q3 | **Does an invite-created agent land in `low_trust_review` regardless of runtime?** CC3 does this only for `claude_code` today. | Extending it is a *behaviour change* for OpenClaw/Cursor onboarding. | **Yes** — invite-onboarded means self-declared and remotely-attached; contain it. Existing agents are untouched. |
| Q4 | **Do we show the raw token to the operator at all?** `AddAgentWizard` shows it once, by design. | The invite flow's whole point is that the *claimer* gets it, not the clipboard. | **No** — for invite-created agents the operator never sees it. Keep the wizard's behaviour for the manual path. |
| Q5 | **Which runtimes must the registry support at v1?** | Sizes ONB1. | OpenClaw (local + gateway), Claude Code, Cursor, `openai_generic` — the four we can test end-to-end today. Hermes/Grok declared but `available:false`. |
| Q6 | **Do we need `hermes_gateway` at all**, or is it Paperclip-specific? | It is the most complex payload in Paperclip's doc, and we have no Hermes install. | **Declare, don't build**, until there's a Hermes agent to onboard. |
| Q7 | **Does an invite carry a pre-assigned role / department / reports-to?** | Would let the board approve an agent straight into the org chart. | Nice-to-have; `defaultsPayload` on the invite can carry it (Paperclip has exactly this field). Defer to ONB6. |
| Q8 | **Jira epic + MCA issue numbers for ONB1–ONB7?** | Convention. | File interactively; back-fill into PLAN §0. |

---

## 8. ADDENDUM (2026-07-14) — deployment profiles, the config bundle, and the four locked defaults

> **Status: OPERATOR-APPROVED.** This addendum supersedes §7's open questions Q1–Q4 and is binding on ONB1–ONB7. It also makes Epic ONB and **Epic H — Packaging & Distribution** (`docs/PLAN-arturita.md` §Epic H) a *joint* design rather than two epics that happen to touch the same machine. Shipped in ONB1 (PR #244).

### 8.1 The deployment-profile abstraction

Mission Control runs in exactly one of **two profiles, chosen by config**, and **the onboarding posture is derived from the profile — never hardcoded at a call site**:

| Profile | What it is | Onboarding posture |
|---|---|---|
| **`hosted`** (default) | Multi-tenant, on a public URL. What we run today (`7ei-backend.fly.dev`). | Public join is **OFF**. Enabling it requires an explicit operator enable **and** every hardening requirement satisfied. A public join endpoint on a public backend is a real attack surface (§4.2). |
| **`packaged`** | Single-tenant, installed on the operator's own machine — the future `.dmg` (Epic H, H1/H4). | **Loopback-trusted**, exactly like Paperclip's `local_trusted`. Onboarding is reachable from localhost; nothing is exposed publicly. |

Shipped as pure `backend/src/services/deployment-profile.ts`: `resolveDeploymentProfile(env)` (`MC_DEPLOYMENT_PROFILE`, **safe default `hosted`** — an unset or garbage value must resolve to the *harder* posture, because mis-reading a hosted deployment as packaged would trust a loopback we do not own) and `onboardingPosture(env)`, which returns the derived posture **plus a hardening checklist that reports, per control, whether it is satisfied and why not**. The checklist is computed, never asserted: `PUBLIC_JOIN_IMPLEMENTED` is `false` while ONB3/ONB4 are unbuilt, so **no env var can talk the posture into being open before the controls that make it safe exist.** It flips in the PR that lands ONB4, and only then.

### 8.2 The config bundle (and where Epic H picks it up)

Every system setting/parameter should be expressible as **one declarative, versioned CONFIG BUNDLE** that (a) Export/Import — the org portability we already ship (`services/portability.ts`) — can move between machines, and (b) the future `.dmg` installer **seeds a fresh machine from** (Epic H, **H4 "fresh-machine config/secret bootstrap"**).

**Secrets are never in the bundle.** They stay in the encrypted store (`services/secrets.ts`, AES-256-GCM) and are re-supplied per machine. Shipped as pure `backend/src/services/config-bundle.ts`: `CONFIG_BUNDLE_VERSION`, the deployment slice, `buildConfigBundle()`/`validateConfigBundle()` (refuses a bundle newer than this build understands), and `assertNoSecrets()` — a **hard throw**, not a warning, on any secret-shaped key anywhere in the object graph. The same detector (`isSecretShapedKey`, token-based so it catches `apiKey`, `x-openclaw-token` and `webhookAuthHeader` while leaving `sessionKeyStrategy` and `paperclipApiUrl` alone) is what the adapter registry uses to route `agentDefaultsPayload` fields into the encrypted store — **one detector, so the bundle rule and the payload rule can never drift apart**. Epic H's H4 story consumes this bundle rather than inventing a second config format; ONB1 ships the spine (version + deployment slice + the no-secrets enforcement), and the org/agent/budget/routine slices fold in from `portability.ts` under Epic H.

### 8.3 The four locked posture defaults (baked in as invariants)

These four are **not env-tunable**. They are constants in `deployment-profile.ts`, restated declaratively in the config bundle so an importing machine can *verify* it agrees with them rather than assume, and each is locked by a test:

1. **Public join endpoint OFF by default, gated by the profile.** `packaged` = loopback-trusted; `hosted` = requires enabling remote onboarding **and** full hardening. (Resolves Q1: yes to a public join endpoint on the hosted backend — but only behind the gate chain, and off until it exists.)
2. **Invites are SINGLE-USE by default.** Multi-use is an explicit, bounded per-invite opt-in (`maxUses` ≤ 50). *(We invert Paperclip's multi-use default: a reusable door on a public backend is a standing risk.)* (Resolves Q2.)
3. **Every invite-created agent lands in `LOW_TRUST_REVIEW`, regardless of runtime** — extending CC3 beyond `claude_code`. Invite-onboarded means self-declared and remotely-attached: contain it. Existing agents are untouched. (Resolves Q3.)
4. **The raw claimed token is NEVER shown in the UI or the clipboard.** Only the claiming agent reads it, once, from the raw HTTP response. `AddAgentWizard`'s show-once behaviour stays for the *manual* path; the invite path never reveals it to an operator or a log. (Resolves Q4.)

*(A small vindication of control 4, worth recording: the config bundle's secret detector rejected our own first name for this invariant — `revealClaimedTokenInUi` — because it contains "token". The field is now `operatorCanSeeClaimedKey`. The detector works.)*

---

## 9. Verdict recap

Paperclip's onboarding is worth copying because of *what it moves*, not what it builds: it moves the credential to the **end** of the flow and puts a **human decision** in the middle, and it makes the whole contract **self-describing** so any HTTP-capable agent can drive it. We already own the post-onboarding half of that contract (`agent-api.ts` and the entire gate chain). The epic is four net-new objects — **invite · join request · claim · adapter registry** — plus a generated document and one dialog.

**Reuse-vs-new in one line:** *~70% reuse (identity, token hashing, registration, approvals queue, CC3 containment, P1 low-trust, `adapterProfile`), 4 net-new objects, 1 generated doc, 1 hardened SSRF probe — and the result is strictly safer than the token we hand-carry today.*
