// ─── MCC-1 — org-scoped agent chat threads ───────────────────────────────────
//
// GET/POST /api/orgs/:orgId/agents/:agentId/chat (routes/agent-chat.ts).
// Behavioural: real routes, real membership gate, real in-memory DB, and the
// REAL agent-api surface for the external round-trip (claim → result → the
// assistant reply lands in the same thread the UI polls).
//
// Tenancy pincer, both jaws:
//   • an outsider (member of org B) on org A's path → 403 at the membership gate
//   • an insider (owner of org A) naming org B's agent → 404 from agentInOrg
// Plus the comms/inbox regression: the unified feed previously selected from
// `messages` with NO org filter — cross-org rows are asserted ABSENT now.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'mcc-agent-chat-key'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

let db: any, schema: any
let app: FastifyInstance        // clerk-secured surface (chat + comms)
let agentApp: FastifyInstance   // agent-token surface (claim/result — the real thing)
let hashToken: (t: string) => string
let eq: any

const ORG_A = 'mcc-org-a'
const ORG_B = 'mcc-org-b'
const OWNER_A = 'mcc-owner-a'
const MEMBER_A = 'mcc-member-a'
const MEMBER_B = 'mcc-member-b'
const EXT_A = 'mcc-ext-a'       // external (openclaw) agent in ORG_A — the chat target
const EXT_B = 'mcc-ext-b'       // external agent in ORG_B — isolation control
const EXT_A_TOKEN = 'mca_mcc_ext_a_token_value_0123456789abcdef'

const CREATED_AT = new Date('2020-01-01T00:00:00Z')

const agentRow = (id: string, orgId: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, orgId, name, role: 'Ops', personality: 'terse', llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-20250514', status: 'idle', agentType: 'standard',
  runtime: 'openclaw', trustMode: 'low_trust_review', permissions: null,
  apiTokenHash: null, deletedAt: null, deletedBy: null, createdAt: CREATED_AT, ...extra,
})

const msgRow = (id: string, agentId: string, role: string, content: string, at: Date) =>
  ({ id, agentId, taskId: null, role, content, createdAt: at })

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ hashToken } = await import('../middleware/agent-token'))
  const { agentAuth } = await import('../middleware/agent-token')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { agentChatRoutes } = await import('../routes/agent-chat')
  const { commsRoutes } = await import('../routes/comms')
  const { agentApiRoutes } = await import('../routes/agent-api')
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  ;({ eq } = await import('drizzle-orm'))

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: OWNER_A, createdAt: new Date() },
    { id: ORG_B, name: 'Org B', ownerId: 'mcc-owner-b', createdAt: new Date() },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'mcc-o-a', orgId: ORG_A, userId: OWNER_A, role: 'owner', createdAt: new Date() },
    { id: 'mcc-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
    { id: 'mcc-m-b', orgId: ORG_B, userId: MEMBER_B, role: 'member', createdAt: new Date() },
  ])

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(agentChatRoutes)
    await secured.register(commsRoutes)
  })
  await app.ready()

  agentApp = Fastify({ logger: false })
  registerJsonBodyParser(agentApp)
  agentApp.addHook('onRequest', agentAuth)
  await agentApp.register(agentApiRoutes)
  await agentApp.ready()
})

const as = (user: string | null, method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as any, url,
    headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  })

const asAgent = (token: string, method: string, url: string, body?: unknown) =>
  agentApp.inject({
    method: method as any, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  })

beforeEach(async () => {
  await db.delete(schema.messages)
  await db.delete(schema.tasks)
  await db.delete(schema.agentRuns)
  await db.delete(schema.agents)
  await db.insert(schema.agents).values([
    agentRow(EXT_A, ORG_A, 'Ext A', { apiTokenHash: hashToken(EXT_A_TOKEN) }),
    agentRow(EXT_B, ORG_B, 'Ext B'),
  ] as any)
})

// ── Read path ────────────────────────────────────────────────────────────────

test('[MCC-1] GET returns the newest-N window in ascending render order', async () => {
  const t = (s: number) => new Date(CREATED_AT.getTime() + s * 1000)
  await db.insert(schema.messages).values([
    msgRow('m1', EXT_A, 'user', 'one', t(1)),
    msgRow('m2', EXT_A, 'assistant', 'two', t(2)),
    msgRow('m3', EXT_A, 'user', 'three', t(3)),
  ] as any)
  const r = await as(MEMBER_A, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat?limit=2`)
  assert.equal(r.statusCode, 200)
  const body = r.json() as any
  // limit=2 must be the LATEST two (an ascending LIMIT would wrongly return m1,m2)
  assert.deepEqual(body.messages.map((m: any) => m.id), ['m2', 'm3'])
  assert.equal(body.agent.external, true)
})

test('[MCC-1] GET since is a GTE window — boundary second re-delivered, same-second rows never missed', async () => {
  const t1 = new Date(CREATED_AT.getTime() + 1000)
  const t2 = new Date(CREATED_AT.getTime() + 60_000)
  await db.insert(schema.messages).values([
    msgRow('m1', EXT_A, 'user', 'old', t1),
    msgRow('m2', EXT_A, 'assistant', 'boundary', t2),
    msgRow('m3', EXT_A, 'user', 'same second as m2', t2),
  ] as any)
  // since = the boundary second: BOTH rows in it come back (a gt at floored
  // seconds silently dropped m3 forever — audit MCC-1 #3); clients dedupe by id.
  const r = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat?since=${t2.getTime()}`)
  assert.equal(r.statusCode, 200)
  assert.deepEqual((r.json() as any).messages.map((m: any) => m.id).sort(), ['m2', 'm3'])
  // a since past the newest row returns nothing
  const empty = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat?since=${t2.getTime() + 1000}`)
  assert.deepEqual((empty.json() as any).messages, [])
  const bad = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat?since=nonsense`)
  assert.equal(bad.statusCode, 400)
})

test('[MCC-1] tenancy pincer: outsider 403 at the gate, insider naming a foreign agent 404', async () => {
  const outsider = await as(MEMBER_B, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`)
  assert.equal(outsider.statusCode, 403)
  const foreign = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_B}/chat`)
  assert.equal(foreign.statusCode, 404)
  const anon = await as(null, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`)
  assert.equal(anon.statusCode, 401)
})

test('[MCC-1] soft-deleted agent is 404 on both verbs', async () => {
  await db.update(schema.agents).set({ deletedAt: new Date(), status: 'deleted' })
    .where(eq(schema.agents.id, EXT_A))
  assert.equal((await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`)).statusCode, 404)
  assert.equal((await as(OWNER_A, 'POST', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`, { content: 'hi' })).statusCode, 404)
})

// ── Send path ────────────────────────────────────────────────────────────────

test('[MCC-1] POST to an external agent writes the user message and an assigned task (org from the PATH)', async () => {
  const r = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`, { content: 'status report please' })
  assert.equal(r.statusCode, 200)
  const body = r.json() as any
  assert.equal(body.async, true)
  const task = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, body.taskId)))[0]
  assert.ok(task, 'task row exists')
  assert.equal(task.orgId, ORG_A)
  assert.equal(task.status, 'assigned')
  const msgs = await db.select().from(schema.messages).where(eq(schema.messages.agentId, EXT_A))
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[0].content, 'status report please')
})

test('[MCC-1] POST validation: empty and oversized content are refused, nothing is written', async () => {
  assert.equal((await as(OWNER_A, 'POST', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`, { content: '  ' })).statusCode, 400)
  assert.equal((await as(OWNER_A, 'POST', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`, { content: 'x'.repeat(8001) })).statusCode, 400)
  assert.equal((await db.select().from(schema.messages)).length, 0)
  assert.equal((await db.select().from(schema.tasks)).length, 0)
})

test('[MCC-1] POST cross-tenant leaves zero rows behind', async () => {
  const r = await as(OWNER_A, 'POST', `/api/orgs/${ORG_A}/agents/${EXT_B}/chat`, { content: 'infiltrate' })
  assert.equal(r.statusCode, 404)
  assert.equal((await db.select().from(schema.messages)).length, 0)
  assert.equal((await db.select().from(schema.tasks)).length, 0)
})

// ── The round-trip that makes it a CHAT: reply arrives through the thread ────

test('[MCC-1] external round-trip: send → claim → result → assistant reply is in the same thread', async () => {
  const sent = await as(OWNER_A, 'POST', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`, { content: 'ping?' })
  assert.equal(sent.statusCode, 200)
  const { taskId } = sent.json() as any

  const claim = await asAgent(EXT_A_TOKEN, 'POST', `/api/agent/tasks/${taskId}/claim`, {})
  assert.equal(claim.statusCode, 200)
  const result = await asAgent(EXT_A_TOKEN, 'POST', `/api/agent/tasks/${taskId}/result`, { output: 'pong!', status: 'done' })
  assert.equal(result.statusCode, 200)

  const r = await as(OWNER_A, 'GET', `/api/orgs/${ORG_A}/agents/${EXT_A}/chat`)
  const msgs = (r.json() as any).messages
  assert.deepEqual(msgs.map((m: any) => [m.role, m.content]), [['user', 'ping?'], ['assistant', 'pong!']])
  assert.equal(msgs[1].taskId, taskId, 'reply is tied to the same task as the question')
})

// ── The comms/inbox regression ───────────────────────────────────────────────

test('[MCC-1] comms/inbox is org-scoped — org B rows never appear in org A feed', async () => {
  await db.insert(schema.messages).values([
    msgRow('ma', EXT_A, 'assistant', 'ours', new Date()),
    msgRow('mb', EXT_B, 'assistant', 'THEIRS', new Date()),
  ] as any)
  const r = await as(MEMBER_A, 'GET', `/api/orgs/${ORG_A}/comms/inbox`)
  assert.equal(r.statusCode, 200)
  const feed = (r.json() as any).messages
  assert.ok(feed.some((m: any) => m.id === 'ma'), 'own org message present')
  assert.ok(!feed.some((m: any) => m.id === 'mb'), 'foreign org message absent')
  assert.ok(!JSON.stringify(feed).includes('THEIRS'), 'foreign content absent')
})
