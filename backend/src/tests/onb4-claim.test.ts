// Epic ONB / ONB4 — the ONE-TIME CLAIM, END TO END, against a REAL database.
//
// The most security-critical surface in the epic: it mints and hands over the actual
// `mca_` credential. This suite is the acceptance evidence, driven (not reasoned):
//
//   * the fail-closed matrix — unapproved / wrong secret / expired / already-claimed /
//     missing agent row / malformed body — each ONE identical flat 404, no oracle;
//   * the happy path — the raw token returned EXACTLY ONCE, stored hash-only on the
//     agent, never in plaintext anywhere in the DB;
//   * the concurrency proof — two simultaneous claims yield EXACTLY ONE token;
//   * posture gating — hosted-without-remote-onboarding answers the same flat 404;
//   * log redaction — a claim secret / agent token is masked out of logs.
//
// Real libSQL in memory: `DATABASE_URL=':memory:'` is set BEFORE `db/client` imports.
// `node --test` gives each test FILE its own process, so nothing leaks across suites.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'onb4-test-key'
// Packaged = loopback-trusted, so the WHOLE flow (join + claim) is open. The
// hosted-and-closed posture (production today) is exercised in its own test below.
process.env.MC_DEPLOYMENT_PROFILE = 'packaged'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

let db: any, schema: any, app: FastifyInstance
let generateInviteToken: () => string, hashToken: (t: string) => string
let redactPath: (s: string) => string, redactTokensInText: (s: string) => string

const OWNER = 'user-owner'
const ORG = 'org-1'

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  const setup = await import('../db/setup')
  await setup.setupDatabase()
  ;({ generateInviteToken, hashToken } = await import('../services/agent-invites'))
  ;({ redactPath, redactTokensInText } = await import('../services/log-redaction'))

  const { agentJoinRoutes, agentInviteRoutes } = await import('../routes/agent-invites')

  await db.insert(schema.organisations).values({ id: ORG, name: '7Ei', ownerId: OWNER, createdAt: new Date() })
  await db.insert(schema.orgMembers).values({ id: 'm-1', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date() })

  app = Fastify({ logger: false })
  await app.register(agentJoinRoutes)                 // public: join + claim
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (req: any) => { req.auth = { userId: OWNER } })
    await secured.register(agentInviteRoutes)          // owner: approve/reject
  })
  await app.ready()
})

// ─── Harness ─────────────────────────────────────────────────────────────────

async function mintInvite(): Promise<string> {
  const token = generateInviteToken()
  await db.insert(schema.agentInvites).values({
    id: `inv-${Math.random().toString(36).slice(2, 10)}`,
    orgId: ORG, tokenHash: hashToken(token), allowedAdapterTypes: null,
    maxUses: 1, usedCount: 0, message: null, createdBy: OWNER,
    expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, lastAcceptedAt: null,
    createdAt: new Date(),
  })
  return token
}

let ipSeq = 0
const freshIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`

const joinBody = (over: Record<string, unknown> = {}) => ({
  agentName: 'Codey', adapterType: 'claude_code',
  capabilities: ['memory:write'], agentDefaultsPayload: { workdir: '/Users/x/checkout' }, ...over,
})

const join = (token: string, ip = freshIp()) =>
  app.inject({ method: 'POST', url: `/api/agent-invites/${token}/join`, payload: joinBody(), remoteAddress: ip })

const approve = (requestId: string) =>
  app.inject({ method: 'POST', url: `/api/orgs/${ORG}/agent-join-requests/${requestId}/approve` })

const claim = (requestId: string, claimSecret: unknown, ip = freshIp()) =>
  app.inject({ method: 'POST', url: `/api/agent-join-requests/${requestId}/claim-api-key`, payload: { claimSecret } as any, remoteAddress: ip })

const rows = async (table: any) => db.select().from(table)
const agentById = async (id: string) => (await rows(schema.agents)).find((a: any) => a.id === id)

/** Join, then approve — the state ONB4 claims from. Returns { requestId, claimSecret, agentId }. */
async function joinAndApprove() {
  const token = await mintInvite()
  const j = (await join(token)).json()
  const a = await approve(j.requestId)
  assert.equal(a.statusCode, 200, 'owner approve should succeed')
  const jr = (await rows(schema.agentJoinRequests)).find((r: any) => r.id === j.requestId)
  return { requestId: j.requestId as string, claimSecret: j.claimSecret as string, agentId: jr.agentId as string }
}

// ─── The happy path: the token, exactly once, hash-only at rest ──────────────

test('[ONB4] claim after approval returns the raw mca_ token EXACTLY ONCE, stored hash-only', async () => {
  const { requestId, claimSecret, agentId } = await joinAndApprove()

  // Approved but not yet claimed: the agent exists, CONTAINED, with a NULL token hash.
  const before = await agentById(agentId)
  assert.equal(before.apiTokenHash, null, 'an approved-but-unclaimed agent authenticates to nothing')
  assert.equal(before.trustMode, 'low_trust_review', 'invariant #3: contained regardless of runtime')

  const res = await claim(requestId, claimSecret)
  assert.equal(res.statusCode, 200)
  const out = res.json()
  assert.ok(/^mca_[0-9a-f]{64}$/.test(out.token), 'the raw agent token is returned, once')
  assert.equal(out.tokenType, 'agent')
  assert.equal(out.agentId, agentId)
  assert.ok(out.baseUrl, 'the agent is told its base URL')

  // The agent row now carries the HASH of that token — and only the hash. The raw
  // token is nowhere in the DB.
  const after = await agentById(agentId)
  assert.equal(after.apiTokenHash, hashToken(out.token), 'the agent stores sha256(token)')
  const wholeDb = JSON.stringify([await rows(schema.agents), await rows(schema.agentJoinRequests)])
  assert.ok(!wholeDb.includes(out.token), 'the RAW token must never be persisted anywhere')

  // The claim is spent: the join request is stamped claimed and its secret hash CLEARED.
  const jr = (await rows(schema.agentJoinRequests)).find((r: any) => r.id === requestId)
  assert.ok(jr.claimedAt, 'claimed_at is stamped')
  assert.equal(jr.claimSecretHash, null, 'the stored claim secret hash is cleared on claim')
})

test('[ONB4] a second claim (replay) is a flat 404, and no second token is minted', async () => {
  const { requestId, claimSecret, agentId } = await joinAndApprove()

  const first = await claim(requestId, claimSecret)
  assert.equal(first.statusCode, 200)
  const mintedHash = (await agentById(agentId)).apiTokenHash

  const replay = await claim(requestId, claimSecret)
  assert.equal(replay.statusCode, 404, 'a spent claim is indistinguishable from unknown')
  assert.deepEqual(replay.json(), { error: 'Not found' })

  // The token hash is UNCHANGED — the replay minted nothing.
  assert.equal((await agentById(agentId)).apiTokenHash, mintedHash, 'no second token was minted')
})

// ─── The fail-closed matrix: every failure is ONE identical flat 404 ─────────

test('[ONB4] claim BEFORE approval is a flat 404 (no oracle for approval status)', async () => {
  const token = await mintInvite()
  const j = (await join(token)).json()
  // No approval. The request is pending; its agent does not exist.
  const res = await claim(j.requestId, j.claimSecret)
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'Not found' })
  const jr = (await rows(schema.agentJoinRequests)).find((r: any) => r.id === j.requestId)
  assert.equal(jr.status, 'pending_approval', 'still pending — the claim did not decide anything')
  assert.equal(jr.agentId, null, 'no agent, and certainly no token, for this request')
  assert.equal(jr.claimedAt, null, 'the claim did not consume the secret of an unapproved request')
})

test('[ONB4] a WRONG claim secret is a flat 404 — and the constant-time compare never mints', async () => {
  const { requestId, agentId } = await joinAndApprove()
  const res = await claim(requestId, 'mcc_' + 'b'.repeat(64))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'Not found' })
  assert.equal((await agentById(agentId)).apiTokenHash, null, 'a wrong secret mints nothing')
})

test('[ONB4] a malformed / missing claim secret is the SAME flat 404 (no field-level echo)', async () => {
  const { requestId } = await joinAndApprove()
  for (const bad of [undefined, '', 'not-a-secret', 12345, { nope: 1 }]) {
    const res = await claim(requestId, bad as any)
    assert.equal(res.statusCode, 404, `bad secret ${JSON.stringify(bad)} must be 404`)
    assert.deepEqual(res.json(), { error: 'Not found' }, 'no field-level echo — the body may carry a credential')
  }
})

test('[ONB4] an EXPIRED claim secret is a flat 404', async () => {
  const { requestId, claimSecret, agentId } = await joinAndApprove()
  // Age the claim secret out.
  await db.update(schema.agentJoinRequests)
    .set({ claimSecretExpiresAt: new Date(Date.now() - 1000) })
    .where((await import('drizzle-orm')).eq(schema.agentJoinRequests.id, requestId))
  const res = await claim(requestId, claimSecret)
  assert.equal(res.statusCode, 404)
  assert.equal((await agentById(agentId)).apiTokenHash, null, 'an expired secret mints nothing')
})

test('[ONB4] a MISSING agent row is a flat 404 — never trust status=approved alone (ONB3 auditor #3)', async () => {
  const { requestId, claimSecret, agentId } = await joinAndApprove()
  // The M-1 shape: an "approved" request whose agent row is gone. The claim must NOT
  // mint against a ghost — it re-reads the agent and fails closed when it is absent.
  const { eq } = await import('drizzle-orm')
  await db.delete(schema.agents).where(eq(schema.agents.id, agentId))
  const res = await claim(requestId, claimSecret)
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'Not found' })
})

test('[ONB4] an unknown requestId is a flat 404', async () => {
  const res = await claim('00000000-0000-0000-0000-000000000000', 'mcc_' + 'c'.repeat(64))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'Not found' })
})

// ─── The concurrency proof: two simultaneous claims → EXACTLY ONE token ──────

test('[ONB4] two simultaneous claims yield EXACTLY ONE token (claimed_at CAS)', async () => {
  const { requestId, claimSecret, agentId } = await joinAndApprove()

  const [a, b] = await Promise.all([
    claim(requestId, claimSecret),
    claim(requestId, claimSecret),
  ])
  const codes = [a.statusCode, b.statusCode].sort()
  assert.deepEqual(codes, [200, 404], 'exactly one claim wins; the other is the flat 404')

  const winner = a.statusCode === 200 ? a : b
  const token = winner.json().token
  assert.ok(/^mca_[0-9a-f]{64}$/.test(token))
  // The agent ends with EXACTLY ONE token hash — the winner's, and no double-mint.
  assert.equal((await agentById(agentId)).apiTokenHash, hashToken(token))

  // The join request is claimed exactly once, secret cleared.
  const jr = (await rows(schema.agentJoinRequests)).find((r: any) => r.id === requestId)
  assert.ok(jr.claimedAt)
  assert.equal(jr.claimSecretHash, null)
})

// Also prove the single-use property at the SERVICE level, where the TOCTOU is
// reproducible without the route's DB-serialization masking it.
test('[ONB4] claimApiKey is single-use even when two callers both pass the pre-checks', async () => {
  const { claimApiKey } = await import('../services/claim')
  const { requestId, claimSecret, agentId } = await joinAndApprove()

  const [r1, r2] = await Promise.all([
    claimApiKey({ joinRequestId: requestId, claimSecret }),
    claimApiKey({ joinRequestId: requestId, claimSecret }),
  ])
  const wins = [r1, r2].filter((r) => r.ok === true)
  assert.equal(wins.length, 1, 'exactly one caller may mint')
  const won = wins[0] as { ok: true; token: string }
  assert.equal((await agentById(agentId)).apiTokenHash, hashToken(won.token))
})

// ─── Posture gating: hosted-without-remote-onboarding is the same flat 404 ───

test('[ONB4] hosted without MC_ENABLE_REMOTE_ONBOARDING → the claim route is a flat 404', async () => {
  const { requestId, claimSecret, agentId } = await joinAndApprove()
  const prevProfile = process.env.MC_DEPLOYMENT_PROFILE
  process.env.MC_DEPLOYMENT_PROFILE = 'hosted'
  delete process.env.MC_ENABLE_REMOTE_ONBOARDING     // the live-backend posture today
  try {
    const res = await claim(requestId, claimSecret)
    assert.equal(res.statusCode, 404, 'posture-closed is indistinguishable from unknown')
    assert.deepEqual(res.json(), { error: 'Not found' })
    assert.equal((await agentById(agentId)).apiTokenHash, null, 'no token minted while the flow is shut')
  } finally {
    process.env.MC_DEPLOYMENT_PROFILE = prevProfile
  }
})

// ─── Log redaction covers the claim credentials (`log-redaction.ts`, mcc_/mca_) ──

test('[ONB4] a claim secret and an agent token are redacted out of logs', () => {
  const secret = 'mcc_' + 'a'.repeat(64)
  const token = 'mca_' + 'f'.repeat(64)
  assert.equal(redactPath(`/api/agent-invites/${secret}/onboarding.txt`), '/api/agent-invites/:token/onboarding.txt')
  assert.ok(!redactTokensInText(`claim failed with ${secret} and token ${token}`).includes(secret))
  assert.ok(!redactTokensInText(`token ${token}`).includes(token))
})
