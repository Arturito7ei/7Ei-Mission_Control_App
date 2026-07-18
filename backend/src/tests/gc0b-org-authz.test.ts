// ─── GC-0b — the SIXTH instance: PATCH /api/orgs/:orgId ─────────────────────
//
// Not on the reported list of five. Found by re-sweeping for the SHAPE rather than
// working the list, which is the whole point of treating this as a CLASS.
//
// This route was a DENY-LIST: it stripped `ownerId` and `id`, then spread everything
// else into `db.update().set()`. The tenant leg was already closed — the org comes
// from the `:orgId` PATH, so there is no row-derived gate-ordering bug, and `ownerId`
// (role-determinant) was stripped. What the deny-list left open was a CREDENTIAL-WRITE
// ESCALATION: every column it did not name stayed writable by a plain MEMBER, and
// three of them are owner-gated everywhere else in the codebase —
//   • `deployConfig`     — the org's PLAINTEXT LLM API KEYS (owner-gated on
//                          POST …/credentials and the custom-model routes). This is
//                          the WRITE side of the same row whose READ leak #294 closed.
//   • `telegramBotToken` — the org's bot credential.
//   • `budgetMonthlyUsd` — the spend cap; a member could raise their own ceiling.
//
// This is the "a deny-list is not an allow-list" leg of the class, stated in one file.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc0b-org-authz-key'

let db: any, schema: any
let app: FastifyInstance

const ORG_A = 'gc0bo-org-a'
const ORG_B = 'gc0bo-org-b'
const MEMBER_A = 'gc0bo-member-a'
const OWNER_A = 'gc0bo-owner-a'
const MEMBER_B = 'gc0bo-member-b'

const CREATED_AT = new Date('2020-01-01T00:00:00Z')
const REAL_KEY = { anthropic_api_key: 'sk-ant-REAL-ORG-KEY' }

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { orgRoutes } = await import('../routes/orgs')

  await db.insert(schema.orgMembers).values([
    { id: 'gc0bo-m-a', orgId: ORG_A, userId: MEMBER_A, role: 'member', createdAt: new Date() },
    { id: 'gc0bo-o-a', orgId: ORG_A, userId: OWNER_A, role: 'owner', createdAt: new Date() },
    { id: 'gc0bo-m-b', orgId: ORG_B, userId: MEMBER_B, role: 'member', createdAt: new Date() },
  ])

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(orgRoutes)
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
  (await db.select().from(schema.organisations).where(eq(schema.organisations.id, id)))[0]

beforeEach(async () => {
  await db.delete(schema.organisations)
  await db.insert(schema.organisations).values([
    { id: ORG_A, name: 'Org A', description: 'a', ownerId: OWNER_A, mission: 'm', culture: 'c', deployMode: 'cloud', cloudProvider: 'aws', preferredLlm: 'anthropic', deployConfig: REAL_KEY, budgetMonthlyUsd: 100, telegramBotToken: 'real-bot-token', createdAt: CREATED_AT },
    { id: ORG_B, name: 'Org B', description: 'b', ownerId: 'gc0bo-owner-b', createdAt: CREATED_AT },
  ] as any)
})

// ── PROOF THE ISOLATION IS REAL ───────────────────────────────────────────────

test('[GC-0b] per-test isolation — step 1 legitimately mutates the org', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, { description: 'MUTATED BY STEP 1' })
  assert.equal(res.statusCode, 200)
  assert.equal((await row(ORG_A)).description, 'MUTATED BY STEP 1')
})

test('[GC-0b] per-test isolation is real — step 2 sees a PRISTINE org', async () => {
  const o = await row(ORG_A)
  assert.equal(o.description, 'a', 'PER-TEST RESET IS NOT RUNNING: this suite would pass for the wrong reason')
  assert.deepEqual(o.deployConfig, REAL_KEY, 'credential state leaked across tests')
})

// ── THE EXPLOIT — member writes owner-gated credentials ───────────────────────

test('[GC-0b] a MEMBER cannot overwrite the org LLM API KEYS via PATCH', async () => {
  // THE CRITICAL. Pre-fix this landed at 200: a plain member swapped the org's model
  // credential, redirecting every agent's LLM spend to an attacker-controlled key.
  const res = await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, {
    deployConfig: { anthropic_api_key: 'sk-ant-ATTACKER' },
  })
  const after = await row(ORG_A)
  assert.deepEqual(after.deployConfig, REAL_KEY,
    `CREDENTIAL OVERWRITE: a member rewrote the org's LLM keys (status ${res.statusCode})`)
})

test('[GC-0b] a MEMBER cannot WIPE the org credentials either', async () => {
  // Destruction is the same primitive as substitution — an empty object would take
  // every agent in the org offline.
  await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, { deployConfig: {} })
  assert.deepEqual((await row(ORG_A)).deployConfig, REAL_KEY, 'a member wiped the org credential bag')
})

test('[GC-0b] a MEMBER cannot rewrite `telegramBotToken`', async () => {
  await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, { telegramBotToken: 'attacker-bot' })
  assert.equal((await row(ORG_A)).telegramBotToken, 'real-bot-token', 'a member rewrote the org bot credential')
})

test('[GC-0b] a MEMBER cannot raise their own spend cap', async () => {
  await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, { budgetMonthlyUsd: 1_000_000 })
  assert.equal((await row(ORG_A)).budgetMonthlyUsd, 100, 'a member raised the org budget ceiling')
})

test('[GC-0b] a MEMBER cannot change the deployment posture', async () => {
  await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, {
    deployMode: 'local', cloudProvider: 'azure', preferredLlm: 'openai',
  })
  const after = await row(ORG_A)
  assert.equal(after.deployMode, 'cloud', '`deployMode` was member-writable')
  assert.equal(after.cloudProvider, 'aws', '`cloudProvider` was member-writable — data residency is a compliance control')
  assert.equal(after.preferredLlm, 'anthropic', '`preferredLlm` was member-writable')
})

test('[GC-0b] `ownerId` stays unwritable (the pre-existing guard survives the rewrite)', async () => {
  // `ownerId` is role-determinant — enforceOrgRole grandfathers the org owner — so a
  // writable one is a direct member→owner escalation. The old deny-list caught this
  // one; the allow-list must not lose it.
  await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, { ownerId: MEMBER_A })
  assert.equal((await row(ORG_A)).ownerId, OWNER_A, 'MEMBER→OWNER ESCALATION: `ownerId` was rewritten')
})

test('[GC-0b] `id` and `createdAt` stay unwritable', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, {
    id: 'hijacked-org', createdAt: new Date('2031-05-05T00:00:00Z').getTime(), description: 'Legit',
  })
  assert.equal(res.statusCode, 200)
  assert.ok(await row(ORG_A), 'the org lost its primary key')
  assert.equal(await row('hijacked-org'), undefined, '`id` was rewritten')
  assert.equal(new Date((await row(ORG_A)).createdAt).getTime(), CREATED_AT.getTime(), '`createdAt` was rewritten')
})

// ── Exotic input shapes ───────────────────────────────────────────────────────

for (const [label, payload] of [
  ['duplicate keys',          `{"description":"ok","deployConfig":{"anthropic_api_key":"sk-EVIL"},"deployConfig":{"anthropic_api_key":"sk-EVIL2"}}`],
  ['case variant DeployConfig', `{"DeployConfig":{"anthropic_api_key":"sk-EVIL"}}`],
  ['snake_case deploy_config',  `{"deploy_config":{"anthropic_api_key":"sk-EVIL"}}`],
  ['case variant OwnerId',    `{"OwnerId":"${MEMBER_A}"}`],
  ['snake_case owner_id',     `{"owner_id":"${MEMBER_A}"}`],
  ['array-valued ownerId',    `{"ownerId":["${MEMBER_A}"]}`],
  ['object-valued ownerId',   `{"ownerId":{"toString":"${MEMBER_A}"}}`],
  ['null deployConfig',       `{"deployConfig":null}`],
  ['__proto__ nesting',       `{"__proto__":{"ownerId":"${MEMBER_A}","deployConfig":{"k":"EVIL"}}}`],
  ['constructor proto',       `{"constructor":{"prototype":{"ownerId":"${MEMBER_A}"}}}`],
  ['whole-object round-trip', `{"id":"${ORG_A}","name":"RT","description":"RT","ownerId":"${MEMBER_A}","mission":"RT","culture":"RT","deployMode":"local","cloudProvider":"azure","preferredLlm":"openai","deployConfig":{"anthropic_api_key":"sk-EVIL"},"budgetMonthlyUsd":999999,"telegramBotToken":"EVIL","createdAt":1600000000000}`],
] as Array<[string, string]>) {
  test(`[GC-0b] the orgs allow-list resists: ${label}`, async () => {
    const res = await asRaw(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, payload)
    const after = await row(ORG_A)
    assert.ok(after, `${label}: the org row vanished (status ${res.statusCode})`)
    assert.deepEqual(after.deployConfig, REAL_KEY, `${label}: CREDENTIAL OVERWRITE (status ${res.statusCode})`)
    assert.equal(after.telegramBotToken, 'real-bot-token', `${label}: bot credential rewritten`)
    assert.equal(after.ownerId, OWNER_A, `${label}: MEMBER→OWNER ESCALATION`)
    assert.equal(after.budgetMonthlyUsd, 100, `${label}: spend cap rewritten`)
    assert.equal(after.cloudProvider, 'aws', `${label}: deployment posture rewritten`)
    assert.equal(new Date(after.createdAt).getTime(), CREATED_AT.getTime(), `${label}: \`createdAt\` was rewritten`)
    assert.equal(({} as any).ownerId, undefined, `${label}: PROTOTYPE POLLUTION via the request body`)
  })
}

// ── Cross-org (the gate itself still stands) ──────────────────────────────────

test('[GC-0b] a member of org A cannot PATCH org B', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_B}`, { description: 'Owned' })
  assert.equal(res.statusCode, 403)
  assert.equal((await row(ORG_B)).description, 'b', 'org B was edited by an outsider')
})

// ── The guard is not a brick ──────────────────────────────────────────────────

test('[GC-0b] the Settings tab still saves exactly what it sends', async () => {
  // The only client caller (web/app/dashboard/page.tsx) sends precisely these three
  // keys. If this fails, the narrowing broke the real UI.
  const res = await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, {
    description: 'New description', mission: 'New mission', culture: 'New culture',
  })
  assert.equal(res.statusCode, 200)
  const after = await row(ORG_A)
  assert.equal(after.description, 'New description')
  assert.equal(after.mission, 'New mission')
  assert.equal(after.culture, 'New culture')
})

test('[GC-0b] `name` and `logoUrl` still write', async () => {
  const res = await as(MEMBER_A, 'PATCH', `/api/orgs/${ORG_A}`, { name: 'Renamed Org', logoUrl: 'https://x/y.png' })
  assert.equal(res.statusCode, 200)
  const after = await row(ORG_A)
  assert.equal(after.name, 'Renamed Org')
  assert.equal(after.logoUrl, 'https://x/y.png')
})

test('[GC-0b] the org READ still projects credentials away (#294 not regressed)', async () => {
  const res = await as(MEMBER_A, 'GET', `/api/orgs/${ORG_A}`)
  assert.equal(res.statusCode, 200)
  const org = res.json().org
  assert.equal(org.deployConfig, undefined, 'the org read leaked deployConfig — #294 regressed')
  assert.equal(org.telegramBotToken, undefined, 'the org read leaked telegramBotToken — #294 regressed')
})
