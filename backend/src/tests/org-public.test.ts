// ─── The org row must not ship its credentials ───────────────────────────────
//
// `GET /api/orgs` was `db.select().from(organisations)` — the WHOLE row — and
// that row carries TWO live credentials: `telegramBotToken`, and `deployConfig`,
// a JSON blob of LLM API keys that org creation writes in PLAINTEXT
// (`deployConfig[`${provider}_api_key`] = body.llmApiKey`). Every authenticated
// client got both: the web dashboard, the desktop shell, and the phone (since
// MOB-1 — ConnectScreen lists orgs). They sat in client JS memory.
//
// This suite is the regression net for the projection that closed it. It is
// BEHAVIOURAL, not a source scan: it seeds a row whose secret columns hold
// values we can search for, drives the REAL routes, and asserts those values are
// not anywhere in the serialised response — so a future `select *` (or a stray
// `{...org}`) fails here rather than on a phone screen.
//
// The suite has two halves, and both matter:
//   1. Per-route: every surface that returns an org — including POST's echo of
//      the key the caller just sent — is driven and searched.
//   2. Schema completeness: every `organisations` column must be classified as
//      public or secret. A NEW column is a test failure until someone decides,
//      which is the property `select *` never had.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'org-public-test-key'

let db: any, schema: any
let app: FastifyInstance
let PUBLIC_ORG_FIELDS: readonly string[]
let SECRET_ORG_FIELDS: readonly string[]
let toPublicOrg: (org: any) => any

const OWNER = 'user-owner'
const ORG = 'org-1'

// Distinctive sentinels: if either string appears ANYWHERE in a response body,
// a credential leaked — no matter which key carried it out.
const BOT_TOKEN = 'SENTINEL-telegram-bot-token-1234'
const LLM_KEY = 'SENTINEL-plaintext-llm-api-key-5678'
const LLM_KEY_ENC = 'SENTINEL-encrypted-llm-api-key-9012'

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ PUBLIC_ORG_FIELDS, SECRET_ORG_FIELDS, toPublicOrg } = await import('../services/org-public'))

  await db.insert(schema.organisations).values({
    id: ORG,
    name: '7Ei',
    description: 'The org',
    ownerId: OWNER,
    createdAt: new Date(),
    mission: 'Ship it',
    culture: 'Directness',
    deployMode: 'cloud',
    cloudProvider: 'aws_ch',
    preferredLlm: 'claude',
    budgetMonthlyUsd: 500,
    // Both credentials, populated exactly as production does.
    telegramBotToken: BOT_TOKEN,
    deployConfig: { anthropic_api_key: LLM_KEY, anthropic_api_key_enc: LLM_KEY_ENC },
  } as any)
  await db.insert(schema.orgMembers).values({
    id: 'm-owner', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date(),
  } as any)

  app = Fastify()
  // Stand in for the Clerk pre-handler: these routes read `userId` / `auth.userId`.
  app.addHook('preHandler', async (req: any) => {
    req.userId = OWNER
    req.auth = { userId: OWNER }
  })
  await app.register((await import('../routes/orgs')).orgRoutes)
  await app.register((await import('../routes/multi-org')).multiOrgRoutes)
  await app.ready()
})

/** Every surface that hands an org (or a list of them) to a client. */
const ORG_RETURNING_ROUTES = [
  { name: 'GET /api/orgs', method: 'GET' as const, url: '/api/orgs' },
  { name: 'GET /api/orgs/:orgId', method: 'GET' as const, url: `/api/orgs/${ORG}` },
  { name: 'GET /api/users/:userId/orgs', method: 'GET' as const, url: `/api/users/${OWNER}/orgs` },
  { name: 'GET /api/orgs/switch/list', method: 'GET' as const, url: '/api/orgs/switch/list' },
]

for (const route of ORG_RETURNING_ROUTES) {
  test(`[SEC-ORG] ${route.name} leaks no credential`, async () => {
    const res = await app.inject({ method: route.method, url: route.url })
    assert.equal(res.statusCode, 200, `${route.name} → ${res.statusCode}: ${res.body}`)

    // The value test, not the key test. A renamed key still fails this.
    assert.ok(!res.body.includes(BOT_TOKEN), `${route.name} leaked telegramBotToken`)
    assert.ok(!res.body.includes(LLM_KEY), `${route.name} leaked a plaintext LLM API key`)
    assert.ok(!res.body.includes(LLM_KEY_ENC), `${route.name} leaked an encrypted LLM API key`)

    // And the key test, so a secret that is null/empty in this fixture — but
    // present in prod — still can't ride out under its own name.
    for (const secret of SECRET_ORG_FIELDS) {
      assert.ok(!res.body.includes(secret), `${route.name} exposes the "${secret}" key`)
    }
  })
}

test('[SEC-ORG] POST /api/orgs does not echo back the API key it was just handed', async () => {
  // The subtle one. The caller SENDS `llmApiKey`; the handler writes it into
  // `deployConfig` and used to return the constructed row verbatim. "They sent
  // it, so they know it" is not a reason to put a live key back on the wire.
  const res = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    payload: { name: 'Fresh Org', llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514', llmApiKey: LLM_KEY },
  })
  assert.equal(res.statusCode, 201, `POST /api/orgs → ${res.statusCode}: ${res.body}`)
  assert.ok(!res.body.includes(LLM_KEY), 'POST /api/orgs echoed the plaintext LLM API key back to the caller')
  assert.ok(!res.body.includes('deployConfig'), 'POST /api/orgs exposes the deployConfig key')

  // The key must still have been PERSISTED — this is a response-shape fix, not a
  // functional one. If the projection silently broke storage, the executor loses
  // its credential and every task fails.
  const stored = await db.query.organisations.findFirst({
    where: (await import('drizzle-orm')).eq(schema.organisations.id, JSON.parse(res.body).org.id),
  })
  assert.equal((stored.deployConfig as any).anthropic_api_key, LLM_KEY, 'the API key must still be stored server-side')
})

test('[SEC-ORG] the fields clients actually read still arrive', async () => {
  // The other half of a narrowing: proof it did not regress the callers. These
  // are the fields the real clients consume —
  //   web    (app/dashboard/page.tsx): `type Org = { id, name, description, mission, culture }`
  //   mobile (src/settings.ts):        `OrgSettingsLite { id, name, description, mission, culture }`
  //   mobile (src/api.ts):             `Org = { id, name, memberRole }`
  const res = await app.inject({ method: 'GET', url: '/api/orgs' })
  const org = JSON.parse(res.body).orgs[0]
  for (const field of ['id', 'name', 'description', 'mission', 'culture']) {
    assert.ok(field in org, `GET /api/orgs dropped "${field}", which web and mobile read`)
  }
  assert.equal(org.name, '7Ei')
  assert.equal(org.mission, 'Ship it')
  // Non-secret config the row carries: kept, because narrowing must not silently
  // shrink beyond the secrets.
  assert.equal(org.cloudProvider, 'aws_ch')
  assert.equal(org.budgetMonthlyUsd, 500)
  assert.equal(org.ownerId, OWNER)

  // `memberRole` is the enrichment mobile's `Org` type reads — the projection
  // sits INSIDE that spread, so prove the enrichment survived it.
  const memberRes = await app.inject({ method: 'GET', url: `/api/users/${OWNER}/orgs` })
  assert.equal(JSON.parse(memberRes.body).orgs[0].memberRole, 'owner')

  // Same for the switch list's counts.
  const switchRes = await app.inject({ method: 'GET', url: '/api/orgs/switch/list' })
  assert.equal(JSON.parse(switchRes.body).orgs[0].agentCount, 0)
})

test('[SEC-ORG] every organisations column is classified public or secret', async () => {
  // The forward guard, and the reason this is an allow-list. `select *` shipped
  // whatever the table grew; the failure mode was a column added years after the
  // route was written. Now a new column is invisible to clients by default AND
  // this test fails until someone classifies it deliberately.
  const columns = Object.keys(schema.organisations)
    .filter((k) => !k.startsWith('_') && typeof (schema.organisations as any)[k]?.name === 'string')
  assert.ok(columns.length > 5, `Scanned only ${columns.length} columns — the scan is broken, not the schema.`)

  const classified = new Set<string>([...PUBLIC_ORG_FIELDS, ...SECRET_ORG_FIELDS])
  const unclassified = columns.filter((c) => !classified.has(c))
  assert.deepEqual(
    unclassified, [],
    `Unclassified organisations column(s): ${unclassified.join(', ')}. ` +
      'Add each to PUBLIC_ORG_FIELDS or SECRET_ORG_FIELDS in services/org-public.ts — ' +
      'a column no one classified must not reach a client by default.',
  )

  // Prove the hazard is real, so this suite fails loudly if a credential column
  // is renamed and someone should re-check what else moved.
  for (const secret of SECRET_ORG_FIELDS) {
    assert.ok(columns.includes(secret), `Expected organisations.${secret} to still exist — if it was renamed, re-check the projection.`)
  }
  // The two lists must not overlap: a field in both would be public in practice.
  for (const secret of SECRET_ORG_FIELDS) {
    assert.ok(!PUBLIC_ORG_FIELDS.includes(secret), `"${secret}" is in BOTH lists — it would ship to clients.`)
  }
})

test('[SEC-ORG] toPublicOrg drops secrets and preserves nulls', async () => {
  const out: any = toPublicOrg({
    id: 'x', name: 'N', description: null, mission: null, culture: null,
    ownerId: 'u', createdAt: new Date(0), logoUrl: null, deployMode: null,
    cloudProvider: null, preferredLlm: null, budgetMonthlyUsd: null,
    telegramBotToken: BOT_TOKEN,
    deployConfig: { anthropic_api_key: LLM_KEY },
  })
  assert.ok(!('telegramBotToken' in out))
  assert.ok(!('deployConfig' in out))
  // A present-but-null column stays present and null: the response shape is the
  // old one minus the secrets, so a client checking `'mission' in org` is unmoved.
  assert.ok('mission' in out)
  assert.equal(out.mission, null)
  // An unknown/new column is not carried through — allow-list, not deny-list.
  const withNewColumn: any = toPublicOrg({ id: 'x', name: 'N', someFutureSecret: 'nope' } as any)
  assert.ok(!('someFutureSecret' in withNewColumn))
})
