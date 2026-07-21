// ─── AAD-1 — the owner-gated, org-scoped agent SOFT DELETE ───────────────────
//
// DELETE /api/orgs/:orgId/agents/:agentId (routes/agent-detail.ts). Behavioural:
// real routes, real membership + owner gate, real in-memory DB, real agent-token
// resolver. Modelled on gc0b-agent-authz.test.ts (three identities, per-test reset).
//
// EVERY guard here is mutation-proven — the file plants the guard-removed shape and
// shows it lets the exploit through, so a green assertion cannot pass for the wrong
// reason:
//   • the OWNER GATE — a planted copy of the handler WITHOUT requireOrgRole('owner')
//     lets a plain member delete; the real route refuses them (403).
//   • the TOKEN DELETED-STATE FILTER — a resolver that omits `isNull(deletedAt)` still
//     finds the soft-deleted row by hash; the production resolver filters it out (401).

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'aad-agent-delete-key'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

let db: any, schema: any
let app: FastifyInstance          // clerk-secured surface (delete + roster + orgchart + audit)
let agentApp: FastifyInstance     // agent-token surface (the real resolver)
let hashToken: (t: string) => string
let requireOrgRole: any
let agentInOrg: any
let revokeAgentCredentials: any
let eq: any, and: any, isNull: any

const ORG_A = 'aad-org-a'
const ORG_B = 'aad-org-b'
const OWNER_A = 'aad-owner-a'
const MEMBER_A = 'aad-member-a'   // plain member of ORG_A — the exploit identity
const OWNER_B = 'aad-owner-b'
const MEMBER_B = 'aad-member-b'
const AGENT_A = 'aad-agent-a'     // lives in ORG_A — the delete target
const MANAGER_A = 'aad-manager-a' // AGENT_A reportsTo this one (org-chart integrity)
const AGENT_B = 'aad-agent-b'     // lives in ORG_B — isolation control
const AGENT_TOKEN = 'mca_aad_agent_a_token_value_0123456789abcdef'

const CREATED_AT = new Date('2020-01-01T00:00:00Z')

const agentRow = (id: string, orgId: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, orgId, name, role: 'Engineer', personality: 'terse', llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-20250514', status: 'idle', agentType: 'standard',
  runtime: 'internal', trustMode: 'standard', permissions: null, apiTokenHash: null,
  deletedAt: null, deletedBy: null, createdAt: CREATED_AT, ...extra,
})

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ hashToken } = await import('../middleware/agent-token'))
  const { agentAuth } = await import('../middleware/agent-token')
  ;({ requireOrgRole } = await import('../middleware/rbac'))
  const { requireOrgMembership } = await import('../middleware/rbac')
  ;({ agentInOrg } = await import('../routes/agent-detail'))
  const { agentDetailRoutes } = await import('../routes/agent-detail')
  ;({ revokeAgentCredentials } = await import('../services/agent-deletion'))
  const { agentRoutes } = await import('../routes/agents')
  const { auditLogQueryRoutes } = await import('../middleware/audit-log')
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  ;({ eq, and, isNull } = await import('drizzle-orm'))

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: OWNER_A, createdAt: new Date() },
    { id: ORG_B, name: 'Org B', ownerId: OWNER_B, createdAt: new Date() },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'aad-o-a', orgId: ORG_A, userId: OWNER_A, role: 'owner', createdAt: new Date() },
    { id: 'aad-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
    { id: 'aad-o-b', orgId: ORG_B, userId: OWNER_B, role: 'owner', createdAt: new Date() },
    { id: 'aad-m-b', orgId: ORG_B, userId: MEMBER_B, role: 'member', createdAt: new Date() },
  ])

  // ── The clerk-secured surface (mirrors index.ts: membership gate on the scope). ──
  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(agentRoutes)
    await secured.register(agentDetailRoutes)
    await secured.register(auditLogQueryRoutes)

    // PLANTED OFFENDER (mutation proof for the owner gate): the SAME soft-delete, but
    // WITHOUT requireOrgRole('owner'). If the owner gate is what stops a member, a
    // member must succeed HERE and be refused on the real route. Kept in-test so the
    // "member is refused" assertion cannot pass merely because delete is broken.
    secured.delete('/planted/orgs/:orgId/agents/:agentId', async (req: any, reply: any) => {
      const { orgId, agentId } = req.params
      const agent = await agentInOrg(orgId, agentId)
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      await db.update(schema.agents)
        .set({ deletedAt: new Date(), deletedBy: 'planted', status: 'deleted' })
        .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)))
      return reply.code(204).send()
    })
  })
  await app.ready()

  // ── The agent-token surface: the REAL production resolver against the real DB. ──
  agentApp = Fastify({ logger: false })
  agentApp.addHook('onRequest', agentAuth)
  agentApp.get('/api/agent/whoami', async (req: any) => ({ agentId: req.agent?.id ?? null }))
  await agentApp.ready()
})

const as = (user: string | null, method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as any, url,
    headers: {
      ...(user ? { authorization: `Bearer ${user}` } : {}),
      'content-type': 'application/json',
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  })

const whoami = (token: string) =>
  agentApp.inject({ method: 'GET', url: '/api/agent/whoami', headers: { authorization: `Bearer ${token}` } })

const row = async (id: string) =>
  (await db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0]

// ── PER-TEST RESET — the load-bearing isolation tripwire (see gc0b-agent-authz). ──
// Without it the first successful delete soft-deletes AGENT_A and every later probe
// 404s, passing for the wrong reason and hiding exactly what this file exists to prove.
beforeEach(async () => {
  await db.delete(schema.agents)
  await db.delete(schema.agentOauthTokens)
  await db.delete(schema.agentOauthStates)
  await db.delete(schema.secrets)
  await db.delete(schema.agentConnectors)
  await db.delete(schema.auditLogs)
  await db.delete(schema.configRevisions)

  await db.insert(schema.agents).values([
    agentRow(MANAGER_A, ORG_A, 'Manager A'),
    agentRow(AGENT_A, ORG_A, 'Agent A', { apiTokenHash: hashToken(AGENT_TOKEN), reportsTo: MANAGER_A }),
    agentRow(AGENT_B, ORG_B, 'Agent B', { apiTokenHash: hashToken('mca_org_b_other_token_value_00000000') }),
  ] as any)

  // AGENT_A holds live credentials: a Google OAuth token, an agent-scoped secret, a
  // connector. The OAuth token's enc value is deliberately UNDECRYPTABLE so the delete
  // path's best-effort upstream revoke short-circuits (loadAgentGoogleToken → null) and
  // NO real network call to Google is made — the local row-purge is what we assert.
  const now = new Date()
  await db.insert(schema.agentOauthTokens).values({
    id: 'aad-tok-a', orgId: ORG_A, agentId: AGENT_A, provider: 'google',
    accessTokenEnc: 'undecryptable-garbage', refreshTokenEnc: 'undecryptable-garbage',
    expiresAt: new Date(now.getTime() + 3600_000), scopes: 'openid', accountEmail: 'a@x.com',
    createdAt: now, updatedAt: now,
  })
  await db.insert(schema.secrets).values([
    { id: 'aad-sec-a', orgId: ORG_A, scope: 'agent', scopeId: AGENT_A, key: 'API_KEY', valueEncrypted: 'enc', createdAt: now },
    { id: 'aad-sec-company', orgId: ORG_A, scope: 'company', scopeId: null, key: 'COMPANY', valueEncrypted: 'enc', createdAt: now },
    { id: 'aad-sec-b', orgId: ORG_A, scope: 'agent', scopeId: MANAGER_A, key: 'OTHER', valueEncrypted: 'enc', createdAt: now },
  ] as any)
  await db.insert(schema.agentConnectors).values({
    id: 'aad-conn-a', orgId: ORG_A, agentId: AGENT_A, connectorId: 'mcp', status: 'configured',
    secretRef: 'aad-sec-a', createdAt: now, updatedAt: now,
  } as any)
})

// ══ PROOF THE ISOLATION IS REAL ═══════════════════════════════════════════════

test('[AAD-1] per-test isolation — step 1 legitimately deletes the agent', async () => {
  const res = await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 204)
  assert.ok((await row(AGENT_A)).deletedAt, 'the delete did not take effect')
})

test('[AAD-1] per-test isolation is real — step 2 sees a PRISTINE agent', async () => {
  const a = await row(AGENT_A)
  assert.equal(a.deletedAt, null, 'PER-TEST RESET IS NOT RUNNING: this suite would pass for the wrong reason')
  assert.equal(a.apiTokenHash, hashToken(AGENT_TOKEN), 'credential state leaked across tests')
})

// ══ AUTHZ — the owner gate and cross-tenant fail-closed ═══════════════════════

test('[AAD-1] a plain MEMBER cannot delete an agent (owner-gated) → 403, agent intact', async () => {
  const res = await as(MEMBER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 403)
  assert.equal((await row(AGENT_A)).deletedAt, null, 'a member soft-deleted an agent — the owner gate is not enforcing')
})

test('[AAD-1] MUTATION PROOF: without the owner gate, that same member DELETE succeeds', async () => {
  // The planted route is the handler MINUS requireOrgRole('owner'). A member deleting
  // here proves the gate above is the ONLY thing stopping them — so the 403 test is
  // load-bearing, not a coincidence of some other refusal.
  const res = await as(MEMBER_A, 'DELETE', `/planted/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 204, 'the guard-removed shape should let a member delete — else this proves nothing')
  assert.ok((await row(AGENT_A)).deletedAt, 'the planted handler did not delete')
})

test('[AAD-1] cross-tenant: a member of org B cannot delete org A\'s agent → 403, zero rows touched in A', async () => {
  const res = await as(MEMBER_B, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.ok(res.statusCode === 403 || res.statusCode === 404, `expected 403/404, got ${res.statusCode}`)
  assert.equal((await row(AGENT_A)).deletedAt, null, 'CROSS-TENANT DELETE: org A agent was soft-deleted by an outsider')
  assert.equal((await row(AGENT_A)).apiTokenHash, hashToken(AGENT_TOKEN), 'org A agent credential was touched')
})

test('[AAD-1] cross-tenant via the OWNER of org B → 403, agent intact', async () => {
  // Even an owner — but of the WRONG org — is refused (the membership gate fires first).
  const res = await as(OWNER_B, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 403)
  assert.equal((await row(AGENT_A)).deletedAt, null)
})

test('[AAD-1] anonymous → 401', async () => {
  const res = await as(null, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 401)
  assert.equal((await row(AGENT_A)).deletedAt, null)
})

test('[AAD-1] unknown agent id → 404 (no existence oracle — same shape as cross-tenant)', async () => {
  const res = await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/does-not-exist`)
  assert.equal(res.statusCode, 404)
})

test('[AAD-1] already-deleted → 404 (idempotent; not 500, not a silent 204)', async () => {
  assert.equal((await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)).statusCode, 204)
  const second = await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.equal(second.statusCode, 404, 'a second delete must be a clean 404')
})

test('[AAD-1] mass-assignment: a body supplying orgId/id/deletedBy is ignored (no writable column)', async () => {
  const res = await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`, {
    orgId: ORG_B, id: 'hijacked', deletedBy: 'attacker', apiTokenHash: 'a'.repeat(64),
  })
  assert.equal(res.statusCode, 204)
  const a = await row(AGENT_A)
  assert.equal(a.orgId, ORG_A, 'the DELETE body rewrote the tenant column')
  assert.equal(a.id, AGENT_A, 'the DELETE body rewrote the primary key')
  assert.equal(a.deletedBy, OWNER_A, 'deletedBy came from the body, not the authenticated caller')
  assert.equal(a.apiTokenHash, null, 'the token hash must be nulled by the server, not set from the body')
})

// ══ THE LEGACY HARD-DELETE IS RETIRED ═════════════════════════════════════════

test('[AAD-1] the legacy member-reachable HARD delete is retired — 410, agent NOT destroyed', async () => {
  // A member hitting the old path must NOT hard-delete (it orphaned credentials + wrote a
  // NULL-orgId audit row). It is refused with 410 and the row is untouched.
  const res = await as(MEMBER_A, 'DELETE', `/api/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 410, 'the legacy hard-delete is still live — the credential-orphaning hole is open')
  const a = await row(AGENT_A)
  assert.ok(a, 'the legacy path hard-deleted the row')
  assert.equal(a.deletedAt, null, 'the legacy path deleted the agent')
  assert.equal(a.apiTokenHash, hashToken(AGENT_TOKEN), 'the legacy path touched the credential')
})

test('[AAD-1] the legacy path still 403s a NON-MEMBER (gate fires before the 410)', async () => {
  const res = await as(MEMBER_B, 'DELETE', `/api/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 403, 'the membership gate must still refuse an outsider on the legacy path')
})

// ══ THE HAPPY PATH — soft delete + roster exclusion ═══════════════════════════

test('[AAD-1] owner deletes → 204, agent soft-deleted and ABSENT from the roster read path', async () => {
  const res = await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  assert.equal(res.statusCode, 204)

  const a = await row(AGENT_A)
  assert.ok(a, 'the row must be RETAINED (soft delete), not hard-deleted')
  assert.ok(a.deletedAt, 'deletedAt not set')
  assert.equal(a.deletedBy, OWNER_A, 'deletedBy must be the acting owner')
  assert.equal(a.status, 'deleted')

  const roster = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/agents`)
  const ids = JSON.parse(roster.body).agents.map((x: any) => x.id)
  assert.ok(!ids.includes(AGENT_A), 'a soft-deleted agent still renders in the roster')
  assert.ok(ids.includes(MANAGER_A), 'the roster dropped a live agent too')
})

// ══ CREDENTIAL REVOCATION — the security case ═════════════════════════════════

test('[AAD-1] delete revokes ALL of: token hash · oauth tokens · agent secrets · connectors', async () => {
  await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)

  assert.equal((await row(AGENT_A)).apiTokenHash, null, 'apiTokenHash survived the delete')

  const oauth = await db.select().from(schema.agentOauthTokens).where(eq(schema.agentOauthTokens.agentId, AGENT_A))
  assert.equal(oauth.length, 0, 'agent_oauth_tokens (Google refresh token) survived — the security finding')

  const agentSecrets = await db.select().from(schema.secrets)
    .where(and(eq(schema.secrets.scope, 'agent'), eq(schema.secrets.scopeId, AGENT_A)))
  assert.equal(agentSecrets.length, 0, 'agent-scoped secrets survived the delete')

  const conn = (await db.select().from(schema.agentConnectors).where(eq(schema.agentConnectors.agentId, AGENT_A)))[0]
  assert.equal(conn.status, 'disabled', 'agent_connectors was not disabled')
})

test('[AAD-1] revocation is SCOPED — company secrets and OTHER agents\' credentials are untouched', async () => {
  await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  const company = await db.select().from(schema.secrets).where(eq(schema.secrets.id, 'aad-sec-company'))
  assert.equal(company.length, 1, 'a company-scoped secret was swept by the agent delete')
  const otherAgentSecret = await db.select().from(schema.secrets).where(eq(schema.secrets.id, 'aad-sec-b'))
  assert.equal(otherAgentSecret.length, 1, 'another agent\'s scoped secret was swept (scopeId precision failed)')
  assert.equal((await row(MANAGER_A)).apiTokenHash, (await row(MANAGER_A)).apiTokenHash, 'sanity')
  // AGENT_B (org B) is entirely untouched.
  assert.equal((await row(AGENT_B)).deletedAt, null, 'a cross-org agent was affected')
})

// ══ THE TOKEN ACTUALLY STOPS WORKING — driven through the REAL resolver ═══════

test('[AAD-1] the agent\'s bearer token works BEFORE delete and 401s AFTER (real resolver)', async () => {
  const before = await whoami(AGENT_TOKEN)
  assert.equal(before.statusCode, 200, 'precondition: the token must resolve before delete')
  assert.equal(JSON.parse(before.body).agentId, AGENT_A)

  await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)

  const after = await whoami(AGENT_TOKEN)
  assert.equal(after.statusCode, 401, 'THE SOFT-DELETE REGRESSION: the token still resolves after delete')
})

test('[AAD-1] MUTATION PROOF: the REAL resolver filters the deleted state even if the hash lingers', async () => {
  // Soft-delete the agent but LEAVE its apiTokenHash in place, so the ONLY thing that can
  // 401 the token through the PRODUCTION resolver (agentAuth) is `isNull(deletedAt)`. The
  // delete route also nulls the hash; this isolates the defence-in-depth filter at
  // agent-token.ts:40. Remove that filter and this test returns 200 — the regression the
  // plan warns about (a soft-deleted agent's token keeps working).
  const hash = hashToken(AGENT_TOKEN)
  await db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, AGENT_A))

  // Precondition: the row is still findable by hash ALONE — so only the deleted-state
  // filter can exclude it (else this test would prove nothing).
  const foundByHashAlone = await db.query.agents.findFirst({ where: eq(schema.agents.apiTokenHash, hash) })
  assert.ok(foundByHashAlone, 'precondition failed: the hash was already gone')

  const res = await whoami(AGENT_TOKEN)
  assert.equal(res.statusCode, 401, 'the REAL resolver still resolved a soft-deleted agent — the deleted-state filter is missing')
})

// ══ THE EXECUTOR BACKSTOP — a deleted agent never executes ════════════════════

test('[AAD-1] executeAgentTask REFUSES a soft-deleted agent (the authoritative execution backstop)', async () => {
  // The read-path filters keep a deleted agent out of enumerations, but the AUTHORITATIVE
  // "never runs" guarantee is at the executor choke point (agent-executor.ts). Removing it
  // fails no other test — this is the one that bites. The agent is EXTERNAL runtime so
  // that IF the backstop were removed, execution would reach the network-free external
  // dispatch branch (not an LLM call), keeping the mutation-proof run deterministic +
  // offline; with the backstop present it throws before any of that.
  const { executeAgentTask } = await import('../services/agent-executor')
  await db.insert(schema.agents).values(
    agentRow('aad-exec-del', ORG_A, 'Deleted Exec', {
      runtime: 'openclaw', status: 'deleted', deletedAt: new Date(), deletedBy: OWNER_A,
    }) as any,
  )
  await assert.rejects(
    () => executeAgentTask({ agentId: 'aad-exec-del', taskId: 'aad-exec-task', input: 'do work' }),
    /deleted/i,
    'a soft-deleted agent was allowed to execute — the executor backstop at agent-executor.ts is missing',
  )
})

// ══ AUDIT + SNAPSHOT ══════════════════════════════════════════════════════════

test('[AAD-1] audit: an agent.delete row lands with the correct non-null orgId, visible in the org feed, naming the agent', async () => {
  await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)

  // Direct: the row exists with the correct orgId (the NULL-orgId hole is closed).
  const rows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'agent.delete'))
  assert.equal(rows.length, 1, 'expected exactly one explicit agent.delete audit row')
  assert.equal(rows[0].orgId, ORG_A, 'audit row orgId is NULL/wrong — invisible in the org-scoped feed')
  assert.equal((rows[0].metadata as any).agentId, AGENT_A, 'the audit row does not name the deleted agent')

  // End-to-end: the owner-scoped audit query actually returns it.
  const feed = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/audit-log?action=agent.delete`)
  assert.equal(feed.statusCode, 200)
  assert.equal(JSON.parse(feed.body).logs.length, 1, 'the deletion is not visible via the org-filtered audit query')
})

test('[AAD-1] snapshot: a config_revisions pre-image row exists for the deleted agent', async () => {
  await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${AGENT_A}`)
  const revs = await db.select().from(schema.configRevisions)
    .where(and(eq(schema.configRevisions.entity, 'agent'), eq(schema.configRevisions.entityId, AGENT_A)))
  assert.ok(revs.length >= 1, 'no config_revisions pre-image snapshot was written for the delete')
})

// ══ ORG-CHART INTEGRITY ═══════════════════════════════════════════════════════

test('[AAD-1] deleting a manager does not orphan the chart — the report still renders, manager is gone', async () => {
  // AGENT_A reportsTo MANAGER_A. Delete MANAGER_A: the chart must still render AGENT_A,
  // and must not include the deleted manager.
  const del = await as(OWNER_A, 'DELETE', `/api/orgs/${ORG_A}/agents/${MANAGER_A}`)
  assert.equal(del.statusCode, 204)

  const chart = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/orgchart`)
  assert.equal(chart.statusCode, 200)
  const ids = JSON.parse(chart.body).agents.map((x: any) => x.id)
  assert.ok(!ids.includes(MANAGER_A), 'the deleted manager still renders in the org chart')
  assert.ok(ids.includes(AGENT_A), 'the report was dropped from the chart when its manager was deleted')
})
