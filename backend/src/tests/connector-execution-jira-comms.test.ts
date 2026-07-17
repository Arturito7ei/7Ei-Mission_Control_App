// Epic CONN / CONN-8b-1 — the JIRA + comms (Telegram / WhatsApp / Google Chat) EXECUTORS.
//
// Mirrors connector-execution.test.ts (CONN-8a / GitHub) for the four executors CONN-8b-1
// adds, against a REAL SQLite file through the REAL connector-config + approval/step-up
// decide routes, with MOCKED provider transports (never a real network call). Proves, per
// connector:
//   1. every executor action's class matches the CONN-7 taxonomy (no drift);
//   2. Jira READ (issue.get / issue.search) executes with a mocked client;
//   3. a WRITE (not trusted) → pending_approval, NOT executed; approved + stepped-up →
//      executes EXACTLY once; the Jira DESTRUCTIVE issue.delete always needs approval;
//   4. the credential is used for the call but NEVER appears in a result, an error, or the
//      ledger — a per-connector SENTINEL, INCLUDING Telegram's bot-token-in-URL and the
//      Google Chat webhook-URL-as-secret;
//   5. SSRF — Jira's baseUrl + Google Chat's webhook are restricted to their allowed hosts
//      and a param value cannot redirect the host; Telegram / WhatsApp hosts are hardcoded.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'conn8b1-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'conn8b1-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const { taskRoutes } = await import('../routes/tasks')
const { executeConnectorAction, getExecutor } = await import('../services/connector-execution')
const { jiraExecutor } = await import('../services/connector-jira')
const { telegramExecutor } = await import('../services/connector-telegram')
const { whatsappExecutor } = await import('../services/connector-whatsapp')
const { googleChatExecutor } = await import('../services/connector-google-chat')
const { classifyConnectorAction } = await import('../services/connector-authz')
const { mintSession } = await import('../services/arturita-session')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org8b1', OWNER = 'owner8b1'
const AGENT = 'agent8b1' // connector:* + all four connectors configured

// One SENTINEL per connector — the sensitive credential that must NEVER surface anywhere.
const JIRA_TOKEN = 'jira_SENTINEL_conn8b1_apitoken'
const JIRA_EMAIL = 'ops@sevenei.example'
const JIRA_BASE = 'https://sevenei.atlassian.net'
const TG_TOKEN = '1234567890:SENTINELtgtokenABCDEFghijklmnop'          // in the URL PATH — the hardest leak
const WA_TOKEN = 'EAAG_SENTINEL_whatsapp_access_token'
const WA_PHONE_ID = '109876543210'
const GC_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=SENTINELkey&token=SENTINELtoken' // whole URL is the secret

let owner: FastifyInstance
const cu = (agentId: string, tail = '') => `/api/orgs/${ORG}/agents/${agentId}/connectors${tail}`

// ── mock transports — record every call, canned/overridable responses ──
function jsonRes(status: number, obj: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(obj)
  return { status, ok: status >= 200 && status < 300, headers, json: async () => obj, text: async () => body }
}
function makeHttp(responder?: (url: string, init: any) => any) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const client = async (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (responder) return responder(url, init)
    if (init.method === 'GET') return jsonRes(200, { key: 'MCA-1', id: '10001', fields: { summary: 'hi' } })
    if (init.method === 'DELETE') return { status: 204, ok: true, headers: {}, json: async () => null, text: async () => '' }
    return jsonRes(200, { ok: true, id: 'msg-1' }) // POST
  }
  return { client, calls }
}

async function setTrust(agentId: string, connectorId: string, trustLevel: string) {
  const r = await owner.inject({ method: 'PUT', url: cu(agentId, `/${connectorId}/trust`), payload: { trustLevel } })
  assert.equal(r.statusCode, 200, r.body)
}
async function mintFreshSession(): Promise<string> {
  const { token, record } = mintSession({ source: 'desk' })
  await db.insert(schema.arturitaSessions).values({
    id: randomUUID(), orgId: ORG, tokenHash: record.tokenHash, source: 'desk',
    createdAt: record.createdAt, expiresAt: record.expiresAt, lastStepupAt: record.lastStepupAt, revokedAt: null,
  } as any)
  return token
}
async function decide(approvalId: string, decision: string, sessionToken?: string) {
  return owner.inject({
    method: 'POST', url: `/api/approvals/${approvalId}/decide`,
    headers: sessionToken ? { 'x-arturita-session': sessionToken } : {},
    payload: { decision },
  })
}
/** File → approve (with step-up) → redeem, returning the executed result + the calls. */
async function runGated(connectorId: string, action: string, params: Record<string, unknown>, http: any) {
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId, action, params }, { httpClient: http.client })
  assert.equal(pend.status, 'pending_approval', JSON.stringify(pend))
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  return executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId, action, params, approvalId }, { httpClient: http.client })
}

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([{ id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now }] as any)
  await db.insert(schema.orgMembers).values([{ id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now }] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), createdAt: now },
  ] as any)

  owner = Fastify({ logger: false })
  owner.addHook('onRequest', async (req) => { (req as any).auth = { userId: OWNER }; (req as any).userId = OWNER })
  await owner.register(agentConnectorRoutes)
  await owner.register(taskRoutes)
  await owner.ready()

  // Configure all four connectors with their sentinel credentials (owner-gated route).
  const cfg = async (path: string, payload: any) => {
    const r = await owner.inject({ method: 'POST', url: cu(AGENT, path), payload })
    assert.ok(r.statusCode === 200 || r.statusCode === 201, `${path}: ${r.body}`)
  }
  await cfg('/jira', { config: { baseUrl: JIRA_BASE, email: JIRA_EMAIL }, secret: JIRA_TOKEN })
  await cfg('/telegram', { config: { botUsername: 'verabot', chatId: '4242' }, secret: TG_TOKEN })
  await cfg('/whatsapp', { config: { phoneNumberId: WA_PHONE_ID }, secret: WA_TOKEN })
  await cfg('/google_chat', { config: { space: 'spaces/AAAA' }, secret: GC_WEBHOOK })
})

after(async () => {
  await owner?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── 1. Taxonomy alignment — every executor action matches CONN-7 ──────────────

test('[CONN8B1-TAX] every Jira/comms executor action class matches the CONN-7 taxonomy', () => {
  for (const ex of [jiraExecutor, telegramExecutor, whatsappExecutor, googleChatExecutor]) {
    for (const [action, spec] of Object.entries(ex.actions)) {
      assert.equal(classifyConnectorAction(ex.connectorId, action), spec.class, `${ex.connectorId} '${action}' class must match taxonomy`)
    }
  }
  // Spot-check the exact classes the story specifies.
  assert.equal(jiraExecutor.actions['issue.get'].class, 'read')
  assert.equal(jiraExecutor.actions['issue.search'].class, 'read')
  assert.equal(jiraExecutor.actions['issue.create'].class, 'write')
  assert.equal(jiraExecutor.actions['issue.comment'].class, 'write')
  assert.equal(jiraExecutor.actions['issue.transition'].class, 'write')
  assert.equal(jiraExecutor.actions['issue.delete'].class, 'destructive')
  assert.equal(telegramExecutor.actions['message.send'].class, 'write')
  assert.equal(whatsappExecutor.actions['message.send'].class, 'write')
  assert.equal(googleChatExecutor.actions['message.send'].class, 'write')
})

test('[CONN8B1-REG] all four connectors are registered with the framework', () => {
  for (const id of ['jira', 'telegram', 'whatsapp', 'google_chat']) {
    assert.ok(getExecutor(id), `${id} must have a registered executor`)
  }
})

// ─── 2. Jira READ executes with a mocked client (host from stored baseUrl) ─────

test('[CONN8B1-JIRA-READ] issue.get + issue.search execute against the mocked Jira client (host = stored atlassian.net)', async () => {
  const g = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.get', params: { issueKey: 'MCA-1' } }, { httpClient: g.client })
  assert.equal(r.status, 'executed', JSON.stringify(r))
  assert.equal((r as any).data.key, 'MCA-1')
  assert.equal(g.calls.length, 1)
  assert.ok(g.calls[0].url.startsWith(`${JIRA_BASE}/rest/api/3/issue/MCA-1`), `SSRF: host must be the stored atlassian.net, got ${g.calls[0].url}`)
  assert.ok(g.calls[0].headers.Authorization.startsWith('Basic '), 'basic auth is used')

  const s = makeHttp((_u) => jsonRes(200, { issues: [{ key: 'MCA-1' }] }))
  const rs = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.search', params: { jql: 'project = MCA ORDER BY created' } }, { httpClient: s.client })
  assert.equal(rs.status, 'executed', JSON.stringify(rs))
  assert.ok(s.calls[0].url.startsWith(`${JIRA_BASE}/rest/api/3/search?jql=`))
  assert.ok(s.calls[0].url.includes(encodeURIComponent('project = MCA ORDER BY created')), 'jql is url-encoded into the query')
})

// ─── 3. WRITE gating + DESTRUCTIVE always-approval (per the story) ─────────────

test('[CONN8B1-WRITE] a Jira WRITE (not trusted) → pending_approval, NOT executed; approved+stepped-up → executes once', async () => {
  await setTrust(AGENT, 'jira', 'approval_required')
  const h = makeHttp((_u) => jsonRes(201, { key: 'MCA-99', id: '10099' }))
  // First pass files an approval, executes nothing.
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.create', params: { projectKey: 'MCA', summary: 'Ship' } }, { httpClient: h.client })
  assert.equal(pend.status, 'pending_approval')
  assert.equal(h.calls.length, 0, 'a needs_approval WRITE must NOT execute')
  // Approve with step-up + redeem → executes exactly once.
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  const done = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.create', params: { projectKey: 'MCA', summary: 'Ship' }, approvalId }, { httpClient: h.client })
  assert.equal(done.status, 'executed', JSON.stringify(done))
  assert.equal(h.calls.length, 1)
  // Replay the same approval → rejected, no second call (single-use).
  const replay = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.create', params: { projectKey: 'MCA', summary: 'Ship' }, approvalId }, { httpClient: h.client })
  assert.equal(replay.status, 'rejected')
  assert.equal(h.calls.length, 1, 'replay must not make a second provider call')
})

test('[CONN8B1-DESTRUCTIVE] Jira issue.delete ALWAYS needs approval, even under auto_write', async () => {
  await setTrust(AGENT, 'jira', 'auto_write')
  const h = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.delete', params: { issueKey: 'MCA-1' } }, { httpClient: h.client })
  assert.equal(r.status, 'pending_approval')
  assert.equal(r.classification, 'destructive')
  assert.equal(h.calls.length, 0, 'a destructive action never auto-executes')
  await setTrust(AGENT, 'jira', 'approval_required')
})

test('[CONN8B1-COMMS-WRITE] each comms message.send (not trusted) → pending_approval, NOT executed', async () => {
  for (const [connectorId, params] of [
    ['telegram', { text: 'hi' }],
    ['whatsapp', { to: '15551234567', text: 'hi' }],
    ['google_chat', { text: 'hi' }],
  ] as const) {
    await setTrust(AGENT, connectorId, 'approval_required')
    const h = makeHttp()
    const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId, action: 'message.send', params }, { httpClient: h.client })
    assert.equal(r.status, 'pending_approval', `${connectorId}: ${JSON.stringify(r)}`)
    assert.equal(h.calls.length, 0, `${connectorId}: a needs_approval send must NOT execute`)
  }
})

test('[CONN8B1-COMMS-EXEC] approved+stepped-up comms sends execute once against the hardcoded host', async () => {
  // telegram — host api.telegram.org, token in the PATH.
  const tg = makeHttp((_u) => jsonRes(200, { ok: true, result: { message_id: 7 } }))
  const tgR = await runGated('telegram', 'message.send', { text: 'hello' }, tg)
  assert.equal(tgR.status, 'executed', JSON.stringify(tgR))
  assert.ok(tg.calls[0].url.startsWith('https://api.telegram.org/bot'), `telegram host hardcoded, got ${tg.calls[0].url}`)
  assert.ok(tg.calls[0].url.endsWith('/sendMessage'))
  assert.equal(JSON.parse(tg.calls[0].body!).chat_id, '4242', 'chat id falls back to stored TELEGRAM_CHAT_ID')

  // whatsapp — host graph.facebook.com, phone number id in the path.
  const wa = makeHttp((_u) => jsonRes(200, { messages: [{ id: 'wamid.X' }] }))
  const waR = await runGated('whatsapp', 'message.send', { to: '15551234567', text: 'hello' }, wa)
  assert.equal(waR.status, 'executed', JSON.stringify(waR))
  assert.ok(wa.calls[0].url.startsWith(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`), `whatsapp host hardcoded, got ${wa.calls[0].url}`)
  assert.equal(wa.calls[0].headers.Authorization, `Bearer ${WA_TOKEN}`, 'bearer access token is used')

  // google_chat — POST to the stored (validated) webhook URL.
  const gc = makeHttp((_u) => jsonRes(200, { name: 'spaces/AAAA/messages/1' }))
  const gcR = await runGated('google_chat', 'message.send', { text: 'hello' }, gc)
  assert.equal(gcR.status, 'executed', JSON.stringify(gcR))
  assert.ok(gc.calls[0].url.startsWith('https://chat.googleapis.com/'), `google_chat host validated, got a non-google host`)
})

// ─── 4. Credentials NEVER leak — per-connector sentinels ──────────────────────

test('[CONN8B1-SECRET] no connector credential appears in a result, an error, or the ledger', async () => {
  // The credential each connector must keep secret — its raw secret-bag value. Telegram's is
  // the bot-token-IN-URL; Google Chat's is the whole webhook URL. These are the values the
  // framework's redactSecrets backstop covers (Object.values of the connector's secret bag).
  const secretsByConnector: Record<string, string[]> = {
    jira: [JIRA_TOKEN],
    telegram: [TG_TOKEN],
    whatsapp: [WA_TOKEN],
    google_chat: [GC_WEBHOOK],
  }
  const cases = [
    ['jira', 'issue.create', { projectKey: 'MCA', summary: 'S' }],
    ['telegram', 'message.send', { text: 'hi' }],
    ['whatsapp', 'message.send', { to: '15551234567', text: 'hi' }],
    ['google_chat', 'message.send', { text: 'hi' }],
  ] as const

  for (const [connectorId, action, params] of cases) {
    const sentinels = secretsByConnector[connectorId]
    await setTrust(AGENT, connectorId, 'auto_write')

    // (a) a provider that ECHOES the credential in a 2xx body → result must be redacted.
    const echo = makeHttp((_u) => jsonRes(200, { ok: true, leaked: `creds ${sentinels.join(' ')}` }))
    const ok = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId, action, params }, { httpClient: echo.client })
    assert.equal(ok.status, 'executed', `${connectorId}: ${JSON.stringify(ok)}`)
    for (const s of sentinels) assert.equal(JSON.stringify(ok).includes(s), false, `${connectorId}: '${s}' must not be in the executed result`)

    // (b) a provider ERROR that echoes the credential → error must be redacted too.
    const errh = makeHttp((_u) => jsonRes(400, { message: `bad ${sentinels.join(' ')}`, description: `bad ${sentinels.join(' ')}`, error: { message: `bad ${sentinels.join(' ')}` }, errorMessages: [`bad ${sentinels.join(' ')}`] }))
    const err = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId, action, params }, { httpClient: errh.client })
    assert.equal(err.status, 'error', `${connectorId}: ${JSON.stringify(err)}`)
    for (const s of sentinels) assert.equal(String((err as any).reason).includes(s), false, `${connectorId}: '${s}' must not be in the error`)

    await setTrust(AGENT, connectorId, 'approval_required')
  }

  // (c) the ledger never persists ANY credential (incl. the telegram token-in-URL and the
  //     google_chat webhook URL) — scan every execution row for this agent.
  const rows = await db.select().from(schema.connectorExecutions).where(and(eq(schema.connectorExecutions.orgId, ORG), eq(schema.connectorExecutions.agentId, AGENT)))
  const blob = JSON.stringify(rows)
  for (const s of [JIRA_TOKEN, TG_TOKEN, WA_TOKEN, GC_WEBHOOK, 'SENTINELkey', 'SENTINELtoken', 'bot' + TG_TOKEN]) {
    assert.equal(blob.includes(s), false, `ledger must not contain '${s}'`)
  }
})

// ─── 5. SSRF — hosts cannot be redirected by params or a malicious stored value ─

test('[CONN8B1-SSRF-JIRA] a param issue key cannot escape the path; a non-Atlassian stored baseUrl is refused', async () => {
  await setTrust(AGENT, 'jira', 'approval_required')
  // (a) a malicious issueKey (traversal / host-injection attempts) is rejected before any call.
  for (const bad of ['../../admin', 'a/@evil.com', 'a%2F..%2Fx', 'http://evil.com', 'a b', 'MCA-1#frag']) {
    const h = makeHttp()
    const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.get', params: { issueKey: bad } }, { httpClient: h.client })
    assert.equal(r.status, 'error', `issueKey '${bad}' must be refused`)
    assert.match((r as any).reason, /issueKey/)
    assert.equal(h.calls.length, 0, `no call for a bad issueKey '${bad}'`)
  }
  // (b) a stored baseUrl on a NON-Atlassian host is refused at execution (fail-closed SSRF).
  await db.update(schema.secrets)
    .set({ valueEncrypted: (await import('../services/secrets')).encrypt('https://evil.internal/rest') })
    .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'JIRA_BASE_URL')))
  const h = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.get', params: { issueKey: 'MCA-1' } }, { httpClient: h.client })
  assert.equal(r.status, 'error')
  assert.match((r as any).reason, /Atlassian/)
  assert.equal(h.calls.length, 0, 'a non-Atlassian baseUrl is never dialed')
  // restore the good baseUrl for any later tests
  await db.update(schema.secrets)
    .set({ valueEncrypted: (await import('../services/secrets')).encrypt(JIRA_BASE) })
    .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'JIRA_BASE_URL')))
})

test('[CONN8B1-SSRF-JIRA-USERINFO] a stored baseUrl with embedded userinfo pointing off-host is refused', async () => {
  await db.update(schema.secrets)
    .set({ valueEncrypted: (await import('../services/secrets')).encrypt('https://sevenei.atlassian.net@evil.com/rest') })
    .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'JIRA_BASE_URL')))
  const h = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'issue.get', params: { issueKey: 'MCA-1' } }, { httpClient: h.client })
  assert.equal(r.status, 'error', 'userinfo host-spoof must be refused')
  assert.equal(h.calls.length, 0)
  await db.update(schema.secrets)
    .set({ valueEncrypted: (await import('../services/secrets')).encrypt(JIRA_BASE) })
    .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'JIRA_BASE_URL')))
})

test('[CONN8B1-SSRF-GC] a stored google_chat webhook on a non-google host is refused', async () => {
  await setTrust(AGENT, 'google_chat', 'auto_write')
  for (const badUrl of [
    'https://evil.com/v1/spaces/x/messages?key=k&token=t',
    'https://chat.googleapis.com.evil.com/v1/x',
    'https://chat.googleapis.com@evil.com/v1/x',
    'http://chat.googleapis.com/v1/x', // not https
  ]) {
    await db.update(schema.secrets)
      .set({ valueEncrypted: (await import('../services/secrets')).encrypt(badUrl) })
      .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'GOOGLE_CHAT_WEBHOOK_URL')))
    const h = makeHttp()
    const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'google_chat', action: 'message.send', params: { text: 'hi' } }, { httpClient: h.client })
    assert.equal(r.status, 'error', `webhook '${badUrl}' must be refused`)
    assert.equal(h.calls.length, 0, `no call for a bad webhook '${badUrl}'`)
  }
  // restore
  await db.update(schema.secrets)
    .set({ valueEncrypted: (await import('../services/secrets')).encrypt(GC_WEBHOOK) })
    .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'GOOGLE_CHAT_WEBHOOK_URL')))
  await setTrust(AGENT, 'google_chat', 'approval_required')
})

test('[CONN8B1-SSRF-TG] a malformed telegram token (URL metachars) is refused before any call', async () => {
  await setTrust(AGENT, 'telegram', 'auto_write')
  await db.update(schema.secrets)
    .set({ valueEncrypted: (await import('../services/secrets')).encrypt('123:tok/../@evil.com') })
    .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'TELEGRAM_BOT_TOKEN')))
  const h = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'telegram', action: 'message.send', params: { text: 'hi' } }, { httpClient: h.client })
  assert.equal(r.status, 'error', 'a token with URL metacharacters must be refused')
  assert.equal(h.calls.length, 0)
  await db.update(schema.secrets)
    .set({ valueEncrypted: (await import('../services/secrets')).encrypt(TG_TOKEN) })
    .where(and(eq(schema.secrets.orgId, ORG), eq(schema.secrets.key, 'TELEGRAM_BOT_TOKEN')))
  await setTrust(AGENT, 'telegram', 'approval_required')
})
