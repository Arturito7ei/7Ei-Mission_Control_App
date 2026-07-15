// AUDIT-ONB3 H-1 — the board-approval gate is now owner-gated on BOTH doors.
//
// The audit proved the exploit: the generic `POST /api/approvals/:id/decide` route —
// the door the shipped Inbox/Governance card actually calls — carried NO membership
// and NO role check. An authenticated user with no `org_members` row for the org
// APPROVED a join and created an agent (200), while the dedicated owner route refused
// the same caller (403). The route has no `:orgId` path param, so `requireOrgRole`
// no-ops on it (R-4), and the MCA-85 leak guard (which only inspects
// `/:orgId|:agentId/` routes) could never see it.
//
// The fix derives the org FROM THE APPROVAL ROW and enforces a role mapped from the
// approval TYPE (`services/approval-authz.ts`): OWNER for agent-minting types
// (`agent_join_request`, `agent_create`, or a `low_trust_review` wrapping one), MEMBER
// for everything else, and membership ALWAYS. Every driven test below FAILS against
// main (where the route has no check) and passes against the fix.
//
// Real route, real gate, real in-memory DB, three real identities (owner / member /
// outsider), driven for BOTH the join card and a generic card.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'onb3-gate-key'
process.env.MC_DEPLOYMENT_PROFILE = 'packaged'
delete process.env.MC_ENABLE_REMOTE_ONBOARDING

let db: any, schema: any, app: FastifyInstance
let generateInviteToken: () => string, hashToken: (t: string) => string
let randomUUID: () => string

const ORG = 'org-1'
const OWNER = 'user-owner'      // org_members role = owner
const MEMBER = 'user-member'    // org_members role = member
const OUTSIDER = 'user-outsider' // NO org_members row for ORG

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ generateInviteToken, hashToken } = await import('../services/agent-invites'))
  ;({ randomUUID } = await import('crypto'))

  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { agentJoinRoutes, agentInviteRoutes } = await import('../routes/agent-invites')
  const { taskRoutes } = await import('../routes/tasks')

  await db.insert(schema.organisations).values({ id: ORG, name: '7Ei', ownerId: OWNER, createdAt: new Date() })
  await db.insert(schema.orgMembers).values([
    { id: 'm-owner', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date() },
    { id: 'm-member', orgId: ORG, userId: MEMBER, role: 'member', createdAt: new Date() },
  ])
  // OUTSIDER is a valid Clerk user (authenticates fine) but is NOT a member of ORG.

  app = Fastify({ logger: false })
  await app.register(agentJoinRoutes) // public join surface
  // The real Clerk hook, with a verifier that treats the bearer token AS the user id —
  // so we can act as owner / member / outsider without reaching Clerk's JWKS. Identity
  // is real (req.auth.userId is set exactly as production sets it); only the signature
  // check is stubbed. The gate then reads the REAL org_members rows.
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    await secured.register(agentInviteRoutes)
    await secured.register(taskRoutes)
  })
  await app.ready()
})

// ─── helpers ─────────────────────────────────────────────────────────────────

let ipSeq = 0
const freshIp = () => `172.20.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`

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

const joinBody = {
  agentName: 'Codey', adapterType: 'claude_code',
  capabilities: ['memory:write'], agentDefaultsPayload: { workdir: '/Users/x/checkout' },
}

/** Run the real public join flow and return the id of the `agent_join_request` card. */
async function newJoinCard(): Promise<string> {
  const token = await mintInvite()
  const res = await app.inject({ method: 'POST', url: `/api/agent-invites/${token}/join`, payload: joinBody, remoteAddress: freshIp() })
  assert.equal(res.statusCode, 201, 'join must file a pending card')
  const requestId = res.json().requestId
  const rows = await db.select().from(schema.approvalRequests)
  const card = rows.find((r: any) => (r.payload as any)?.joinRequestId === requestId)
  assert.ok(card, 'the join must have created its approval card')
  return card.id
}

/** Insert a generic (non-join) approval card of a given type; returns its id. */
async function newGenericCard(type: string): Promise<string> {
  const id = randomUUID()
  await db.insert(schema.approvalRequests).values({
    id, orgId: ORG, type, summary: `${type} card`, payload: null, status: 'pending',
    requestedByAgentId: null, decidedBy: null, decidedAt: null, createdAt: new Date(),
  } as any)
  return id
}

const decide = (approvalId: string, as: string | null, decision = 'approved') =>
  app.inject({
    method: 'POST', url: `/api/approvals/${approvalId}/decide`,
    payload: { decision },
    headers: as ? { authorization: `Bearer ${as}` } : {},
  })

// ─── the non-member is refused on EVERY door ─────────────────────────────────

test('[ONB3-H1] an authenticated NON-MEMBER gets 403 deciding a join card — and no agent is created', async () => {
  const card = await newJoinCard()
  const agentsBefore = (await db.select().from(schema.agents)).length

  const res = await decide(card, OUTSIDER)
  assert.equal(res.statusCode, 403, 'a caller with no org_members row must not decide a join')
  assert.match(res.json().error, /member/i)

  assert.equal((await db.select().from(schema.agents)).length, agentsBefore, 'the refused decide must mint NO agent (the exploit)')
  const cardRow = await db.query.approvalRequests.findFirst({ where: (await import('drizzle-orm')).eq(schema.approvalRequests.id, card) })
  assert.equal(cardRow.status, 'pending', 'the card stays pending — the decision never ran')
})

test('[ONB3-H1] a NON-MEMBER gets 403 deciding a generic (lower-stakes) card too — membership is always required', async () => {
  const card = await newGenericCard('spend')
  const res = await decide(card, OUTSIDER)
  assert.equal(res.statusCode, 403)
  const cardRow = await db.query.approvalRequests.findFirst({ where: (await import('drizzle-orm')).eq(schema.approvalRequests.id, card) })
  assert.equal(cardRow.status, 'pending')
})

test('[ONB3-H1] an UNAUTHENTICATED decide is 401 (Clerk scope), never reaching the handler', async () => {
  const card = await newGenericCard('spend')
  const res = await decide(card, null)
  assert.equal(res.statusCode, 401)
})

// ─── the member: refused on agent-minting, allowed on lower-stakes ───────────

test('[ONB3-H1] a MEMBER (non-owner) gets 403 deciding an agent_join_request — minting is owner-only', async () => {
  const card = await newJoinCard()
  const res = await decide(card, MEMBER)
  assert.equal(res.statusCode, 403, 'a member may not approve a join (it would mint an agent)')
  assert.match(res.json().error, /owner/i)
  assert.equal((await db.select().from(schema.agents)).length, 0, 'still no agent')
})

test('[ONB3-H1] a MEMBER (non-owner) gets 403 deciding an agent_create card — the other agent-minting type', async () => {
  const card = await newGenericCard('agent_create')
  const res = await decide(card, MEMBER)
  assert.equal(res.statusCode, 403)
  assert.match(res.json().error, /owner/i)
})

test('[ONB3-H1] a MEMBER (non-owner) CAN decide a lower-stakes card (spend) — we do not over-restrict everyday approvals', async () => {
  const card = await newGenericCard('spend')
  const res = await decide(card, MEMBER)
  assert.equal(res.statusCode, 200, 'a member decides everyday, non-minting cards')
  const cardRow = await db.query.approvalRequests.findFirst({ where: (await import('drizzle-orm')).eq(schema.approvalRequests.id, card) })
  assert.equal(cardRow.status, 'approved')
})

// ─── the owner: allowed on everything ────────────────────────────────────────

test('[ONB3-H1] an OWNER may decide an agent_join_request card — approving mints the contained agent', async () => {
  const card = await newJoinCard()
  const res = await decide(card, OWNER)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().agentToken, null, 'invariant #4: no token is minted')
  const agents = await db.select().from(schema.agents)
  assert.equal(agents.length, 1, 'the owner approval created exactly one agent')
  assert.equal(agents[0].trustMode, 'low_trust_review', 'invariant #3: contained')
  assert.equal(agents[0].apiTokenHash, null)
  await db.delete(schema.agents)
})

test('[ONB3-H1] an OWNER may decide an agent_create card and a lower-stakes card', async () => {
  const mint = await newGenericCard('agent_create')
  assert.equal((await decide(mint, OWNER)).statusCode, 200, 'owner decides agent-minting')

  const everyday = await newGenericCard('summarize')
  assert.equal((await decide(everyday, OWNER)).statusCode, 200, 'owner decides everyday too')
})

// ─── the pure helper: data-driven, fail-closed ───────────────────────────────

test('[ONB3-H1] requiredRoleForApproval — owner for agent-minting, member for the rest, owner (fail-closed) for unknown/malformed', async () => {
  const { requiredRoleForApproval, isAgentMintingApproval, AGENT_MINTING_APPROVAL_TYPES } =
    await import('../services/approval-authz')

  // agent-minting → owner
  assert.equal(requiredRoleForApproval({ type: 'agent_join_request' }), 'owner')
  assert.equal(requiredRoleForApproval({ type: 'agent_create' }), 'owner')
  assert.equal(requiredRoleForApproval({ type: 'Agent_Create' }), 'owner', 'normalized (case/space)')
  // a low_trust_review wrapping an agent-minting action is minting too
  assert.equal(requiredRoleForApproval({ type: 'low_trust_review', actionType: 'agent_create' }), 'owner')
  assert.equal(isAgentMintingApproval('low_trust_review', 'agent_create'), true)

  // everyday non-minting → member
  for (const t of ['spend', 'hire', 'summarize', 'deploy', 'external_action', 'email_send', 'wallet_tx', 'machine_exec', 'low_trust_review']) {
    assert.equal(requiredRoleForApproval({ type: t }), 'member', `${t} → member`)
  }
  // a low_trust_review wrapping a NON-minting action stays member
  assert.equal(requiredRoleForApproval({ type: 'low_trust_review', actionType: 'file_destructive' }), 'member')

  // malformed / absent → owner (fail closed)
  for (const t of [undefined, null, '', '   ', 42 as any]) {
    assert.equal(requiredRoleForApproval({ type: t }), 'owner', `malformed(${String(t)}) → owner`)
  }

  assert.deepEqual([...AGENT_MINTING_APPROVAL_TYPES], ['agent_join_request', 'agent_create'])
})
