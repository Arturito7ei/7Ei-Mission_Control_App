// Epic CONN / CONN-6 — Telegram + WhatsApp + Google Chat become per-agent Communication
// connectors (config + credential STORAGE; execution is CONN-8).
//
// The sibling of agent-connectors-github-jira.test.ts. This suite is the security net
// for storing THIRD-PARTY comms credentials at agent scope. It proves, against REAL
// handlers on a REAL SQLite file through the REAL owner gate:
//   1. owner can configure each connector → 201; a member 403s (nothing written);
//   2. the credential NEVER appears in ANY read/list/get/test/put response (value + key);
//   3. the credential flows to the agent as ENV under the runtime-expected keys —
//      TELEGRAM_BOT_TOKEN / WHATSAPP_ACCESS_TOKEN / GOOGLE_CHAT_WEBHOOK_URL plus the
//      NON-secret ids — proven via resolveSecretsForAgent (the exact bag
//      GET /api/agent/secrets injects);
//   4. strict config validation rejects unknown keys;
//   5. a required credential is enforced on first configure;
//   6. disconnect purges EVERY agent-scoped env row (credential AND non-secret ids);
//   7. tenant scoping holds (owner of org A cannot reach an agent in org B → 404);
//   8. `test` is a safe STUB — it never dials a provider (no SSRF), records the attempt.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'agent-conn-comms-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'agent-connectors-comms-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const {
  validateConnectorConfig, getAgentConnector, connectorSecretEntries,
  connectorEnvKeys, primarySecretKey, connectorAccountLabel,
} = await import('../services/agent-connectors')
const { decrypt, resolveSecretsForAgent } = await import('../services/secrets')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org-c', OWNER = 'user-owner', MEMBER = 'user-member', AGENT = 'agent-c'
const OTHER_ORG = 'org-other', OTHER_OWNER = 'user-other-owner', OTHER_AGENT = 'agent-other'

// Distinctive credentials: if any appears ANYWHERE in a response body, a secret leaked.
const TG_SENTINEL = '123456:SENTINEL-telegram-bot-token-abcXYZ'
const WA_SENTINEL = 'EAA-SENTINEL-whatsapp-access-token-abcXYZ'
const GC_SENTINEL = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=SENTINEL-gchat&token=abcXYZ'

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

const tgConfig = { botUsername: 'mc_bot', chatId: '99887766' }
const waConfig = { phoneNumberId: '111222333', businessAccountId: '444555666' }
const gcConfig = { space: 'spaces/AAAAAAAA' }

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

test('[CONN6-CAT] telegram + whatsapp + google_chat are in the catalog, token-auth, secret-required', () => {
  for (const id of ['telegram', 'whatsapp', 'google_chat']) {
    const m = getAgentConnector(id)
    assert.ok(m, `${id} must be in the catalog`)
    assert.equal(m!.category, 'Communication', `${id} is a Communication connector`)
    assert.equal(m!.authType, 'token')
    assert.ok(m!.hasSecret && m!.secretRequired, `${id} stores a required credential`)
  }
})

test('[CONN6-VAL] config schemas are strict + all-optional non-secret fields', () => {
  assert.equal(validateConnectorConfig('telegram', {}).ok, true)          // credential carries the auth, config optional
  assert.equal(validateConnectorConfig('telegram', tgConfig).ok, true)
  assert.equal(validateConnectorConfig('telegram', { botUsername: 'x', evil: 1 }).ok, false) // strict
  assert.equal(validateConnectorConfig('telegram', { token: 'x' }).ok, false)                // no secret in config

  assert.equal(validateConnectorConfig('whatsapp', {}).ok, true)
  assert.equal(validateConnectorConfig('whatsapp', waConfig).ok, true)
  assert.equal(validateConnectorConfig('whatsapp', { accessToken: 'x' }).ok, false)          // strict — no secret

  assert.equal(validateConnectorConfig('google_chat', {}).ok, true)
  assert.equal(validateConnectorConfig('google_chat', gcConfig).ok, true)
  assert.equal(validateConnectorConfig('google_chat', { webhookUrl: 'x' }).ok, false)        // strict — URL is the secret
})

test('[CONN6-ENV] the env-key mapping is the runtime contract', () => {
  assert.deepEqual([...connectorEnvKeys('telegram')], ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
  assert.deepEqual([...connectorEnvKeys('whatsapp')], ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID'])
  assert.deepEqual([...connectorEnvKeys('google_chat')], ['GOOGLE_CHAT_WEBHOOK_URL'])
  assert.equal(primarySecretKey('telegram'), 'TELEGRAM_BOT_TOKEN')
  assert.equal(primarySecretKey('whatsapp'), 'WHATSAPP_ACCESS_TOKEN')
  assert.equal(primarySecretKey('google_chat'), 'GOOGLE_CHAT_WEBHOOK_URL')
  // Non-secret ids always derive from config; the credential only when supplied.
  assert.deepEqual(connectorSecretEntries('telegram', tgConfig, undefined), { TELEGRAM_CHAT_ID: tgConfig.chatId })
  assert.deepEqual(connectorSecretEntries('telegram', tgConfig, TG_SENTINEL), { TELEGRAM_CHAT_ID: tgConfig.chatId, TELEGRAM_BOT_TOKEN: TG_SENTINEL })
  assert.deepEqual(connectorSecretEntries('whatsapp', waConfig, WA_SENTINEL), { WHATSAPP_PHONE_NUMBER_ID: waConfig.phoneNumberId, WHATSAPP_BUSINESS_ACCOUNT_ID: waConfig.businessAccountId, WHATSAPP_ACCESS_TOKEN: WA_SENTINEL })
  assert.deepEqual(connectorSecretEntries('google_chat', gcConfig, GC_SENTINEL), { GOOGLE_CHAT_WEBHOOK_URL: GC_SENTINEL })
  assert.equal(connectorAccountLabel('telegram', tgConfig), 'mc_bot')
  assert.equal(connectorAccountLabel('telegram', { chatId: '5' }), '5') // falls back to chatId
  assert.equal(connectorAccountLabel('whatsapp', waConfig), '111222333')
  assert.equal(connectorAccountLabel('google_chat', gcConfig), 'spaces/AAAAAAAA')
})

// ─── Owner gate + required credential ─────────────────────────────────────────

test('[CONN6-AUTHZ] a member cannot configure telegram → 403, nothing written', async () => {
  const member = appAs(MEMBER); await member.ready()
  const res = await member.inject({ method: 'POST', url: url(ORG, AGENT, '/telegram'), payload: { config: tgConfig, secret: TG_SENTINEL } })
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(await connRow(ORG, AGENT, 'telegram'), undefined)
  await member.close()
})

test('[CONN6-REQ] each comms connector requires a credential on first configure → 400', async () => {
  const fresh = 'agent-req-c'
  await db.insert(schema.agents).values({ id: fresh, orgId: ORG, name: 'Req', role: 'X', skills: [], runtime: 'internal', createdAt: new Date() } as any)
  for (const [cid, cfg] of [['telegram', tgConfig], ['whatsapp', waConfig], ['google_chat', gcConfig]] as const) {
    const res = await app.inject({ method: 'POST', url: url(ORG, fresh, `/${cid}`), payload: { config: cfg } })
    assert.equal(res.statusCode, 400, `${cid}: ${res.body}`)
    assert.equal(await connRow(ORG, fresh, cid), undefined, `no row for a rejected ${cid} write`)
  }
})

// ─── Configure → the credential is stored as ENV under the runtime keys ───────

test('[CONN6-EXEC] configure stores each credential at agent scope; all keys reach the runtime env', async () => {
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/telegram'), payload: { config: tgConfig, secret: TG_SENTINEL } })
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/whatsapp'), payload: { config: waConfig, secret: WA_SENTINEL } })
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/google_chat'), payload: { config: gcConfig, secret: GC_SENTINEL } })

  const tg = await connRow(ORG, AGENT, 'telegram')
  assert.ok(tg && tg.secretRef === 'TELEGRAM_BOT_TOKEN' && tg.accountLabel === 'mc_bot')
  // Encrypted at rest, decrypts back.
  const sec = await agentSecret(ORG, AGENT, 'TELEGRAM_BOT_TOKEN')
  assert.ok(sec && sec.valueEncrypted !== TG_SENTINEL && decrypt(sec.valueEncrypted) === TG_SENTINEL)

  const bag = await agentEnvBag(ORG, AGENT)
  assert.equal(bag.TELEGRAM_BOT_TOKEN, TG_SENTINEL, 'TELEGRAM_BOT_TOKEN must reach the runtime env')
  assert.equal(bag.TELEGRAM_CHAT_ID, tgConfig.chatId)
  assert.equal(bag.WHATSAPP_ACCESS_TOKEN, WA_SENTINEL, 'WHATSAPP_ACCESS_TOKEN must reach the runtime env')
  assert.equal(bag.WHATSAPP_PHONE_NUMBER_ID, waConfig.phoneNumberId)
  assert.equal(bag.WHATSAPP_BUSINESS_ACCOUNT_ID, waConfig.businessAccountId)
  assert.equal(bag.GOOGLE_CHAT_WEBHOOK_URL, GC_SENTINEL, 'GOOGLE_CHAT_WEBHOOK_URL must reach the runtime env')
})

// ─── The credential NEVER leaves the backend ──────────────────────────────────

test('[CONN6-LEAK] no read/list/get/test/put response carries any credential or secret key name', async () => {
  const surfaces = [
    { name: 'POST telegram', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/telegram'), payload: { config: tgConfig, secret: TG_SENTINEL } }) },
    { name: 'POST whatsapp', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/whatsapp'), payload: { config: waConfig, secret: WA_SENTINEL } }) },
    { name: 'POST google_chat', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/google_chat'), payload: { config: gcConfig, secret: GC_SENTINEL } }) },
    { name: 'GET list', res: await app.inject({ method: 'GET', url: url(ORG, AGENT) }) },
    { name: 'GET telegram', res: await app.inject({ method: 'GET', url: url(ORG, AGENT, '/telegram') }) },
    { name: 'GET whatsapp', res: await app.inject({ method: 'GET', url: url(ORG, AGENT, '/whatsapp') }) },
    { name: 'GET google_chat', res: await app.inject({ method: 'GET', url: url(ORG, AGENT, '/google_chat') }) },
    { name: 'POST telegram test', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/telegram/test') }) },
    { name: 'POST whatsapp test', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/whatsapp/test') }) },
    { name: 'POST google_chat test', res: await app.inject({ method: 'POST', url: url(ORG, AGENT, '/google_chat/test') }) },
    { name: 'PUT telegram config', res: await app.inject({ method: 'PUT', url: url(ORG, AGENT, '/telegram/config'), payload: { config: { ...tgConfig, chatId: '55' } } }) },
  ]
  for (const s of surfaces) {
    assert.ok(s.res.statusCode < 400, `${s.name} → ${s.res.statusCode}: ${s.res.body}`)
    for (const [label, sentinel] of [['telegram', TG_SENTINEL], ['whatsapp', WA_SENTINEL], ['google_chat', GC_SENTINEL]] as const) {
      assert.ok(!s.res.body.includes(sentinel), `${s.name} leaked the ${label} credential`)
    }
    assert.ok(!s.res.body.includes('secretRef'), `${s.name} exposed secretRef`)
    assert.ok(!s.res.body.includes('TELEGRAM_BOT_TOKEN') && !s.res.body.includes('WHATSAPP_ACCESS_TOKEN') && !s.res.body.includes('GOOGLE_CHAT_WEBHOOK_URL'),
      `${s.name} exposed a secret key name`)
  }
  // Non-secret config still travels (the renamed chatId is returnable).
  const tg = JSON.parse((await app.inject({ method: 'GET', url: url(ORG, AGENT, '/telegram') })).body).connector
  assert.equal(tg.config.chatId, '55')
  assert.equal(tg.status, 'configured')
})

// ─── `test` is a safe stub — no provider dial ─────────────────────────────────

test('[CONN6-TEST] test is a stub — ok:true and never dials a provider (no SSRF)', async () => {
  const calls: string[] = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response('{}', { status: 200 }) }) as any
  try {
    for (const cid of ['telegram', 'whatsapp', 'google_chat']) {
      const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, `/${cid}/test`) })
      assert.equal(res.statusCode, 200, res.body)
      assert.equal(JSON.parse(res.body).ok, true)
    }
    assert.equal(calls.length, 0, 'a comms connector test must NOT dial any host (execution is CONN-8)')
  } finally {
    globalThis.fetch = origFetch
  }
})

// ─── Disconnect purges every env row; tenant scoping ──────────────────────────

test('[CONN6-DEL] disconnect whatsapp purges token + phone id + business id rows', async () => {
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/whatsapp'), payload: { config: waConfig, secret: WA_SENTINEL } })
  const res = await app.inject({ method: 'DELETE', url: url(ORG, AGENT, '/whatsapp') })
  assert.equal(res.statusCode, 204, res.body)
  assert.equal(await connRow(ORG, AGENT, 'whatsapp'), undefined)
  for (const k of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID']) {
    assert.equal(await agentSecret(ORG, AGENT, k), undefined, `${k} must be purged on disconnect`)
  }
})

test('[CONN6-AUTHZ] an owner cannot configure telegram on an agent in ANOTHER org → 404', async () => {
  const res = await app.inject({ method: 'POST', url: url(ORG, OTHER_AGENT, '/telegram'), payload: { config: tgConfig, secret: TG_SENTINEL } })
  assert.equal(res.statusCode, 404, res.body)
  assert.equal(await connRow(ORG, OTHER_AGENT, 'telegram'), undefined)
})
