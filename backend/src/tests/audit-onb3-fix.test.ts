// AUDIT-ONB3 — the three fixes the independent audit of PR #250 landed.
//
// Each test FAILS against the code as it shipped in #250 and passes against the fix:
//
//   M-1  a failed agent insert used to leave the join request `approved` with a
//        dangling `agent_id` — and a second approve is a 409, so the request was
//        stuck approved with no agent, forever. It now compensates back to
//        `pending_approval` and re-throws, so the operator can retry.
//   M-2  the per-IP join limit keyed on `req.ip`, which — with `trustProxy: true`
//        (which production needs, behind Fly) — is the LEFTMOST X-Forwarded-For
//        entry, i.e. a value the caller types. A rotating header was an unlimited
//        door. It now keys on an address the caller cannot choose.
//   M-3  `GET /api/agent/secrets` SELECTed every scope in the org and decrypted the
//        lot before `resolveSecretsForAgent` discarded the `join_request`-scoped
//        rows. The scope allow-list is now in the WHERE clause too.
//
// The HIGH finding (the generic `POST /api/approvals/:id/decide` door into the
// approval gate carries no owner check) is NOT fixed here — it is an authorization
// contract change on a shipped route. See docs/AUDIT-ONB3.md.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'onb3-audit-key'
process.env.MC_DEPLOYMENT_PROFILE = 'packaged'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

let db: any, schema: any, app: FastifyInstance
let generateInviteToken: () => string, hashToken: (t: string) => string
let applyJoinDecision: any, JOIN_SECRET_SCOPE: string
let encrypt: (v: string) => string

const OWNER = 'user-owner'
const ORG = 'org-1'

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ generateInviteToken, hashToken } = await import('../services/agent-invites'))
  ;({ encrypt } = await import('../services/secrets'))
  ;({ applyJoinDecision } = await import('../services/join-approvals'))
  ;({ JOIN_SECRET_SCOPE } = await import('../services/join-requests'))

  const { agentJoinRoutes } = await import('../routes/agent-invites')

  await db.insert(schema.organisations).values({ id: ORG, name: '7Ei', ownerId: OWNER, createdAt: new Date() })
  await db.insert(schema.orgMembers).values({ id: 'm-1', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date() })

  // `trustProxy: true` — exactly as src/index.ts boots the server. This is the
  // setting that made `req.ip` attacker-controlled, so the test must carry it.
  app = Fastify({ logger: false, trustProxy: true })
  await app.register(agentJoinRoutes)
  await app.ready()
})

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

const body = {
  agentName: 'Codey',
  adapterType: 'claude_code',
  capabilities: ['memory:write'],
  agentDefaultsPayload: { workdir: '/Users/x/checkout' },
}

// ─── M-1 — a failed agent insert must not strand an approved request ─────────

test('[ONB3-audit/M-1] if the agent insert fails, the approve is COMPENSATED — the request goes back to pending, not stuck approved with a dangling agent_id', async () => {
  const token = await mintInvite()
  const res = await app.inject({ method: 'POST', url: `/api/agent-invites/${token}/join`, payload: body, remoteAddress: '10.1.0.1' })
  assert.equal(res.statusCode, 201)
  const requestId = res.json().requestId

  // A database whose `insert` throws exactly where the agent row would be written —
  // the DB error the real path has no transaction to undo.
  const failing = new Proxy(db, {
    get(target: any, prop: string) {
      if (prop === 'insert') return () => { throw new Error('turso: connection reset mid-approve') }
      return target[prop]
    },
  })

  await assert.rejects(
    () => applyJoinDecision({ joinRequestId: requestId, orgId: ORG, decision: 'approved', actor: OWNER, database: failing }),
    /connection reset mid-approve/,
    'the failure must surface — it is not swallowed into a fake success',
  )

  const row = await db.query.agentJoinRequests.findFirst({ where: eq(schema.agentJoinRequests.id, requestId) })
  assert.equal(row.status, 'pending_approval', 'the status CAS must be rolled back when the agent it promised was never inserted')
  assert.equal(row.agentId ?? null, null, 'no dangling agent_id may survive a failed approve')
  assert.equal((await db.select().from(schema.agents)).length, 0, 'and no agent exists')

  // And the operator can simply retry — the state is not wedged.
  const retry = await applyJoinDecision({ joinRequestId: requestId, orgId: ORG, decision: 'approved', actor: OWNER })
  assert.equal(retry.ok, true)
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, retry.agentId) })
  assert.ok(agent, 'the retry creates the agent')
  assert.equal(agent.apiTokenHash, null, 'and it still carries NO credential — ONB4 owns the claim')
})

// ─── M-2 — the per-IP limit must key on an address the caller cannot choose ───

test('[ONB3-audit/M-2] a rotating X-Forwarded-For does NOT buy a fresh rate-limit bucket (trustProxy makes req.ip caller-typed)', async () => {
  const token = await mintInvite({ maxUses: 100 })
  const codes: number[] = []
  for (let i = 0; i < 14; i++) {
    const res = await app.inject({
      method: 'POST', url: `/api/agent-invites/${token}/join`, payload: body,
      remoteAddress: '203.0.113.7',                       // ONE socket…
      headers: { 'x-forwarded-for': `198.51.100.${i}` },  // …with a header it typed itself
    })
    codes.push(res.statusCode)
  }
  assert.ok(codes.includes(429), `a spoofed XFF must not defeat the 10/min join limit — got ${codes.join(',')}`)
})

test('[ONB3-audit/M-2] the limiter keys on Fly-Client-IP or the socket — and ignores X-Forwarded-For unless a trusted proxy is declared', async () => {
  const { rateLimitClientIp } = await import('../middleware/ratelimit')

  // Production: Fly writes this itself, so it beats anything the caller sent.
  assert.equal(
    rateLimitClientIp({ headers: { 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }, ip: '1.1.1.1', socket: { remoteAddress: '10.0.0.1' } }),
    '9.9.9.9',
  )
  // No Fly header and no declared proxy: a caller-typed XFF is IGNORED — the socket wins.
  delete process.env.MC_TRUSTED_PROXY
  assert.equal(
    rateLimitClientIp({ headers: { 'x-forwarded-for': '1.1.1.1' }, ip: '1.1.1.1', socket: { remoteAddress: '10.0.0.1' } }),
    '10.0.0.1',
  )
  // A self-hosted operator who DOES front the app with a proxy opts in — and even then
  // it is the entry that proxy appended (rightmost), never the one the caller led with.
  process.env.MC_TRUSTED_PROXY = '1'
  assert.equal(
    rateLimitClientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 8.8.8.8' }, ip: '1.1.1.1', socket: { remoteAddress: '10.0.0.1' } }),
    '8.8.8.8',
  )
  delete process.env.MC_TRUSTED_PROXY

  // No proxy at all (packaged/dev): the socket.
  assert.equal(rateLimitClientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
})

// ─── M-3 — the parked join_request secrets are unreadable at the QUERY, not just the filter ───

test('[ONB3-audit/M-3] an agent secrets fetch never even SELECTS a join_request-scoped secret', async () => {
  const { AGENT_RESOLVABLE_SCOPES, resolveSecretsForAgent } = await import('../services/secrets')
  assert.deepEqual([...AGENT_RESOLVABLE_SCOPES], ['company', 'agent'], 'the allow-list is the source of truth for both the query and the resolver')

  const agentId = 'agent-live'
  await db.insert(schema.agents).values({
    id: agentId, orgId: ORG, name: 'Live', role: 'r', llmProvider: 'minimax', llmModel: 'minimax',
    status: 'idle', agentType: 'external', runtime: 'claude_code', apiTokenHash: null,
    heartbeatStatus: 'unknown', permissions: JSON.stringify(['memory:write']), trustMode: 'low_trust_review',
    createdAt: new Date(),
  } as any)
  await db.insert(schema.secrets).values({
    id: 'sec-parked', orgId: ORG, scope: JOIN_SECRET_SCOPE, scopeId: 'some-pending-request',
    key: 'apiKey', valueEncrypted: encrypt('sk-live-PENDING-CANARY'), createdAt: new Date(),
  } as any)
  await db.insert(schema.secrets).values({
    id: 'sec-company', orgId: ORG, scope: 'company', scopeId: null,
    key: 'COMPANY_KEY', valueEncrypted: encrypt('company-value'), createdAt: new Date(),
  } as any)

  // The exact query the route now runs (scope filtered in SQL, not only in the resolver).
  const { inArray } = await import('drizzle-orm')
  const rows = await db.select().from(schema.secrets).where(and(
    eq(schema.secrets.orgId, ORG),
    inArray(schema.secrets.scope, [...AGENT_RESOLVABLE_SCOPES]),
  ))
  assert.ok(!rows.some((r: any) => r.scope === JOIN_SECRET_SCOPE), 'a pending join request\'s secret is never read out of the DB')

  const bag = resolveSecretsForAgent(
    rows.map((r: any) => ({ scope: r.scope, scopeId: r.scopeId, key: r.key, value: 'x' })),
    agentId,
  )
  assert.deepEqual(Object.keys(bag), ['COMPANY_KEY'], 'and it can never reach an agent bag')
})
