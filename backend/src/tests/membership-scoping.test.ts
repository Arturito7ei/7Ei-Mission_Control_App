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
let resolveRequestOrg: (params: any, database?: any, routeUrl?: string) => Promise<{ scoped: false } | { scoped: true; orgId: string | null }>

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
  ;({ resolveRequestOrg } = await import('../middleware/rbac'))
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

  // ── Seed one real record of ORG in every table the HIGH-1 record routes address,
  //    so the targeted tests below prove a NON-MEMBER is refused on a record that
  //    genuinely EXISTS (membership enforced), not merely on a missing-row 403.
  await db.insert(schema.projects).values({ id: 'proj-1', orgId: ORG, name: 'P', createdAt: new Date() } as any)
  await db.insert(schema.goals).values({ id: 'goal-1', orgId: ORG, title: 'G', createdAt: new Date() } as any)
  await db.insert(schema.knowledgeItems).values({ id: 'know-1', orgId: ORG, name: 'K', type: 'document', content: 'CONFIDENTIAL', backend: 'upload', createdAt: new Date() } as any)
  await db.insert(schema.secrets).values({ id: 'sec-1', orgId: ORG, scope: 'company', key: 'K', valueEncrypted: 'x', createdAt: new Date() } as any)
  await db.insert(schema.budgetPolicies).values({ id: 'budg-1', orgId: ORG, scope: 'company', limitUsd: 100, createdAt: new Date() } as any)
  await db.insert(schema.plugins).values({ id: 'plug-1', orgId: ORG, name: 'PL', version: '1.0.0', createdAt: new Date() } as any)
  await db.insert(schema.workspaces).values({ id: 'ws-1', orgId: ORG, name: 'W', createdAt: new Date() } as any)
  await db.insert(schema.taskAttachments).values({ id: 'att-1', orgId: ORG, taskId: TASK_ID, kind: 'link', name: 'f', createdAt: new Date() } as any)
  await db.insert(schema.taskWatchdogs).values({ id: 'wd-1', orgId: ORG, taskId: TASK_ID, kind: 'runtime', threshold: '60', createdAt: new Date() } as any)
  await db.insert(schema.scheduledTasks).values({ id: 'sch-1', orgId: ORG, agentId: AGENT_ID, title: 'R', input: 'R', cronExpression: '0 * * * *', enabled: true, triggerType: 'cron', createdAt: new Date() } as any)
  await db.insert(schema.webhooks).values({ id: 'wh-1', orgId: ORG, name: 'WH', url: 'http://127.0.0.1:0/never', events: ['*'], enabled: 1, createdAt: new Date() } as any)
  await db.insert(schema.executionPolicies).values({ id: 'pol-1', orgId: ORG, action: 'agent.hire', createdAt: new Date() } as any)
  await db.insert(schema.configRevisions).values({ id: 'rev-1', orgId: ORG, entity: 'agent', entityId: AGENT_ID, createdAt: new Date() } as any)
  // Two skills: a per-ORG custom skill (membership-enforced) and a shared GLOBAL
  // library skill (orgId NULL — the gate must STAND DOWN, not lock everyone out).
  await db.insert(schema.skills).values({ id: 'skill-org', orgId: ORG, name: 'OrgSkill', domain: 'integration', content: 'x', source: 'custom', createdAt: new Date() } as any)
  await db.insert(schema.skills).values({ id: 'skill-global', orgId: null, name: 'GlobalSkill', domain: 'integration', content: 'x', source: 'github', createdAt: new Date() } as any)

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
  const { webhookRoutes } = await import('../routes/webhooks')
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
    await secured.register(webhookRoutes)          // outbound webhook config — was MISSING from this boot (HIGH-1 blind spot)
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

// ── 1. the WIDENED leak-guard: an allowlist-negation sweep over EVERY secured route ──
//
// AUDIT-MCA HIGH-1 fix. The OLD sweep filtered to `/api/orgs/:orgId/*` — it proved
// coverage only of the routes that were never the gap, and structurally excluded the
// ~25 top-level record routes (`/api/secrets/:id`, `/api/knowledge/:itemId`, …) that
// carried the org in a differently-named param and so slipped the gate. The NEW guard
// inverts that: it enumerates EVERY secured route and requires each to EITHER resolve
// an org (so the membership gate covers it) OR appear on a SHORT, JUSTIFIED exempt
// allowlist of genuinely org-agnostic routes. A new secured route that resolves to
// `scoped:false` without being allowlisted FAILS this test — the hole cannot reopen.

// The exempt allowlist: secured routes that legitimately resolve to `scoped:false`.
// Each is org-agnostic OR self-authorizing in-handler — never a cross-tenant record
// addressed by id. Adding a route here is a deliberate, reviewed act.
const EXEMPT = new Set<string>([
  'GET /api/orgs',                    // lists ONLY the caller's own orgs (self-scoped)
  'POST /api/orgs',                   // create a NEW org — no existing org to be a member of
  'POST /api/orgs/import',            // imports a bundle into a NEW org owned by the caller
  'GET /api/orgs/switch/list',        // lists orgs the caller OWNS (ownerId === caller)
  'GET /api/users/:userId/orgs',      // self-only: callerId must equal :userId (in-handler)
  'POST /api/approvals/:id/decide',   // derives org FROM the approval row + enforces type-role in-handler (ONB3 H-1)
  'GET /api/agent-templates',         // static agent-preset catalogue (org-agnostic)
  'GET /api/skills',                  // the shared GLOBAL skill library (org-agnostic; see L-skills flag)
  'POST /api/skills',                 // create a library skill (global library write — pre-existing, flagged)
  'POST /api/skills/sync',            // GitHub library sync (global)
  'POST /api/skills/obsidian-sync',   // Obsidian library sync (global)
  'GET /api/scheduled/presets',       // static cron presets
  'GET /api/scheduled/preview',       // static cron math (no record)
  'GET /api/webhooks/events',         // static webhook-event-name list
  'POST /api/notifications/register',   // register a push token for a user id (device/user-scoped, not org)
  'DELETE /api/notifications/register', // unregister a push token (device/user-scoped, not org)
])

/** Every `:param` in a route → a dummy value; `:orgId` → ORG so org routes point at
 *  an org the outsider isn't in. Record ids stay dummy → the derivation fail-closes. */
function synthParams(url: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of url.matchAll(/:([A-Za-z0-9_]+)/g)) out[m[1]] = m[1] === 'orgId' ? ORG : 'x'
  return out
}

const securedSurface = () =>
  collectedRoutes()
    .filter(r => r.method !== 'HEAD' && r.method !== 'OPTIONS')
    // WebSocket upgrade routes can't be exercised (or resolved) as plain requests.
    .filter(r => !r.url.endsWith('/stream'))

test('[MCA-R4] leak-guard: EVERY secured route resolves an org (gate covers it) OR is explicitly exempt', async () => {
  const routes = securedSurface()
  assert.ok(routes.length > 150, `expected the full secured surface, got ${routes.length}`)

  const ungated: string[] = []
  for (const r of routes) {
    const resolved = await resolveRequestOrg(synthParams(r.url), db, r.url)
    if (!resolved.scoped && !EXEMPT.has(`${r.method} ${r.url}`)) {
      ungated.push(`${r.method} ${r.url}`)
    }
  }
  assert.deepEqual(
    ungated, [],
    'these secured routes resolve to scoped:false and are NOT on the exempt allowlist — the ' +
    'membership gate STANDS DOWN for them (a cross-tenant hole, HIGH-1 class). Either derive their ' +
    'org in resolveRequestOrg (RECORD_ORG_ROUTES) or, if genuinely org-agnostic, add to EXEMPT with ' +
    'justification:\n' + ungated.join('\n'),
  )
})

test('[MCA-R4] leak-guard is REAL: an ungated secured route makes this guard FAIL (self-test)', async () => {
  // Prove the guard has teeth: a synthetic secured route with no org param and no
  // RECORD_ORG_ROUTES mapping resolves scoped:false; absent from EXEMPT it is flagged.
  const rogue = { method: 'DELETE', url: '/api/rogue-widgets/:id' }
  const resolved = await resolveRequestOrg(synthParams(rogue.url), db, rogue.url)
  assert.equal(resolved.scoped, false, 'an unmapped record route must resolve scoped:false')
  assert.ok(!EXEMPT.has(`${rogue.method} ${rogue.url}`), 'and would therefore be reported by the sweep above')
})

test('[MCA-R4] behavioural sweep: every NON-EXEMPT secured route 403s an authenticated NON-MEMBER', async () => {
  const leaks: string[] = []
  for (const r of securedSurface()) {
    if (EXEMPT.has(`${r.method} ${r.url}`)) continue
    // Dummy record ids → the derivation fail-closes to a 403 before the handler runs,
    // so this sweep never mutates a real record. Org routes point at ORG (outsider ∉).
    const res = await asUser(r.method, fillUrl(r.url), OUTSIDER)
    if (res.statusCode !== 403) leaks.push(`${r.method} ${r.url} → ${res.statusCode}`)
  }
  assert.deepEqual(
    leaks, [],
    'these secured routes did NOT 403 a non-member — the membership gate does not reject them:\n' + leaks.join('\n'),
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

// ── 3b. the newly-covered TOP-LEVEL RECORD ROUTES (AUDIT-MCA HIGH-1) ─────────────
//
// These carry the org in a differently-named param (`:projectId`, `:goalId`,
// `:itemId`, `:skillId`) or the generic `:id`, and used to slip the gate entirely:
// an outsider could read/delete another org's secret, confidential knowledge doc,
// project, execution policy, agent revision, webhook, … Now `resolveRequestOrg`
// derives the org from the record via its URL PREFIX. Every id below is a REAL row
// owned by ORG (not a missing-row 403) — this proves MEMBERSHIP is enforced.

const RECORD_ROUTES: Array<[string, string]> = [
  ['DELETE', '/api/secrets/sec-1'],
  ['GET',    '/api/knowledge/know-1/content'],
  ['DELETE', '/api/knowledge/know-1'],
  ['DELETE', '/api/policies/pol-1'],
  ['POST',   '/api/revisions/rev-1/rollback'],
  ['POST',   '/api/webhooks/wh-1/test'],
  ['PATCH',  '/api/webhooks/wh-1'],
  ['DELETE', '/api/webhooks/wh-1'],
  ['PATCH',  '/api/projects/proj-1'],
  ['DELETE', '/api/projects/proj-1'],
  ['GET',    '/api/projects/proj-1/board'],
  ['PATCH',  '/api/goals/goal-1'],
  ['DELETE', '/api/goals/goal-1'],
  ['DELETE', '/api/budgets/budg-1'],
  ['PATCH',  '/api/plugins/plug-1'],
  ['DELETE', '/api/plugins/plug-1'],
  ['PATCH',  '/api/workspaces/ws-1'],
  ['DELETE', '/api/workspaces/ws-1'],
  ['DELETE', '/api/attachments/att-1'],
  ['PATCH',  '/api/watchdogs/wd-1'],
  ['DELETE', '/api/watchdogs/wd-1'],
  ['PATCH',  '/api/scheduled/sch-1'],
  ['DELETE', '/api/scheduled/sch-1'],
  ['GET',    '/api/skills/skill-org'],
  ['PATCH',  '/api/skills/skill-org'],
  ['DELETE', '/api/skills/skill-org'],
]

test('[MCA-R4] HIGH-1: a NON-MEMBER is refused (403) on EVERY top-level record route of a foreign org', async () => {
  // The gate 403s in the preHandler, BEFORE any handler runs — so this loop drives
  // real DELETE/PATCH/POST routes at ORG's records without mutating or firing them
  // (no webhook fetch, no rollback, no delete). It is the exploit the audit proved,
  // now closed at every door.
  const leaks: string[] = []
  for (const [method, url] of RECORD_ROUTES) {
    const res = await asUser(method, url, OUTSIDER)
    if (res.statusCode !== 403) leaks.push(`${method} ${url} → ${res.statusCode}`)
  }
  assert.deepEqual(leaks, [], 'a non-member reached these foreign-org record routes (cross-tenant leak):\n' + leaks.join('\n'))
})

test('[MCA-R4] HIGH-1: a MEMBER of the owning org is NOT blocked (non-403) on the same record routes', async () => {
  // The operator must keep working. Reads + a non-destructive PATCH prove the gate
  // lets a real member through; we avoid driving the member through the DELETEs so
  // the seed survives for other assertions.
  for (const [method, url] of [
    ['GET',   '/api/knowledge/know-1/content'],
    ['GET',   '/api/projects/proj-1/board'],
    ['GET',   '/api/skills/skill-org'],
    ['PATCH', '/api/projects/proj-1'],
    ['PATCH', '/api/goals/goal-1'],
    ['PATCH', '/api/plugins/plug-1'],
    ['PATCH', '/api/watchdogs/wd-1'],
    ['PATCH', '/api/scheduled/sch-1'],
    ['PATCH', '/api/webhooks/wh-1'],
  ] as const) {
    const res = await asUser(method, url, MEMBER)
    assert.notEqual(res.statusCode, 401, `${method} ${url} must not 401 a member`)
    assert.notEqual(res.statusCode, 403, `${method} ${url} must not 403 a member — got ${res.statusCode} ${res.body?.slice(0, 120)}`)
  }
})

test('[MCA-R4] skills: a SHARED GLOBAL library skill (orgId NULL) stands down; a per-ORG skill is membership-gated', async () => {
  // FLAGGED edge case, failed OPEN-by-design only for the shared library: a skill with
  // a null orgId is global — the gate must NOT 403 everyone out of it. But a per-org
  // custom skill (orgId != null) is a tenant record and IS gated.
  const globalByOutsider = await asUser('GET', '/api/skills/skill-global', OUTSIDER)
  assert.notEqual(globalByOutsider.statusCode, 403, 'a shared global-library skill must remain readable (gate stands down)')

  assert.equal((await asUser('GET', '/api/skills/skill-org', OUTSIDER)).statusCode, 403, 'a per-org custom skill is membership-gated')
  assert.notEqual((await asUser('GET', '/api/skills/skill-org', MEMBER)).statusCode, 403, 'a member reads their org’s custom skill')

  // A MISSING skill still fails closed (403), never a silent skip.
  assert.equal((await asUser('GET', '/api/skills/does-not-exist', OUTSIDER)).statusCode, 403, 'missing skill fails closed')
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
