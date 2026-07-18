// ─── GC-0b (audit round 2) — THE EXECUTOR TENANT INVARIANT, + instances #8/#9 ──
//
// PR #334 closed the create-side hole at two routes. This file covers the design call
// that came out of reviewing it, and the two further instances the WIDENED class guard
// found on its first run.
//
// THE INVARIANT: a task must be executed by an agent in the TASK'S OWN ORG.
//
// It is enforced in `executeAgentTask` (services/agent-executor.ts) rather than only at
// the routes, because it is a property of EXECUTION, not of any entry point. There are
// eight call sites into that function and six paths that create an executable row; the
// per-route checks are the ergonomic layer (400 at create, no bad row, real message),
// this is the authoritative one. The argument for both is empirical: instance #7 shipped
// because a route was added without re-deriving the check, and #8/#9 existed the whole
// time in a file nobody thought of as task-creating.
//
// #8 `POST /api/orgs/:orgId/jira/sync`   — imports a whole backlog as executable tasks
// #9 `POST /api/orgs/:orgId/jira/issues` — same, when the optional `agentId` is present
//
// Behavioural: real executor, real in-memory DB. The executor tests do NOT stub the LLM
// — they assert the refusal happens BEFORE any provider call, which is the point.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0b-executor-invariant-key'

let db: any, schema: any
let app: FastifyInstance
let executeAgentTask: any

const ORG_A = 'gc0be-org-a'
const ORG_B = 'gc0be-org-b'
const MEMBER_A = 'gc0be-member-a'
const AGENT_A = 'gc0be-agent-a'   // ORG_A
const AGENT_B = 'gc0be-agent-b'   // ORG_B — the victim
const TASK_A = 'gc0be-task-a'     // ORG_A

const CREATED_AT = new Date('2020-01-01T00:00:00Z')

const agentRow = (id: string, orgId: string, name: string) => ({
  id, orgId, name, role: 'Engineer', llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-20250514', status: 'idle', agentType: 'standard',
  runtime: 'internal', trustMode: 'standard', createdAt: CREATED_AT,
})

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ executeAgentTask } = await import('../services/agent-executor'))
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { jiraRoutes } = await import('../routes/jira')

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: 'gc0be-owner-a', createdAt: new Date() },
    { id: ORG_B, name: 'Org B', ownerId: 'gc0be-owner-b', createdAt: new Date() },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'gc0be-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
  ])
  await db.insert(schema.agents).values([
    agentRow(AGENT_A, ORG_A, 'Agent A'),
    agentRow(AGENT_B, ORG_B, 'Agent B'),
  ] as any)

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(jiraRoutes)
  })
  await app.ready()
})

const as = (user: string, method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as any, url,
    headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  })

const { eq } = await import('drizzle-orm')
const task = async (id: string) =>
  (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]

// Per-test reset, with the same two-step tripwire the sibling suites carry.
beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.insert(schema.tasks).values([
    { id: TASK_A, orgId: ORG_A, agentId: AGENT_A, title: 'Task A', input: 'work', status: 'pending', priority: 'medium', kanbanColumn: 'todo', workMode: 'execute', createdAt: CREATED_AT },
  ] as any)
})

test('[GC-0b] per-test isolation — step 1 mutates the task', async () => {
  await db.update(schema.tasks).set({ status: 'MUTATED' }).where(eq(schema.tasks.id, TASK_A))
  assert.equal((await task(TASK_A)).status, 'MUTATED')
})

test('[GC-0b] per-test isolation is real — step 2 sees a pristine task', async () => {
  assert.equal((await task(TASK_A)).status, 'pending',
    'PER-TEST RESET IS NOT RUNNING: this suite would pass for the wrong reason')
})

// ── THE EXECUTOR INVARIANT ────────────────────────────────────────────────────

test('[GC-0b] the executor REFUSES a task whose agent is in another org', async () => {
  // The authoritative layer. Even if a bad row reaches the DB by ANY route — a future
  // unguarded create, a direct insert, an import — execution refuses it.
  await db.update(schema.tasks).set({ agentId: AGENT_B }).where(eq(schema.tasks.id, TASK_A))

  const result = await executeAgentTask({ agentId: AGENT_B, taskId: TASK_A, input: 'exfiltrate' })

  assert.equal(result.provider, 'governance',
    'the executor RAN a cross-tenant task — it reached a real LLM provider under org B\'s credentials')
  assert.match(result.output, /different organisation/i)
  assert.equal(result.costUsd, 0, 'a refused execution must not bill anyone')
  assert.equal(result.tokensUsed, 0)

  const after = await task(TASK_A)
  assert.equal(after.status, 'failed', 'the refused task must be marked, not left pending to retry forever')
  assert.equal(after.inboxState, 'needs_attention', 'the operator must be able to see it')
})

test('[GC-0b] the executor still runs a SAME-org task (the invariant is not a brick)', async () => {
  // Must not reach the governance refusal. It will fail later for want of a real LLM
  // key, which is fine — what matters is that it got PAST the tenant check.
  let provider: string | undefined
  try {
    const r = await executeAgentTask({ agentId: AGENT_A, taskId: TASK_A, input: 'hello' })
    provider = r.provider
  } catch { provider = 'threw-downstream' }
  assert.notEqual(provider, 'governance',
    'a legitimate same-org execution was refused by the tenant invariant')
})

test('[GC-0b] the refusal does not depend on WHICH agent id the caller passes', async () => {
  // Passing org A's agent id while the ROW says org B (or vice versa) must not sneak
  // past: the comparison is row-vs-resolved-agent, not caller-supplied-vs-anything.
  await db.update(schema.tasks).set({ orgId: ORG_B }).where(eq(schema.tasks.id, TASK_A))
  const result = await executeAgentTask({ agentId: AGENT_A, taskId: TASK_A, input: 'x' })
  assert.equal(result.provider, 'governance', 'a task moved to org B was still run by org A\'s agent')
})

// ── INSTANCE #8 — POST /api/orgs/:orgId/jira/sync ─────────────────────────────

test('[GC-0b] #8 — jira/sync cannot import a backlog onto another org\'s agent', async () => {
  // Jira is not connected in this fixture, so a REFUSED request and a NOT-CONNECTED
  // request both fail — which would make a naive assertion vacuous. So assert on the
  // specific 400 body, and (below) that no task row was created either way.
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/jira/sync`, { agentId: AGENT_B, projectKey: 'X' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /not an agent in this organisation/i,
    `expected the tenant refusal, got: ${res.body}`)
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.agentId, AGENT_B))
  assert.equal(rows.length, 0, 'CROSS-TENANT TASK IMPORT: rows were created against org B\'s agent')
})

test('[GC-0b] #8 — the tenant check runs BEFORE the Jira connection check', async () => {
  // Ordering matters: if "not connected" answered first, the check would silently not
  // run for every org that IS connected — i.e. every real deployment.
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/jira/sync`, { agentId: AGENT_B })
  assert.match(res.json().error, /not an agent in this organisation/i,
    'the Jira-not-connected check short-circuits the tenant check — it would not run in production')
})

// ── INSTANCE #9 — POST /api/orgs/:orgId/jira/issues ───────────────────────────

test('[GC-0b] #9 — jira/issues cannot attach a task to another org\'s agent', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/jira/issues`, {
    summary: 'Do the thing', agentId: AGENT_B,
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /not an agent in this organisation/i, `got: ${res.body}`)
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.agentId, AGENT_B))
  assert.equal(rows.length, 0, 'CROSS-TENANT TASK: a row was created against org B\'s agent')
})

test('[GC-0b] #9 — a nonexistent agentId is refused the same way (no existence oracle)', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/jira/issues`, {
    summary: 'x', agentId: 'no-such-agent-anywhere',
  })
  assert.equal(res.statusCode, 400)
  // Identical message for "foreign" and "missing": distinguishing them tells an
  // attacker whether an id exists in another tenant.
  assert.match(res.json().error, /not an agent in this organisation/i)
})

// ── The shared helper itself ──────────────────────────────────────────────────

test('[GC-0b] assertAgentInOrg: same-org passes, foreign fails, missing fails, null is a no-op', async () => {
  const { assertAgentInOrg } = await import('../services/tenant-guard')
  assert.equal(await assertAgentInOrg(AGENT_A, ORG_A), null, 'a same-org agent was refused')
  assert.match(String(await assertAgentInOrg(AGENT_B, ORG_A)), /not an agent/i, 'a FOREIGN agent was accepted')
  assert.match(String(await assertAgentInOrg('nope', ORG_A)), /not an agent/i, 'a MISSING agent was accepted')
  assert.equal(await assertAgentInOrg(null, ORG_A), null, 'an absent optional field must be a no-op')
  assert.equal(await assertAgentInOrg(undefined, ORG_A), null, 'an absent optional field must be a no-op')
})
