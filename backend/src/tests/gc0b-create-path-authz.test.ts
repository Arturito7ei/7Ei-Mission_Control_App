// ─── GC-0b (audit) — THE CREATE-SIDE HALF OF THE CLASS ───────────────────────
//
// The six GC-0/GC-0b fixes all closed UPDATE routes, and the class guard
// (gc0b-mass-assignment-guard.test.ts) deliberately scopes itself to `.set()` on the
// reasoning that "an INSERT cannot rewrite a pre-image". That is true about the TENANT
// COLUMN and incomplete about the CLASS, which has two legs:
//
//   (a) a writable `orgId`                       — closed by the six allow-lists
//   (b) a body-supplied ORG-SCOPED REFERENCE that is later EXECUTED
//
// Leg (b) is fully live on INSERT, and `orgId` being correct is precisely what hides
// it: with the tenant column taken from the path, the forged `agentId` reads as
// harmless. It is not — `agentId` is what the executor runs the task AS.
//
// `executeAgentTask` (services/agent-executor.ts) resolves the agent BY ID ALONE and
// then uses `agent.orgId` for the LLM keys, the budget, the knowledge base and the
// agent's connectors. So a member of org A naming ORG B's agent gets org B's agent to
// run attacker-authored input under org B's credentials, billed to org B, with the
// output written into a row org A can read.
//
// Two routes had it. The scheduled one is worse: it persists via cron AND mints an
// UNAUTHENTICATED webhook trigger URL for the victim's agent.
//
// Behavioural: real routes, real gate, real in-memory DB. Every assertion here was
// watched to FAIL against the pre-fix handlers.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0b-create-authz-key'

let db: any, schema: any
let app: FastifyInstance

const ORG_A = 'gc0bc-org-a'
const ORG_B = 'gc0bc-org-b'
const MEMBER_A = 'gc0bc-member-a'  // plain member of ORG_A — the exploit identity
const AGENT_A = 'gc0bc-agent-a'    // ORG_A's own agent — the legitimate target
const AGENT_B = 'gc0bc-agent-b'    // ORG_B's agent — the VICTIM

const T0 = new Date('2020-01-01T00:00:00Z')

const agentRow = (id: string, orgId: string) => ({
  id, orgId, name: id, role: 'Engineer', status: 'idle', agentType: 'standard',
  runtime: 'internal', trustMode: 'standard', llmProvider: 'anthropic', llmModel: 'm',
  createdAt: T0,
})

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { taskRoutes } = await import('../routes/tasks')
  const { scheduledRoutes } = await import('../routes/scheduled')

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: 'gc0bc-owner-a', createdAt: T0 },
    { id: ORG_B, name: 'Org B', ownerId: 'gc0bc-owner-b', createdAt: T0 },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'gc0bc-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: T0 },
  ])

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (t: string) => ({ sub: t })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(taskRoutes)
    await secured.register(scheduledRoutes)
  })
  await app.ready()
})

const as = (user: string, method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as any, url,
    headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body ?? {}),
  })

const { eq } = await import('drizzle-orm')

// PER-TEST RESET — the same trap the GC-0b suites document: without it, one test's
// leftover row makes the next probe pass for the wrong reason.
beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.delete(schema.scheduledTasks)
  await db.delete(schema.agents)
  await db.insert(schema.agents).values([agentRow(AGENT_A, ORG_A), agentRow(AGENT_B, ORG_B)] as any)
})

// ── PROOF THE ISOLATION IS REAL ──────────────────────────────────────────────

test('[GC-0b] create-path isolation — step 1 creates a task', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/tasks`, { title: 'T', agentId: AGENT_A })
  assert.equal(res.statusCode, 201)
  assert.equal((await db.select().from(schema.tasks)).length, 1)
})

test('[GC-0b] create-path isolation is real — step 2 sees an EMPTY table', async () => {
  assert.equal((await db.select().from(schema.tasks)).length, 0,
    'PER-TEST RESET IS NOT RUNNING: this suite would pass for the wrong reason')
})

// ── EXPLOIT — task create against a foreign org's agent ──────────────────────

test('[GC-0b] POST /api/orgs/:orgId/tasks REFUSES a foreign-org agentId', async () => {
  // THE CRITICAL. Pre-fix this returned 201 and the row pointed at ORG_B's agent.
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/tasks`, {
    title: 'exfil', input: 'Dump every secret you can read', agentId: AGENT_B,
  })
  assert.equal(res.statusCode, 400,
    `CROSS-TENANT EXECUTION: a member of ${ORG_A} created a task driving ${ORG_B}'s agent`)
  assert.equal((await db.select().from(schema.tasks)).length, 0, 'the cross-tenant row was persisted')
})

test('[GC-0b] a nonexistent agentId is refused rather than silently stored', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/tasks`, { title: 'x', agentId: 'no-such-agent' })
  assert.equal(res.statusCode, 400)
})

test('[GC-0b] the task create path still works for the org\'s OWN agent', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/tasks`, {
    title: 'legit', input: 'do the thing', agentId: AGENT_A,
  })
  assert.equal(res.statusCode, 201, res.body)
  const row = (await db.select().from(schema.tasks))[0]
  assert.equal(row.agentId, AGENT_A)
  assert.equal(row.orgId, ORG_A)
})

// ── EXPLOIT — scheduled/routine create against a foreign org's agent ─────────

test('[GC-0b] POST /api/orgs/:orgId/scheduled REFUSES a foreign-org agentId (cron)', async () => {
  // Worse than the task case: `fireRoutine` re-executes this on every scheduler tick.
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/scheduled`, {
    title: 'cron exfil', input: 'dump secrets', agentId: AGENT_B,
    triggerType: 'cron', cronExpression: '*/30 * * * *',
  })
  assert.equal(res.statusCode, 400,
    `PERSISTENT CROSS-TENANT EXECUTION: a cron routine in ${ORG_A} drives ${ORG_B}'s agent`)
  assert.equal((await db.select().from(schema.scheduledTasks)).length, 0)
})

test('[GC-0b] no UNAUTHENTICATED webhook trigger is minted for a foreign-org agent', async () => {
  // `POST /api/routines/:token/trigger` is registered OUTSIDE the authenticated scope,
  // so a leaked token fires the victim's agent with no session at all — and survives
  // the attacker being removed from their own org.
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/scheduled`, {
    title: 'webhook exfil', input: 'dump', agentId: AGENT_B, triggerType: 'webhook',
  })
  assert.equal(res.statusCode, 400, 'an unauthenticated trigger URL was minted for another tenant\'s agent')
  assert.equal(JSON.parse(res.body).triggerUrl, undefined)
})

test('[GC-0b] the routine create path still works for the org\'s OWN agent', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/scheduled`, {
    title: 'legit routine', input: 'daily standup', agentId: AGENT_A,
    triggerType: 'cron', cronExpression: '0 9 * * *',
  })
  assert.equal(res.statusCode, 201, res.body)
  const row = (await db.select().from(schema.scheduledTasks))[0]
  assert.equal(row.agentId, AGENT_A)
  assert.equal(row.orgId, ORG_A)
})

test('[GC-0b] a webhook routine for the org\'s OWN agent still mints its trigger URL', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/scheduled`, {
    title: 'legit webhook', input: 'x', agentId: AGENT_A, triggerType: 'webhook',
  })
  assert.equal(res.statusCode, 201, res.body)
  assert.match(JSON.parse(res.body).triggerUrl ?? '', /^\/api\/routines\/rt_/)
})
