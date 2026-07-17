// Epic CONN / CONN-4a — GitHub (PAT) + Jira (basic) become REAL per-agent connectors.
//
// The sibling of agent-connectors.test.ts (which covers the custom-MCP pilot). This
// suite is the security net for storing THIRD-PARTY tokens AND for the wiring that
// makes them actually usable at runtime. It proves, against REAL handlers on a REAL
// SQLite file through the REAL owner gate:
//   1. owner can configure github + jira → 201; a member 403s (nothing written);
//   2. the token NEVER appears in ANY read/list/get/test response (value + key both);
//   3. the credential flows to the agent as ENV under the runtime-expected keys —
//      GITHUB_TOKEN / JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN — proven via
//      resolveSecretsForAgent (the exact bag GET /api/agent/secrets injects);
//   4. Jira's baseUrl is URL-validated; a bad URL / junk config → 400;
//   5. a required credential is enforced on first configure;
//   6. disconnect purges EVERY agent-scoped env row (token AND non-secret base/email);
//   7. tenant scoping holds (owner of org A cannot reach an agent in org B → 404);
//   8. the live `test` check is SSRF-safe (known hosts only) and never echoes the token.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'agent-conn-gj-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'agent-connectors-gj-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const {
  validateConnectorConfig, getAgentConnector, connectorSecretEntries,
  connectorEnvKeys, primarySecretKey, connectorAccountLabel, isAtlassianHost,
} = await import('../services/agent-connectors')
const { decrypt, resolveSecretsForAgent } = await import('../services/secrets')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org-gj', OWNER = 'user-owner', MEMBER = 'user-member', AGENT = 'agent-gj'
const OTHER_ORG = 'org-other', OTHER_OWNER = 'user-other-owner', OTHER_AGENT = 'agent-other'

// Distinctive tokens: if either appears ANYWHERE in a response body, a secret leaked.
const GH_SENTINEL = 'ghp_SENTINEL-github-pat-abc123xyz'
const JIRA_SENTINEL = 'SENTINEL-jira-api-token-abc123xyz'

let app: FastifyInstance

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentConnectorRoutes)
  return a
}

const url = (orgId: string, agentId: string, tail = '') => `/api/orgs/${orgId}/agents/${agentId}/connectors${tail}`
const connRow = async (orgId: string, agentId: string, cid: string) =>
  db.query.agentConnectors.findFirst({ where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)) })
const agentSecret = async (orgId: string, agentId: string, key: string) =>
  db.query.secrets.findFirst({ where: and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'agent'), eq(schema.secrets.scopeId, agentId), eq(schema.secrets.key, key)) })

const ghConfig = { username: 'octocat' }
const jiraConfig = { baseUrl: 'https://acme.atlassian.net', email: 'ops@acme.com' }

// The agent's env bag, resolved exactly as GET /api/agent/secrets does.
async function agentEnvBag(orgId: string, agentId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.orgId, orgId))
  const decrypted = rows
    .filter(r => r.scope === 'company' || r.scope === 'agent')
    .map(r => ({ scope: r.scope, scopeId: r.scopeId, key: r.key, value: decrypt(r.valueEncrypted) }))
  return resolveSecretsForAgent(decrypted, agentId)
}

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([
    { id: ORG, name: 'Acme', ownerId: OWNER, createdAt: now },
    { id: OTHER_ORG, name: 'Rivals', ownerId: OTHER_OWNER, createdAt: now },
  ] as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
    { id: randomUUID(), orgId: ORG, userId: MEMBER, role: 'member', createdAt: now },
    { id: randomUUID(), orgId: OTHER_ORG, userId: OTHER_OWNER, role: 'owner', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', createdAt: now },
    { id: OTHER_AGENT, orgId: OTHER_ORG, name: 'Spy', role: 'Analyst', skills: [], runtime: 'internal', createdAt: now },
  ] as any)
  app = appAs(OWNER)
  await app.ready()
})

after(async () => {
  await app?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── Catalog + pure validators ────────────────────────────────────────────────

test('[CONN4A-CAT] github + jira are in the agent catalog with the right auth types', () => {
  const gh = getAgentConnector('github'), jira = getAgentConnector('jira')
  assert.ok(gh && gh.authType === 'token' && gh.hasSecret && gh.secretRequired)
  assert.ok(jira && jira.authType === 'basic' && jira.hasSecret && jira.secretRequired)
})

test('[CONN4A-VAL] jira config requires a valid URL baseUrl + email', () => {
  assert.equal(validateConnectorConfig('jira', jiraConfig).ok, true)
  assert.equal(validateConnectorConfig('jira', { baseUrl: 'not-a-url', email: 'ops@acme.com' }).ok, false)
  assert.equal(validateConnectorConfig('jira', { baseUrl: 'https://acme.atlassian.net', email: 'not-an-email' }).ok, false)
  assert.equal(validateConnectorConfig('jira', { baseUrl: 'https://acme.atlassian.net' }).ok, false) // missing email
  assert.equal(validateConnectorConfig('jira', { baseUrl: 'https://acme.atlassian.net', email: 'ops@acme.com', evil: 1 }).ok, false) // strict
})

test('[CONN4A-VAL] github config is optional-username only, strict', () => {
  assert.equal(validateConnectorConfig('github', {}).ok, true)
  assert.equal(validateConnectorConfig('github', ghConfig).ok, true)
  assert.equal(validateConnectorConfig('github', { token: 'x' }).ok, false) // strict — no secret in config
})

test('[CONN4A-ENV] the env-key mapping is the runtime contract', () => {
  assert.deepEqual([...connectorEnvKeys('github')], ['GITHUB_TOKEN'])
  assert.deepEqual([...connectorEnvKeys('jira')], ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'])
  assert.equal(primarySecretKey('github'), 'GITHUB_TOKEN')
  assert.equal(primarySecretKey('jira'), 'JIRA_API_TOKEN')
  // Non-secret jira fields always derive from config; the token only when supplied.
  assert.deepEqual(connectorSecretEntries('jira', jiraConfig, undefined), { JIRA_BASE_URL: jiraConfig.baseUrl, JIRA_EMAIL: jiraConfig.email })
  assert.deepEqual(connectorSecretEntries('jira', jiraConfig, JIRA_SENTINEL), { JIRA_BASE_URL: jiraConfig.baseUrl, JIRA_EMAIL: jiraConfig.email, JIRA_API_TOKEN: JIRA_SENTINEL })
  assert.deepEqual(connectorSecretEntries('github', ghConfig, GH_SENTINEL), { GITHUB_TOKEN: GH_SENTINEL })
  assert.equal(connectorAccountLabel('github', ghConfig), 'octocat')
  assert.equal(connectorAccountLabel('jira', jiraConfig), 'ops@acme.com')
})

test('[CONN4A-SSRF] isAtlassianHost only trusts *.atlassian.net', () => {
  assert.equal(isAtlassianHost('https://acme.atlassian.net'), true)
  assert.equal(isAtlassianHost('https://atlassian.net/x'), true)
  assert.equal(isAtlassianHost('https://evil.com'), false)
  assert.equal(isAtlassianHost('https://acme.atlassian.net.evil.com'), false)
  assert.equal(isAtlassianHost('http://169.254.169.254'), false)
  assert.equal(isAtlassianHost('garbage'), false)
})

// ─── Owner gate + required credential ─────────────────────────────────────────

test('[CONN4A-AUTHZ] a member cannot configure github → 403, nothing written', async () => {
  const member = appAs(MEMBER); await member.ready()
  const res = await member.inject({ method: 'POST', url: url(ORG, AGENT, '/github'), payload: { config: ghConfig, secret: GH_SENTINEL } })
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(await connRow(ORG, AGENT, 'github'), undefined)
  await member.close()
})

test('[CONN4A-REQ] github/jira require a credential on first configure → 400', async () => {
  const fresh = 'agent-req'
  await db.insert(schema.agents).values({ id: fresh, orgId: ORG, name: 'Req', role: 'X', skills: [], runtime: 'internal', createdAt: new Date() } as any)
  const gh = await app.inject({ method: 'POST', url: url(ORG, fresh, '/github'), payload: { config: ghConfig } })
  assert.equal(gh.statusCode, 400, gh.body)
  const jira = await app.inject({ method: 'POST', url: url(ORG, fresh, '/jira'), payload: { config: jiraConfig } })
  assert.equal(jira.statusCode, 400, jira.body)
  assert.equal(await connRow(ORG, fresh, 'github'), undefined, 'no row for a rejected required-credential write')
})

// ─── Configure → the credential is stored as ENV under the runtime keys ───────

test('[CONN4A-EXEC] github configure stores GITHUB_TOKEN at agent scope, injected by resolveSecretsForAgent', async () => {
  const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, '/github'), payload: { config: ghConfig, secret: GH_SENTINEL } })
  assert.equal(res.statusCode, 201, res.body)
  const row = await connRow(ORG, AGENT, 'github')
  assert.ok(row && row.secretRef === 'GITHUB_TOKEN' && row.accountLabel === 'octocat')
  const sec = await agentSecret(ORG, AGENT, 'GITHUB_TOKEN')
  assert.ok(sec && sec.valueEncrypted !== GH_SENTINEL && decrypt(sec.valueEncrypted) === GH_SENTINEL, 'encrypted at rest, decrypts back')
  // The execution proof: the runtime bag carries GITHUB_TOKEN for this agent.
  const bag = await agentEnvBag(ORG, AGENT)
  assert.equal(bag.GITHUB_TOKEN, GH_SENTINEL, 'GITHUB_TOKEN must reach the agent runtime env')
})

test('[CONN4A-EXEC] jira configure stores base/email/token; all three reach the runtime env', async () => {
  const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, '/jira'), payload: { config: jiraConfig, secret: JIRA_SENTINEL } })
  assert.equal(res.statusCode, 201, res.body)
  const row = await connRow(ORG, AGENT, 'jira')
  assert.ok(row && row.secretRef === 'JIRA_API_TOKEN' && row.accountLabel === 'ops@acme.com')
  const bag = await agentEnvBag(ORG, AGENT)
  assert.equal(bag.JIRA_BASE_URL, jiraConfig.baseUrl)
  assert.equal(bag.JIRA_EMAIL, jiraConfig.email)
  assert.equal(bag.JIRA_API_TOKEN, JIRA_SENTINEL, 'JIRA_API_TOKEN must reach the agent runtime env')
})

// ─── The token NEVER leaves the backend ───────────────────────────────────────

test('[CONN4A-LEAK] no read/list/get/test/put response carries either token or a secretRef', async () => {
  // Both connectors already configured above. `test` is stubbed to avoid real network.
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ login: 'octocat', displayName: 'Acme Ops' }), { status: 200 })) as any
  try {
    const surfaces = [
      { name: 'POST github', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/github'), payload: { config: ghConfig, secret: GH_SENTINEL } }) },
      { name: 'POST jira', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/jira'), payload: { config: jiraConfig, secret: JIRA_SENTINEL } }) },
      { name: 'GET list', res: await app.inject({ method: 'GET', url: url(ORG, AGENT) }) },
      { name: 'GET github', res: await app.inject({ method: 'GET', url: url(ORG, AGENT, '/github') }) },
      { name: 'GET jira', res: await app.inject({ method: 'GET', url: url(ORG, AGENT, '/jira') }) },
      { name: 'POST github test', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/github/test') }) },
      { name: 'POST jira test', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/jira/test') }) },
      { name: 'PUT jira config', res: await app.inject({ method: 'PUT', url: url(ORG, AGENT, '/jira/config'), payload: { config: { ...jiraConfig, email: 'lead@acme.com' } } }) },
    ]
    for (const s of surfaces) {
      assert.ok(s.res.statusCode < 400, `${s.name} → ${s.res.statusCode}: ${s.res.body}`)
      assert.ok(!s.res.body.includes(GH_SENTINEL), `${s.name} leaked the GitHub token`)
      assert.ok(!s.res.body.includes(JIRA_SENTINEL), `${s.name} leaked the Jira token`)
      assert.ok(!s.res.body.includes('secretRef'), `${s.name} exposed secretRef`)
      assert.ok(!s.res.body.includes('GITHUB_TOKEN') && !s.res.body.includes('JIRA_API_TOKEN'), `${s.name} exposed a secret key name`)
    }
    // Non-secret config still travels (base url + the renamed email are returnable).
    const jira = JSON.parse((await app.inject({ method: 'GET', url: url(ORG, AGENT, '/jira') })).body).connector
    assert.equal(jira.config.baseUrl, jiraConfig.baseUrl)
    assert.equal(jira.config.email, 'lead@acme.com')
    assert.equal(jira.status, 'configured')
  } finally {
    globalThis.fetch = origFetch
  }
})

// ─── The live test is real + SSRF-safe ────────────────────────────────────────

test('[CONN4A-TEST] github test dials only api.github.com and returns the login, not the token', async () => {
  const calls: string[] = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }) }) as any
  try {
    const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, '/github/test') })
    assert.equal(res.statusCode, 200, res.body)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.detail, 'octocat')
    assert.ok(calls.every(c => c.startsWith('https://api.github.com/')), `only github.com may be dialed, got: ${calls.join()}`)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('[CONN4A-TEST] jira test on a NON-atlassian host is skipped (no dial), never SSRFs', async () => {
  // Reconfigure jira with a self-hosted (non-atlassian) base URL.
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/jira'), payload: { config: { baseUrl: 'https://jira.internal.acme.com', email: 'ops@acme.com' }, secret: JIRA_SENTINEL } })
  const calls: string[] = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response('{}', { status: 200 }) }) as any
  try {
    const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, '/jira/test') })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(JSON.parse(res.body).ok, true)
    assert.equal(calls.length, 0, 'a non-Atlassian host must NOT be dialed (SSRF guard)')
  } finally {
    globalThis.fetch = origFetch
  }
  // Restore the atlassian.net config for later tests.
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/jira'), payload: { config: jiraConfig, secret: JIRA_SENTINEL } })
})

test('[CONN4A-TEST] a failing github token records lastError=error, no token echoed', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('Bad credentials', { status: 401 })) as any
  try {
    const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, '/github/test') })
    assert.equal(res.statusCode, 200, res.body)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.ok(!res.body.includes(GH_SENTINEL))
    const row = await connRow(ORG, AGENT, 'github')
    assert.equal(row!.status, 'error')
  } finally {
    globalThis.fetch = origFetch
  }
})

// ─── Disconnect purges every env row; tenant scoping ──────────────────────────

test('[CONN4A-DEL] disconnect jira purges base/email/token agent-scoped rows', async () => {
  // Ensure configured.
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/jira'), payload: { config: jiraConfig, secret: JIRA_SENTINEL } })
  const res = await app.inject({ method: 'DELETE', url: url(ORG, AGENT, '/jira') })
  assert.equal(res.statusCode, 204, res.body)
  assert.equal(await connRow(ORG, AGENT, 'jira'), undefined)
  for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) {
    assert.equal(await agentSecret(ORG, AGENT, k), undefined, `${k} must be purged on disconnect`)
  }
})

test('[CONN4A-AUTHZ] an owner cannot configure github on an agent in ANOTHER org → 404', async () => {
  const res = await app.inject({ method: 'POST', url: url(ORG, OTHER_AGENT, '/github'), payload: { config: ghConfig, secret: GH_SENTINEL } })
  assert.equal(res.statusCode, 404, res.body)
  assert.equal(await connRow(ORG, OTHER_AGENT, 'github'), undefined)
})
