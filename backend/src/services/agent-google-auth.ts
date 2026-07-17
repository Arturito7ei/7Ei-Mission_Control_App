// Epic CONN / CONN-5 — per-AGENT Google OAuth (Calendar / Gmail / Drive).
//
// A sibling of services/google-auth.ts (the ORG-level Google connection), but scoped
// to a single AGENT and hardened for a user-initiated, per-agent flow:
//
//   • STATE is unforgeable + single-use + expiring. The org flow used `state=orgId`
//     — a value an attacker can forge to attach THEIR Google account to ANY org's
//     connector, or to CSRF the callback. Here `state` is the id of a short-lived,
//     server-side, single-use row (createOauthState / consumeOauthState): 256 bits of
//     randomness (unforgeable + unguessable), bound to one (org, agent, connector),
//     spent exactly once, and expired after 10 minutes.
//   • PKCE (S256) binds the authorization code to THIS flow's code_verifier, so a
//     stolen code can't be exchanged elsewhere.
//   • TOKENS are stored ENCRYPTED at agent scope (agent_oauth_tokens, AES-256-GCM) —
//     the org table stores them in plaintext; this is an improvement — and are NEVER
//     returned to a client, never logged, and never projected by toPublicConnector.
//
// The client id/secret + PUBLIC_URL come from the SAME env the org flow uses
// (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / PUBLIC_URL) — no new secret to provision.

import { randomBytes, createHash } from 'crypto'
import { db, schema } from '../db/client'
import { and, eq, lt, isNull } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { encrypt, decrypt } from './secrets'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

/** The public callback path (unauthenticated — the state row IS the authorization). */
export const GOOGLE_CALLBACK_PATH = '/api/agent-connectors/google/callback'

/** How long a pending OAuth `state` row is valid before the callback must arrive. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export type GoogleService = 'calendar' | 'gmail' | 'drive'
export const GOOGLE_SERVICES: readonly GoogleService[] = ['calendar', 'gmail', 'drive']

// Scopes ALWAYS requested — openid + email/profile so we can label the connection
// with the Google account address (accountEmail). No user data beyond identity.
const BASE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

// Per-service scopes. Kept in lock-step with the org connector's SCOPES set
// (services/google-auth.ts) so a per-agent grant is a subset of what the OAuth
// consent screen already lists — no new Google verification surface.
const SERVICE_SCOPES: Record<GoogleService, string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
  ],
  drive: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ],
}

/** The default service selection when a Connect request omits `services`: all three. */
export function defaultServices(): Record<GoogleService, boolean> {
  return { calendar: true, gmail: true, drive: true }
}

/**
 * The scope string for a service selection. Always includes the identity scopes;
 * adds each enabled service's scopes. At least one service must be enabled (the
 * caller enforces this) — otherwise the grant would be identity-only and useless.
 * Deterministic + de-duplicated so the requested-scope record is stable. Pure.
 */
export function scopesForServices(services: Partial<Record<GoogleService, boolean>>): string {
  const out = new Set(BASE_SCOPES)
  for (const svc of GOOGLE_SERVICES) {
    if (services[svc]) for (const s of SERVICE_SCOPES[svc]) out.add(s)
  }
  return [...out].join(' ')
}

/** True when at least one Google service is enabled in the selection. Pure. */
export function hasAnyService(services: Partial<Record<GoogleService, boolean>>): boolean {
  return GOOGLE_SERVICES.some(svc => !!services[svc])
}

/** Derive the enabled-service map from a granted scope string (what Google actually
 *  granted, which may differ from what was requested). A service counts as enabled if
 *  ANY of its scopes was granted. Pure — used to record the connector's config. */
export function servicesFromScopes(scopes: string | null | undefined): Record<GoogleService, boolean> {
  const granted = new Set((scopes ?? '').split(/\s+/).filter(Boolean))
  const out = {} as Record<GoogleService, boolean>
  for (const svc of GOOGLE_SERVICES) out[svc] = SERVICE_SCOPES[svc].some(s => granted.has(s))
  return out
}

/** Normalize an untrusted `services` body into a clean boolean map. Pure. */
export function normalizeServices(raw: unknown): Record<GoogleService, boolean> {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    calendar: o.calendar === true,
    gmail: o.gmail === true,
    drive: o.drive === true,
  }
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

/** base64url with no padding — the PKCE + state encoding. Pure. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh PKCE pair. `verifier` is stored in the state row; `challenge` (S256)
 *  goes to Google. 32 random bytes → a 43-char verifier (within RFC 7636's 43..128). */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** A 256-bit opaque, unguessable state id (also the DB row id). */
export function generateStateId(): string {
  return randomBytes(32).toString('hex')
}

// ─── Auth URL ───────────────────────────────────────────────────────────────

/** Build the Google consent URL. `redirect_uri` is ALWAYS our own callback (fixed,
 *  never client-supplied), and `state` is the opaque server-side id. Pure over its
 *  inputs + GOOGLE_CLIENT_ID/PUBLIC_URL env. */
export function buildAgentAuthUrl(args: { state: string; scopes: string; challenge: string }): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: `${process.env.PUBLIC_URL}${GOOGLE_CALLBACK_PATH}`,
    response_type: 'code',
    scope: args.scopes,
    access_type: 'offline',           // ask for a refresh token
    include_granted_scopes: 'true',
    prompt: 'consent',                // force a refresh token even on re-consent
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
  })
  return `${GOOGLE_AUTH_URL}?${params}`
}

// ─── Token exchange / refresh / revoke / userinfo ─────────────────────────────

export interface GoogleTokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  scopes: string | null
}

/** Exchange an authorization code for tokens, presenting the PKCE code_verifier. */
export async function exchangeCodePkce(code: string, codeVerifier: string): Promise<GoogleTokenSet> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: `${process.env.PUBLIC_URL}${GOOGLE_CALLBACK_PATH}`,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`)
  const data = await res.json() as any
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    scopes: typeof data.scope === 'string' ? data.scope : null,
  }
}

/** Refresh an access token from a stored refresh token. */
export async function refreshAgentAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`)
  const data = await res.json() as any
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000) }
}

/** Fetch the Google account email for the connection label. Best-effort — a failure
 *  just leaves the label null; it never blocks the connection. */
export async function fetchGoogleUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
    })
    if (!res.ok) return null
    const data = await res.json() as any
    return typeof data.email === 'string' ? data.email : null
  } catch { return null }
}

/** Best-effort revoke a token at Google (disconnect). Never throws. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      redirect: 'manual',
    })
  } catch { /* revoke is best-effort — local purge still happens */ }
}

// ─── State store (single-use CSRF/PKCE row) ───────────────────────────────────

export interface CreatedState { id: string; challenge: string }

/** Create a pending OAuth state row and return its id (the `state` param) + the PKCE
 *  CHALLENGE (for the auth URL; the verifier stays server-side in the row).
 *  Opportunistically prunes expired rows so the table can't grow. */
export async function createOauthState(args: {
  orgId: string; agentId: string; connectorId: string; provider: string
  scopes: string; redirectOrigin: string | null
}): Promise<CreatedState> {
  const id = generateStateId()
  const { verifier, challenge } = generatePkce()
  const now = new Date()
  // Best-effort prune of stale rows (never blocks the create).
  try { await db.delete(schema.agentOauthStates).where(lt(schema.agentOauthStates.expiresAt, now)) } catch { /* prune is best-effort */ }
  await db.insert(schema.agentOauthStates).values({
    id, orgId: args.orgId, agentId: args.agentId, connectorId: args.connectorId, provider: args.provider,
    codeVerifier: verifier, scopes: args.scopes, redirectOrigin: args.redirectOrigin,
    createdAt: now, expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS), usedAt: null,
  })
  return { id, challenge }
}

export type OauthStateRow = typeof schema.agentOauthStates.$inferSelect
export interface ConsumedState {
  ok: boolean
  /** Present (and the row valid) only when ok. */
  state?: OauthStateRow
  /** Present only when !ok. */
  reason?: 'not_found' | 'expired' | 'used'
}

/**
 * Look up + SPEND a state row exactly once. Rejects an unknown id (forged/guessed),
 * an expired row, or one already used (replay). The spend is atomic: a conditional
 * UPDATE that only sets used_at when it is still NULL, and we require it to have
 * affected exactly one row — so two concurrent callbacks can't both win.
 */
export async function consumeOauthState(id: string): Promise<ConsumedState> {
  if (!id || typeof id !== 'string') return { ok: false, reason: 'not_found' }
  const row = await db.query.agentOauthStates.findFirst({ where: eq(schema.agentOauthStates.id, id) })
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.usedAt) return { ok: false, reason: 'used' }
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' }
  const now = new Date()
  const res: any = await db.update(schema.agentOauthStates)
    .set({ usedAt: now })
    .where(and(eq(schema.agentOauthStates.id, id), /* still unused */ isNull(schema.agentOauthStates.usedAt)))
  // drizzle/libsql returns rowsAffected; if another callback spent it first, bail.
  const affected = res?.rowsAffected ?? res?.changes ?? res?.rows_affected
  if (affected === 0) return { ok: false, reason: 'used' }
  return { ok: true, state: { ...row, usedAt: now } }
}

// ─── Agent-scoped ENCRYPTED token store ───────────────────────────────────────

export interface AgentGoogleToken {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  scopes: string | null
  accountEmail: string | null
}

const agentTokWhere = (orgId: string, agentId: string, provider: string) =>
  and(
    eq(schema.agentOauthTokens.orgId, orgId),
    eq(schema.agentOauthTokens.agentId, agentId),
    eq(schema.agentOauthTokens.provider, provider),
  )

/** Upsert the agent's Google tokens, ENCRYPTED. A refresh token is preserved when a
 *  re-consent omits it (Google only returns it on first consent). */
export async function storeAgentGoogleToken(args: {
  orgId: string; agentId: string; provider: string
  tokens: GoogleTokenSet; accountEmail: string | null
}): Promise<void> {
  const { orgId, agentId, provider, tokens, accountEmail } = args
  const existing = await db.query.agentOauthTokens.findFirst({ where: agentTokWhere(orgId, agentId, provider) })
  const refreshEnc = tokens.refreshToken
    ? encrypt(tokens.refreshToken)
    : (existing?.refreshTokenEnc ?? null)   // keep the prior refresh token if none re-issued
  const now = new Date()
  if (existing) {
    await db.update(schema.agentOauthTokens).set({
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: refreshEnc,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes ?? existing.scopes,
      accountEmail: accountEmail ?? existing.accountEmail,
      updatedAt: now,
    }).where(eq(schema.agentOauthTokens.id, existing.id))
  } else {
    await db.insert(schema.agentOauthTokens).values({
      id: randomUUID(), orgId, agentId, provider,
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: refreshEnc,
      expiresAt: tokens.expiresAt, scopes: tokens.scopes, accountEmail,
      createdAt: now, updatedAt: now,
    })
  }
}

/** Load + DECRYPT the agent's stored Google token, or null if none. */
export async function loadAgentGoogleToken(orgId: string, agentId: string, provider = 'google'): Promise<AgentGoogleToken | null> {
  const row = await db.query.agentOauthTokens.findFirst({ where: agentTokWhere(orgId, agentId, provider) })
  if (!row) return null
  try {
    return {
      accessToken: decrypt(row.accessTokenEnc),
      refreshToken: row.refreshTokenEnc ? decrypt(row.refreshTokenEnc) : null,
      expiresAt: row.expiresAt ?? null,
      scopes: row.scopes ?? null,
      accountEmail: row.accountEmail ?? null,
    }
  } catch { return null }   // undecryptable (key rotation) → treat as not connected
}

/**
 * Return a FRESH access token for the agent, refreshing + re-encrypting in place if
 * the stored one is within 60s of expiry. Mirrors google-auth.ensureFreshToken but
 * for the encrypted agent store. Throws if there is no usable credential.
 */
export async function ensureFreshAgentGoogleToken(orgId: string, agentId: string, provider = 'google'): Promise<{ accessToken: string; accountEmail: string | null } | null> {
  const tok = await loadAgentGoogleToken(orgId, agentId, provider)
  if (!tok) return null
  if (tok.expiresAt && tok.expiresAt.getTime() > Date.now() + 60000) {
    return { accessToken: tok.accessToken, accountEmail: tok.accountEmail }
  }
  if (!tok.refreshToken) {
    // Expired and no refresh token — best we can do is hand back the (stale) access
    // token; the caller's API call will fail cleanly. Prefer returning null.
    return null
  }
  const fresh = await refreshAgentAccessToken(tok.refreshToken)
  await db.update(schema.agentOauthTokens)
    .set({ accessTokenEnc: encrypt(fresh.accessToken), expiresAt: fresh.expiresAt, updatedAt: new Date() })
    .where(agentTokWhere(orgId, agentId, provider))
  return { accessToken: fresh.accessToken, accountEmail: tok.accountEmail }
}

/** Delete the agent's stored Google token, best-effort revoking it at Google first.
 *  Returns the decrypted refresh/access token count purged (for the caller's log). */
export async function deleteAgentGoogleToken(orgId: string, agentId: string, provider = 'google'): Promise<void> {
  const tok = await loadAgentGoogleToken(orgId, agentId, provider)
  if (tok) {
    // Revoke the refresh token (revokes the whole grant) — best effort.
    if (tok.refreshToken) await revokeGoogleToken(tok.refreshToken)
    else if (tok.accessToken) await revokeGoogleToken(tok.accessToken)
  }
  await db.delete(schema.agentOauthTokens).where(agentTokWhere(orgId, agentId, provider))
}
