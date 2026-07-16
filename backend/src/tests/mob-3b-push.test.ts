// MOB-3B — backend push hardening + approval emit.
//
// Three deliverables, driven against a real in-memory DB and the real secured
// routes (with a stubbed Clerk verifier that treats the bearer token AS the user
// id, exactly like onb3-approval-gate.test.ts — identity is real, only the JWT
// signature check is stood in for):
//
//   1. Identity trust (audit L1): the register/unregister endpoints key a device
//      on the AUTHENTICATED session, never a body-supplied `userId`. A body id
//      that mismatches the session is 403; unregister is scoped to the caller.
//   2. Persistence: tokens live in the `push_tokens` table (survive restart),
//      register upserts (dedupe by token), unregister deletes.
//   3. Approval emit: creating an approval fires a push to the org OWNER's tokens
//      with the approval id in the payload, and never throws into the caller.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'mob3b-key'
process.env.MC_DEPLOYMENT_PROFILE = 'packaged'

let db: any, schema: any, app: FastifyInstance
let registerPushToken: any, unregisterPushToken: any, getPushTokensForUser: any
let sendPushNotification: any, notifyApprovalCreated: any
let eq: any

const ORG = 'org-mob3b'
const OWNER = 'user-owner-mob3b'
const ALICE = 'user-alice'
const BOB = 'user-bob'

// ─── fetch capture — the Expo send path calls global fetch; we record instead ──
let fetchCalls: Array<{ url: string; body: any }> = []
const realFetch = globalThis.fetch
function stubFetch() {
  fetchCalls = []
  globalThis.fetch = (async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return { ok: true, status: 200, json: async () => ({ data: [] }) } as any
  }) as any
}

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ eq } = await import('drizzle-orm'))
  ;({ registerPushToken, unregisterPushToken, getPushTokensForUser, sendPushNotification, notifyApprovalCreated } =
    await import('../services/push'))

  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { notificationRoutes } = await import('../routes/notifications')

  await db.insert(schema.organisations).values({ id: ORG, name: '7Ei', ownerId: OWNER, createdAt: new Date() })

  app = Fastify({ logger: false })
  // Real Clerk hook; verifier maps the bearer token → user id (identity is real,
  // signature check stubbed) — the same trick onb3-approval-gate.test.ts uses.
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    await secured.register(notificationRoutes)
  })
  await app.ready()
})

beforeEach(() => stubFetch())

const register = (as: string | null, payload: any) =>
  app.inject({ method: 'POST', url: '/api/notifications/register', payload, headers: as ? { authorization: `Bearer ${as}` } : {} })
const unregister = (as: string | null, payload: any) =>
  app.inject({ method: 'DELETE', url: '/api/notifications/register', payload, headers: as ? { authorization: `Bearer ${as}` } : {} })

async function rowsFor(userId: string) {
  return db.select().from(schema.pushTokens).where(eq(schema.pushTokens.userId, userId))
}

// ─── Item 2: persistence + upsert service ─────────────────────────────────────

test('[MOB-3B] registerPushToken persists a row; getPushTokensForUser reads it back', async () => {
  await registerPushToken({ userId: ALICE, token: 'ExponentPushToken[a1]', platform: 'ios' })
  const tokens = await getPushTokensForUser(ALICE)
  assert.deepEqual(tokens, ['ExponentPushToken[a1]'])
})

test('[MOB-3B] register upserts — same token twice yields ONE row (dedupe by token)', async () => {
  await registerPushToken({ userId: ALICE, token: 'ExponentPushToken[dup]', platform: 'ios' })
  await registerPushToken({ userId: ALICE, token: 'ExponentPushToken[dup]', platform: 'android' })
  const rows = (await rowsFor(ALICE)).filter((r: any) => r.token === 'ExponentPushToken[dup]')
  assert.equal(rows.length, 1, 'the unique token index must dedupe to one row')
  assert.equal(rows[0].platform, 'android', 'upsert updates platform')
})

test('[MOB-3B] re-registering a device under a new login re-points userId (no orphan dupe)', async () => {
  await registerPushToken({ userId: ALICE, token: 'ExponentPushToken[shared-device]' })
  await registerPushToken({ userId: BOB, token: 'ExponentPushToken[shared-device]' })
  assert.ok(!(await getPushTokensForUser(ALICE)).includes('ExponentPushToken[shared-device]'), 'device no longer belongs to ALICE')
  assert.ok((await getPushTokensForUser(BOB)).includes('ExponentPushToken[shared-device]'), 'device now belongs to BOB')
  // And the re-point did not create a second row for the same device token.
  const dupe = await db.select().from(schema.pushTokens).where(eq(schema.pushTokens.token, 'ExponentPushToken[shared-device]'))
  assert.equal(dupe.length, 1, 'one physical device = one row after re-point')
})

test('[MOB-3B] unregisterPushToken removes only the caller-scoped token', async () => {
  await registerPushToken({ userId: BOB, token: 'ExponentPushToken[bob-del]' })
  await unregisterPushToken({ userId: BOB, token: 'ExponentPushToken[bob-del]' })
  assert.ok(!(await getPushTokensForUser(BOB)).includes('ExponentPushToken[bob-del]'))
})

test('[MOB-3B] sendPushNotification is a no-op (no fetch) when the user has no tokens', async () => {
  await sendPushNotification('user-with-no-devices', 'hi', 'there')
  assert.equal(fetchCalls.length, 0, 'must not call Expo when there is nothing to send to')
})

// ─── Item 1: identity trust (audit L1) ────────────────────────────────────────

test('[MOB-3B] register keys the device on the AUTHENTICATED session, not the body', async () => {
  const res = await register(ALICE, { token: 'ExponentPushToken[authed]' })
  assert.equal(res.statusCode, 200)
  // The row is owned by the session user (ALICE), even with no body userId.
  assert.ok((await getPushTokensForUser(ALICE)).includes('ExponentPushToken[authed]'))
})

test('[MOB-3B] register accepts a body userId that MATCHES the session', async () => {
  const res = await register(ALICE, { userId: ALICE, token: 'ExponentPushToken[match]' })
  assert.equal(res.statusCode, 200)
  assert.ok((await getPushTokensForUser(ALICE)).includes('ExponentPushToken[match]'))
})

test('[MOB-3B] register REJECTS (403) a body userId spoofing another user — the L1 exploit', async () => {
  const res = await register(ALICE, { userId: BOB, token: 'ExponentPushToken[spoof]' })
  assert.equal(res.statusCode, 403, 'a device must never register under another user id')
  // And crucially, no token was written under the victim (BOB).
  assert.ok(!(await getPushTokensForUser(BOB)).includes('ExponentPushToken[spoof]'), 'no cross-user token leak')
})

test('[MOB-3B] register requires authentication (401) and a token (400)', async () => {
  assert.equal((await register(null, { token: 'x' })).statusCode, 401)
  assert.equal((await register(ALICE, {})).statusCode, 400)
})

test('[MOB-3B] unregister cannot delete another user\'s device', async () => {
  await register(ALICE, { token: 'ExponentPushToken[alice-owns]' })
  // BOB tries to unregister ALICE's token (no body userId, so scoped to BOB) → no-op.
  const res = await unregister(BOB, { token: 'ExponentPushToken[alice-owns]' })
  assert.equal(res.statusCode, 200)
  assert.ok((await getPushTokensForUser(ALICE)).includes('ExponentPushToken[alice-owns]'), 'ALICE keeps her device')
})

test('[MOB-3B] unregister with a mismatched body userId is 403', async () => {
  const res = await unregister(ALICE, { userId: BOB, token: 'ExponentPushToken[whatever]' })
  assert.equal(res.statusCode, 403)
})

// ─── Item 3: approval emit ────────────────────────────────────────────────────

test('[MOB-3B] notifyApprovalCreated pushes to the org OWNER with the approval id in the payload', async () => {
  await registerPushToken({ userId: OWNER, token: 'ExponentPushToken[owner-phone]' })
  await notifyApprovalCreated({ id: 'appr-123', orgId: ORG, type: 'memory.write', summary: 'Codey → write recent.md' })
  assert.equal(fetchCalls.length, 1, 'exactly one Expo send')
  const msgs = fetchCalls[0].body
  assert.equal(msgs[0].to, 'ExponentPushToken[owner-phone]', 'sent to the owner device')
  assert.equal(msgs[0].data.approvalId, 'appr-123', 'approval id rides the payload for the deep-link')
  assert.equal(msgs[0].data.type, 'approval')
  assert.equal(msgs[0].data.requiresStepUp, false, 'a non-dangerous type does not need step-up')
})

test('[MOB-3B] a DANGEROUS approval type is flagged step-up in title + payload', async () => {
  await registerPushToken({ userId: OWNER, token: 'ExponentPushToken[owner-phone-2]' })
  await notifyApprovalCreated({ id: 'appr-danger', orgId: ORG, type: 'machine_exec', summary: 'Run: rm -rf /tmp/x' })
  const msgs = fetchCalls[0].body
  assert.equal(msgs[0].data.requiresStepUp, true, 'machine_exec is a dangerous type')
  assert.match(msgs[0].title, /step-up/i, 'the title makes step-up clear')
})

test('[MOB-3B] notifyApprovalCreated NEVER throws — unknown org is a silent no-op', async () => {
  await assert.doesNotReject(notifyApprovalCreated({ id: 'x', orgId: 'no-such-org', type: 'spend', summary: 's' }))
  assert.equal(fetchCalls.length, 0, 'no owner resolved → nothing sent, nothing thrown')
})

test('[MOB-3B] restore global fetch', async () => {
  globalThis.fetch = realFetch
})
