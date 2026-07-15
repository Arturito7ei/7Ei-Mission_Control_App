// ─── Multi-tenant membership hardening (the R-4 fix) ─────────────────────────
//
// The whole `/api/orgs/:orgId/*` surface was Clerk-AUTHENTICATED but not
// membership-CHECKED: only ~35 of ~159 org-scoped routes ran `requireOrgRole`, so
// any logged-in user could act on ANY org's resources by swapping `:orgId`. This is
// the cross-tenant gap the ONB2/ONB3 audits kept surfacing (R-4: `requireOrgRole`
// silently no-ops on paths without an `:orgId`, and most routes had no gate at all).
//
// The fix is ONE scope-level `preHandler` (`requireOrgMembership`) on the whole
// Clerk-secured scope. This suite is its regression net, and it is BEHAVIOURAL, not
// a route-table tag — a route table cannot see whether membership is enforced:
//
//  1. The surface-wide sweep: enumerate EVERY `/api/orgs/:orgId/*` route the secured
//     scope registers and drive a NON-MEMBER request at each — all must 403. Because
//     the gate rides the scope, a NEW org route is covered the moment it registers,
//     and this sweep proves it can't be forgotten.
//  2. The member/owner positives: the operator is a member of their own org, so their
//     everyday flows still return non-403; owner-only routes still 403 a plain member.
//  3. The record-derived tail: `/api/agents/:agentId`, `/api/tasks/:taskId` carry no
//     `:orgId`; the gate derives the org FROM THE ROW. Non-member → 403, member → 200,
//     missing row → 403 (fail closed). (The generic `POST /api/approvals/:id/decide`
//     is the other record-derived door — it self-enforces via `enforceOrgRole` and is
//     driven in `onb3-approval-gate.test.ts`.)
//  4. The exempt boundary: the agent-token API authenticates by agent token, NOT Clerk
//     membership — a valid-token agent request is unaffected. The public join surface
//     (invite token is the bearer) is unaffected.
//
// Real routes, real gate, real in-memory DB, three real identities.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'membership-scoping-key'
process.env.MC_DEPLOYMENT_PROFILE = 'packaged'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

let db: any, schema: any
let securedApp: FastifyInstance
let agentApp: FastifyInstance
let collectedRoutes: () => Array<{ auth: string; method: string; url: string }>
let hashToken: (t: string) => string

const ORG = 'org-1'
const OWNER = 'user-owner'       // org_members role = owner
const MEMBER = 'user-member'     // org_members role = member
const OUTSIDER = 'user-outsider' // authenticates fine, NO org_members row for ORG
const LEGACY_ORG = 'org-legacy'  // an org created BEFORE membership rows existed
const LEGACY_OWNER = 'user-legacy-owner' // owns LEGACY_ORG but has NO org_members row
const AGENT_ID = 'agent-1'
const TASK_ID = 'task-1'
const AGENT_TOKEN = 'mca_membership_scoping_test_token'

// Routes that carry an `:orgId` but are PUBLIC by design (registered outside the
// secured scope, self-authed) — they never get the membership gate, so they must not
// appear in the secured boot below. Listed here only to document the boundary.
// POST /api/orgs/:orgId/arturita/panic  — session-token authed in-handler
// GET  /api/orgs/:orgId/auth/google[/status] — Google OAuth handshake

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  const { resetOpenApi, recordRoute } = await import('../services/openapi')
  ;({ collectedRoutes } = await import('../services/openapi'))
  ;({ hashToken } = await import('../middleware/agent-token'))
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')

  // ── Seed: one org, an owner + a member; an agent + a task that belong to it. ──
  await db.insert(schema.organisations).values({ id: ORG, name: '7Ei', ownerId: OWNER, createdAt: new Date() })
  await db.insert(schema.orgMembers).values([
    { id: 'm-owner', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date() },
    { id: 'm-member', orgId: ORG, userId: MEMBER, role: 'member', createdAt: new Date() },
  ])
  // A legacy org: owned by LEGACY_OWNER, but with NO org_members row (predates the
  // membership-insert). It must NOT lock its owner out — enforceOrgRole grandfathers
  // `organisations.ownerId` as an implicit owner.
  await db.insert(schema.organisations).values({ id: LEGACY_ORG, name: 'Legacy', ownerId: LEGACY_OWNER, createdAt: new Date() })
  await db.insert(schema.agents).values({
    id: AGENT_ID, orgId: ORG, name: 'Codey', role: 'Engineer',
    llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514',
    skills: [], status: 'idle', agentType: 'standard', createdAt: new Date(),
    apiTokenHash: hashToken(AGENT_TOKEN),
  } as any)
  await db.insert(schema.tasks).values({
    id: TASK_ID, orgId: ORG, agentId: AGENT_ID, title: 'Ship it', status: 'pending', createdAt: new Date(),
  } as any)

  // ── The Clerk-secured scope, wired EXACTLY like src/index.ts: clerk hook, the
  //    onRoute tagger (so we can enumerate the surface), then the membership gate,
  //    then the full org-scoped plugin set. The verifier treats the bearer token AS
  //    the user id, so we act as owner/member/outsider without reaching Clerk's JWKS.
  resetOpenApi()
  const all = await import('../routes/all')
  const { knowledgeRoutes } = await import('../routes/knowledge')
  const { commsRoutes } = await import('../routes/comms')
  const { connectorRoutes } = await import('../routes/connectors')
  const { notificationRoutes } = await import('../routes/notifications')
  const { jiraRoutes } = await import('../routes/jira')
  const { jiraEventRoutes } = await import('../routes/jira-webhook')
  const { memoryRoutes } = await import('../routes/memory')
  const { multiOrgRoutes } = await import('../routes/multi-org')
  const { usageRoutes } = await import('../middleware/ratelimit')
  const { scheduledRoutes } = await import('../routes/scheduled')
  const { agentDetailRoutes } = await import('../routes/agent-detail')
  const { arturitaRoutes } = await import('../routes/arturita')
  const { arturitaWalletRoutes } = await import('../routes/arturita-wallet')
  const { arturitaVoiceRoutes } = await import('../routes/arturita-voice')
  const { arturitaConverseRoutes } = await import('../routes/arturita-converse')
  const { arturitaPipelineRoutes } = await import('../routes/arturita-pipeline')
  const { arturitaCustomModelRoutes } = await import('../routes/arturita-custom-model')
  const { customModelRoutes } = await import('../routes/custom-models')
  const { agentInviteRoutes } = await import('../routes/agent-invites')
  const { auditLogQueryRoutes } = await import('../middleware/audit-log')
  const { telemetryQueryRoutes } = await import('../services/telemetry')

  securedApp = Fastify({ logger: false })
  registerJsonBodyParser(securedApp) // bodiless JSON must reach the preHandler, not 400
  await securedApp.register(websocket)
  await securedApp.register(multipart)
  await securedApp.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('onRoute', (r) => recordRoute('clerk', r.method as string, r.url))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(all.orgRoutes)
    await secured.register(all.agentRoutes)
    await secured.register(agentDetailRoutes)
    await secured.register(all.taskRoutes)
    await secured.register(all.projectRoutes)
    await secured.register(all.costRoutes)
    await secured.register(knowledgeRoutes)
    await secured.register(multiOrgRoutes)
    await secured.register(scheduledRoutes)
    await secured.register(all.credentialRoutes)
    await secured.register(connectorRoutes)
    await secured.register(jiraRoutes)
    await secured.register(jiraEventRoutes)
    await secured.register(commsRoutes)
    await secured.register(notificationRoutes)
    await secured.register(memoryRoutes)
    await secured.register(usageRoutes)
    await secured.register(all.skillRoutes)
    await secured.register(arturitaRoutes)
    await secured.register(arturitaWalletRoutes)
    await secured.register(arturitaVoiceRoutes)
    await secured.register(arturitaConverseRoutes)
    await secured.register(arturitaPipelineRoutes)
    await secured.register(arturitaCustomModelRoutes)
    await secured.register(customModelRoutes)
    await secured.register(agentInviteRoutes)
    await secured.register(auditLogQueryRoutes)
    await secured.register(telemetryQueryRoutes)
  })
  await securedApp.ready()

  // ── The agent-token API scope: NO membership gate (agents authenticate by token).
  const { agentApiRoutes } = await import('../routes/agent-api')
  agentApp = Fastify({ logger: false })
  registerJsonBodyParser(agentApp)
  await agentApp.register(agentApiRoutes)
  await agentApp.ready()
})

// ── helpers ───────────────────────────────────────────────────────────────────

/** Fill a route template: `:orgId` → ORG, every other `:param` → a dummy. */
function fillUrl(url: string): string {
  return url.replace(/:orgId/g, ORG).replace(/:[A-Za-z0-9_]+/g, 'x')
}

const asUser = (method: string, url: string, user: string | null) =>
  securedApp.inject({
    method: method as any,
    url,
    headers: {
      ...(user ? { authorization: `Bearer ${user}` } : {}),
      'content-type': 'application/json',
    },
    // A bodiless-but-typed JSON payload for mutating verbs — the gate is a preHandler,
    // so it runs before any handler-level Zod validation; an outsider 403s regardless.
    payload: method === 'GET' || method === 'HEAD' ? undefined : {},
  })

// ── 1. the surface-wide sweep: every /api/orgs/:orgId/* route 403s a non-member ──

test('[MCA-R4] every secured /api/orgs/:orgId/* route refuses an authenticated NON-MEMBER (403)', async () => {
  const orgRoutes = collectedRoutes()
    .filter(r => /^\/api\/orgs\/:orgId(\/|$)/.test(r.url))
    // WebSocket upgrade routes can't be exercised with inject() as a plain request.
    .filter(r => r.url !== '/api/orgs/:orgId/agents/:agentId/stream')

  assert.ok(orgRoutes.length > 80, `expected the full org surface, got ${orgRoutes.length}`)

  const leaks: string[] = []
  for (const r of orgRoutes) {
    const res = await asUser(r.method, fillUrl(r.url), OUTSIDER)
    if (res.statusCode !== 403) leaks.push(`${r.method} ${r.url} → ${res.statusCode}`)
  }
  assert.deepEqual(
    leaks, [],
    'these org-scoped routes did NOT 403 a non-member — the membership gate does not cover them:\n' + leaks.join('\n'),
  )
})

test('[MCA-R4] an UNAUTHENTICATED request to an org route is 401 (Clerk), never reaching the gate/handler', async () => {
  const res = await asUser('GET', `/api/orgs/${ORG}/agents`, null)
  assert.equal(res.statusCode, 401)
})

// ── 2. the operator is not broken: a member/owner is allowed on the routes they use ──

test('[MCA-R4] a MEMBER of the org is allowed (non-403) on the everyday routes they use today', async () => {
  // A representative slice of member-level GETs across several route files. The point
  // is the gate does NOT 401/403 a legitimate member; the handler may 200 or 404, but
  // never an auth rejection.
  for (const [method, url] of [
    ['GET', `/api/orgs/${ORG}`],
    ['GET', `/api/orgs/${ORG}/agents`],
    ['GET', `/api/orgs/${ORG}/tasks`],
    ['GET', `/api/orgs/${ORG}/projects`],
    ['GET', `/api/orgs/${ORG}/departments`],
    ['GET', `/api/orgs/${ORG}/costs`],
  ] as const) {
    const res = await asUser(method, url, MEMBER)
    assert.notEqual(res.statusCode, 401, `${method} ${url} must not 401 a member`)
    assert.notEqual(res.statusCode, 403, `${method} ${url} must not 403 a member — got ${res.statusCode} ${res.body?.slice(0, 120)}`)
  }
})

test('[MCA-R4] existing OWNER-only gates still hold: a plain MEMBER is 403, the OWNER is allowed', async () => {
  // `DELETE /api/orgs/:orgId` is owner-gated by a route-level requireOrgRole('owner').
  // The scope membership gate passes the member (they ARE a member); the owner gate
  // then refuses them — the layered enforcement the fix preserves.
  const memberDel = await asUser('DELETE', `/api/orgs/${ORG}`, MEMBER)
  assert.equal(memberDel.statusCode, 403, 'a member must not delete the org (owner-only)')

  // The owner passes both gates. (Use a non-destructive owner route to avoid nuking
  // the seed org mid-suite: the agent-invite list is owner-gated and side-effect free.)
  const ownerList = await asUser('GET', `/api/orgs/${ORG}/agent-invites`, OWNER)
  assert.notEqual(ownerList.statusCode, 401)
  assert.notEqual(ownerList.statusCode, 403)

  const memberList = await asUser('GET', `/api/orgs/${ORG}/agent-invites`, MEMBER)
  assert.equal(memberList.statusCode, 403, 'invite list is owner-only — a member is refused')
})

test('[MCA-R4] GRANDFATHER: a legacy org OWNER with no org_members row is not locked out; an outsider still 403s', async () => {
  // The exact don't-break-the-operator case: an org whose owner never got a members
  // row. The owner must still reach their org; a non-owner non-member must not.
  const owner = await asUser('GET', `/api/orgs/${LEGACY_ORG}`, LEGACY_OWNER)
  assert.notEqual(owner.statusCode, 401, 'legacy owner must authenticate')
  assert.notEqual(owner.statusCode, 403, 'legacy owner (organisations.ownerId) must NOT be locked out of their own org')

  // Owner-only routes work for the grandfathered owner too (implicit owner role).
  const ownerOnly = await asUser('GET', `/api/orgs/${LEGACY_ORG}/agent-invites`, LEGACY_OWNER)
  assert.notEqual(ownerOnly.statusCode, 403, 'grandfathered owner is a full owner, not just a member')

  assert.equal((await asUser('GET', `/api/orgs/${LEGACY_ORG}`, OUTSIDER)).statusCode, 403, 'a non-owner non-member is still refused')
})

// ── 3. the record-derived tail: org comes from the row, not the path ─────────────

test('[MCA-R4] record-derived /api/agents/:agentId — non-member 403, member 200, missing row 403 (fail closed)', async () => {
  assert.equal((await asUser('GET', `/api/agents/${AGENT_ID}`, OUTSIDER)).statusCode, 403, 'non-member refused')

  const member = await asUser('GET', `/api/agents/${AGENT_ID}`, MEMBER)
  assert.equal(member.statusCode, 200, 'a member reads their org’s agent')

  // Unknown agent id → the gate derives a null org → 403, never a skip (fail closed).
  assert.equal((await asUser('GET', `/api/agents/does-not-exist`, MEMBER)).statusCode, 403, 'missing record fails closed')
})

test('[MCA-R4] record-derived /api/tasks/:taskId — non-member 403, member 200', async () => {
  assert.equal((await asUser('GET', `/api/tasks/${TASK_ID}`, OUTSIDER)).statusCode, 403, 'non-member refused')
  assert.equal((await asUser('GET', `/api/tasks/${TASK_ID}`, MEMBER)).statusCode, 200, 'a member reads their org’s task')
})

test('[MCA-R4] /api/users/:userId/orgs is self-only — a caller cannot read another user’s memberships', async () => {
  assert.equal((await asUser('GET', `/api/users/${MEMBER}/orgs`, OUTSIDER)).statusCode, 403, 'cannot read another user’s orgs')
  assert.equal((await asUser('GET', `/api/users/${MEMBER}/orgs`, MEMBER)).statusCode, 200, 'a caller reads their OWN org list')
})

// ── 4. the exempt boundary: agent-token API + public join are unaffected ─────────

test('[MCA-R4] the agent-token API is NOT membership-gated: a valid-token agent request succeeds', async () => {
  const ok = await agentApp.inject({
    method: 'GET', url: '/api/agent/me',
    headers: { authorization: `Bearer ${AGENT_TOKEN}` },
  })
  assert.equal(ok.statusCode, 200, 'the agent authenticates by token, not org membership')
  assert.equal(ok.json().agent.id, AGENT_ID)

  // And it is still a real gate for its own scheme: a bad agent token is 401.
  const bad = await agentApp.inject({
    method: 'GET', url: '/api/agent/me',
    headers: { authorization: 'Bearer mca_not_a_real_token' },
  })
  assert.equal(bad.statusCode, 401)
})
