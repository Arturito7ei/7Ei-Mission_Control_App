// CONN-8b-4 — the owner-only connector-execution LEDGER monitor.
//
// Two layers, both about the security invariant "no secret ever reaches a client":
//   1. The PURE projection (`projectConnectorExecution`) — an allow-list that can only
//      emit the safe fields, collapses `approvalId` to a boolean, and truncates the
//      error. Even a row whose `error` somehow carried junk projects to a short string
//      and never leaks the approval id or any unknown column.
//   2. The ROUTE (`GET …/agents/:agentId/connector-executions`) driven through the REAL
//      owner gate against a REAL SQLite file: an owner reads the ledger newest-first,
//      scoped to (org, agent); a member gets 403; another org's / another agent's rows
//      never appear; the limit is capped; an unknown agent 404s. Mirrors
//      agent-detail-routes.test.ts (the R-4-safe `:orgId` path — the gate really bites).
//
// DATABASE_URL is pointed at a temp file BEFORE db/client loads (it reads env at import).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'conn-exec-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentDetailRoutes } = await import('../routes/agent-detail')
const { registerJsonBodyParser } = await import('../middleware/body-parser')
const {
  projectConnectorExecution, CONNECTOR_EXECUTION_STATUSES, CONNECTOR_EXECUTION_ERROR_MAX,
} = await import('../services/connector-execution')
const { eq } = await import('drizzle-orm')

const ORG = 'org-ce', OTHER_ORG = 'org-other', OWNER = 'user-owner', MEMBER = 'user-member'
const AGENT = 'agent-ce', OTHER_AGENT = 'agent-ce-2', OTHER_ORG_AGENT = 'agent-other'

let app: FastifyInstance

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  registerJsonBodyParser(a)
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentDetailRoutes)
  return a
}

/** Insert a ledger row directly (the service does this on execute; here we seed it). */
async function exec(row: {
  orgId?: string; agentId?: string; connectorId: string; action: string
  classification?: string; approvalId?: string | null; status?: string; error?: string | null
  createdAt: Date
}) {
  const id = randomUUID()
  await db.insert(schema.connectorExecutions).values({
    id, orgId: row.orgId ?? ORG, agentId: row.agentId ?? AGENT,
    connectorId: row.connectorId, action: row.action, classification: row.classification ?? 'read',
    approvalId: row.approvalId ?? null, status: row.status ?? 'succeeded', error: row.error ?? null,
    createdAt: row.createdAt,
  } as any)
  return id
}

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([
    { id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now },
    { id: OTHER_ORG, name: 'Rivals', ownerId: 'someone-else', createdAt: now },
  ] as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
    { id: randomUUID(), orgId: ORG, userId: MEMBER, role: 'member', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', createdAt: now },
    { id: OTHER_AGENT, orgId: ORG, name: 'Nia', role: 'Ops', skills: [], runtime: 'internal', createdAt: now },
    { id: OTHER_ORG_AGENT, orgId: OTHER_ORG, name: 'Spy', role: 'Ops', skills: [], runtime: 'internal', createdAt: now },
  ] as any)

  // This agent's ledger — three rows, oldest→newest, mixed status/classification/gating.
  await exec({ connectorId: 'github', action: 'get_repo', classification: 'read', status: 'succeeded', createdAt: new Date(1000) })
  await exec({ connectorId: 'telegram', action: 'send_message', classification: 'write', status: 'failed', error: 'provider request failed', approvalId: null, createdAt: new Date(2000) })
  await exec({ connectorId: 'github', action: 'delete_ref', classification: 'destructive', status: 'succeeded', approvalId: randomUUID(), createdAt: new Date(3000) })
  // Rows that MUST NOT appear for AGENT: a sibling agent + another org's agent.
  await exec({ agentId: OTHER_AGENT, connectorId: 'jira', action: 'create_issue', createdAt: new Date(4000) })
  await exec({ orgId: OTHER_ORG, agentId: OTHER_ORG_AGENT, connectorId: 'github', action: 'get_repo', createdAt: new Date(5000) })

  app = appAs(OWNER)
  await app.ready()
})

after(async () => {
  await app?.close()
  rmSync(tmp, { recursive: true, force: true })
})

const url = (org = ORG, agent = AGENT) => `/api/orgs/${org}/agents/${agent}/connector-executions`

// ─── The pure allow-list projection ───────────────────────────────────────────

test('[CONN-8b-4] projectConnectorExecution emits ONLY the allow-listed fields', () => {
  const item = projectConnectorExecution({
    id: 'x', connectorId: 'github', action: 'get_repo', classification: 'read',
    approvalId: null, status: 'succeeded', error: null, createdAt: new Date(1234),
  })
  assert.deepEqual(Object.keys(item).sort(), ['action', 'classification', 'connectorId', 'createdAt', 'error', 'gated', 'id', 'status'])
  assert.equal(item.createdAt, 1234)
  assert.equal(item.gated, false)
})

test('[CONN-8b-4] gated is a boolean derived from approvalId — never the id itself', () => {
  const gated = projectConnectorExecution({ id: 'x', connectorId: 'c', action: 'a', classification: 'destructive', approvalId: 'appr-SECRET-id', status: 'succeeded', error: null, createdAt: 0 })
  assert.equal(gated.gated, true)
  // The approval id must NOT appear anywhere in the projected object.
  assert.equal(JSON.stringify(gated).includes('appr-SECRET-id'), false)
  assert.equal((gated as any).approvalId, undefined)
})

test('[CONN-8b-4] error is truncated and never carries an unknown/secret column', () => {
  const long = 'x'.repeat(CONNECTOR_EXECUTION_ERROR_MAX + 50)
  const item = projectConnectorExecution({
    // a hostile row with extra keys — the allow-list must drop them all.
    id: 'x', connectorId: 'c', action: 'a', classification: 'read', approvalId: null,
    status: 'failed', error: long, createdAt: 42,
    ...( { token: 'ghp_LEAK', paramsDigest: 'digest', params: { to: 'eve' } } as any ),
  } as any)
  assert.equal(item.error!.length, CONNECTOR_EXECUTION_ERROR_MAX + 1) // +1 for the ellipsis
  assert.ok(item.error!.endsWith('…'))
  const json = JSON.stringify(item)
  for (const leak of ['ghp_LEAK', 'digest', 'eve', 'params']) assert.equal(json.includes(leak), false, `projection leaked ${leak}`)
})

test('[CONN-8b-4] the status vocab is exactly the ledger enum', () => {
  assert.deepEqual([...CONNECTOR_EXECUTION_STATUSES], ['running', 'succeeded', 'failed'])
})

// ─── The route: owner gate, scoping, projection, limit ────────────────────────

test('[CONN-8b-4] an owner reads the ledger newest-first, scoped to this agent', async () => {
  const res = await app.inject({ method: 'GET', url: url() })
  assert.equal(res.statusCode, 200, res.body)
  const { executions } = res.json()
  // Only THIS agent's three rows; the sibling + other-org rows are absent.
  assert.equal(executions.length, 3)
  assert.deepEqual(executions.map((e: any) => e.action), ['delete_ref', 'send_message', 'get_repo']) // desc by createdAt
  const gated = executions.find((e: any) => e.action === 'delete_ref')
  assert.equal(gated.gated, true)
  assert.equal(gated.classification, 'destructive')
  assert.equal(executions.find((e: any) => e.action === 'send_message').status, 'failed')
})

test('[CONN-8b-4] no row carries a credential/params/digest/approvalId field', async () => {
  const res = await app.inject({ method: 'GET', url: url() })
  const body = res.body
  for (const leak of ['approvalId', 'params', 'paramsDigest', 'secret', 'token', 'valueEncrypted', 'orgId', 'agentId']) {
    assert.equal(body.includes(`"${leak}"`), false, `response leaked ${leak}`)
  }
})

test('[CONN-8b-4] a member is refused (owner-gated, R-4-safe :orgId path)', async () => {
  const member = appAs(MEMBER)
  await member.ready()
  const res = await member.inject({ method: 'GET', url: url() })
  assert.equal(res.statusCode, 403)
  await member.close()
})

test('[CONN-8b-4] an unknown agent in this org is a 404, not an empty 200', async () => {
  const res = await app.inject({ method: 'GET', url: url(ORG, 'no-such-agent') })
  assert.equal(res.statusCode, 404)
})

test('[CONN-8b-4] the limit is capped at 50 even when more rows exist', async () => {
  const now = Date.now()
  for (let i = 0; i < 60; i++) await exec({ agentId: OTHER_AGENT, connectorId: 'github', action: `a${i}`, createdAt: new Date(now + i) })
  const res = await app.inject({ method: 'GET', url: `${url(ORG, OTHER_AGENT)}?limit=999` })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().executions.length, 50)
})

test('[CONN-8b-4] the ledger default status is a member of the vocab', async () => {
  // Insert WITHOUT a status → the schema/setup default applies. Proves the vocab's
  // first entry ('running') is the real column default, not just a comment.
  const id = randomUUID()
  await db.insert(schema.connectorExecutions).values({
    id, orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'defaulted',
    classification: 'read', createdAt: new Date(6000),
  } as any)
  const row = await db.query.connectorExecutions.findFirst({ where: eq(schema.connectorExecutions.id, id) })
  assert.ok(CONNECTOR_EXECUTION_STATUSES.includes(row!.status as any), `default status ${row!.status} not in vocab`)
  assert.equal(row!.status, 'running')
  // Clean up so the newest-first ordering test above stays deterministic if reordered.
  await db.delete(schema.connectorExecutions).where(eq(schema.connectorExecutions.id, id))
})
