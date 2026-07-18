// ─── GC-0 (audit) — the goals cross-org write hole ───────────────────────────
//
// The SAME defect as `PATCH /api/projects/:projectId`, found by auditing the CLASS
// rather than the single route. `PATCH /api/goals/:goalId` was
// `db.update(goals).set(req.body as any)` — the raw body written straight to the row,
// no parse, no allow-list. Because `orgId` is a column, ANY MEMBER OF ORG A COULD
// RE-HOME A GOAL INTO ORG B with `{"orgId":"org-b"}`.
//
// The surface-wide membership gate does not catch it, for the structural reason GC-0
// documents: `resolveRequestOrg` (middleware/rbac.ts) derives this route's org FROM
// THE GOAL ROW — the `/api/goals/` entry in `RECORD_ORG_ROUTES` — and reads it BEFORE
// the handler mutates that row. The caller is a genuine member of the goal's org at
// check time, so the gate says yes; the handler then moves the row out from under it.
// A gate that authorises against the pre-image cannot defend a field that rewrites the
// pre-image.
//
// Every assertion here was watched to FAIL against the pre-fix handler (status 200,
// write landed) and to pass after. Behavioural tests: real routes, real gate, real
// in-memory DB.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0-goal-authz-key'

let db: any, schema: any
let app: FastifyInstance

const ORG_A = 'gc0g-org-a'
const ORG_B = 'gc0g-org-b'
const MEMBER_A = 'gc0g-member-a' // member of ORG_A only
const MEMBER_B = 'gc0g-member-b' // member of ORG_B only
const GOAL_A = 'gc0g-goal-a'     // lives in ORG_A
const GOAL_B = 'gc0g-goal-b'     // lives in ORG_B

const CREATED_AT = new Date('2020-01-01T00:00:00Z')

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { taskRoutes } = await import('../routes/all')

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: 'gc0g-owner-a', createdAt: new Date() },
    { id: ORG_B, name: 'Org B', ownerId: 'gc0g-owner-b', createdAt: new Date() },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'gc0g-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
    { id: 'gc0g-m-b', orgId: ORG_B, userId: MEMBER_B, role: 'member', createdAt: new Date() },
  ])

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    // The verifier treats the bearer token AS the user id — act as any identity without
    // reaching Clerk's JWKS. Same stub the other authz suites use.
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(taskRoutes)
  })
  await app.ready()
})

const as = (user: string, method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as any,
    url,
    headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body),
  })

// RAW body variant — bypasses JSON.stringify so duplicate keys and a literal
// `__proto__` key can actually be sent, which is what an attacker curls.
const asRaw = (user: string, method: string, url: string, payload: string) =>
  app.inject({ method: method as any, url, headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, payload })

const { eq } = await import('drizzle-orm')
const row = async (id: string) =>
  (await db.select().from(schema.goals).where(eq(schema.goals.id, id)))[0]

// Every test starts from the SAME pristine two-goal world.
//
// This is load-bearing, not tidiness. Without it the suite is VACUOUS against the
// pre-fix handler: the first test's exploit moves GOAL_A into ORG_B, so every later
// test hits the membership gate and 403s — passing for that reason and "proving"
// guards that do not exist. (Observed first-hand while auditing: adding this reset
// flipped three sibling probes from green to red.)
beforeEach(async () => {
  await db.delete(schema.goals)
  await db.insert(schema.goals).values([
    { id: GOAL_A, orgId: ORG_A, title: 'Goal A', description: 'a', status: 'active', createdAt: CREATED_AT },
    { id: GOAL_B, orgId: ORG_B, title: 'Goal B', description: 'b', status: 'active', createdAt: CREATED_AT },
  ] as any)
})

// ── THE EXPLOIT ───────────────────────────────────────────────────────────────

test('[GC-0] a member of org A CANNOT re-home a goal into org B', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, { orgId: ORG_B })
  const after = await row(GOAL_A)
  assert.equal(after.orgId, ORG_A, `CROSS-ORG WRITE: goal escaped ORG_A into ${after.orgId} (status ${res.statusCode})`)
})

test('[GC-0] `orgId` is rejected even alongside a legitimate field', async () => {
  await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, { title: 'Renamed', orgId: ORG_B })
  const after = await row(GOAL_A)
  assert.equal(after.orgId, ORG_A, 'CROSS-ORG WRITE smuggled alongside a legitimate field')
  assert.equal(after.title, 'Renamed', 'the legitimate field did not land')
})

// ── Exotic input shapes ───────────────────────────────────────────────────────

for (const [label, payload] of [
  ['duplicate keys',      `{"title":"ok","orgId":"${ORG_B}","orgId":"${ORG_B}"}`],
  ['case variant OrgId',  `{"OrgId":"${ORG_B}"}`],
  ['case variant ORGID',  `{"ORGID":"${ORG_B}"}`],
  ['snake_case org_id',   `{"org_id":"${ORG_B}"}`],
  ['array-valued orgId',  `{"orgId":["${ORG_B}"]}`],
  ['object-valued orgId', `{"orgId":{"toString":"${ORG_B}"}}`],
  ['__proto__ nesting',   `{"__proto__":{"orgId":"${ORG_B}"}}`],
  ['constructor proto',   `{"constructor":{"prototype":{"orgId":"${ORG_B}"}}}`],
  ['whole-object round-trip', `{"id":"${GOAL_A}","orgId":"${ORG_B}","title":"RT","description":"d","metric":null,"status":"active","ownerAgentId":null,"parentGoalId":null,"createdAt":1600000000000}`],
] as Array<[string, string]>) {
  test(`[GC-0] the goals allow-list resists: ${label}`, async () => {
    const res = await asRaw(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, payload)
    const after = await row(GOAL_A)
    assert.ok(after, `${label}: the goal row vanished (status ${res.statusCode})`)
    assert.equal(after.orgId, ORG_A, `${label}: CROSS-ORG WRITE (status ${res.statusCode})`)
    assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), `${label}: \`createdAt\` was rewritten`)
    assert.equal(({} as any).orgId, undefined, `${label}: PROTOTYPE POLLUTION via the request body`)
  })
}

// ── Immutable columns ─────────────────────────────────────────────────────────

test('[GC-0] `id` is not writable', async () => {
  await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, { id: 'hijacked-goal' })
  assert.ok(await row(GOAL_A), 'the goal lost its primary key — `id` was writable')
  assert.equal(await row('hijacked-goal'), undefined, '`id` was rewritten')
})

test('[GC-0] `createdAt` is not writable, and the request still SUCCEEDS', async () => {
  // 200, not merely "unchanged". Against the pre-fix handler a numeric `createdAt`
  // threw inside drizzle's timestamp mapper and 500'd, leaving the row untouched —
  // the assertion would have passed on a CRASH rather than on a guard.
  const res = await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, {
    title: 'Legit', createdAt: new Date('2031-05-05T00:00:00Z').getTime(),
  })
  assert.equal(res.statusCode, 200)
  const after = await row(GOAL_A)
  assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), '`createdAt` was rewritten')
  assert.equal(after.title, 'Legit', 'the request did not actually take effect')
})

// ── Mass assignment ───────────────────────────────────────────────────────────

test('[GC-0] unknown body keys are never persisted', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, {
    title: 'Legit rename', bogusColumn: 'x', isAdmin: true,
  })
  assert.equal(res.statusCode, 200)
  const after = await row(GOAL_A)
  assert.equal(after.title, 'Legit rename')
  for (const k of ['bogusColumn', 'isAdmin']) {
    assert.equal((after as any)[k], undefined, `unknown key \`${k}\` reached the row`)
  }
})

test('[GC-0] the allow-listed goal fields DO still write (the guard is not a brick)', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, {
    title: 'Edited', description: 'new description', metric: '$1M MRR',
    status: 'done', ownerAgentId: null, parentGoalId: null,
  })
  assert.equal(res.statusCode, 200)
  const after = await row(GOAL_A)
  assert.equal(after.title, 'Edited')
  assert.equal(after.description, 'new description')
  assert.equal(after.metric, '$1M MRR')
  assert.equal(after.status, 'done')
})

test('[GC-0] an invalid `status` is refused rather than written', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_A}`, { status: 'not-a-status' })
  assert.equal(res.statusCode, 400)
  assert.equal((await row(GOAL_A)).status, 'active', 'an out-of-enum status reached the row')
})

// ── Cross-org read / update / delete (the gate itself still stands) ───────────

test('[GC-0] a member of org A cannot UPDATE org B\'s goal', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/goals/${GOAL_B}`, { title: 'Owned' })
  assert.equal(res.statusCode, 403)
  assert.equal((await row(GOAL_B)).title, 'Goal B', "org B's goal was edited by an outsider")
})

test('[GC-0] a member of org A cannot DELETE org B\'s goal', async () => {
  const res = await as(MEMBER_A, 'DELETE', `/api/goals/${GOAL_B}`)
  assert.equal(res.statusCode, 403)
  assert.ok(await row(GOAL_B), "org B's goal was deleted by an outsider")
})

test('[GC-0] the goals LIST is scoped to the org in the path', async () => {
  const res = await as(MEMBER_B, 'GET', `/api/orgs/${ORG_B}/goals`)
  assert.equal(res.statusCode, 200)
  const ids = res.json().goals.map((g: any) => g.id)
  assert.ok(ids.includes(GOAL_B))
  assert.ok(!ids.includes(GOAL_A), "the list leaked another org's goal")
})

test('[GC-0] goal CREATE ignores a client-supplied orgId and id', async () => {
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/goals`, {
    title: 'Created', orgId: ORG_B, id: 'client-chosen-id',
  })
  assert.equal(res.statusCode, 201)
  const created = res.json().goal
  assert.equal(created.orgId, ORG_A, 'CREATE honoured a client-supplied orgId')
  assert.notEqual(created.id, 'client-chosen-id', 'CREATE honoured a client-supplied id')
})
