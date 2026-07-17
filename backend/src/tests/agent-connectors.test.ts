// Epic CONN / CONN-1 — the per-agent connector foundation, end-to-end.
//
// This suite is the security net for a feature that stores THIRD-PARTY CREDENTIALS.
// It proves, against REAL handlers on a REAL SQLite file through the REAL owner gate:
//   1. every write is OWNER-gated (a member 403s, the row is unchanged);
//   2. the credential is stored encrypted at AGENT scope and referenced by secretRef —
//      and NEVER appears in ANY read/list/echo/test response (value + key both);
//   3. config validation rejects junk with 400;
//   4. disconnect removes the row AND its agent-scoped secret;
//   5. tenant scoping holds (an owner of org A cannot reach an agent in org B → 404);
//   6. the agent-scoped secret is the one `resolveSecretsForAgent` injects (agent
//      override wins over a company default — the execution path CONN-8 rides);
//   7. the migration applies idempotently and every column is classified.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'agent-conn-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'agent-connectors-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const {
  validateConnectorConfig, toPublicConnector, connectorSecretKey,
  PUBLIC_CONNECTOR_FIELDS, SECRET_CONNECTOR_FIELDS, INTERNAL_CONNECTOR_FIELDS,
} = await import('../services/agent-connectors')
const { decrypt, resolveSecretsForAgent } = await import('../services/secrets')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org-conn', OWNER = 'user-owner', MEMBER = 'user-member', AGENT = 'agent-conn'
const OTHER_ORG = 'org-other', OTHER_OWNER = 'user-other-owner', OTHER_AGENT = 'agent-other'
const CID = 'mcp'

// A distinctive credential: if this string appears ANYWHERE in a response body, a
// secret leaked — no matter which key carried it out.
const SECRET_SENTINEL = 'SENTINEL-mcp-bearer-token-abc123'

let app: FastifyInstance

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentConnectorRoutes)
  return a
}

const url = (orgId: string, agentId: string, tail = '') => `/api/orgs/${orgId}/agents/${agentId}/connectors${tail}`
const connRow = async (orgId: string, agentId: string, cid = CID) =>
  db.query.agentConnectors.findFirst({ where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)) })

const validConfig = { name: 'My MCP', transport: 'http', url: 'https://mcp.example.com/sse' }

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([
    { id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now },
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

// ─── Pure config validator ───────────────────────────────────────────────────

test('[CONN-VAL] a well-formed http MCP config is accepted', () => {
  const r = validateConnectorConfig(CID, validConfig)
  assert.equal(r.ok, true)
  assert.equal((r as any).config.url, 'https://mcp.example.com/sse')
})

test('[CONN-VAL] a stdio MCP config needs a command; http needs a url', () => {
  assert.equal(validateConnectorConfig(CID, { name: 'X', transport: 'stdio', command: 'npx mcp' }).ok, true)
  assert.equal(validateConnectorConfig(CID, { name: 'X', transport: 'http' }).ok, false)   // no url
  assert.equal(validateConnectorConfig(CID, { name: 'X', transport: 'stdio' }).ok, false)  // no command
})

test('[CONN-VAL] junk config is rejected (unknown key, bad url, missing name)', () => {
  assert.equal(validateConnectorConfig(CID, { name: 'X', transport: 'http', url: 'not-a-url' }).ok, false)
  assert.equal(validateConnectorConfig(CID, { name: 'X', transport: 'http', url: 'https://ok', evil: 1 }).ok, false) // strict
  assert.equal(validateConnectorConfig(CID, { transport: 'http', url: 'https://ok' }).ok, false) // no name
})

test('[CONN-VAL] an unknown connector id has no schema → rejected', () => {
  assert.equal(validateConnectorConfig('nope', validConfig).ok, false)
})

// ─── The projection + classification (never-leak) ─────────────────────────────

test('[CONN-PROJ] toPublicConnector drops secretRef, keeps the public fields', () => {
  const out: any = toPublicConnector({
    id: 'r1', orgId: ORG, agentId: AGENT, connectorId: CID, status: 'configured',
    config: { name: 'X' }, accountLabel: 'X', secretRef: connectorSecretKey(CID),
    useOrgConnection: false, lastTestedAt: null, lastError: null,
    createdAt: new Date(0), updatedAt: new Date(0),
  } as any)
  assert.ok(!('secretRef' in out), 'secretRef must never be projected')
  assert.ok(!('id' in out) && !('orgId' in out) && !('agentId' in out), 'structural columns are not projected')
  assert.equal(out.connectorId, CID)
  assert.equal(out.status, 'configured')
  assert.deepEqual(out.config, { name: 'X' })
})

test('[CONN-PROJ] every agent_connectors column is classified public / secret / internal', () => {
  const columns = Object.keys(schema.agentConnectors)
    .filter((k) => !k.startsWith('_') && typeof (schema.agentConnectors as any)[k]?.name === 'string')
  assert.ok(columns.length > 5, `Scanned only ${columns.length} columns — the scan is broken, not the schema.`)
  const classified = new Set<string>([...PUBLIC_CONNECTOR_FIELDS, ...SECRET_CONNECTOR_FIELDS, ...INTERNAL_CONNECTOR_FIELDS])
  const unclassified = columns.filter((c) => !classified.has(c))
  assert.deepEqual(unclassified, [], `Unclassified agent_connectors column(s): ${unclassified.join(', ')} — classify each in services/agent-connectors.ts.`)
  // secretRef must be a secret, and must not also be public.
  assert.ok(SECRET_CONNECTOR_FIELDS.includes('secretRef' as any), 'secretRef must be classified secret')
  assert.ok(!(PUBLIC_CONNECTOR_FIELDS as readonly string[]).includes('secretRef'), 'secretRef must NOT be public')
  assert.ok(columns.includes('secretRef'), 'expected agent_connectors.secretRef to exist — if renamed, re-check the projection')
})

// ─── Owner gate ──────────────────────────────────────────────────────────────

test('[CONN-AUTHZ] a non-owner MEMBER cannot configure a connector → 403, nothing written', async () => {
  const member = appAs(MEMBER); await member.ready()
  const res = await member.inject({ method: 'POST', url: url(ORG, AGENT, `/${CID}`), payload: { config: validConfig, secret: SECRET_SENTINEL } })
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(await connRow(ORG, AGENT), undefined, 'the refused write must not have landed')
  await member.close()
})

test('[CONN-AUTHZ] a member cannot PUT config / test / delete either → 403', async () => {
  const member = appAs(MEMBER); await member.ready()
  for (const [method, tail] of [['PUT', `/${CID}/config`], ['POST', `/${CID}/test`], ['DELETE', `/${CID}`]] as const) {
    const res = await member.inject({ method, url: url(ORG, AGENT, tail), payload: { config: validConfig } })
    assert.equal(res.statusCode, 403, `${method} ${tail} → ${res.body}`)
  }
  await member.close()
})

test('[CONN-AUTHZ] an OWNER can configure → 201, row persisted, secret encrypted at AGENT scope', async () => {
  const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, `/${CID}`), payload: { config: validConfig, secret: SECRET_SENTINEL } })
  assert.equal(res.statusCode, 201, res.body)
  const row = await connRow(ORG, AGENT)
  assert.ok(row, 'the row must exist')
  assert.equal(row!.status, 'configured')
  assert.equal((row!.config as any).url, validConfig.url)
  assert.equal(row!.secretRef, connectorSecretKey(CID))
  // The secret is in the `secrets` table, at AGENT scope, ENCRYPTED (not plaintext).
  const sec = await db.query.secrets.findFirst({ where: and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.scope, 'agent'), eq(schema.secrets.scopeId, AGENT), eq(schema.secrets.key, connectorSecretKey(CID))) })
  assert.ok(sec, 'the credential must be stored at agent scope')
  assert.notEqual(sec!.valueEncrypted, SECRET_SENTINEL, 'the credential must be encrypted at rest, not plaintext')
  assert.equal(decrypt(sec!.valueEncrypted), SECRET_SENTINEL, 'and it must decrypt back to the value')
})

// ─── The credential NEVER leaves the backend ──────────────────────────────────

test('[CONN-LEAK] no read/list/echo/test response carries the credential or secretRef', async () => {
  // The connector is already configured (previous test). Drive every read surface.
  const surfaces = [
    { name: 'POST (configure echo)', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, `/${CID}`), payload: { config: validConfig, secret: SECRET_SENTINEL } }) },
    { name: 'GET list', res: await app.inject({ method: 'GET', url: url(ORG, AGENT) }) },
    { name: 'GET one', res: await app.inject({ method: 'GET', url: url(ORG, AGENT, `/${CID}`) }) },
    { name: 'POST test', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, `/${CID}/test`) }) },
    { name: 'PUT config', res: await app.inject({ method: 'PUT', url: url(ORG, AGENT, `/${CID}/config`), payload: { config: { ...validConfig, name: 'Renamed' } } }) },
  ]
  for (const s of surfaces) {
    assert.ok(s.res.statusCode < 400, `${s.name} → ${s.res.statusCode}: ${s.res.body}`)
    assert.ok(!s.res.body.includes(SECRET_SENTINEL), `${s.name} leaked the credential VALUE`)
    assert.ok(!s.res.body.includes('secretRef'), `${s.name} exposed the secretRef key`)
    assert.ok(!s.res.body.includes(connectorSecretKey(CID)), `${s.name} exposed the secret key name`)
  }
  // The list still carries the non-secret fields a client actually reads. Re-fetch
  // AFTER the PUT above renamed it — config travels, the credential does not.
  const fresh = await app.inject({ method: 'GET', url: url(ORG, AGENT) })
  const list = JSON.parse(fresh.body).connectors.find((c: any) => c.connectorId === CID)
  assert.equal(list.status, 'configured')
  assert.equal(list.config.name, 'Renamed')
})

// ─── Config validation on the write path ──────────────────────────────────────

test('[CONN-VAL] an owner posting junk config → 400, nothing persisted for a fresh connector', async () => {
  // Use a fresh agent so we can assert the row was NOT created.
  const fresh = 'agent-fresh'
  await db.insert(schema.agents).values({ id: fresh, orgId: ORG, name: 'Fresh', role: 'X', skills: [], runtime: 'internal', createdAt: new Date() } as any)
  const res = await app.inject({ method: 'POST', url: url(ORG, fresh, `/${CID}`), payload: { config: { name: 'X', transport: 'http', url: 'not-a-url' } } })
  assert.equal(res.statusCode, 400, res.body)
  assert.equal(await connRow(ORG, fresh), undefined, 'a rejected config must not create a row')
})

// ─── Disconnect removes the row AND the secret ────────────────────────────────

test('[CONN-DEL] disconnect removes the row and its agent-scoped secret', async () => {
  // Ensure configured with a secret first.
  await app.inject({ method: 'POST', url: url(ORG, AGENT, `/${CID}`), payload: { config: validConfig, secret: SECRET_SENTINEL } })
  const res = await app.inject({ method: 'DELETE', url: url(ORG, AGENT, `/${CID}`) })
  assert.equal(res.statusCode, 204, res.body)
  assert.equal(await connRow(ORG, AGENT), undefined, 'the row must be gone')
  const sec = await db.query.secrets.findFirst({ where: and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.scope, 'agent'), eq(schema.secrets.scopeId, AGENT), eq(schema.secrets.key, connectorSecretKey(CID))) })
  assert.equal(sec, undefined, 'the agent-scoped secret must be deleted with the connector')
})

// ─── Tenant scoping ───────────────────────────────────────────────────────────

test('[CONN-AUTHZ] an owner cannot configure an agent in ANOTHER org → 404, nothing written', async () => {
  // OWNER owns ORG, not OTHER_ORG. Pairing ORG's path with the foreign agent id
  // must not write (and OWNER is not even a member of OTHER_ORG).
  const res = await app.inject({ method: 'POST', url: url(ORG, OTHER_AGENT, `/${CID}`), payload: { config: validConfig } })
  assert.equal(res.statusCode, 404, res.body)
  assert.equal(await connRow(ORG, OTHER_AGENT), undefined, 'a cross-tenant write must not land')
})

// ─── The execution path: the agent-scoped secret is what gets injected ────────

test('[CONN-EXEC] resolveSecretsForAgent returns the agent connector secret, overriding a company default', async () => {
  const key = connectorSecretKey(CID)
  // A company-scope default under the SAME key, plus the agent's connector secret.
  const { encrypt } = await import('../services/secrets')
  await db.insert(schema.secrets).values({ id: randomUUID(), orgId: ORG, scope: 'company', scopeId: null, key, valueEncrypted: encrypt('COMPANY-DEFAULT'), createdAt: new Date() } as any)
  await app.inject({ method: 'POST', url: url(ORG, AGENT, `/${CID}`), payload: { config: validConfig, secret: SECRET_SENTINEL } })
  // Mimic GET /api/agent/secrets: fetch the org's resolvable secrets, decrypt, resolve.
  const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.orgId, ORG))
  const decrypted = rows
    .filter(r => r.scope === 'company' || r.scope === 'agent')
    .map(r => ({ scope: r.scope, scopeId: r.scopeId, key: r.key, value: decrypt(r.valueEncrypted) }))
  const bag = resolveSecretsForAgent(decrypted, AGENT)
  assert.equal(bag[key], SECRET_SENTINEL, 'the agent connector secret must WIN over the company default')
})

// ─── Migration idempotency ────────────────────────────────────────────────────

test('[CONN-MIG] the migration is idempotent — a second setupDatabase() does not throw', async () => {
  await setupDatabase()  // ran once in before(); running again must be a no-op
  // And the data seeded before the re-run is untouched.
  const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, ORG))
  assert.ok(agents.length >= 1, 'existing rows survive a re-migration')
})
