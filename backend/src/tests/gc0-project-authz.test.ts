// ─── GC-0 — the projects cross-org write hole ────────────────────────────────
//
// `PATCH /api/projects/:projectId` was `db.update(projects).set(req.body as any)`:
// no Zod parse, no field allow-list, the raw request body written straight to the
// row. Because `orgId` is a column, ANY MEMBER OF ORG A COULD RE-HOME A PROJECT
// INTO ORG B by sending `{"orgId":"org-b"}` — a cross-tenant WRITE.
//
// The surface-wide membership gate does NOT catch it. `resolveRequestOrg`
// (middleware/rbac.ts) derives the org for `/api/projects/:projectId` FROM THE ROW,
// and it does so BEFORE the handler mutates that row. The caller is a legitimate
// member of the org the project is in *at check time*, so the gate says yes; the
// handler then moves the row somewhere the caller was never authorised to write.
// A gate that reads the pre-image cannot defend a field that rewrites the pre-image
// — the allow-list has to.
//
// These are BEHAVIOURAL tests against real routes + the real gate + a real in-memory
// DB, and every one of them was watched to FAIL against the pre-fix handler.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0-project-authz-key'

let db: any, schema: any
let app: FastifyInstance

const ORG_A = 'gc0-org-a'
const ORG_B = 'gc0-org-b'
const MEMBER_A = 'gc0-user-member-a' // member of ORG_A only
const MEMBER_B = 'gc0-user-member-b' // member of ORG_B only
const PROJ_A = 'gc0-proj-a'          // lives in ORG_A
const PROJ_B = 'gc0-proj-b'          // lives in ORG_B

const CREATED_AT = new Date('2020-01-01T00:00:00Z')

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { projectRoutes } = await import('../routes/all')

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: 'gc0-owner-a', createdAt: new Date() },
    { id: ORG_B, name: 'Org B', ownerId: 'gc0-owner-b', createdAt: new Date() },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'gc0-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
    { id: 'gc0-m-b', orgId: ORG_B, userId: MEMBER_B, role: 'member', createdAt: new Date() },
  ])
  await db.insert(schema.projects).values([
    { id: PROJ_A, orgId: ORG_A, name: 'Project A', description: 'a', createdAt: CREATED_AT },
    { id: PROJ_B, orgId: ORG_B, name: 'Project B', description: 'b', createdAt: CREATED_AT },
  ] as any)

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    // The verifier treats the bearer token AS the user id — act as any identity
    // without reaching Clerk's JWKS. Same stub membership-scoping.test.ts uses.
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(projectRoutes)
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

const { eq } = await import('drizzle-orm')
const row = async (id: string) =>
  (await db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0]

// Every test starts from the SAME pristine two-project world.
//
// This matters more than tidiness. Without it the suite was VACUOUS against the
// pre-fix handler: the first test's exploit moved PROJ_A into ORG_B, so every
// later test hit the membership gate and 403'd — and passed for that reason,
// "proving" guards that did not exist. An isolated reset is what makes each
// assertion actually exercise the field allow-list.
beforeEach(async () => {
  await db.delete(schema.projects)
  await db.insert(schema.projects).values([
    { id: PROJ_A, orgId: ORG_A, name: 'Project A', description: 'a', createdAt: CREATED_AT },
    { id: PROJ_B, orgId: ORG_B, name: 'Project B', description: 'b', createdAt: CREATED_AT },
  ] as any)
})

// ── THE EXPLOIT ───────────────────────────────────────────────────────────────

test('[GC-0] a member of org A CANNOT re-home a project into org B', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/projects/${PROJ_A}`, { orgId: ORG_B })

  // The write must not land, whatever the status code. THIS is the exploit: before
  // the fix this returned 200 and `orgId` was ORG_B — the project, its board and
  // every task hanging off it silently became another tenant's.
  const after = await row(PROJ_A)
  assert.equal(after.orgId, ORG_A, `CROSS-ORG WRITE: project escaped ORG_A into ${after.orgId} (status ${res.statusCode})`)
})

test('[GC-0] `orgId` is rejected even alongside a legitimate field', async () => {
  // The interesting shape: a valid edit that smuggles orgId. A guard that only
  // looked at "is this body suspicious" rather than allow-listing would let it by.
  await as(MEMBER_A, 'PATCH', `/api/projects/${PROJ_A}`, { name: 'Renamed', orgId: ORG_B })
  const after = await row(PROJ_A)
  assert.equal(after.orgId, ORG_A, 'CROSS-ORG WRITE smuggled alongside a legitimate field')
})

// ── Immutable columns ─────────────────────────────────────────────────────────

test('[GC-0] `id` is not writable', async () => {
  await as(MEMBER_A, 'PATCH', `/api/projects/${PROJ_A}`, { id: 'hijacked-id' })
  assert.ok(await row(PROJ_A), 'the project lost its primary key — `id` was writable')
  assert.equal(await row('hijacked-id'), undefined, '`id` was rewritten')
})

test('[GC-0] `createdAt` is not writable', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/projects/${PROJ_A}`, {
    name: 'Legit', createdAt: new Date('2031-05-05T00:00:00Z').getTime(),
  })
  // 200, not merely "unchanged". Against the pre-fix handler this threw inside
  // drizzle's timestamp mapper and 500'd, leaving the row untouched — the test
  // would have passed on a CRASH rather than on a guard. Requiring the request to
  // SUCCEED while `createdAt` stays put is what makes this assertion mean anything.
  assert.equal(res.statusCode, 200)
  const after = await row(PROJ_A)
  assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), '`createdAt` was rewritten')
  assert.equal(after.name, 'Legit', 'the request did not actually take effect')
})

// ── Mass assignment ───────────────────────────────────────────────────────────

test('[GC-0] unknown body keys are never persisted', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/projects/${PROJ_A}`, {
    name: 'Legit rename', bogusColumn: 'x', isAdmin: true, __proto__: { polluted: true },
  })
  assert.equal(res.statusCode, 200)
  const after = await row(PROJ_A)
  assert.equal(after.name, 'Legit rename', 'the legitimate field did not land')
  for (const k of ['bogusColumn', 'isAdmin', 'polluted']) {
    assert.equal((after as any)[k], undefined, `unknown key \`${k}\` reached the row`)
  }
  assert.equal(({} as any).polluted, undefined, 'prototype pollution via the request body')
})

test('[GC-0] the allow-listed fields DO still write (the guard is not a brick)', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/projects/${PROJ_A}`, {
    name: 'Edited', description: 'new description', departmentId: null,
  })
  assert.equal(res.statusCode, 200)
  const after = await row(PROJ_A)
  assert.equal(after.name, 'Edited')
  assert.equal(after.description, 'new description')
})

// ── Cross-org read / update / delete ──────────────────────────────────────────

test('[GC-0] a member of org A cannot UPDATE org B\'s project', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/projects/${PROJ_B}`, { name: 'Owned' })
  assert.equal(res.statusCode, 403)
  assert.equal((await row(PROJ_B)).name, 'Project B', "org B's project was edited by an outsider")
})

test('[GC-0] a member of org A cannot READ org B\'s project board', async () => {
  const res = await as(MEMBER_A, 'GET', `/api/projects/${PROJ_B}/board`)
  assert.equal(res.statusCode, 403)
})

test('[GC-0] a member of org A cannot DELETE org B\'s project', async () => {
  const res = await as(MEMBER_A, 'DELETE', `/api/projects/${PROJ_B}`)
  assert.equal(res.statusCode, 403)
  assert.ok(await row(PROJ_B), "org B's project was deleted by an outsider")
})

test('[GC-0] the projects LIST is scoped to the org in the path', async () => {
  const res = await as(MEMBER_B, 'GET', `/api/orgs/${ORG_B}/projects`)
  assert.equal(res.statusCode, 200)
  const ids = res.json().projects.map((p: any) => p.id)
  assert.ok(ids.includes(PROJ_B))
  assert.ok(!ids.includes(PROJ_A), 'the list leaked another org\'s project')
})

test('[GC-0] CREATE ignores a client-supplied orgId and uses the path org', async () => {
  // The create route already derives orgId from the path, but nothing STOPPED a
  // body orgId from being spread in later. Pin the behaviour.
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/projects`, {
    name: 'Created', orgId: ORG_B, id: 'client-chosen-id',
  })
  assert.equal(res.statusCode, 201)
  const created = res.json().project
  assert.equal(created.orgId, ORG_A, 'CREATE honoured a client-supplied orgId')
  assert.notEqual(created.id, 'client-chosen-id', 'CREATE honoured a client-supplied id')
})

test('[GC-0] CREATE rejects a missing name rather than writing NULL', async () => {
  // `name` is NOT NULL; the unvalidated handler passed `undefined` straight through.
  const res = await as(MEMBER_A, 'POST', `/api/orgs/${ORG_A}/projects`, { description: 'no name' })
  assert.equal(res.statusCode, 400)
})
