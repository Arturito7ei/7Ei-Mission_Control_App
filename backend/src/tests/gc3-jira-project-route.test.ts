// GC-3 — Jira-backed Command Center project selector persistence.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc3-jira-project-key'

let db: any, schema: any
let app: FastifyInstance

const ORG = 'gc3-org'
const OWNER = 'gc3-owner'
const THREAD = `/api/orgs/${ORG}/arturita/thread`
const PROJECT = `/api/orgs/${ORG}/arturita/project`
const JIRA_PROJECTS = `/api/orgs/${ORG}/jira/projects`

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()

  await db.insert(schema.organisations).values({
    id: ORG, name: 'GC3 Org', ownerId: OWNER, createdAt: new Date(), deployConfig: {},
  })
  await db.insert(schema.orgMembers).values({
    id: 'm1', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date(),
  })

  const { setJiraCfg } = await import('../routes/jira')
  await setJiraCfg(ORG, {
    domain: '7ei',
    email: 'ops@7ei.ai',
    apiToken: 'test-token',
    defaultProjectKey: 'MCA',
  })

  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    if (url.includes('/project/search')) {
      return new Response(JSON.stringify({
        values: [
          { id: '1', key: 'MCA', name: 'Mission Control', projectTypeKey: 'software' },
          { id: '2', key: 'OS', name: '7Ei OS', projectTypeKey: 'software' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(input, init)
  }) as typeof fetch

  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { arturitaConverseRoutes } = await import('../routes/arturita-converse')
  const { jiraRoutes } = await import('../routes/jira')

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(arturitaConverseRoutes)
    await secured.register(jiraRoutes)
  })
  await app.ready()
})

after(async () => {
  if (app) await app.close()
})

test('[GC-3] GET /thread includes null jiraProjectKey before selection', async () => {
  const res = await app.inject({ method: 'GET', url: THREAD, headers: { authorization: `Bearer ${OWNER}` } })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.jiraProjectKey, null)
  assert.ok(Array.isArray(body.turns))
})

test('[GC-3] PUT /project persists and survives GET /thread reload', async () => {
  const put = await app.inject({
    method: 'PUT', url: PROJECT,
    headers: { authorization: `Bearer ${OWNER}` },
    payload: { projectKey: 'OS' },
  })
  assert.equal(put.statusCode, 200, put.body)
  assert.equal(put.json().jiraProjectKey, 'OS')

  const get = await app.inject({ method: 'GET', url: THREAD, headers: { authorization: `Bearer ${OWNER}` } })
  assert.equal(get.statusCode, 200, get.body)
  assert.equal(get.json().jiraProjectKey, 'OS')
})

test('[GC-3] PUT /project rejects unknown keys when Jira is connected', async () => {
  const res = await app.inject({
    method: 'PUT', url: PROJECT,
    headers: { authorization: `Bearer ${OWNER}` },
    payload: { projectKey: 'NOPE' },
  })
  assert.equal(res.statusCode, 400, res.body)
})

test('[GC-3] GET /jira/projects lists org projects for the picker', async () => {
  const res = await app.inject({ method: 'GET', url: JIRA_PROJECTS, headers: { authorization: `Bearer ${OWNER}` } })
  assert.equal(res.statusCode, 200, res.body)
  const keys = res.json().projects.map((p: any) => p.key)
  assert.deepEqual(keys, ['MCA', 'OS'])
})

test('[GC-3] PUT /project fails closed when Jira project list is unavailable', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    if (url.includes('/project/search')) {
      return new Response('upstream error', { status: 503 })
    }
    return origFetch(input, init)
  }) as typeof fetch
  try {
    const res = await app.inject({
      method: 'PUT', url: PROJECT,
      headers: { authorization: `Bearer ${OWNER}` },
      payload: { projectKey: 'MCA' },
    })
    assert.equal(res.statusCode, 502, res.body)
    assert.equal(res.json().error, 'Jira API error')
  } finally {
    globalThis.fetch = origFetch
  }
})
