// Epic CONN / CONN-8b-2 — the GOOGLE WORKSPACE executor (Gmail / Calendar / Drive).
//
// The security net for the first OAUTH-credentialed executor: an agent making a REAL
// Google API call with the agent's OAuth ACCESS TOKEN (resolved from CONN-5's encrypted
// `agent_oauth_tokens`, NOT the env secret bag). Proven here against a REAL SQLite file
// through the REAL approval/step-up decide route, with a MOCKED Google transport and a
// MOCKED (injectable) token resolver — never a real network call, never a real Google:
//   1. every executor action's class matches the CONN-7 taxonomy; kind is 'google_oauth';
//   2. a READ executes, obtaining a FRESH token via the resolver (and via the REAL
//      ensureFreshAgentGoogleToken over a seeded encrypted row — proving the source);
//   3. gmail.send (WRITE, not trusted) → NOT executed, approval filed; approved+stepped-up
//      → executes EXACTLY once; replay rejected (single-use);
//   4. a DESTRUCTIVE google action under auto_write STILL needs approval;
//   5. the access token is used for the call but NEVER appears in a result / error /
//      ledger; the refresh token never reaches the executor at all (sentinels);
//   6. no Google connection / revoked token → fail closed (NOT executed);
//   7. SSRF: host is fixed to the hardcoded Google hosts; ids/params can't move it;
//   8. a missing granted scope fails closed with a clean "reconnect" (no raw 403).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { GoogleTokenResolver } from '../services/connector-execution'

const tmp = mkdtempSync(join(tmpdir(), 'conn8b2-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'conn8b2-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { taskRoutes } = await import('../routes/tasks')
const { executeConnectorAction } = await import('../services/connector-execution')
const { googleExecutor } = await import('../services/connector-google')
const { classifyConnectorAction } = await import('../services/connector-authz')
const { mintSession } = await import('../services/arturita-session')
const { encrypt } = await import('../services/secrets')
const { eq, and } = await import('drizzle-orm')

const ORG = 'orgg', OWNER = 'ownerg'
const AGENT = 'agentg'          // connector:* + google connected (the workhorse; resolver injected)
const AGENT_REAL = 'agentg-real' // drives the REAL ensureFreshAgentGoogleToken over a seeded row

// The OAuth token sentinels — must NEVER surface in a result / error / ledger.
const ACCESS_SENTINEL = 'ya29.ACCESS_SENTINEL_conn8b2'
const REFRESH_SENTINEL = '1//REFRESH_SENTINEL_conn8b2' // the executor must never even SEE this

// A fully-connected grant (matches CONN-5 SERVICE_SCOPES for all three services).
const FULL_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

let owner: FastifyInstance // owner-authed: the real decide + step-up route

// A resolver that hands back the sentinel token + full scopes (the "connected" case).
const resolverFull: GoogleTokenResolver = async () => ({ accessToken: ACCESS_SENTINEL, accountEmail: 'agent@example.com', scopes: FULL_SCOPES })
// A resolver with a narrow grant (only gmail.send) — reads fail closed on missing scope.
const resolverSendOnly: GoogleTokenResolver = async () => ({ accessToken: ACCESS_SENTINEL, accountEmail: 'agent@example.com', scopes: 'https://www.googleapis.com/auth/gmail.send' })

// ── a mock Google transport — records every call, canned/overridable responses ──
function jsonRes(status: number, obj: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(obj)
  return { status, ok: status >= 200 && status < 300, headers, json: async () => obj, text: async () => body }
}
function makeHttp(responder?: (url: string, init: any) => any) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const client = async (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (responder) return responder(url, init)
    if (init.method === 'GET') return jsonRes(200, { messages: [{ id: 'abc' }], id: 'abc', kind: 'calendar#events' })
    if (init.method === 'POST') return jsonRes(200, { id: 'created-1', threadId: 't1' })
    if (init.method === 'PATCH') return jsonRes(200, { id: 'file-1', name: 'renamed' })
    if (init.method === 'DELETE') return { status: 204, ok: true, headers: {}, json: async () => null, text: async () => '' }
    return jsonRes(200, {})
  }
  return { client, calls }
}

async function connectGoogle(agentId: string, trustLevel = 'approval_required') {
  const now = new Date()
  await db.insert(schema.agentConnectors).values({
    id: randomUUID(), orgId: ORG, agentId, connectorId: 'google', status: 'connected',
    config: { services: { calendar: true, gmail: true, drive: true } }, accountLabel: 'agent@example.com',
    secretRef: null, useOrgConnection: false, trustLevel, createdAt: now, updatedAt: now,
  } as any)
}
async function setTrust(agentId: string, trustLevel: string) {
  await db.update(schema.agentConnectors).set({ trustLevel })
    .where(and(eq(schema.agentConnectors.orgId, ORG), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, 'google')))
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
async function ledgerFor(approvalId: string) {
  return db.query.connectorExecutions.findFirst({ where: eq(schema.connectorExecutions.approvalId, approvalId) })
}
// Execute with the injected sentinel resolver + a mock http (never a real Google/network).
function exec(input: any, http: any, resolver: GoogleTokenResolver = resolverFull) {
  return executeConnectorAction(input, { httpClient: http, googleTokenResolver: resolver })
}

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([{ id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now }] as any)
  await db.insert(schema.orgMembers).values([{ id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now }] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Gia', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), createdAt: now },
    { id: AGENT_REAL, orgId: ORG, name: 'Rea', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), createdAt: now },
  ] as any)
  await connectGoogle(AGENT)
  await connectGoogle(AGENT_REAL)

  owner = Fastify({ logger: false })
  owner.addHook('onRequest', async (req) => { (req as any).auth = { userId: OWNER }; (req as any).userId = OWNER })
  await owner.register(taskRoutes)
  await owner.ready()
})

after(async () => {
  await owner?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── 1. Taxonomy alignment + credential kind ──────────────────────────────────

test('[CONN8B2-TAX] every Google executor action class matches the CONN-7 taxonomy', () => {
  const seen = { read: 0, write: 0, destructive: 0 }
  for (const [action, spec] of Object.entries(googleExecutor.actions)) {
    assert.equal(classifyConnectorAction('google', action), spec.class, `google '${action}' class must match taxonomy`)
    seen[spec.class as keyof typeof seen]++
  }
  // The killer write + a couple of reads + a destructive are all present.
  assert.equal(googleExecutor.actions['gmail.send'].class, 'write')
  assert.ok(seen.read >= 2 && seen.write >= 1 && seen.destructive >= 1)
})

test('[CONN8B2-KIND] the Google executor resolves its credential via OAuth, not the env bag', () => {
  assert.equal(googleExecutor.credentialKind, 'google_oauth')
  assert.equal(googleExecutor.connectorId, 'google')
})

// ─── 2. READ executes with a mocked client + fresh-token path ─────────────────

test('[CONN8B2-READ] a READ executes against the mocked Google client (host fixed to gmail.googleapis.com)', async () => {
  const { client, calls } = makeHttp()
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.list', params: { maxResults: 5 } }, client)
  assert.equal(r.status, 'executed', JSON.stringify(r))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.startsWith('https://gmail.googleapis.com/'), `SSRF: host must be gmail.googleapis.com, got ${calls[0].url}`)
  assert.equal(calls[0].headers.Authorization, `Bearer ${ACCESS_SENTINEL}`, 'the fresh access token IS used for the call')
})

test('[CONN8B2-HOSTS] calendar + drive reads dial their hardcoded www.googleapis.com host', async () => {
  const cal = makeHttp()
  await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'calendar.list', params: {} }, cal.client)
  assert.ok(cal.calls[0].url.startsWith('https://www.googleapis.com/calendar/v3/'), cal.calls[0].url)
  const drv = makeHttp()
  await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'drive.list', params: {} }, drv.client)
  assert.ok(drv.calls[0].url.startsWith('https://www.googleapis.com/drive/v3/'), drv.calls[0].url)
})

test('[CONN8B2-REALSTORE] the fresh token comes from the ENCRYPTED agent_oauth_tokens store (real resolver)', async () => {
  // Seed a REAL encrypted token row (non-expired) and run WITHOUT an injected resolver —
  // executeConnectorAction falls through to the real ensureFreshAgentGoogleToken, proving
  // agent_oauth_tokens (NOT the env secret bag) is the credential source.
  const now = new Date()
  await db.insert(schema.agentOauthTokens).values({
    id: randomUUID(), orgId: ORG, agentId: AGENT_REAL, provider: 'google',
    accessTokenEnc: encrypt(ACCESS_SENTINEL), refreshTokenEnc: encrypt(REFRESH_SENTINEL),
    expiresAt: new Date(Date.now() + 3600_000), scopes: FULL_SCOPES, accountEmail: 'agent@example.com',
    createdAt: now, updatedAt: now,
  } as any)
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT_REAL, connectorId: 'google', action: 'gmail.list', params: {} }, { httpClient: client })
  assert.equal(r.status, 'executed', JSON.stringify(r))
  assert.equal(calls[0].headers.Authorization, `Bearer ${ACCESS_SENTINEL}`, 'decrypted access token from agent_oauth_tokens was used')
})

// ─── 3. gmail.send lifecycle: WRITE gate → approve+step-up → single-use ────────

test('[CONN8B2-SEND] gmail.send (not trusted) → pending_approval, NOT executed; no credential on the card', async () => {
  const { client, calls } = makeHttp()
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params: { to: 'x@example.com', subject: 'Hi', body: 'Hello' }, target: 'x@example.com' }, client)
  assert.equal(r.status, 'pending_approval', JSON.stringify(r))
  assert.equal(r.classification, 'write')
  assert.equal(calls.length, 0, 'a needs_approval action must NOT execute')
  const ap = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, (r as any).approvalId) })
  assert.ok(ap && ap.type === 'connector_action' && ap.status === 'pending')
  assert.equal((ap!.payload as any)?.requiresStepUp, true)
  assert.equal(JSON.stringify(ap).includes(ACCESS_SENTINEL), false, 'no credential in the approval card')
})

test('[CONN8B2-ONCE] gmail.send approved+stepped-up → executes EXACTLY once; replay rejected (single-use)', async () => {
  const params = { to: 'ship@example.com', subject: 'Ship', body: 'Now' }
  const pend = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params }, makeHttp().client)
  assert.equal(pend.status, 'pending_approval')
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)

  const { client, calls } = makeHttp()
  const first = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params, approvalId }, client)
  assert.equal(first.status, 'executed', JSON.stringify(first))
  assert.equal(calls.length, 1, 'the approved send executes exactly once')
  assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
  assert.equal(calls[0].method, 'POST')
  assert.ok(JSON.parse(calls[0].body!).raw, 'a base64url RFC5322 message is posted')
  const led = await ledgerFor(approvalId)
  assert.equal(led!.status, 'succeeded')

  const replay = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params, approvalId }, client)
  assert.equal(replay.status, 'rejected')
  assert.match((replay as any).reason, /already been executed/)
  assert.equal(calls.length, 1, 'replay must not make a second provider call')
})

test('[CONN8B2-STEPUP] approving a gmail.send WITHOUT step-up is refused (approval stays pending)', async () => {
  const pend = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params: { to: 'a@example.com', subject: 'S', body: 'B' } }, makeHttp().client)
  const approvalId = (pend as any).approvalId
  assert.equal((await decide(approvalId, 'approved')).statusCode, 403) // no session header
  const ap = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, approvalId) })
  assert.equal(ap!.status, 'pending')
})

// ─── 4. Trust: auto_write WRITE runs; DESTRUCTIVE still needs approval ─────────

test('[CONN8B2-TRUST] auto_write gmail.send executes; calendar.event.delete (destructive) still needs approval', async () => {
  await setTrust(AGENT, 'auto_write')
  const wh = makeHttp()
  const w = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params: { to: 'auto@example.com', subject: 'Auto', body: 'Body' } }, wh.client)
  assert.equal(w.status, 'executed', JSON.stringify(w))
  assert.equal(wh.calls.length, 1)
  // DESTRUCTIVE always needs approval, even trusted.
  const dh = makeHttp()
  const d = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'calendar.event.delete', params: { calendarId: 'primary', eventId: 'evt123' } }, dh.client)
  assert.equal(d.status, 'pending_approval')
  assert.equal(d.classification, 'destructive')
  assert.equal(dh.calls.length, 0, 'a destructive action never auto-executes')
  await setTrust(AGENT, 'approval_required')
})

// ─── 5. The token never leaks (access AND refresh sentinels) ──────────────────

test('[CONN8B2-SECRET] the access token is used but never appears in a result / error / ledger; refresh never seen', async () => {
  await setTrust(AGENT, 'auto_write')
  // (a) a provider that ECHOES the access token in a 2xx body — the result must be redacted.
  const echo = makeHttp(() => jsonRes(200, { id: 'e1', leaked: `token is ${ACCESS_SENTINEL}` }))
  const ok = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params: { to: 'e@example.com', subject: 'E', body: 'B' } }, echo.client)
  assert.equal(ok.status, 'executed')
  assert.equal(JSON.stringify(ok).includes(ACCESS_SENTINEL), false, 'no access token in the executed result')
  assert.equal(echo.calls[0].headers.Authorization, `Bearer ${ACCESS_SENTINEL}`, 'the token WAS used for the call')
  // (b) a provider ERROR that echoes the access token — the error must be redacted too.
  const errh = makeHttp(() => jsonRes(400, { error: { message: `bad ${ACCESS_SENTINEL}` } }))
  const err = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params: { to: 'e@example.com', subject: 'E', body: 'B' } }, errh.client)
  assert.equal(err.status, 'error')
  assert.equal(String((err as any).reason).includes(ACCESS_SENTINEL), false, 'no access token in the error')
  // (c) neither sentinel ever persists in the execution ledger.
  const rows = await db.select().from(schema.connectorExecutions).where(eq(schema.connectorExecutions.orgId, ORG))
  const dump = JSON.stringify(rows)
  assert.equal(dump.includes(ACCESS_SENTINEL), false, 'no access token in the ledger')
  assert.equal(dump.includes(REFRESH_SENTINEL), false, 'the refresh token never even reaches the executor / ledger')
  await setTrust(AGENT, 'approval_required')
})

// ─── 6. Fail-closed: no Google connection / revoked token ─────────────────────

test('[CONN8B2-NOCONN] no Google connection (resolver → null) → fail closed, NOT executed', async () => {
  const { client, calls } = makeHttp()
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.list', params: {} }, client, async () => null)
  assert.equal(r.status, 'error')
  assert.match((r as any).reason, /google connection is unavailable|reconnect/i)
  assert.equal(calls.length, 0, 'no provider call when the connection is unavailable')
})

test('[CONN8B2-REVOKED] a revoked token (resolver throws on refresh) → fail closed, NOT executed', async () => {
  const { client, calls } = makeHttp()
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.list', params: {} }, client, async () => { throw new Error('invalid_grant') })
  assert.equal(r.status, 'error')
  assert.match((r as any).reason, /reconnect|unavailable/i)
  assert.equal(String((r as any).reason).includes('invalid_grant'), false, 'raw refresh error is not surfaced')
  assert.equal(calls.length, 0)
})

// ─── 7. SSRF — ids/params can't move the host ─────────────────────────────────

test('[CONN8B2-SSRF] a param cannot inject a non-Google host — an invalid id is refused before any call', async () => {
  const { client, calls } = makeHttp()
  // gmail.get is a READ (allowed), but a host-injecting id fails validation → error, no call.
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.get', params: { id: 'evil.com/x' } }, client)
  assert.equal(r.status, 'error')
  assert.match((r as any).reason, /id/)
  assert.equal(calls.length, 0, 'no request is ever dialed for an invalid segment')
  // a calendarId that tries to escape the path is refused too.
  const r2 = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'calendar.event.get', params: { calendarId: 'evil.com/../x', eventId: 'e1' } }, makeHttp().client)
  assert.equal(r2.status, 'error')
})

test('[CONN8B2-SEND-VALIDATION] gmail.send rejects a bad recipient / header injection before any call', async () => {
  await setTrust(AGENT, 'auto_write')
  const inj = makeHttp()
  // a newline in `to` (header injection) is rejected.
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.send', params: { to: 'ok@example.com\r\nBcc: evil@x.com', subject: 'S', body: 'B' } }, inj.client)
  assert.equal(r.status, 'error')
  assert.equal(inj.calls.length, 0, 'no send is dialed for an injected header')
  await setTrust(AGENT, 'approval_required')
})

// ─── 8. Missing-scope handled cleanly (no raw 403, no token) ───────────────────

test('[CONN8B2-SCOPE] a read with a grant missing gmail.readonly fails closed with a clean reconnect message', async () => {
  const { client, calls } = makeHttp()
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.list', params: {} }, client, resolverSendOnly)
  assert.equal(r.status, 'error')
  assert.match((r as any).reason, /scope/)
  assert.match((r as any).reason, /reconnect/i)
  assert.equal(String((r as any).reason).includes(ACCESS_SENTINEL), false, 'no token leaks in the missing-scope error')
  assert.equal(calls.length, 0, 'no Google call is made when a required scope is absent')
})

test('[CONN8B2-DELETE-FAILCLOSED] gmail.delete fails closed (CONN-5 never grants gmail.modify)', async () => {
  // gmail.delete is DESTRUCTIVE → approval; approve it, then redeem: even a full grant
  // lacks gmail.modify, so the handler fails closed with a clean scope message — no call.
  await setTrust(AGENT, 'auto_write') // trust is irrelevant for destructive; kept explicit
  const pend = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.delete', params: { id: 'msg1' } }, makeHttp().client)
  assert.equal(pend.status, 'pending_approval')
  assert.equal(pend.classification, 'destructive')
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  const { client, calls } = makeHttp()
  const r = await exec({ orgId: ORG, agentId: AGENT, connectorId: 'google', action: 'gmail.delete', params: { id: 'msg1' }, approvalId }, client)
  assert.equal(r.status, 'error')
  assert.match((r as any).reason, /scope/)
  assert.equal(calls.length, 0, 'no trash/delete is dialed without gmail.modify')
  await setTrust(AGENT, 'approval_required')
})
