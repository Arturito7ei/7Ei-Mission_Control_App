// ─── GC-0b — the agents DENY-LIST hole (cross-org move + trust escalation) ────
//
// `PATCH /api/agents/:agentId` was a DENY-LIST: it deleted exactly one key
// (`permissions`) and spread the rest of the body into `db.update().set()`. A
// deny-list is how this route got here — every column NOT named stayed writable.
//
// Two live escalations followed:
//
//   1. CROSS-ORG MOVE. `orgId` is a column, so a member of org A could re-home an
//      agent into org B. The gate cannot catch it: `resolveRequestOrg` derives this
//      route's org FROM THE AGENT ROW and reads it BEFORE the handler mutates that
//      row — it authorises the pre-image of a write that rewrites the pre-image.
//
//   2. TRUST ESCALATION INTO THE CONNECTOR GATE. `trustMode` is owner-gated on
//      `PUT /api/orgs/:orgId/agents/:agentId/trust`, but a plain MEMBER could set
//      `{"trustMode":"autonomous"}` here. Trust level is what CONN-7 consults to
//      decide whether a connector write needs human approval, so this was a
//      member-reachable bypass of the connector execution gate.
//
// The suite therefore asserts the two surfaces cannot DISAGREE: anything the sibling
// owner-gated PUT protects must be unreachable for a member through this PATCH.
//
// Behavioural: real routes, real gate, real in-memory DB. Every assertion was watched
// to fail against the pre-fix handler and pass after.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0b-agent-authz-key'

let db: any, schema: any
let app: FastifyInstance

const ORG_A = 'gc0ba-org-a'
const ORG_B = 'gc0ba-org-b'
const MEMBER_A = 'gc0ba-member-a' // plain member of ORG_A — the exploit identity
const OWNER_A = 'gc0ba-owner-a'   // owner of ORG_A — the legitimate path
const MEMBER_B = 'gc0ba-member-b'
const AGENT_A = 'gc0ba-agent-a'   // lives in ORG_A
const AGENT_B = 'gc0ba-agent-b'   // lives in ORG_B
const PEER_A = 'gc0ba-peer-a'     // a second ORG_A agent, for advisor wiring

const CREATED_AT = new Date('2020-01-01T00:00:00Z')

const agentRow = (id: string, orgId: string, name: string) => ({
  id, orgId, name, role: 'Engineer', personality: 'terse', llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-20250514', status: 'idle', agentType: 'standard',
  runtime: 'internal', trustMode: 'standard', permissions: null, apiTokenHash: null,
  createdAt: CREATED_AT,
})

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { agentRoutes } = await import('../routes/agents')

  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', ownerId: OWNER_A, createdAt: new Date() },
    { id: ORG_B, name: 'Org B', ownerId: 'gc0ba-owner-b', createdAt: new Date() },
  ])
  await db.insert(schema.orgMembers).values([
    { id: 'gc0ba-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
    { id: 'gc0ba-o-a', orgId: ORG_A, userId: OWNER_A, role: 'owner', createdAt: new Date() },
    { id: 'gc0ba-m-b', orgId: ORG_B, userId: MEMBER_B, role: 'member', createdAt: new Date() },
  ])

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(agentRoutes)
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
  (await db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0]

// PER-TEST RESET — see the skills suite for why this is load-bearing. Without it the
// first successful exploit moves AGENT_A into ORG_B and every later probe 403s,
// passing for the wrong reason and hiding exactly the Criticals this file exists for.
beforeEach(async () => {
  await db.delete(schema.agents)
  await db.insert(schema.agents).values([
    agentRow(AGENT_A, ORG_A, 'Agent A'),
    agentRow(PEER_A, ORG_A, 'Peer A'),
    agentRow(AGENT_B, ORG_B, 'Agent B'),
  ] as any)
})

// ── PROOF THE ISOLATION IS REAL ───────────────────────────────────────────────

test('[GC-0b] per-test isolation — step 1 legitimately mutates the agent', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { personality: 'MUTATED BY STEP 1' })
  assert.equal(res.statusCode, 200)
  assert.equal((await row(AGENT_A)).personality, 'MUTATED BY STEP 1')
})

test('[GC-0b] per-test isolation is real — step 2 sees a PRISTINE agent', async () => {
  const a = await row(AGENT_A)
  assert.equal(a.personality, 'terse', 'PER-TEST RESET IS NOT RUNNING: this suite would pass for the wrong reason')
  assert.equal(a.orgId, ORG_A, 'agent tenancy leaked across tests')
  assert.equal(a.trustMode, 'standard', 'trust state leaked across tests')
})

// ── EXPLOIT 1 — the cross-org move ────────────────────────────────────────────

test('[GC-0b] a member of org A CANNOT re-home an agent into org B', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { orgId: ORG_B })
  const after = await row(AGENT_A)
  assert.equal(after.orgId, ORG_A, `CROSS-ORG WRITE: agent escaped ORG_A into ${after.orgId} (status ${res.statusCode})`)
})

test('[GC-0b] `orgId` is rejected even alongside a legitimate field', async () => {
  await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { personality: 'Renamed', orgId: ORG_B })
  const after = await row(AGENT_A)
  assert.equal(after.orgId, ORG_A, 'CROSS-ORG WRITE smuggled alongside a legitimate field')
  assert.equal(after.personality, 'Renamed', 'the legitimate field did not land')
})

// ── EXPLOIT 2 — trust escalation into the CONN-7 connector gate ───────────────

test('[GC-0b] a MEMBER cannot set `trustMode` via PATCH (the CONN-7 bypass)', async () => {
  // THE CRITICAL. Trust level governs whether a connector write needs approval, so a
  // member-writable trustMode is a privilege escalation INTO the execution gate.
  for (const mode of ['autonomous', 'standard', 'low_trust_review']) {
    await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { trustMode: mode })
  }
  const after = await row(AGENT_A)
  assert.equal(after.trustMode, 'standard',
    `TRUST ESCALATION: a plain member set trustMode to "${after.trustMode}" through the legacy PATCH`)
})

test('[GC-0b] a MEMBER cannot widen `trustBoundary` via PATCH', async () => {
  await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { trustBoundary: JSON.stringify({ projects: ['*'] }) })
  assert.equal((await row(AGENT_A)).trustBoundary, null, 'a member widened a contained agent\'s boundary')
})

test('[GC-0b] a MEMBER cannot set `permissions` via PATCH (the capability caps)', async () => {
  // This was the ONE key the old deny-list removed. It must stay closed under the
  // allow-list — and now for a structural reason rather than a hand-maintained delete.
  await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { permissions: JSON.stringify(['*']) })
  assert.equal((await row(AGENT_A)).permissions, null, 'a member rewrote capability caps')
})

test('[GC-0b] the two surfaces cannot DISAGREE — every owner-gated field is member-unreachable here', async () => {
  // The cross-check the story asks for, stated as one property: a field that requires
  // the OWNER on its dedicated PUT must not be settable by a MEMBER through this PATCH.
  //   config       → PUT …/agents/:agentId/config        (CONFIG_FIELDS)
  //   permissions  → PUT …/agents/:agentId/permissions
  //   trust        → PUT …/agents/:agentId/trust
  //   model-profile→ PUT …/agents/:agentId/model-profile
  const { CONFIG_FIELDS } = await import('../services/agent-config')
  const OWNER_GATED = [
    ...CONFIG_FIELDS,
    'permissions', 'trustMode', 'trustBoundary',
    'cheapModel', 'cheapModelEnabled', 'reasoningEffort',
  ]
  const before = await row(AGENT_A)
  for (const field of OWNER_GATED) {
    const probe = field === 'cheapModelEnabled' ? true : 'attacker-value'
    await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { [field]: probe })
    const after = await row(AGENT_A)
    assert.deepEqual(after[field], before[field],
      `OWNER-GATED FIELD \`${field}\` was written by a MEMBER through the legacy PATCH — the two surfaces disagree`)
  }
})

test('[GC-0b] `apiTokenHash` — the agent CREDENTIAL — is not writable', async () => {
  // A writable token hash lets a member mint themselves a working agent token and act
  // as the agent against the whole agent API.
  await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { apiTokenHash: 'a'.repeat(64) })
  assert.equal((await row(AGENT_A)).apiTokenHash, null, 'AGENT CREDENTIAL was attacker-writable')
})

test('[GC-0b] `externalEndpoint` (an egress target) is not writable', async () => {
  await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { externalEndpoint: 'http://169.254.169.254/latest/meta-data/' })
  assert.equal((await row(AGENT_A)).externalEndpoint, null, 'a member set the agent push-callback egress target')
})

// ── Exotic input shapes ───────────────────────────────────────────────────────

for (const [label, payload] of [
  ['duplicate keys',        `{"personality":"ok","orgId":"${ORG_B}","orgId":"${ORG_B}"}`],
  ['case variant OrgId',    `{"OrgId":"${ORG_B}"}`],
  ['case variant ORGID',    `{"ORGID":"${ORG_B}"}`],
  ['snake_case org_id',     `{"org_id":"${ORG_B}"}`],
  ['array-valued orgId',    `{"orgId":["${ORG_B}"]}`],
  ['object-valued orgId',   `{"orgId":{"toString":"${ORG_B}"}}`],
  ['null orgId',            `{"orgId":null}`],
  ['duplicate trustMode',   `{"trustMode":"standard","trustMode":"autonomous"}`],
  ['case variant TrustMode',`{"TrustMode":"autonomous"}`],
  ['snake_case trust_mode', `{"trust_mode":"autonomous"}`],
  ['__proto__ nesting',     `{"__proto__":{"orgId":"${ORG_B}","trustMode":"autonomous"}}`],
  ['constructor proto',     `{"constructor":{"prototype":{"orgId":"${ORG_B}"}}}`],
  ['whole-object round-trip', `{"id":"${AGENT_A}","orgId":"${ORG_B}","name":"RT","role":"RT","personality":"RT","trustMode":"autonomous","permissions":"[\\"*\\"]","apiTokenHash":"deadbeef","llmModel":"evil","createdAt":1600000000000}`],
] as Array<[string, string]>) {
  test(`[GC-0b] the agents allow-list resists: ${label}`, async () => {
    const res = await asRaw(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, payload)
    const after = await row(AGENT_A)
    assert.ok(after, `${label}: the agent row vanished (status ${res.statusCode})`)
    assert.equal(after.orgId, ORG_A, `${label}: CROSS-ORG WRITE (status ${res.statusCode})`)
    assert.equal(after.trustMode, 'standard', `${label}: TRUST ESCALATION (status ${res.statusCode})`)
    assert.equal(after.permissions, null, `${label}: capability caps rewritten`)
    assert.equal(after.apiTokenHash, null, `${label}: agent credential rewritten`)
    assert.equal(after.name, 'Agent A', `${label}: owner-gated \`name\` rewritten`)
    assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), `${label}: \`createdAt\` was rewritten`)
    assert.equal(({} as any).orgId, undefined, `${label}: PROTOTYPE POLLUTION via the request body`)
    assert.equal(({} as any).trustMode, undefined, `${label}: PROTOTYPE POLLUTION of trustMode`)
  })
}

// ── Immutable columns ─────────────────────────────────────────────────────────

test('[GC-0b] `id` is not writable', async () => {
  await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { id: 'hijacked-agent' })
  assert.ok(await row(AGENT_A), 'the agent lost its primary key — `id` was writable')
  assert.equal(await row('hijacked-agent'), undefined, '`id` was rewritten')
})

test('[GC-0b] `createdAt` is not writable, and the request still SUCCEEDS', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, {
    personality: 'Legit', createdAt: new Date('2031-05-05T00:00:00Z').getTime(),
  })
  assert.equal(res.statusCode, 200)
  const after = await row(AGENT_A)
  assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), '`createdAt` was rewritten')
  assert.equal(after.personality, 'Legit', 'the request did not actually take effect')
})

test('[GC-0b] unknown body keys are never persisted', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { personality: 'Legit', bogusColumn: 'x', isAdmin: true })
  assert.equal(res.statusCode, 200)
  const after = await row(AGENT_A)
  for (const k of ['bogusColumn', 'isAdmin']) {
    assert.equal((after as any)[k], undefined, `unknown key \`${k}\` reached the row`)
  }
})

// ── Cross-org (the gate itself still stands) ──────────────────────────────────

test('[GC-0b] a member of org A cannot PATCH org B\'s agent', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_B}`, { personality: 'Owned' })
  assert.equal(res.statusCode, 403)
  assert.equal((await row(AGENT_B)).personality, 'terse', "org B's agent was edited by an outsider")
})

// ── The guard is not a brick ──────────────────────────────────────────────────

test('[GC-0b] the allow-listed agent fields DO still write', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, {
    personality: 'Edited', cv: 'a cv', termsOfReference: 'tor',
    persona: 'p', expertise: 'e', agentType: 'advisor', status: 'paused',
  })
  assert.equal(res.statusCode, 200)
  const after = await row(AGENT_A)
  assert.equal(after.personality, 'Edited')
  assert.equal(after.cv, 'a cv')
  assert.equal(after.termsOfReference, 'tor')
  assert.equal(after.agentType, 'advisor')
  assert.equal(after.status, 'paused')
})

test('[GC-0b] advisorIds still writes AND is still same-org validated', async () => {
  const ok = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { advisorIds: [PEER_A] })
  assert.equal(ok.statusCode, 200)
  assert.equal((await row(AGENT_A)).advisorIds, JSON.stringify([PEER_A]))

  // The pre-existing same-org check must survive the rewrite.
  const bad = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { advisorIds: [AGENT_B] })
  assert.equal(bad.statusCode, 400, "an advisor from another org was accepted")
  assert.equal((await row(AGENT_A)).advisorIds, JSON.stringify([PEER_A]), 'the rejected write still landed')
})

test('[GC-0b] an invalid `agentType` is refused rather than written', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/agents/${AGENT_A}`, { agentType: 'superuser' })
  assert.equal(res.statusCode, 400)
  assert.equal((await row(AGENT_A)).agentType, 'standard', 'an out-of-enum agentType reached the row')
})

test('[GC-0b] the OWNER path to trust still works (the fix narrows PATCH, not the feature)', async () => {
  // The legitimate surface must be unharmed — otherwise this is a denial of the
  // feature rather than a fix. An owner sets trust through the owner-gated PUT.
  const res = await as(OWNER_A, 'PUT', `/api/orgs/${ORG_A}/agents/${AGENT_A}/trust`, { trustMode: 'low_trust_review' })
  assert.equal(res.statusCode, 200)
  assert.equal((await row(AGENT_A)).trustMode, 'low_trust_review', 'the owner-gated trust route stopped working')
})

test('[GC-0b] a MEMBER is refused by the owner-gated trust route (belt and braces)', async () => {
  const res = await as(MEMBER_A, 'PUT', `/api/orgs/${ORG_A}/agents/${AGENT_A}/trust`, { trustMode: 'autonomous' })
  assert.equal(res.statusCode, 403)
  assert.equal((await row(AGENT_A)).trustMode, 'standard')
})
