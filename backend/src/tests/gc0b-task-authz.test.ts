// ─── GC-0b — the tasks cross-org write hole + the agentId re-point ───────────
//
// `PATCH /api/tasks/:taskId` was `db.update(tasks).set(req.body as any)`. Same
// structural cause as projects and goals: `resolveRequestOrg` derives this route's org
// FROM THE TASK ROW (the `:taskId` branch in middleware/rbac.ts) and reads it BEFORE
// the handler mutates that row, so a member of org A could write `orgId` and move the
// task — with its input, output and whole comment thread — into org B.
//
// The sharper half is `agentId`: it is what the executor runs the task AS, so
// re-pointing it at another org's agent hands that agent this task's `input` and makes
// it execute work for a tenant it does not belong to. `agentId` stays writable
// (reassignment is real product behaviour) but is validated against the TASK's org.
//
// Behavioural: real routes, real gate, real in-memory DB.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0b-task-authz-key'

let db: any, schema: any
let app: FastifyInstance

const ORG_A = 'gc0bt-org-a'
const ORG_B = 'gc0bt-org-b'
const MEMBER_A = 'gc0bt-member-a'
const MEMBER_B = 'gc0bt-member-b'
const AGENT_A = 'gc0bt-agent-a'   // ORG_A
const PEER_A = 'gc0bt-peer-a'     // ORG_A — a legitimate reassignment target
const AGENT_B = 'gc0bt-agent-b'   // ORG_B — the exploit target
const TASK_A = 'gc0bt-task-a'     // ORG_A
const TASK_B = 'gc0bt-task-b'     // ORG_B

const CREATED_AT = new Date('2020-01-01T00:00:00Z')
const SECRET_INPUT = 'ORG A CONFIDENTIAL: rotate the production database credentials'

const agentRow = (id: string, orgId: string, name: string) => ({
  id, orgId, name, role: 'Engineer', llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-20250514', status: 'idle', agentType: 'standard',
  runtime: 'internal', trustMode: 'standard', createdAt: CREATED_AT,
})

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { taskRoutes } = await import('../routes/tasks')

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: 'gc0bt-owner-a', createdAt: new Date() },
    { id: ORG_B, name: 'Org B', ownerId: 'gc0bt-owner-b', createdAt: new Date() },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'gc0bt-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
    { id: 'gc0bt-m-b', orgId: ORG_B, userId: MEMBER_B, role: 'member', createdAt: new Date() },
  ])
  await db.insert(schema.agents).values([
    agentRow(AGENT_A, ORG_A, 'Agent A'),
    agentRow(PEER_A, ORG_A, 'Peer A'),
    agentRow(AGENT_B, ORG_B, 'Agent B'),
  ] as any)

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(taskRoutes)
  })
  await app.ready()
})

const as = (user: string, method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as any, url,
    headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  })

const asRaw = (user: string, method: string, url: string, payload: string) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, payload })

const { eq } = await import('drizzle-orm')
const row = async (id: string) =>
  (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]

// PER-TEST RESET — load-bearing. Without it the first exploit moves TASK_A into ORG_B
// and every later probe 403s, passing for the wrong reason.
beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.insert(schema.tasks).values([
    { id: TASK_A, orgId: ORG_A, agentId: AGENT_A, title: 'Task A', input: SECRET_INPUT, status: 'pending', priority: 'medium', kanbanColumn: 'todo', workMode: 'execute', lockToken: null, tokensUsed: null, costUsd: null, createdAt: CREATED_AT },
    { id: TASK_B, orgId: ORG_B, agentId: AGENT_B, title: 'Task B', input: 'b', status: 'pending', priority: 'medium', kanbanColumn: 'todo', workMode: 'execute', createdAt: CREATED_AT },
  ] as any)
})

// ── PROOF THE ISOLATION IS REAL ───────────────────────────────────────────────

test('[GC-0b] per-test isolation — step 1 legitimately mutates the task', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { title: 'MUTATED BY STEP 1' })
  assert.equal(res.statusCode, 200)
  assert.equal((await row(TASK_A)).title, 'MUTATED BY STEP 1')
})

test('[GC-0b] per-test isolation is real — step 2 sees a PRISTINE task', async () => {
  const t = await row(TASK_A)
  assert.equal(t.title, 'Task A', 'PER-TEST RESET IS NOT RUNNING: this suite would pass for the wrong reason')
  assert.equal(t.orgId, ORG_A, 'task tenancy leaked across tests')
  assert.equal(t.agentId, AGENT_A, 'task assignment leaked across tests')
})

// ── EXPLOIT 1 — the cross-org move ────────────────────────────────────────────

test('[GC-0b] a member of org A CANNOT move a task into org B', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { orgId: ORG_B })
  const after = await row(TASK_A)
  assert.equal(after.orgId, ORG_A, `CROSS-ORG WRITE: task escaped ORG_A into ${after.orgId} (status ${res.statusCode})`)
})

test('[GC-0b] `orgId` is rejected even alongside a legitimate field', async () => {
  await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { title: 'Renamed', orgId: ORG_B })
  const after = await row(TASK_A)
  assert.equal(after.orgId, ORG_A, 'CROSS-ORG WRITE smuggled alongside a legitimate field')
  assert.equal(after.title, 'Renamed', 'the legitimate field did not land')
})

// ── EXPLOIT 2 — re-pointing agentId at another org's agent ────────────────────

test('[GC-0b] a task CANNOT be re-pointed at another org\'s agent', async () => {
  // THE ONE THAT MATTERS: `agentId` is what the executor runs the task AS. Pre-fix
  // this landed at 200 and org B's agent inherited org A's confidential `input`.
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { agentId: AGENT_B })
  const after = await row(TASK_A)
  assert.equal(after.agentId, AGENT_A,
    `CROSS-ORG AGENT RE-POINT: org B's agent now owns an ORG_A task carrying "${after.input}" (status ${res.statusCode})`)
  assert.equal(res.statusCode, 400, 'the re-point must be refused explicitly')
})

test('[GC-0b] the cross-org re-point is refused even smuggled alongside a legit field', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { title: 'Legit', agentId: AGENT_B })
  assert.equal(res.statusCode, 400)
  const after = await row(TASK_A)
  assert.equal(after.agentId, AGENT_A, 'CROSS-ORG AGENT RE-POINT smuggled alongside a legitimate field')
  assert.equal(after.title, 'Task A', 'a REFUSED request still applied its other fields — the write was not atomic')
})

test('[GC-0b] a nonexistent agentId is refused rather than dangled', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { agentId: 'no-such-agent' })
  assert.equal(res.statusCode, 400)
  assert.equal((await row(TASK_A)).agentId, AGENT_A)
})

test('[GC-0b] reassignment WITHIN the org still works (the guard is not a brick)', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { agentId: PEER_A })
  assert.equal(res.statusCode, 200)
  assert.equal((await row(TASK_A)).agentId, PEER_A, 'a legitimate same-org reassignment was blocked')
})

// ── Executor-owned + lock columns ─────────────────────────────────────────────

test('[GC-0b] the checkout lock (`lockToken`/`lockedAt`) is not client-writable', async () => {
  // Client-writable lock state lets one caller steal or forge another runner's claim.
  await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { lockToken: 'stolen', lockedAt: Date.now() })
  const after = await row(TASK_A)
  assert.equal(after.lockToken, null, 'the atomic checkout lock was forgeable from the client')
  assert.equal(after.lockedAt, null, '`lockedAt` was client-writable')
})

test('[GC-0b] metering (`tokensUsed`, `costUsd`) is not client-writable', async () => {
  // Billing integrity: understating spend evades the org budget cap.
  await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { tokensUsed: 0, costUsd: 0, durationMs: 0 })
  const after = await row(TASK_A)
  assert.equal(after.tokensUsed, null, '`tokensUsed` was client-writable — budget accounting is forgeable')
  assert.equal(after.costUsd, null, '`costUsd` was client-writable')
})

// ── Exotic input shapes ───────────────────────────────────────────────────────

for (const [label, payload] of [
  ['duplicate keys',        `{"title":"ok","orgId":"${ORG_B}","orgId":"${ORG_B}"}`],
  ['case variant OrgId',    `{"OrgId":"${ORG_B}"}`],
  ['case variant ORGID',    `{"ORGID":"${ORG_B}"}`],
  ['snake_case org_id',     `{"org_id":"${ORG_B}"}`],
  ['array-valued orgId',    `{"orgId":["${ORG_B}"]}`],
  ['object-valued orgId',   `{"orgId":{"toString":"${ORG_B}"}}`],
  ['null orgId',            `{"orgId":null}`],
  ['snake_case agent_id',   `{"agent_id":"${AGENT_B}"}`],
  ['case variant AgentId',  `{"AgentId":"${AGENT_B}"}`],
  ['__proto__ nesting',     `{"__proto__":{"orgId":"${ORG_B}","agentId":"${AGENT_B}"}}`],
  ['constructor proto',     `{"constructor":{"prototype":{"orgId":"${ORG_B}"}}}`],
  ['whole-object round-trip', `{"id":"${TASK_A}","orgId":"${ORG_B}","agentId":"${AGENT_A}","title":"RT","input":"RT","status":"pending","priority":"medium","kanbanColumn":"todo","lockToken":"forged","tokensUsed":0,"costUsd":0,"createdAt":1600000000000}`],
] as Array<[string, string]>) {
  test(`[GC-0b] the tasks allow-list resists: ${label}`, async () => {
    const res = await asRaw(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, payload)
    const after = await row(TASK_A)
    assert.ok(after, `${label}: the task row vanished (status ${res.statusCode})`)
    assert.equal(after.orgId, ORG_A, `${label}: CROSS-ORG WRITE (status ${res.statusCode})`)
    assert.equal(after.agentId, AGENT_A, `${label}: CROSS-ORG AGENT RE-POINT (status ${res.statusCode})`)
    assert.equal(after.lockToken, null, `${label}: the checkout lock was forged`)
    assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), `${label}: \`createdAt\` was rewritten`)
    assert.equal(({} as any).orgId, undefined, `${label}: PROTOTYPE POLLUTION via the request body`)
  })
}

// ── Immutable columns ─────────────────────────────────────────────────────────

test('[GC-0b] `id` is not writable', async () => {
  await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { id: 'hijacked-task' })
  assert.ok(await row(TASK_A), 'the task lost its primary key — `id` was writable')
  assert.equal(await row('hijacked-task'), undefined, '`id` was rewritten')
})

test('[GC-0b] `createdAt` is not writable, and the request still SUCCEEDS', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, {
    title: 'Legit', createdAt: new Date('2031-05-05T00:00:00Z').getTime(),
  })
  assert.equal(res.statusCode, 200)
  const after = await row(TASK_A)
  assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), '`createdAt` was rewritten')
  assert.equal(after.title, 'Legit', 'the request did not actually take effect')
})

test('[GC-0b] unknown body keys are never persisted', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, { title: 'Legit', bogusColumn: 'x', isAdmin: true })
  assert.equal(res.statusCode, 200)
  const after = await row(TASK_A)
  for (const k of ['bogusColumn', 'isAdmin']) {
    assert.equal((after as any)[k], undefined, `unknown key \`${k}\` reached the row`)
  }
})

// ── Cross-org (the gate itself still stands) ──────────────────────────────────

test('[GC-0b] a member of org A cannot PATCH org B\'s task', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_B}`, { title: 'Owned' })
  assert.equal(res.statusCode, 403)
  assert.equal((await row(TASK_B)).title, 'Task B', "org B's task was edited by an outsider")
})

// ── The guard is not a brick ──────────────────────────────────────────────────

test('[GC-0b] the allow-listed task fields DO still write', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}`, {
    title: 'Edited', input: 'new input', output: 'result', status: 'done',
    priority: 'high', kanbanColumn: 'done', assignedTo: 'someone', labels: '["x"]',
  })
  assert.equal(res.statusCode, 200)
  const after = await row(TASK_A)
  assert.equal(after.title, 'Edited')
  assert.equal(after.input, 'new input')
  assert.equal(after.output, 'result')
  assert.equal(after.status, 'done')
  assert.equal(after.priority, 'high')
  assert.equal(after.kanbanColumn, 'done')
})

test('[GC-0b] the kanban move sub-route is unaffected', async () => {
  // `PATCH /api/tasks/:taskId/move` writes its own hard-coded literal; the fix must
  // not disturb the drag-and-drop path the board depends on.
  const res = await as(MEMBER_A, 'PATCH', `/api/tasks/${TASK_A}/move`, { column: 'in_progress' })
  assert.equal(res.statusCode, 200)
  const after = await row(TASK_A)
  assert.equal(after.kanbanColumn, 'in_progress')
  assert.equal(after.status, 'in_progress')
})
