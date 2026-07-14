// Epic ONB / ONB3 — the join flow END TO END, against a REAL database.
//
// This suite exists because ONB2's audit said it had to (M-4): ONB3's route is the
// first one that WRITES, and "no agent row and no token exist before approval" is not
// a claim you can make from a unit test — you have to look in the database.
//
// It also owns the ONB1 audit's **H1** proof: two simultaneous joins against a
// single-use invite, exactly one wins. That test fails against a read-then-write
// consume (both handlers read `used_count = 0` across the await boundary and both
// proceed), and passes only because the consume is one atomic conditional UPDATE.
//
// The DB is a real libSQL, in memory: `DATABASE_URL=':memory:'` is set BEFORE
// `db/client` is imported (hence the dynamic imports below — a static `import` would
// be hoisted above the assignment and connect to `dev.db`). `node --test` gives each
// test FILE its own process, so this cannot leak into another suite.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'onb3-test-key'
// Packaged = loopback-trusted, so the join surface is OPEN. The hosted-and-closed
// posture (production today) is asserted in its own test by flipping this back.
process.env.MC_DEPLOYMENT_PROFILE = 'packaged'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

let db: any, schema: any, app: FastifyInstance
let decrypt: (b: string) => string
let generateInviteToken: () => string, hashToken: (t: string) => string
let JOIN_SECRET_SCOPE: string, JOIN_APPROVAL_TYPE: string

const OWNER = 'user-owner'
const ORG = 'org-1'

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  const setup = await import('../db/setup')
  await setup.setupDatabase()
  ;({ decrypt } = await import('../services/secrets'))
  ;({ generateInviteToken, hashToken } = await import('../services/agent-invites'))
  ;({ JOIN_SECRET_SCOPE, JOIN_APPROVAL_TYPE } = await import('../services/join-requests'))

  const { agentJoinRoutes, agentInviteRoutes } = await import('../routes/agent-invites')
  const { taskRoutes } = await import('../routes/tasks')

  await db.insert(schema.organisations).values({ id: ORG, name: '7Ei', ownerId: OWNER, createdAt: new Date() })
  await db.insert(schema.orgMembers).values({ id: 'm-1', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date() })

  app = Fastify({ logger: false })
  // Public, exactly as src/index.ts registers it.
  await app.register(agentJoinRoutes)
  // The secured scope, with a stand-in for the Clerk hook: `requireOrgRole` reads
  // `req.auth.userId` and checks the real `org_members` row, which is what we want to
  // exercise — the gate itself, not Clerk.
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (req: any) => { req.auth = { userId: OWNER } })
    await secured.register(agentInviteRoutes)
    await secured.register(taskRoutes)   // the generic tri-state decide route (the Inbox card)
  })
  await app.ready()
})

/** Mint an invite straight into the DB and hand back its raw token. */
async function mintInvite(over: Record<string, unknown> = {}): Promise<string> {
  const token = generateInviteToken()
  await db.insert(schema.agentInvites).values({
    id: `inv-${Math.random().toString(36).slice(2, 10)}`,
    orgId: ORG, tokenHash: hashToken(token), allowedAdapterTypes: null,
    maxUses: 1, usedCount: 0, message: null, createdBy: OWNER,
    expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, lastAcceptedAt: null,
    createdAt: new Date(), ...over,
  })
  return token
}

const body = (over: Record<string, unknown> = {}) => ({
  agentName: 'Codey',
  adapterType: 'claude_code',
  capabilities: ['memory:write'],
  agentDefaultsPayload: { workdir: '/Users/x/checkout' },
  ...over,
})

// Each test gets its OWN client IP. The join route is per-IP rate limited (10/min) and
// the limiter's window is module state, so tests that shared an IP would starve each
// other — which is itself a small proof that the limiter is real and is wired on.
let ipSeq = 0
const freshIp = () => `172.16.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`

const join = (token: string, b: unknown = body(), ip: string = freshIp()) =>
  app.inject({ method: 'POST', url: `/api/agent-invites/${token}/join`, payload: b as any, remoteAddress: ip })

const rows = async (table: any, ...where: any[]) => db.select().from(table).where(where.length ? where[0] : undefined)

/** THIS test's invite, by its token — never `invites[0]`, which is whichever invite an
 *  earlier test happened to mint first. */
const inviteRow = async (token: string) =>
  (await rows(schema.agentInvites)).find((i: any) => i.tokenHash === hashToken(token))

// ─── The invariant: a join creates NO agent and NO credential ────────────────

test('[ONB3] a join creates a pending request + an approval card — and NO agent row and NO token anywhere in the DB', async () => {
  const token = await mintInvite()
  const res = await join(token, body({
    adapterType: 'openai_generic',
    agentDefaultsPayload: { baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'sk-live-CANARY' },
  }))

  assert.equal(res.statusCode, 201)
  const out = res.json()
  assert.ok(out.requestId)
  assert.equal(out.status, 'pending_approval')
  assert.equal(out.claimStatus, 'not_yet_open')
  assert.ok(!/mca_|claimSecret|"token"/.test(JSON.stringify(out)), 'the join response must carry no credential')

  // The DB, inspected. This is the assertion the whole epic turns on.
  const agents = await rows(schema.agents)
  assert.equal(agents.length, 0, 'NO agent row may exist before a human approves')

  const jr = await rows(schema.agentJoinRequests)
  assert.equal(jr.length, 1)
  assert.equal(jr[0].status, 'pending_approval')
  assert.equal(jr[0].agentId, null)
  assert.ok(!JSON.stringify(jr[0]).includes('sk-live-CANARY'), 'the secret VALUE must not be in the join-request row')
  assert.deepEqual(JSON.parse(jr[0].secretKeys), ['apiKey'], 'only the key name is persisted')

  // The board's queue item — in the SHIPPED approvals store, not a parallel one.
  const approvals = await rows(schema.approvalRequests)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].type, JOIN_APPROVAL_TYPE)
  assert.equal(approvals[0].status, 'pending')
  assert.ok(!JSON.stringify(approvals[0]).includes('sk-live-CANARY'), 'the approval card must not carry a secret value')

  // The secret: encrypted, and parked in an INERT scope (resolveSecretsForAgent
  // resolves only `company` and `agent`, so no agent can read it).
  const secrets = await rows(schema.secrets)
  assert.equal(secrets.length, 1)
  assert.equal(secrets[0].scope, JOIN_SECRET_SCOPE)
  assert.equal(secrets[0].scopeId, out.requestId)
  assert.notEqual(secrets[0].valueEncrypted, 'sk-live-CANARY', 'stored ciphertext, not plaintext')
  assert.equal(decrypt(secrets[0].valueEncrypted), 'sk-live-CANARY', 'and it is the real value, recoverable only with the key')

  await db.delete(schema.agentJoinRequests)
  await db.delete(schema.approvalRequests)
  await db.delete(schema.secrets)
})

// ─── ONB1 audit H1 — the single-use invariant under concurrency ──────────────
//
// TWO tests, because they prove different halves and only one of them can fail for
// the right reason. Stated plainly, since a future reader will otherwise trust the
// wrong one:
//
//  * The CAS test below drives the **TOCTOU shape itself**: both callers have already
//    read `used_count = 0` and both have already decided the invite is usable — which
//    is exactly the state a read-then-write route reaches — and only then do they
//    consume. A naive consume writes `read + 1 = 1` twice and admits two agents. The
//    atomic `used_count = used_count + 1 WHERE used_count < max_uses` admits one. This
//    is the test that fails if someone reintroduces `consumeUsePatch`.
//  * The route test after it fires two joins at the real endpoint. It is a genuine
//    end-to-end check — but it is NOT the race proof, and it must not be mistaken for
//    one: the in-memory libSQL driver serializes each request's statements, so the
//    second handler's read already sees the first handler's write. I verified that by
//    temporarily reverting the consume to read-then-write: the route test still passed,
//    and the CAS test caught it.

test('[ONB3/H1] the TOCTOU shape: two callers that BOTH read used_count = 0 — exactly one consume wins', async () => {
  const token = await mintInvite({ maxUses: 1 })
  const { isInviteUsable } = await import('../services/agent-invites')
  const { consumeInviteUse } = await import('../services/invite-consume')

  const row = await inviteRow(token)
  // Both callers hold a stale-but-valid read and have both passed the usability check.
  // This is precisely the window a read-then-write consume writes into.
  const readA = { ...row }, readB = { ...row }
  assert.equal(isInviteUsable(readA as any), true)
  assert.equal(isInviteUsable(readB as any), true)
  assert.equal(readA.usedCount, 0)
  assert.equal(readB.usedCount, 0)

  const results = await Promise.all([consumeInviteUse(row.id), consumeInviteUse(row.id)])
  assert.deepEqual(results.filter(Boolean).length, 1, 'exactly ONE consume may win — a naive `set used_count = read + 1` would let both')
  assert.equal((await inviteRow(token)).usedCount, 1, 'the counter is incremented once, in SQL — never twice to the same value')

  // And a third attempt, on an exhausted invite, still fails closed.
  assert.equal(await consumeInviteUse(row.id), false)
})

test('[ONB3/H1] a consume against an invite revoked or expired SINCE the read is refused (the WHERE clause is the state machine)', async () => {
  const { consumeInviteUse } = await import('../services/invite-consume')

  const revoked = await mintInvite()
  let row = await inviteRow(revoked)           // read while active…
  await db.update(schema.agentInvites).set({ revokedAt: new Date() })
    .where((await import('drizzle-orm')).eq(schema.agentInvites.id, row.id))  // …revoked in between…
  assert.equal(await consumeInviteUse(row.id), false, 'a revocation that lands after the read must still stop the consume')
  assert.equal((await inviteRow(revoked)).usedCount, 0)

  const expired = await mintInvite()
  row = await inviteRow(expired)
  await db.update(schema.agentInvites).set({ expiresAt: new Date(Date.now() - 1000) })
    .where((await import('drizzle-orm')).eq(schema.agentInvites.id, row.id))
  assert.equal(await consumeInviteUse(row.id), false, 'expiry is re-checked atomically with the write')
  assert.equal((await inviteRow(expired)).usedCount, 0)
})

test('[ONB3/H1] two SIMULTANEOUS joins on a single-use invite: exactly one wins, and exactly one row is written', async () => {
  const token = await mintInvite({ maxUses: 1 })

  // Fired together, and awaited together. Against a read-then-write consume both
  // handlers read used_count = 0 across the await boundary and both create a request.
  const [a, b] = await Promise.all([
    join(token, body({ agentName: 'RacerA' })),
    join(token, body({ agentName: 'RacerB' })),
  ])

  const codes = [a.statusCode, b.statusCode].sort()
  assert.deepEqual(codes, [201, 404], `exactly one join must win; got ${codes.join(', ')}`)

  const jr = await rows(schema.agentJoinRequests)
  assert.equal(jr.length, 1, 'a single-use invite must produce exactly ONE join request')

  assert.equal((await inviteRow(token)).usedCount, 1, 'the use is spent exactly once — never twice')

  // The loser's 404 is the same flat 404 as an unknown invite: no oracle.
  const loser = a.statusCode === 404 ? a : b
  assert.deepEqual(loser.json(), { error: 'Not found' })

  await db.delete(schema.agentJoinRequests)
  await db.delete(schema.approvalRequests)
})

test('[ONB3/H1] a multi-use invite admits exactly maxUses joins, no more', async () => {
  const token = await mintInvite({ maxUses: 3 })
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => join(token, body({ agentName: `A${i}` }))))
  const won = results.filter(r => r.statusCode === 201).length

  assert.equal(won, 3, `maxUses=3 must admit exactly 3 joins, got ${won}`)
  assert.equal((await rows(schema.agentJoinRequests)).length, 3)
  assert.equal((await inviteRow(token)).usedCount, 3)

  await db.delete(schema.agentJoinRequests)
  await db.delete(schema.approvalRequests)
})

// ─── The board-approval gate ────────────────────────────────────────────────

test('[ONB3] approve → a CONTAINED agent with NO token; the secret is re-scoped to it; a second approve is 409', async () => {
  const token = await mintInvite()
  const joined = (await join(token, body({
    adapterType: 'openai_generic',
    capabilities: ['memory:write', 'machine_exec'],
    agentDefaultsPayload: { baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'sk-live-CANARY' },
  }))).json()

  const res = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/agent-join-requests/${joined.requestId}/approve` })
  assert.equal(res.statusCode, 200)
  const out = res.json()
  assert.equal(out.agentToken, null, 'invariant #4: approving hands the operator no key, because none exists')
  assert.ok(!/mca_/.test(JSON.stringify(out)))

  const agents = await rows(schema.agents)
  assert.equal(agents.length, 1)
  assert.equal(agents[0].trustMode, 'low_trust_review', 'invariant #3: contained regardless of runtime')
  assert.equal(agents[0].apiTokenHash, null, 'invariant #1: no token is minted, hashed or parked before ONB4')
  assert.deepEqual(JSON.parse(agents[0].permissions), ['memory:write', 'machine_exec'])
  assert.equal(agents[0].name, 'Codey')

  const jr = (await rows(schema.agentJoinRequests))[0]
  assert.equal(jr.status, 'approved')
  assert.equal(jr.agentId, agents[0].id)
  assert.equal(jr.decidedBy, OWNER)

  // The queue item closed with it.
  assert.equal((await rows(schema.approvalRequests))[0].status, 'approved')

  // The parked secret is now the agent's — and only now readable by it.
  const secret = (await rows(schema.secrets))[0]
  assert.equal(secret.scope, 'agent')
  assert.equal(secret.scopeId, agents[0].id)
  const { resolveSecretsForAgent } = await import('../services/secrets')
  assert.deepEqual(
    resolveSecretsForAgent([{ scope: secret.scope, scopeId: secret.scopeId, key: secret.key, value: decrypt(secret.valueEncrypted) }], agents[0].id),
    { apiKey: 'sk-live-CANARY' },
  )

  // Decided once, and only once (the CAS on `status = pending_approval`).
  const again = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/agent-join-requests/${joined.requestId}/approve` })
  assert.equal(again.statusCode, 409)
  assert.equal((await rows(schema.agents)).length, 1, 'a re-approve must not create a second agent')

  await db.delete(schema.agents)
  await db.delete(schema.agentJoinRequests)
  await db.delete(schema.approvalRequests)
  await db.delete(schema.secrets)
})

test('[ONB3] reject → no agent, no token, and the secrets the agent sent are DELETED', async () => {
  const token = await mintInvite()
  const joined = (await join(token, body({
    adapterType: 'openai_generic',
    agentDefaultsPayload: { baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'sk-live-CANARY' },
  }))).json()

  const res = await app.inject({ method: 'POST', url: `/api/orgs/${ORG}/agent-join-requests/${joined.requestId}/reject` })
  assert.equal(res.statusCode, 200)

  assert.equal((await rows(schema.agents)).length, 0, 'rejection mints nothing')
  assert.equal((await rows(schema.secrets)).length, 0, 'a rejected agent\'s credentials are destroyed, not kept')
  const jr = (await rows(schema.agentJoinRequests))[0]
  assert.equal(jr.status, 'rejected')
  assert.equal(jr.agentId, null)
  assert.equal((await rows(schema.approvalRequests))[0].status, 'rejected')

  await db.delete(schema.agentJoinRequests)
  await db.delete(schema.approvalRequests)
})

test('[ONB3] deciding the card in the SHIPPED approvals inbox runs the same gate — approving there creates the contained agent', async () => {
  const token = await mintInvite()
  const joined = (await join(token, body({ agentName: 'Inboxy' }))).json()
  const approvalId = (await rows(schema.approvalRequests))[0].id

  // This is what the Governance/Inbox panel calls. If it merely flipped a status,
  // an owner could "approve" a join request and no agent would ever appear.
  const res = await app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decide`, payload: { decision: 'approved' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().agentToken, null)

  const agents = await rows(schema.agents)
  assert.equal(agents.length, 1, 'approving the inbox card must actually create the agent')
  assert.equal(agents[0].name, 'Inboxy')
  assert.equal(agents[0].trustMode, 'low_trust_review')
  assert.equal(agents[0].apiTokenHash, null)
  assert.equal((await rows(schema.agentJoinRequests))[0].status, 'approved')

  await db.delete(schema.agents)
  await db.delete(schema.agentJoinRequests)
  await db.delete(schema.approvalRequests)
})

// ─── The closed states: one flat 404, no oracle ─────────────────────────────

test('[ONB3] unknown / malformed / revoked / expired / exhausted invites all answer the SAME flat 404', async () => {
  const good = await mintInvite()
  const revoked = await mintInvite({ revokedAt: new Date() })
  const expired = await mintInvite({ expiresAt: new Date(Date.now() - 1000) })
  const spent = await mintInvite({ usedCount: 1, maxUses: 1 })

  const cases: Array<[string, string]> = [
    ['not-a-token', 'garbage'],
    ['mci_inv_' + 'f'.repeat(32), 'well-shaped but unknown'],
    [revoked, 'revoked'],
    [expired, 'expired'],
    [spent, 'exhausted'],
  ]
  for (const [token, why] of cases) {
    const res = await join(token, body(), '10.0.0.2')
    assert.equal(res.statusCode, 404, `${why} must be 404`)
    assert.deepEqual(res.json(), { error: 'Not found' }, `${why} must be INDISTINGUISHABLE from unknown`)
  }
  // …and the good one still works, so the 404s above are not just "everything 404s".
  assert.equal((await join(good, body(), '10.0.0.2')).statusCode, 201)

  await db.delete(schema.agentJoinRequests)
  await db.delete(schema.approvalRequests)
})

test('[ONB3-audit] a free-text field in the join body is REFUSED, not ignored (the carried caveat)', async () => {
  const token = await mintInvite()
  // The exact shape the ONB2 re-audit warned about: a secret in free text under an
  // innocuous key. `.strict()` refuses the whole request, so it never reaches a log.
  const res = await join(token, { ...body(), notes: 'my provider key is sk-live-abc123' }, '10.0.0.3')
  assert.equal(res.statusCode, 400)
  assert.ok(!JSON.stringify(res.json()).includes('sk-live-abc123'), 'the error must not echo the submitted value back')

  // Refused means refused: the invite is untouched and nothing was written.
  assert.equal((await rows(schema.agentJoinRequests)).length, 0)
  assert.equal((await inviteRow(token)).usedCount, 0, 'a refused join must not consume a use')
})

// ─── The posture gate: production is CLOSED ─────────────────────────────────

test('[ONB3] hosted profile without MC_ENABLE_REMOTE_ONBOARDING → the join route is a flat 404 (production today)', async () => {
  const token = await mintInvite()
  process.env.MC_DEPLOYMENT_PROFILE = 'hosted'
  delete process.env.MC_ENABLE_REMOTE_ONBOARDING
  try {
    const res = await join(token, body(), '10.0.0.4')
    assert.equal(res.statusCode, 404, 'a hosted deployment must not expose the join surface without an explicit operator enable')
    assert.deepEqual(res.json(), { error: 'Not found' })
    assert.equal((await rows(schema.agentJoinRequests)).length, 0)

    // The flag opens it — which is the operator's decision, and the reason the
    // rate limit and the approval gate had to exist before this PR could flip
    // PUBLIC_JOIN_IMPLEMENTED.
    process.env.MC_ENABLE_REMOTE_ONBOARDING = '1'
    assert.equal((await join(token, body(), '10.0.0.4')).statusCode, 201)
  } finally {
    process.env.MC_DEPLOYMENT_PROFILE = 'packaged'
    delete process.env.MC_ENABLE_REMOTE_ONBOARDING
    await db.delete(schema.agentJoinRequests)
    await db.delete(schema.approvalRequests)
  }
})

// ─── The rate limit (ONB2 re-audit M-3): it exists, and it is on the join route ──

test('[ONB3] the public join endpoint is per-IP rate limited — perIpRateLimit finally has a caller', async () => {
  // A fresh IP, and an unknown (but well-shaped) token so nothing is consumed: we are
  // measuring the limiter, not the invite. 10/min → the 11th request is refused.
  const ghost = 'mci_inv_' + 'a'.repeat(32)
  const ip = '203.0.113.99'
  const codes: number[] = []
  for (let i = 0; i < 12; i++) codes.push((await join(ghost, body(), ip)).statusCode)

  assert.equal(codes.filter(c => c === 404).length, 10, 'the first 10/min are served (and 404, since the invite is unknown)')
  assert.ok(codes.includes(429), 'an 11th request within the window must be rate limited')
  // The limiter is per-IP, so it must not have shut the door on everyone else.
  const token = await mintInvite()
  assert.equal((await join(token, body(), '198.51.100.7')).statusCode, 201, 'a different IP is unaffected')
})
