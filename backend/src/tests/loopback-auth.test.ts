// Epic H / H6 — the single-operator LOOPBACK IDENTITY for the packaged profile.
//
// Two layers, mirroring how `auth-scoping.test.ts` proves Clerk:
//   A. The hook in isolation — the correct per-install session secret authenticates
//      AS the local operator; a missing/wrong bearer 401s; an UNCONFIGURED secret
//      fails closed (nothing authenticates).
//   B. Real routes, real gate, real in-memory DB — the loopback operator is a real
//      OWNER/MEMBER of the seeded local org, so it PASSES the same secured-scope
//      membership + owner gates Clerk fills on hosted; a request without the loopback
//      session is refused. This is the whole H6 requirement #3: the new identity
//      gates the SAME write routes, it is not an open-on-loopback instance.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

// Real in-memory DB for Part B. Set BEFORE importing db/client (module reads it at load).
process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'loopback-auth-test-enc-key'
process.env.MC_DEPLOYMENT_PROFILE = 'packaged'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

import { createLoopbackAuth } from '../middleware/loopback-auth'
import { LOCAL_OPERATOR_USER_ID, LOCAL_ORG_ID, bootstrapLocalOperator } from '../services/loopback-identity'
import { enforceOrgRole, requireOrgMembership } from '../middleware/rbac'

const SECRET = 'test-loopback-session-secret-abc123'

// ─── Part A — the hook in isolation ──────────────────────────────────────────

async function bootHook(sessionSecret: string | undefined) {
  const app = Fastify({ logger: false })
  await app.register(async (secured) => {
    secured.addHook('onRequest', createLoopbackAuth({ sessionSecret }))
    secured.get('/whoami', async (req) => ({ auth: (req as any).auth ?? null, userId: (req as any).userId ?? null }))
  })
  await app.ready()
  return app
}

test('[H6] a valid loopback session secret authenticates AS the local operator', async () => {
  const app = await bootHook(SECRET)
  const res = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${SECRET}` } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.userId, LOCAL_OPERATOR_USER_ID)
  assert.equal(body.auth.userId, LOCAL_OPERATOR_USER_ID)
  assert.equal(body.auth.claims.loopback, true)
  await app.close()
})

test('[H6] a missing or wrong bearer is 401 (not an open instance)', async () => {
  const app = await bootHook(SECRET)
  const none = await app.inject({ method: 'GET', url: '/whoami' })
  assert.equal(none.statusCode, 401, 'no bearer must 401')
  const wrong = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: 'Bearer not-the-secret' } })
  assert.equal(wrong.statusCode, 401, 'wrong bearer must 401')
  // A same-length-but-different token still fails (constant-time compare, no length oracle).
  const sameLen = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${'x'.repeat(SECRET.length)}` } })
  assert.equal(sameLen.statusCode, 401, 'same-length wrong bearer must 401')
  await app.close()
})

test('[H6] an UNCONFIGURED session secret fails closed — nothing authenticates', async () => {
  const app = await bootHook(undefined)
  // Even presenting an empty/any bearer cannot authenticate when no secret is set.
  const res = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: 'Bearer ' } })
  assert.equal(res.statusCode, 401)
  const res2 = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: 'Bearer anything' } })
  assert.equal(res2.statusCode, 401)
  await app.close()
})

// ─── Part B — real routes, real gate, real in-memory DB ──────────────────────

let db: any, schema: any
let orgRoutes: any

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ orgRoutes } = await import('../routes/all'))
  // Seed the local operator + local org exactly as index.ts does on a packaged boot.
  await bootstrapLocalOperator(db)
})

async function bootSecured() {
  const app = Fastify({ logger: false })
  await app.register(async (secured) => {
    // The SAME wiring as src/index.ts's secured scope, but with loopbackAuth as the
    // identity source (packaged) instead of clerkAuth (hosted).
    secured.addHook('onRequest', createLoopbackAuth({ sessionSecret: SECRET }))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(orgRoutes)
  })
  await app.ready()
  return app
}

test('[H6] bootstrapLocalOperator seeds an owned local org, idempotently', async () => {
  // Called once in before(); calling again must not duplicate.
  await bootstrapLocalOperator(db)
  const orgs = await db.select().from(schema.organisations)
  const local = orgs.filter((o: any) => o.id === LOCAL_ORG_ID)
  assert.equal(local.length, 1, 'exactly one local org')
  assert.equal(local[0].ownerId, LOCAL_OPERATOR_USER_ID)
  const members = await db.select().from(schema.orgMembers)
  const owners = members.filter((m: any) => m.orgId === LOCAL_ORG_ID)
  assert.equal(owners.length, 1, 'exactly one owner membership row')
  assert.equal(owners[0].role, 'owner')
})

test('[H6] the loopback operator is treated as OWNER of the local org', async () => {
  const asOwner = await enforceOrgRole({ userId: LOCAL_OPERATOR_USER_ID, orgId: LOCAL_ORG_ID, minRole: 'owner', database: db })
  assert.equal(asOwner.ok, true, 'local operator must be an owner of the local org')
  const asMember = await enforceOrgRole({ userId: LOCAL_OPERATOR_USER_ID, orgId: LOCAL_ORG_ID, minRole: 'member', database: db })
  assert.equal(asMember.ok, true)
  // A different identity is NOT a member of the local org → 403.
  const outsider = await enforceOrgRole({ userId: 'someone-else', orgId: LOCAL_ORG_ID, minRole: 'member', database: db })
  assert.equal(outsider.ok, false)
  assert.equal((outsider as any).code, 403)
})

test('[H6] loopback bearer PASSES the secured membership gate; no bearer is 401', async () => {
  const app = await bootSecured()

  // GET /api/orgs lists the operator's orgs — the local org must be there.
  const listed = await app.inject({ method: 'GET', url: '/api/orgs', headers: { authorization: `Bearer ${SECRET}` } })
  assert.equal(listed.statusCode, 200)
  const ids = (listed.json().orgs as any[]).map((o) => o.id)
  assert.ok(ids.includes(LOCAL_ORG_ID), 'the packaged dashboard sees the local org')

  // A membership-gated org route resolves the operator as a member → not 401/403.
  const detail = await app.inject({ method: 'GET', url: `/api/orgs/${LOCAL_ORG_ID}`, headers: { authorization: `Bearer ${SECRET}` } })
  assert.ok(detail.statusCode < 400, `member must pass the gate, got ${detail.statusCode}`)

  // No loopback session → 401 before the handler (same as hosted without a Clerk JWT).
  const noAuth = await app.inject({ method: 'GET', url: `/api/orgs/${LOCAL_ORG_ID}` })
  assert.equal(noAuth.statusCode, 401)

  await app.close()
})
