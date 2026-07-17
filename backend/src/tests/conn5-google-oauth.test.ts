// Epic CONN / CONN-5 — per-AGENT Google OAuth, end-to-end.
//
// The security net for a feature that stores OAUTH TOKENS. It proves, against REAL
// handlers on a REAL SQLite file through the REAL owner gate, with Google's network
// STUBBED (no real HTTP):
//   1. STATE is unforgeable + single-use + expiring — an unknown, tampered, expired,
//      or reused `state` is REJECTED at the callback (no token issued);
//   2. tokens are stored ENCRYPTED at agent scope and NEVER appear in any response
//      (start url, callback redirect, connector read) — value + refresh both;
//   3. the start + disconnect routes are OWNER-gated (a member 403s) and TENANT-scoped
//      (an owner of org A cannot touch an agent in org B → 404);
//   4. the callback binds the tokens to the (org, agent) the state was minted for;
//   5. disconnect revokes + PURGES the agent-scoped tokens;
//   6. the stored token is the one the RUNTIME helper (ensureFreshAgentGoogleToken)
//      resolves — the Drive-RAG execution path;
//   7. redirect targets are allow-listed (no open redirect).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'conn5-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'conn5-test-key'
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.PUBLIC_URL = 'https://api.example.com'
process.env.ALLOWED_ORIGINS = 'https://app.example.com'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const { agentAuthGoogleRoutes } = await import('../routes/agent-auth-google')
const gauth = await import('../services/agent-google-auth')
const { decrypt } = await import('../services/secrets')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org-c5', OWNER = 'user-owner', MEMBER = 'user-member', AGENT = 'agent-c5'
const OTHER_ORG = 'org-c5-other', OTHER_OWNER = 'user-other', OTHER_AGENT = 'agent-c5-other'

// Distinctive token values: if any appears in a response, a secret leaked.
const ACCESS_SENTINEL = 'ya29.ACCESS-SENTINEL-conn5'
const REFRESH_SENTINEL = '1//REFRESH-SENTINEL-conn5'
const GRANTED_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'
const ACCOUNT_EMAIL = 'agent-bot@example.com'

let ownerApp: FastifyInstance      // owner-authed agent-connectors routes
let memberApp: FastifyInstance     // member-authed
let publicApp: FastifyInstance     // the unauthenticated callback plugin
let realFetch: typeof fetch

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentConnectorRoutes)
  return a
}

// ── Stub Google's network. Routes by URL; never touches the real internet. ──
function installFetchStub() {
  realFetch = globalThis.fetch
  ;(globalThis as any).fetch = async (url: any, init?: any) => {
    const u = String(url)
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const body = String(init?.body ?? '')
      // The refresh grant returns only a new access token; the auth-code grant returns both.
      if (body.includes('grant_type=refresh_token')) {
        return jsonRes({ access_token: ACCESS_SENTINEL + '-refreshed', expires_in: 3600 })
      }
      return jsonRes({ access_token: ACCESS_SENTINEL, refresh_token: REFRESH_SENTINEL, expires_in: 3600, scope: GRANTED_SCOPES })
    }
    if (u.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
      return jsonRes({ email: ACCOUNT_EMAIL, email_verified: true })
    }
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) {
      return jsonRes({})
    }
    throw new Error(`unexpected fetch in test: ${u}`)
  }
}
function jsonRes(obj: any) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) } as any
}

before(async () => {
  await setupDatabase()
  installFetchStub()
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
  ownerApp = appAs(OWNER); memberApp = appAs(MEMBER)
  publicApp = Fastify({ logger: false }); publicApp.register(agentAuthGoogleRoutes)
  await Promise.all([ownerApp.ready(), memberApp.ready(), publicApp.ready()])
})

after(async () => {
  ;(globalThis as any).fetch = realFetch
  await Promise.all([ownerApp?.close(), memberApp?.close(), publicApp?.close()])
  rmSync(tmp, { recursive: true, force: true })
})

const startUrl = (orgId: string, agentId: string) => `/api/orgs/${orgId}/agents/${agentId}/connectors/google/oauth/start`
const delUrl = (orgId: string, agentId: string) => `/api/orgs/${orgId}/agents/${agentId}/connectors/google`
const tokenRow = (orgId: string, agentId: string) =>
  db.query.agentOauthTokens.findFirst({ where: and(eq(schema.agentOauthTokens.orgId, orgId), eq(schema.agentOauthTokens.agentId, agentId), eq(schema.agentOauthTokens.provider, 'google')) })
const connRow = (orgId: string, agentId: string) =>
  db.query.agentConnectors.findFirst({ where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, 'google')) })

// ─── Pure scope + PKCE helpers ────────────────────────────────────────────────

test('[CONN5-SCOPE] scopesForServices includes identity + only the enabled services', () => {
  const s = gauth.scopesForServices({ calendar: true, gmail: false, drive: true })
  assert.ok(s.includes('openid') && s.includes('userinfo.email'))
  assert.ok(s.includes('calendar.events'))
  assert.ok(s.includes('drive.readonly') && s.includes('drive.file'))
  assert.ok(!s.includes('gmail'), 'gmail not enabled → no gmail scope')
})

test('[CONN5-SCOPE] normalizeServices + hasAnyService reject an identity-only grant', () => {
  assert.deepEqual(gauth.normalizeServices({ calendar: true, junk: 1 }), { calendar: true, gmail: false, drive: false })
  assert.equal(gauth.hasAnyService({ calendar: false, gmail: false, drive: false }), false)
  assert.equal(gauth.hasAnyService(gauth.normalizeServices({ gmail: true })), true)
})

test('[CONN5-SCOPE] servicesFromScopes reflects what Google actually granted', () => {
  assert.deepEqual(gauth.servicesFromScopes(GRANTED_SCOPES), { calendar: true, gmail: false, drive: true })
  assert.deepEqual(gauth.servicesFromScopes(''), { calendar: false, gmail: false, drive: false })
})

test('[CONN5-PKCE] generatePkce yields a verifier and a distinct S256 challenge', () => {
  const { verifier, challenge } = gauth.generatePkce()
  assert.ok(verifier.length >= 43 && challenge.length >= 43)
  assert.notEqual(verifier, challenge)
  assert.equal(/[^A-Za-z0-9\-_]/.test(verifier + challenge), false, 'base64url only (no +/= padding)')
})

test('[CONN5-PKCE] the auth URL carries state + an S256 challenge, our redirect_uri, and no secret', () => {
  const url = gauth.buildAgentAuthUrl({ state: 'STATE123', scopes: 'openid', challenge: 'CHAL' })
  assert.ok(url.includes('state=STATE123'))
  assert.ok(url.includes('code_challenge=CHAL'))
  assert.ok(url.includes('code_challenge_method=S256'))
  assert.ok(url.includes(encodeURIComponent('https://api.example.com/api/agent-connectors/google/callback')))
  assert.ok(url.includes('access_type=offline'))
  assert.ok(!url.includes('test-client-secret'), 'the client secret must never be in the auth URL')
})

// ─── State store: single-use, expiring, unforgeable ──────────────────────────

test('[CONN5-STATE] a fresh state is consumed exactly once; a replay is rejected', async () => {
  const { id } = await gauth.createOauthState({ orgId: ORG, agentId: AGENT, connectorId: 'google', provider: 'google', scopes: 'openid', redirectOrigin: null })
  const first = await gauth.consumeOauthState(id)
  assert.equal(first.ok, true)
  assert.equal(first.state?.agentId, AGENT)
  const replay = await gauth.consumeOauthState(id)
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'used')
})

test('[CONN5-STATE] an unknown/forged state id is rejected (not_found)', async () => {
  const r = await gauth.consumeOauthState('deadbeef'.repeat(8))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not_found')
})

test('[CONN5-STATE] an expired state is rejected (expired), not consumed', async () => {
  const { id } = await gauth.createOauthState({ orgId: ORG, agentId: AGENT, connectorId: 'google', provider: 'google', scopes: 'openid', redirectOrigin: null })
  // Force expiry in the past.
  await db.update(schema.agentOauthStates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.agentOauthStates.id, id))
  const r = await gauth.consumeOauthState(id)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'expired')
})

// ─── Start route: owner-gated, tenant-scoped, no token, creates state ─────────

test('[CONN5-START] a member cannot start the Google flow (403)', async () => {
  const res = await memberApp.inject({ method: 'POST', url: startUrl(ORG, AGENT), payload: { services: { drive: true } } })
  assert.equal(res.statusCode, 403)
})

test('[CONN5-START] an owner starts the flow → a Google consent url + a state row', async () => {
  const res = await ownerApp.inject({ method: 'POST', url: startUrl(ORG, AGENT), payload: { services: { calendar: true, drive: true } } })
  assert.equal(res.statusCode, 200)
  const body = res.json() as any
  assert.ok(String(body.url).startsWith('https://accounts.google.com/o/oauth2/v2/auth?'))
  // The state param resolves to a real, unused row bound to this org+agent.
  const state = new URL(body.url).searchParams.get('state')!
  const row = await db.query.agentOauthStates.findFirst({ where: eq(schema.agentOauthStates.id, state) })
  assert.equal(row?.orgId, ORG); assert.equal(row?.agentId, AGENT); assert.equal(row?.usedAt, null)
  // No token material anywhere in the start response.
  assert.equal(res.payload.includes('test-client-secret'), false)
})

test('[CONN5-START] tenant scoping — owner of org A cannot start for an agent in org B (404)', async () => {
  const res = await ownerApp.inject({ method: 'POST', url: startUrl(ORG, OTHER_AGENT), payload: {} })
  assert.equal(res.statusCode, 404)
})

// ─── Callback: the happy path stores encrypted tokens + connects, leaks nothing ─

async function mintState(orgId = ORG, agentId = AGENT) {
  const { id } = await gauth.createOauthState({
    orgId, agentId, connectorId: 'google', provider: 'google',
    scopes: gauth.scopesForServices({ calendar: true, drive: true }),
    redirectOrigin: 'https://app.example.com',
  })
  return id
}

test('[CONN5-CB] a valid callback stores ENCRYPTED tokens, connects the row, and bounces back with no token', async () => {
  const state = await mintState()
  const res = await publicApp.inject({ method: 'GET', url: `/api/agent-connectors/google/callback?code=AUTH_CODE&state=${state}` })
  assert.equal(res.statusCode, 302)
  const loc = res.headers.location as string
  assert.ok(loc.startsWith('https://app.example.com/dashboard?'))
  assert.ok(loc.includes('google=connected'))
  assert.ok(loc.includes(`agent=${AGENT}`))
  // No token/refresh/code in the redirect.
  for (const secret of [ACCESS_SENTINEL, REFRESH_SENTINEL, 'AUTH_CODE']) {
    assert.equal(loc.includes(secret), false, `redirect must not carry ${secret}`)
    assert.equal(res.payload.includes(secret), false)
  }
  // Tokens are stored ENCRYPTED (the raw column is not the plaintext) yet decrypt back.
  const tok = await tokenRow(ORG, AGENT)
  assert.ok(tok, 'a token row exists')
  assert.notEqual(tok!.accessTokenEnc, ACCESS_SENTINEL, 'access token must be encrypted at rest')
  assert.notEqual(tok!.refreshTokenEnc, REFRESH_SENTINEL, 'refresh token must be encrypted at rest')
  assert.equal(decrypt(tok!.accessTokenEnc), ACCESS_SENTINEL)
  assert.equal(decrypt(tok!.refreshTokenEnc!), REFRESH_SENTINEL)
  assert.equal(tok!.accountEmail, ACCOUNT_EMAIL)
  // The connector row is connected, labelled with the email, and records granted scopes.
  const row = await connRow(ORG, AGENT)
  assert.equal(row?.status, 'connected')
  assert.equal(row?.accountLabel, ACCOUNT_EMAIL)
  const cfg = row?.config as any
  assert.deepEqual(cfg.services, { calendar: true, gmail: false, drive: true })
  assert.ok(Array.isArray(cfg.scopes) && cfg.scopes.includes('https://www.googleapis.com/auth/calendar.events'))
})

test('[CONN5-CB] the masked connector READ never carries a token (toPublicConnector)', async () => {
  const res = await ownerApp.inject({ method: 'GET', url: `/api/orgs/${ORG}/agents/${AGENT}/connectors/google` })
  assert.equal(res.statusCode, 200)
  const payload = res.payload
  for (const secret of [ACCESS_SENTINEL, REFRESH_SENTINEL]) assert.equal(payload.includes(secret), false)
  const conn = (res.json() as any).connector
  assert.equal(conn.status, 'connected')
  assert.equal(conn.accountLabel, ACCOUNT_EMAIL)
  assert.ok(!('secretRef' in conn) && !('accessToken' in conn) && !('refreshToken' in conn))
})

test('[CONN5-CB] a REUSED state (replay) is rejected and mints no second token', async () => {
  const state = await mintState()
  const first = await publicApp.inject({ method: 'GET', url: `/api/agent-connectors/google/callback?code=C1&state=${state}` })
  assert.ok((first.headers.location as string).includes('google=connected'))  // spent once, valid
  const replay = await publicApp.inject({ method: 'GET', url: `/api/agent-connectors/google/callback?code=C2&state=${state}` })
  assert.equal(replay.statusCode, 302)
  assert.ok((replay.headers.location as string).includes('google=error'))  // second use → rejected
})

test('[CONN5-CB] a FORGED/unknown state issues no token and error-bounces', async () => {
  const before = await tokenRow(ORG, AGENT)
  const res = await publicApp.inject({ method: 'GET', url: `/api/agent-connectors/google/callback?code=X&state=${'ab'.repeat(32)}` })
  assert.equal(res.statusCode, 302)
  assert.ok((res.headers.location as string).includes('google=error'))
  // The existing token (from the happy-path test) is untouched; no NEW row for a forged state.
  const after = await tokenRow(ORG, AGENT)
  assert.equal(after?.id, before?.id)
})

test('[CONN5-CB] denied consent (?error=access_denied) bounces error, spends nothing usable', async () => {
  const state = await mintState()
  const res = await publicApp.inject({ method: 'GET', url: `/api/agent-connectors/google/callback?error=access_denied&state=${state}` })
  assert.equal(res.statusCode, 302)
  assert.ok((res.headers.location as string).includes('google=error'))
  // State is now spent (single-use) so it cannot be completed later.
  const replay = await gauth.consumeOauthState(state)
  assert.equal(replay.ok, false)
})

// ─── Runtime reach + refresh (the Drive-RAG execution path) ──────────────────

test('[CONN5-RUNTIME] ensureFreshAgentGoogleToken resolves the stored token (what the executor uses)', async () => {
  const fresh = await gauth.ensureFreshAgentGoogleToken(ORG, AGENT)
  assert.ok(fresh, 'the agent has a resolvable Google token')
  assert.equal(fresh!.accountEmail, ACCOUNT_EMAIL)
  assert.equal(fresh!.accessToken, ACCESS_SENTINEL)  // not yet near expiry → no refresh
})

test('[CONN5-RUNTIME] a near-expired token refreshes + RE-ENCRYPTS in place', async () => {
  await db.update(schema.agentOauthTokens).set({ expiresAt: new Date(Date.now() + 1000) })
    .where(and(eq(schema.agentOauthTokens.orgId, ORG), eq(schema.agentOauthTokens.agentId, AGENT)))
  const fresh = await gauth.ensureFreshAgentGoogleToken(ORG, AGENT)
  assert.equal(fresh!.accessToken, ACCESS_SENTINEL + '-refreshed')
  const tok = await tokenRow(ORG, AGENT)
  assert.notEqual(tok!.accessTokenEnc, ACCESS_SENTINEL + '-refreshed', 'refreshed token re-encrypted at rest')
  assert.equal(decrypt(tok!.accessTokenEnc), ACCESS_SENTINEL + '-refreshed')
})

// ─── Disconnect: owner-gated, purges tokens ──────────────────────────────────

test('[CONN5-DEL] a member cannot disconnect (403); the token survives', async () => {
  const res = await memberApp.inject({ method: 'DELETE', url: delUrl(ORG, AGENT) })
  assert.equal(res.statusCode, 403)
  assert.ok(await tokenRow(ORG, AGENT), 'token still present after a denied disconnect')
})

test('[CONN5-DEL] an owner disconnect revokes + PURGES the agent token and the connector row', async () => {
  const res = await ownerApp.inject({ method: 'DELETE', url: delUrl(ORG, AGENT) })
  assert.equal(res.statusCode, 204)
  assert.equal(await tokenRow(ORG, AGENT), undefined)
  assert.equal(await connRow(ORG, AGENT), undefined)
})

// ─── Generic write path refuses Google (must use the OAuth flow) ─────────────

test('[CONN5-GUARD] the generic configure POST rejects the oauth connector', async () => {
  const res = await ownerApp.inject({ method: 'POST', url: `/api/orgs/${ORG}/agents/${AGENT}/connectors/google`, payload: { config: {} } })
  assert.equal(res.statusCode, 400)
  assert.ok(String((res.json() as any).error).toLowerCase().includes('oauth'))
})
