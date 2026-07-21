# PLAN — "+ Agent" onboarding entry points & "Delete Agent"

> **Phase 0 — PLAN ONLY. No code written.** Produced 2026-07-20 against `main` @ `ed180bd`.
> Companions: `docs/DESIGN-agent-onboarding.md`, `docs/RUNBOOK-agent-onboarding.md`,
> `docs/SECURITY-posture.md`, `docs/PLAN-arturita.md` §0 (ONB1–ONB7).
>
> **Headline finding:** the "+ Agent" half needs **no backend work at all** — Epic ONB
> shipped the entire invite spine and the dialog. It is a pure placement/discoverability
> change in `web/`. The "Delete Agent" half is where the real (backend-first) work is,
> and the existing `DELETE /api/agents/:agentId` has **five concrete gaps**, one of which
> (orphaned third-party OAuth refresh tokens) is a security finding rather than a nit.

---

## 0. Three premises in the brief that the source does not support

Recorded up front, because each one changes the shape of the work.

| Brief said | Source says |
|---|---|
| "agents soft-delete columns" in `schema.ts` | **They do not exist.** `agents` (`backend/src/db/schema.ts:36-92`) has no `deletedAt`/`archived` column, and `backend/src/db/setup.ts` adds none. The seam that *does* exist is the free-text `status` column (`schema.ts:48`), which already carries `'terminated'` via the governance verbs at `backend/src/routes/agents.ts:374-380`. |
| The DELETE route may have a cross-tenant hole | **Cross-tenant delete is already closed.** `requireOrgMembership` is installed on the whole Clerk-secured scope (`backend/src/index.ts:183`) and derives the org *from the agent row* for any `:agentId` route (`backend/src/middleware/rbac.ts:161-164`); a missing agent yields `orgId: null` → 403 fail-closed. The missing `orgId` in the delete's WHERE clause is **not** exploitable — the gate read the same row by the same id one hop earlier. The real gap is the **role level** (member, not owner). |
| `HANDOVER.md` at repo root | Missing at root; it is `docs/HANDOVER.md`. `HANDOFF.md` exists at root. All other referenced files exist. |

**Docs referenced vs present:** `docs/DESIGN-agent-onboarding.md` ✅ · `docs/RUNBOOK-agent-onboarding.md` ✅ ·
`docs/SECURITY-posture.md` ✅ · `docs/PLAN-arturita.md` ✅ · `STATUS.md` ✅ · `HANDOFF.md` ✅ ·
`HANDOVER.md` ❌ (→ `docs/HANDOVER.md` ✅). All named source files exist.

---

## 1. Gap analysis vs existing ONB

### 1a. "+ Agent" — the spine is complete; only *placement* is missing

**Backend — 100% reuse, zero changes required.**

| Capability | Where it already lives |
|---|---|
| Create invite (owner-gated, returns raw token once) | `backend/src/routes/agent-invites.ts:116` |
| List invites (never returns token or hash) | `backend/src/routes/agent-invites.ts:167` |
| Revoke invite (idempotent) | `backend/src/routes/agent-invites.ts:179` |
| Onboarding posture + joinable types | `backend/src/routes/agent-invites.ts:200` |
| Public join (rate-limited, profile-gated) | `backend/src/routes/agent-invites.ts:302` |
| One-time claim | `backend/src/routes/agent-invites.ts:443` |
| Owner-gated approve/reject | `backend/src/routes/agent-invites.ts:242` |
| Public adapter registry | `backend/src/routes/agent-invites.ts:554` |

**Web — the dialog is complete too.** `web/app/dashboard/cockpit/InviteAgentDialog.tsx`
already fetches `GET /api/adapters` (`:65`) + posture (`:66`), creates via
`POST /api/orgs/:orgId/agent-invites` (`:84-86`), renders the token + onboarding prompt
+ doc URL once with copy buttons (`:100-133`), lists invites with revoke (`:95`), and
shows an honest "public join is closed" banner when `joinEnabled === false`
(`:109-114`, `:202-206`). The adapter picker is registry-driven:
`pickableAdapters()` = `invitable && available && kind !== 'internal'`
(`web/lib/invites.logic.ts:28`).

**What is actually missing — discoverability, and only that.** All three creation paths
(Hire / Invite / Add) live in one toolbar, `web/app/dashboard/CockpitPanel.tsx:263-268`,
**inside a `{!focused && …}` guard** (`:263`; `focused = !!only`, `:222`). So they render
only in the full Operations stack and are **suppressed in every focused section view**:

- **Org** (`navModel.ts:107`, `kind: 'section'` → `CockpitPanel only={['org']}`,
  `web/app/dashboard/page.tsx:396-397`) — `OrgChart.tsx` toolbar has Import/Export/zoom
  only (`:183-212`). **No add affordance.**
- **Agents** (`navModel.ts:105`, `kind: 'tab'`, `page.tsx:450-488`) — only a Staff/Table
  view toggle (`:455-465`). `StaffGrid.tsx` renders cards, no add button. **No add affordance.**

⇒ **Scope for (a): mount an existing dialog in two more places.** No new endpoint, no
new store, no contract change. This is the cheapest half of the wave by a wide margin.

### 1b. "Delete Agent" — nothing exists on the client; the server route is unhardened

- **`web/app/dashboard/agent/ConfigurationTab.tsx`** (286 lines) has **no delete/archive
  control**. Its only destructive actions are avatar removal (`:139-147`) and custom-model
  removal (`:124-137`). Sections today: Avatar (`:160-179`), Identity (`:182-214`),
  Adapter + model (`:217-271`), Save bar (`:273-278`).
- **No web client role signal.** `ConfigurationTab` receives `{ orgId, agentId, getToken, onSaved? }`
  (`:25-30`) — no role. There is no `useRole`/`isOwner` hook anywhere in `web/`; the one
  `isOwner` (`ActivityLogSection.tsx:140`) is read out of an API response body, not shared.
  An owner-gated Delete button therefore needs a **net-new client role source**.
  `apps/mobile/src/agentEdit.ts:36` (`isOwnerRole()`, fail-closed — `'admin'` → false,
  locked by `agentEdit.test.ts:254`) is the shape to copy.
- **Reusable server pattern already exists:** the Configuration tab's own write path,
  `PUT /api/orgs/:orgId/agents/:agentId/config` (`backend/src/routes/agent-detail.ts:263`),
  is owner-gated + org-scoped + snapshotted. `agentInOrg()` (`agent-detail.ts:26-31`) and
  the `config_revisions` `snapshot()` helper (`agent-detail.ts:254-258`) are directly reusable.
- **Adjacent, already wired:** `terminate` exists in `CockpitPanel.tsx:163`'s verb union
  and as `POST /api/agents/:agentId/terminate` (`agents.ts:374-380`) — **with no UI caller.**

---

## 2. Backend API contract

### 2a. Invite-create for "+ Agent" — reuse verbatim, add nothing

**Endpoint:** `POST /api/orgs/:orgId/agent-invites` — owner-gated
(`requireOrgRole('owner')`, `agent-invites.ts:116`).

**Payload** (all optional; `web/lib/invites.logic.ts:67-76` already builds it sparsely so
the server owns the defaults):

```jsonc
{
  "allowedAdapterTypes": ["claude_code"],  // omit ⇒ any joinable adapter
  "maxUses": 1,                            // omit ⇒ DEFAULT_MAX_USES = 1 (single-use)
  "expiresInHours": 72,                    // omit ⇒ DEFAULT_INVITE_TTL_HOURS = 72
  "message": "…"                           // optional, ≤2000 chars
}
```

**Defaults are invariants, not UI choices** — single-use (`agent-invites.ts:44`), 72h
(`:40`), max 168h (`:42`), max 50 uses (`:46`). Out-of-range values are **refused, not
clamped** (`createInvite`, `services/agent-invites.ts:131-158`).

> **No parallel store. No new endpoint.** A second invite table or a "quick add" path that
> bypasses `createInvite()` would fork the hash-only/TTL/single-use state machine — exactly
> the drift the epic was built to prevent.

**Honesty requirement carried into the new entry points:** on hosted prod
`MC_ENABLE_REMOTE_ONBOARDING` is unset, so join/claim/doc answer a **flat 404**
(`docs/RUNBOOK-agent-onboarding.md:28-30`). A "+ Agent" button that mints an invite the
agent cannot yet spend must keep the dialog's existing `joinEnabled === false` banner
(`InviteAgentDialog.tsx:109-114`, `:202-206`). **Do not hide or soften that banner to make
the new entry point feel complete.**

### 2b. Delete-agent hardening — audit of `DELETE /api/agents/:agentId`

Current implementation, in full (`backend/src/routes/agents.ts:381-384`):

```ts
app.delete('/api/agents/:agentId', async (req, reply) => {
  await db.delete(schema.agents).where(eq(schema.agents.id, (req.params as any).agentId))
  reply.code(204)
})
```

| # | Property | Status | Evidence |
|---|---|---|---|
| 1 | **Org-scoped / cross-tenant safe** | ✅ **PASS** | `requireOrgMembership` on the Clerk scope (`index.ts:183`) derives org from the agent row (`rbac.ts:161-164`); missing agent → `orgId: null` → 403 (`rbac.ts:35`). Regression-covered by the `[MCA-R4]` sweeps (`tests/membership-scoping.test.ts:264`, `:292`). |
| 2 | **Owner-gated** | ❌ **GAP** | Baseline is `minRole: 'member'` (`rbac.ts:213`). **Any member can delete any agent in their org.** Compare `DELETE /api/orgs/:orgId` (`routes/orgs.ts:207`), which carries an explicit `requireOrgRole('owner')`. |
| 3 | **Soft delete** | ❌ **GAP** | Hard `db.delete`. No `deletedAt` column exists (`schema.ts:36-92`). Irreversible, and it destroys the audit pre-image. |
| 4 | **Audit-logged** | ⚠️ **GAP (records into a hole)** | `shouldAudit` returns true (`DELETE` ∈ `SENSITIVE_METHODS`, `audit-log.ts:92`) and `classifyAction` has an `agent.delete` arm (`audit-log.ts:83`). **But** the row is written with `orgId: (req.params as any)?.orgId ?? null` (`audit-log.ts:254`) — this route has no `:orgId` param, so **`audit_logs.orgId` is NULL**, and the query route filters `eq(auditLogs.orgId, orgId)` (`audit-log.ts:277`). **The record never appears in any org's audit log.** A bodiless DELETE also yields no metadata, so nothing records *which* agent died. |
| 5 | **Credential / connector revocation** | ❌ **GAP — the security finding** | See below. |
| 6 | **Mass-assignment (GC-0b class)** | ✅ **N/A by shape** | The handler reads only `req.params.agentId`; no body is parsed, so there is no writable-column surface. The GC-0b guards (`tests/gc0b-mass-assignment-guard.test.ts:122`, `:230`) target `db.update/insert` body sinks and correctly do not fire here. **However** the GC-0b *gate-order* lesson still applies to the redesign: `resolveRequestOrg` authorises the **pre-image**, so any new handler must re-assert org membership on the row it actually mutates. |
| 7 | **Fail-closed on already-deleted** | ✅ **PASS, accidentally** | A second delete 403s (gate can't resolve the row), never 500s. Semantically odd (403 for "gone") but not unsafe. |
| 8 | **Existing tests** | ❌ **NONE** | No test exercises this route. Nearest: `auth-scoping.test.ts:171` (the `/memory` sub-route), `membership-scoping.test.ts:430-455` (DELETE list — does not include it). Tenancy is covered transitively; delete **behaviour** is untested. |
| 9 | **Any client caller** | ℹ️ None | No `web/` or `apps/mobile/` code calls it. Reachable only by direct API call today. |

#### The credential-revocation gap, in detail

**Good news, and it is accidental:** the agent's own bearer token dies with the row. The
resolver keys off `agents.apiTokenHash` (`middleware/agent-token.ts:39-40`) and 401s when
no agent resolves (`:53`) — the token has no independent storage.

> ⚠️ **This is the single most important consequence of switching to soft delete.** A
> soft-deleted agent's `apiTokenHash` stays on the row, so **its token keeps working**
> unless `agent-token.ts:40` also filters on the not-deleted state. Soft delete without
> that change is a *regression* against the current hard delete.

**Bad news — these survive a delete today, orphaned and unrevoked:**

- `agent_oauth_tokens` — `accessTokenEnc` + `refreshTokenEnc` (`schema.ts:603-604`). A live
  **Google refresh token for a real user account**, now ownerless, invisible to every UI,
  never expiring, and never revoked upstream at Google.
- `secrets` where `scope='agent' AND scopeId=<agentId>` (`schema.ts:302-305`) — reachable
  from `agent_connectors.secretRef` (`schema.ts:217`). Note the column name contains no
  "agent", so a naive `agentId` cascade **misses it**.

**No FK will help.** `references(` appears **zero** times in `schema.ts`, and no
`PRAGMA foreign_keys` appears in `backend/src` — libSQL defaults it OFF per connection.
Every cascade must be explicit application code.

**Full blast radius — 17 orphan sites.** Direct `agentId`: `messages` (`:96`), `tasks`
(`:105`), `agent_files` (`:197`), `agent_connectors` (`:212`), `connector_executions`
(`:237`), `agent_runs` (`:252`), `agent_join_requests` (`:418`), `scheduled_tasks` (`:554`),
`agent_oauth_tokens` (`:602`), `agent_oauth_states` (`:622`). Aliased: `agents.reportsTo`
(`:70` — orphans the org chart), `agents.advisorIds` (`:58`), `tasks.assignedTo` (`:124`),
`task_attachments.createdByAgentId` (`:152`), `task_comments.authorAgentId` (`:269`),
`approval_requests.requestedByAgentId` (`:327`), `goals.ownerAgentId` (`:482`).
Untyped: `secrets.scopeId` (`:303`).

#### Recommended shape (Phase 1)

**Add a new owner-gated, org-scoped route; do not merely patch the legacy one.**

```
DELETE /api/orgs/:orgId/agents/:agentId   { preHandler: requireOrgRole('owner') }
```

Rationale, each point load-bearing:

1. **`requireOrgRole` no-ops on a path without `:orgId`** (`rbac.ts:70-71` — the documented
   R-4 trap, and a known repo landmine). Bolting the preHandler onto the legacy top-level
   path would enforce **nothing**. The route must be *re-pathed*, not just decorated.
2. It mirrors the Configuration tab's existing owner-gated write path exactly
   (`agent-detail.ts:263`), so the tab's two mutations share one authz story.
3. It **fixes the NULL-`orgId` audit hole for free** — `audit-log.ts:254` reads
   `req.params.orgId`, which this path now carries.
4. `agentInOrg(orgId, agentId)` (`agent-detail.ts:26-31`) gives a real **404** for
   already-deleted / wrong-org, replacing the current semantically-odd 403.

Handler outline (Phase 1 detail, not final code):
- `agentInOrg()` → 404 if absent.
- **Soft delete** via the existing `status` seam (`status='deleted'`, or reuse `'terminated'`
  — decide in Phase 1) + a new `deletedAt` column added as an **idempotent ALTER in
  `setup.ts`**. ⚠️ Per the known `setup.ts` trap, a new column must go in the **CREATE TABLE
  string too**, not only the ALTER loop, or fresh/test DBs break.
- **Revoke credentials explicitly**: null `apiTokenHash`; delete `agent_oauth_tokens` rows
  (and attempt upstream Google revocation, best-effort, non-blocking); delete
  `secrets WHERE scope='agent' AND scopeId=agentId`; disable `agent_connectors`.
- **Filter the token resolver** (`agent-token.ts:40`) on the not-deleted state.
- **Snapshot** the pre-image into `config_revisions` via the existing `snapshot()` helper.
- **Exclude deleted agents from every read path** (roster, staff grid, org chart, advisor
  pickers, `reportsTo` resolution) — a soft delete that still renders is a bug, not a feature.

**Open decision for the operator (Phase 1):** `DELETE /api/orgs/:orgId` (`orgs.ts:207-210`)
deletes only the `organisations` row and orphans **everything** in it — the same bug at
larger blast radius. Should the cascade helper be agent-shaped, or built reusable? *(Out of
scope for this wave either way — flagged, not scheduled.)*

### 2c. Enabling Hermes / Grok / OpenClaw-gateway — **defer all five. Verified.**

I checked the dispatch half directly rather than trusting the registry notes. **The notes
are accurate, not stale.**

**The mechanism that matters: Mission Control never pushes. Dispatch is entirely PULL.**
`agent-executor.ts:125-129` flips the task row to `assigned`; the agent's own poll loop
collects it via `GET /api/agent/tasks?state=assigned` (`routes/agent-api.ts:325-350`),
claims it under an atomic CAS (`:353-383`), and posts a result (`:401`). All three shipped
adapters are stdlib poll loops on the operator's host
(`adapters/openclaw/mc_adapter.py:244-247`, `:277-279`; `adapters/cursor/`, `adapters/claude-code/`).

The one MC→agent notification, `notifyExternalAgent` (`services/agent-runtime.ts:33-48`),
**accepts `externalEndpoint` in its signature and never reads it** (verified at
`agent-runtime.ts:34`). It calls `fireWebhook(…, agent.orgId, …)`
(`services/outbound-webhooks.ts:30-48`), an **org-level event broadcast** to
operator-registered URLs — not per-agent dispatch. For an org with no webhook rows it is a
silent no-op, and the agent learns of the task only on its next poll.

| Runtime | Dispatch | Evidence |
|---|---|---|
| `openclaw_gateway` | **ABSENT** | **No outbound WebSocket client anywhere in `backend/src`.** `ws://`/`wss://`/`new WebSocket`/`from 'ws'` hit only registry strings (`adapter-registry.ts:119`, `:125`) and a test fixture. `@fastify/websocket` (`package.json:28`) is **inbound-only** and cannot dial out. No `ws` client dep. |
| `hermes_gateway` | **ABSENT** | No Hermes client, no `/api/v1/runs` call, no port-8642 code. Every `hermes` hit is a registry declaration (`adapter-registry.ts:197-211`) or a test asserting unavailability (`tests/agent-invites.test.ts:147`, `tests/join-requests.test.ts:193-194`). |
| `hermes_local` | **ABSENT** + structurally impossible | Requires MC to spawn a host process; no `spawn`/`exec` of it exists. The backend runs on Fly and does not start host processes (`adapter-registry.ts:225`). |
| `grok_local` | **ABSENT** | No `grok`/`xai`/`x.ai` outside the registry row + tests. **The LLM router has no xAI provider** — `llm-router.ts:364-379` switches on google/anthropic/openai/deepseek/moonshot/qwen/minimax/ollama/custom only. |
| `http_webhook` | **ABSENT** | `agents.external_endpoint` (`schema.ts:63`) is **written** on join (`join-requests.ts:335`) and create (`agents.ts:485`, `:515`) and **never read into an HTTP call**. Dead weight w.r.t. dispatch. |

**`openai_generic` is the precedent — and it inverts the naive reading.** It maps to
`runtime: 'custom'` (`adapter-registry.ts:169`), and `isExternalAgent` is true for anything
≠ `'internal'` (`agent-runtime.ts:10-12`), so it takes the **external branch and never
reaches `streamLLM`**. MC does **not** call the endpoint. The operator runs the same
OpenClaw poll adapter with `MC_EXECUTOR=llm`, and the *adapter*, on the operator's host,
calls the OpenAI-compatible endpoint (`adapters/openclaw/mc_adapter.py:131-141`, gated `:215`);
`adapters/presets/*.env` are literally this shape. **So `openai_generic` is honest as
`available: true` precisely because it is still pull-based** — MC makes no outbound
connection and needs no SSRF guard. It is **not** evidence that an `http`-kind adapter can
dispatch; `http_webhook` inverts the direction, and that direction is the unbuilt half.

**ONB5 does not exist.** No `ssrf`/`test-resolution`/`health-candidates`/`isPrivateIp`
module in `backend/src`; `docs/PLAN-arturita.md:73` marks it `deferred` and names it a
precondition for exactly these runtimes. The nearest reusable building block is the
MCP connector's DNS-pinned guarded client (`services/connector-mcp.ts:133`, `:186`, `:212`),
which is scoped to MCP only. Note `fireWebhook`'s delivery has **no SSRF guard at all** —
a bare `fetch(hook.url)` with a 10s abort (`outbound-webhooks.ts:64`) — so building push
dispatch on that path would inherit an unguarded egress primitive.

#### Recommendation: **all five stay `available: false`.**

Flipping any of them would be faking availability — a join would be accepted for a runtime
that can never be handed work. Per-runtime criteria to lift the deferral:

| Runtime | Recommendation | Criteria to lift |
|---|---|---|
| `openclaw_gateway` | **Defer** | (1) An outbound WS client (new dep) with auth, reconnect, backpressure; (2) a per-agent dispatch path replacing the org-broadcast `notifyExternalAgent`; (3) **ONB5 SSRF guard** on the operator-supplied `url`, `wss://` enforced; (4) a worked round-trip example in the onboarding doc; (5) a real dispatch integration test. |
| `http_webhook` | **Defer** (closest to feasible) | (1) A per-agent HTTP pusher that actually **reads** `externalEndpoint`; (2) **ONB5** — private/loopback/link-local/multicast refused, no redirect into private space, timeout + body cap, DNS-pinned (extend `connector-mcp.ts:186`); (3) retry/idempotency semantics; (4) a decision on whether push *replaces* or *supplements* the poll claim CAS. **Do not build it on the unguarded `fireWebhook` path.** |
| `hermes_gateway` | **Defer** | Blocked on having **no Hermes install to test against**. Needs a real instance, the client, ONB5, and a worked example. The `apiKey` field is the most confusable in the flow (Hermes key ≠ MC token, `adapter-registry.ts:210`) — the doc example must be unambiguous before any join is accepted. |
| `hermes_local` | **Defer indefinitely** | Requires MC to spawn host processes. **Not meaningful for the hosted Fly deployment at all**; only revisit under the `packaged` profile (Epic H), and then only with the CC5 denylist + CC6 host guards applied. |
| `grok_local` | **Defer** | Needs an xAI provider in `llm-router.ts:364-379` *plus* a local CLI spawn path. **Cheaper alternative that is already true today:** an operator points `MC_LLM_BASE_URL` at xAI's OpenAI-compatible endpoint via `openai_generic`. Recommend documenting that instead of building `grok_local`. |

**Two small honesty corrections worth folding into this wave (docs/comment only, no behaviour):**
- `adapter-registry.ts:240` claims grok is "covered today by `openai_generic` **via the LLM
  router**" — the router half is **wrong**; coverage is via the host-side adapter.
- `agent-runtime.ts:34` takes `externalEndpoint` and never uses it, which reads as though
  push dispatch exists. Either drop it from the signature or comment why it is inert.

---

## 3. Security invariants that must stay green

| # | Invariant | How this wave preserves it |
|---|---|---|
| 1 | **Hash-only invite tokens** | Untouched. `createInvite` stores `hashToken(token)` only (`services/agent-invites.ts:168`); the raw token exists solely in the create response (`routes/agent-invites.ts:146-163`). New entry points call the **same endpoint** — no second mint path, no persistence of the raw token client-side. |
| 2 | **No existence oracle** | Untouched. Unknown/expired/revoked/exhausted/posture-closed all collapse to one flat 404 (`agent-invites.ts:303`, `:327`, `:329`, `:342`; claim `:444-456`). No new public route is added. The *delete* route's fail-closed behaviour improves (403-for-gone → a proper org-scoped 404 that still requires membership to reach). |
| 3 | **Owner-gated approve** | Untouched — `requireOrgRole('owner')` on approve/reject (`agent-invites.ts:242`) and the generic decide door hardened by ONB3 H-1 (`services/approval-authz.ts`). **No new decision path is introduced.** |
| 4 | **`low_trust_review` default** | Untouched. Set by `applyJoinDecision` → `secureRegistration()` regardless of runtime (ONB invariant #3, `docs/SECURITY-posture.md:59-60`). "+ Agent" changes *where the button is*, never what approval produces. |
| 5 | **Shell OFF by default** | Untouched. `allowShell` defaults `false` in the registry (`adapter-registry.ts:104`). No new surface writes it. |
| 6 | **`MC_ENABLE_REMOTE_ONBOARDING` 404-gate** | **Explicitly not weakened.** New entry points reuse the dialog unchanged, including its closed-join banner (`InviteAgentDialog.tsx:109-114`, `:202-206`). The posture stays *derived*, never asserted (`services/deployment-profile.ts`). No new code reads or sets the flag. |
| 7 | **No cross-tenant leak on delete** | Already held by the membership gate (`rbac.ts:161-164`) and **strengthened**: the new path is `/api/orgs/:orgId/agents/:agentId` with `agentInOrg()` re-asserting org on the row being mutated — closing the GC-0b gate-order class by construction rather than by luck. |
| 8 | **Credential/connector revocation on delete** | **The net-new invariant.** Delete must null `apiTokenHash`, purge `agent_oauth_tokens` (+ best-effort upstream Google revocation), purge `secrets WHERE scope='agent' AND scopeId=agentId`, and disable `agent_connectors`. **If soft delete lands, `agent-token.ts:40` must also filter the deleted state** or the token survives — the one property the current hard delete gets right. |
| 9 | **Adapter picker stays registry-driven** | Untouched — `pickableAdapters()` = `invitable && available && kind !== 'internal'` (`web/lib/invites.logic.ts:28`), fed by `GET /api/adapters`. New entry points reuse the same dialog; **no hardcoded runtime list is introduced.** ⚠️ Note `ConfigurationTab.tsx:17-23` has a **hardcoded `ADAPTERS` const** — pre-existing drift, flagged but out of scope. |
| 10 | **Audit trail records the sensitive write** | **Improved.** Today `agent.delete` writes with `orgId: NULL` (`audit-log.ts:254`) and is invisible to the org-filtered query (`:277`). The org-scoped path fixes it, plus an explicit in-handler record of *which* agent, with a `config_revisions` pre-image snapshot. |

---

## 4. Test plan (backend-first)

Convention: `node --test` via tsx, `test('[TAG] description')`, per `backend/CLAUDE.md`.
**Invariant: zero failures + 11/11 evals.**

### 4a. Registry readiness — extend `tests/adapter-registry.test.ts`
- `[ADD-1]` `joinableAdapterTypes()` is **exactly** `['openclaw_local','claude_code','cursor','openai_generic']` — a tripwire that fails the moment anyone flips an unbuilt runtime to `available: true`.
- `[ADD-1]` every `available: false` adapter carries a non-empty `note` explaining *why* (keeps "declared ≠ available" honest).
- `[ADD-1]` `internal` is never invitable.
- **Fail-closed case:** a join naming each unavailable runtime is refused with a reason (`checkInviteAccepts`, `services/agent-invites.ts:221`) — already partly covered by `tests/join-requests.test.ts:193-194`; extend to all five.

### 4b. Invite create — extend `tests/agent-invites.test.ts`
- `[ADD-2]` non-owner (member) → **403**; anonymous → **401**.
- `[ADD-2]` defaults applied when the body is empty: `maxUses=1`, TTL 72h, `allowedAdapterTypes=null`.
- `[ADD-2]` out-of-range TTL/uses are **refused, not clamped** (400).
- `[ADD-2]` **hash-only:** the created row's `tokenHash ≠ token`, and no column holds the raw token.
- `[ADD-2]` the create response is the **only** place the raw token appears — list (`:167`) never returns token or hash.

### 4c. Join + claim — regression only (`tests/onb3-join-flow.test.ts`, `tests/onb4-claim.test.ts`)
- `[ADD-3]` **posture 404-gate intact:** with `MC_ENABLE_REMOTE_ONBOARDING` unset, join *and* claim return a flat 404 — the exact byte-identical shape as an unknown invite (no oracle).
- `[ADD-3]` approve → agent is `low_trust_review` with `apiTokenHash = NULL`.
- `[ADD-3]` the single-use CAS still holds (existing TOCTOU test must keep passing).

### 4d. Delete — **new suite `tests/agent-delete.test.ts`**, driven against a real in-memory DB
Modelled on `tests/gc0b-agent-authz.test.ts` (three real identities, per-test isolation).

| Case | Expected |
|---|---|
| `[ADD-4]` **non-owner** (member of the same org) deletes | **403**, agent still present — *fail-closed* |
| `[ADD-4]` **cross-tenant**: member of org B deletes org A's agent | **403/404**, agent still present, **zero rows touched in org A** |
| `[ADD-4]` anonymous | **401** |
| `[ADD-4]` **already-deleted** (idempotency) | **404** (not 500, not a silent 204) |
| `[ADD-4]` unknown agent id | **404**, indistinguishable from cross-tenant — no existence oracle |
| `[ADD-4]` **mass-assignment**: a body supplying `orgId`/`id`/`apiTokenHash` on the DELETE | ignored entirely; **no column is writable through this route** (asserted, not assumed) |
| `[ADD-4]` owner deletes | 200/204, agent soft-deleted and **absent from the roster read path** |
| `[ADD-4]` **credential revocation** (the security case) | after delete: `apiTokenHash` null · `agent_oauth_tokens` rows for that agent **gone** · `secrets WHERE scope='agent' AND scopeId=agentId` **gone** · `agent_connectors` disabled |
| `[ADD-4]` **the token actually stops working** | the agent's pre-delete bearer token → **401** on `GET /api/agent/tasks`. ⚠️ *This is the test that catches the soft-delete regression at `agent-token.ts:40`. It must be driven through the real resolver, not a mock.* |
| `[ADD-4]` **audit** | an `agent.delete` row exists **with the correct non-null `orgId`**, is visible via the org-filtered audit query, and names the deleted agent |
| `[ADD-4]` **snapshot** | a `config_revisions` pre-image row exists for the deleted agent |
| `[ADD-4]` **org-chart integrity** | an agent that `reportsTo` the deleted one does not orphan the chart render |

**Guard tests (they must bite):**
- `[ADD-5]` add the new route to the `auth-scoping.test.ts` / `membership-scoping.test.ts`
  leak-guard nets **by name** — the ONB3-H1 precedent. A route the sweep cannot see is a
  route the sweep cannot protect.
- `[ADD-5]` a **planted offender** (a delete handler without the owner preHandler) is
  detected — per the repo's "prove the guard bites" discipline, and per the
  *fixture-sized-to-the-mechanism* lesson: the fixture must be able to fail.

### 4e. Web + mobile
- `web/` — pure logic only (Node 22 `node --test`, no jest/vitest): `pickableAdapters` unchanged; a new `canDeleteAgent(role)` helper **fail-closed** (unknown/`'admin'` → false), mirroring `apps/mobile/src/agentEdit.ts:36`.
- `cd web && npm run build` must stay clean.
- **Mobile parity:** both features are **greenfield** on `apps/mobile` (no invite surface, no agent delete — verified). Per the standing rule, Phase 1 must state **mirrored / deferred-to-a-named-story / N/A-with-reason**. Recommended: **defer to a named MOB story** and log it in `docs/DESIGN-mobile-parity.md` — the phone is the operator's remote and destructive agent lifecycle belongs there, but it should follow the hardened backend rather than ship beside it. ⚠️ Also resolve in Phase 1 which RN tree is canonical: `apps/mobile/` (maintained) vs `app/` (legacy/frozen per root `CLAUDE.md`, but it *does* contain `app/app/agents/create.tsx` and `app/app/onboarding/index.tsx`).

---

## 5. Explicit non-goals for this wave

1. **Flipping any adapter to `available: true`.** All five stay false; criteria documented in §2c.
2. **Building ONB5** (SSRF-hardened reachability). It is a precondition *for* the gateway/webhook runtimes, and those are deferred.
3. **Building push/gateway dispatch** — outbound WS client, per-agent HTTP pusher, Hermes client, grok CLI, or an xAI provider in the LLM router.
4. **Weakening `MC_ENABLE_REMOTE_ONBOARDING`** or any posture gate, and **not** setting it on Fly. That stays an operator console action (`GO-LIVE.md`).
5. **Org-delete cascade** (`orgs.ts:207`) — the same orphaning bug at larger blast radius. **Flagged, not scheduled.**
6. **Refactoring the legacy `PATCH /api/agents/:agentId`** or the hardcoded `ADAPTERS` const in `ConfigurationTab.tsx:17-23`. Both are pre-existing drift; noted, out of scope.
7. **A bulk / multi-agent delete**, and **any un-delete/restore UI** (soft delete makes recovery *possible*; a restore flow is a separate story).
8. **Changing invite defaults** (single-use, 72h) or adding invite-template presets.
9. **Touching `.github/workflows/`**, the live adapter (`~/.openclaw/mc-adapter/`), or any vendor console setting.

---

## 6. Recommended phase order

| Phase | Content | Gate |
|---|---|---|
| **1 — backend** | New owner-gated `DELETE /api/orgs/:orgId/agents/:agentId` + soft-delete column (idempotent ALTER **and** the CREATE string) + explicit credential revocation + `agent-token.ts` deleted-state filter + audit/snapshot + the `agent-delete` suite & leak-guard entries | `npm test` zero failures · 11/11 evals · typecheck clean |
| **2 — web "+ Agent"** | Mount the existing `InviteAgentDialog` on the **Org** section view and the **Agents** roster; keep the closed-join banner honest. No backend change. | `npm run build` clean · web tests pass |
| **3 — web Delete** | Delete control in `ConfigurationTab`, owner-gated client-side via a new fail-closed role source, typed-name confirmation, wired to the Phase-1 route | build clean · logic tests pass |
| **4 — mobile** | Named MOB story per the parity rule (or an explicit N/A with reason) | `npm test && npm run typecheck && npm run export` |

**Every phase ships via a PR with green CI.** Branch protection is ON for `main`
(`enforce_admins: true`, required status checks) as of `ed180bd` — `--admin` no longer
bypasses red, and direct pushes to `main` are rejected.
