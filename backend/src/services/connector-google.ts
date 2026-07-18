// Epic CONN / CONN-8b-2 — the GOOGLE WORKSPACE connector EXECUTOR (Gmail / Calendar /
// Drive) — the first OAUTH-credentialed provider adapter in the CONN-8a execution
// framework (services/connector-execution.ts).
//
// It differs from the env-secret executors (github/jira/comms) in ONE crucial way: the
// credential is NOT a value from the encrypted env secret bag. It is the agent's
// per-agent Google OAuth ACCESS TOKEN, which the framework resolves at execution time
// via CONN-5's `ensureFreshAgentGoogleToken` (decrypt from `agent_oauth_tokens` →
// refresh if within 60s of expiry → re-encrypt in place) and hands to the handler as
// `ctx.oauthAccessToken`. This executor NEVER reads a refresh token (it never reaches an
// executor), NEVER touches `resolveSecretsForAgent`, and NEVER returns/logs the token —
// the framework's `redactSecrets` backstop scrubs the access token from any result/error
// as belt-and-suspenders. A missing/revoked connection fails CLOSED in the framework
// (the handler is never called).
//
// SSRF is closed BY CONSTRUCTION:
//   • Hosts are HARDCODED (gmail.googleapis.com, www.googleapis.com). No param ever
//     supplies a host, an origin, or a path base.
//   • Every id (message / event / file) and calendarId is validated against a strict
//     charset THEN encodeURIComponent-encoded, so a segment can't escape the path.
//   • Query params travel through URLSearchParams (encoded), never string-concatenated.
//   • The framework transport enforces redirect:'error' + a timeout + a 1 MB size cap,
//     so a provider 3xx can't bounce the fixed host and a huge body can't flood us.
//
// SCOPES: Google's single connection covers Gmail/Calendar/Drive, but each action needs
// a SPECIFIC granted scope (CONN-5 `SERVICE_SCOPES`). Before dialing, an action pre-checks
// the granted scope string (`ctx.oauthScopes`) and fails closed with a clean "reconnect
// with X" — rather than leaking a raw Google 403. If the granted scopes are unknown
// (null), it proceeds best-effort and the 403 handler still returns a clean, tokenless
// error. `gmail.delete` requires a scope the connector never requests (gmail.modify /
// full mail access), so it deliberately fails closed until the grant is widened.
//
// Every action's declared `class` MUST equal `classifyConnectorAction('google', <key>)`
// (the CONN-7 taxonomy) — asserted in connector-google.test.ts, so the executor can
// never drift from the authorization policy: READ runs freely, WRITE needs approval
// unless the (agent,google) pair is trusted (auto_write), DESTRUCTIVE always needs
// approval even when trusted.

import { ConnectorProviderError, type ConnectorExecutor, type ExecutorContext, type HttpClient } from './connector-execution'

// ─── HARDCODED hosts — the ONLY origins this executor ever dials ────────────────
const GMAIL_API = 'https://gmail.googleapis.com'    // Gmail REST v1
const GAPIS = 'https://www.googleapis.com'          // Calendar v3 + Drive v3 share this host

// ─── Granted-scope constants (kept in lock-step with CONN-5 SERVICE_SCOPES) ─────
const SCOPE_GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'
const SCOPE_GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send'
const SCOPE_GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify' // NOT requested by CONN-5 → gmail.delete fails closed
const SCOPE_CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events'
const SCOPE_DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly'
const SCOPE_DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'

// ─── Validation limits + charsets ───────────────────────────────────────────────
const GMAIL_MSG_ID_RE = /^[A-Za-z0-9_-]{1,256}$/       // Gmail message/thread ids (url-safe)
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,1024}$/          // Calendar event ids (base32hex + url-safe)
const CALENDAR_ID_RE = /^[A-Za-z0-9@._+-]{1,256}$/     // 'primary' or an email-form calendar id
const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/      // Drive file ids (url-safe)
const EMAIL_RE = /^[^\s@]{1,320}@[^\s@]{1,255}\.[^\s@]{1,255}$/
const MAX_SUBJECT = 998                                // RFC 5322 line length ceiling
const MAX_BODY = 100_000
const MAX_NAME = 400
const MAX_QUERY = 1024
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

/** Reject any CR/LF (or other control) chars — the header-injection guard for the fields
 *  that land in a MIME header (To / Cc / Subject). */
function noControlChars(v: string): boolean { return !/[\x00-\x1f\x7f]/.test(v) }

/** The agent's fresh Google access token. Belt-and-suspenders: the framework already
 *  fails closed (never calling the handler) when there is no usable connection. */
function requireAccessToken(ctx: ExecutorContext): string {
  const t = ctx.oauthAccessToken
  if (!t || !t.trim()) throw new ConnectorProviderError("Google credential is not available — connect the agent's Google account")
  return t
}

/** Fail closed with a clean "reconnect with X" when the granted scope set is KNOWN and
 *  does NOT cover this action. When scopes are unknown (null), proceed best-effort — the
 *  provider 403 handler still returns a clean, tokenless error. Never leaks the token. */
function requireScope(ctx: ExecutorContext, scope: string, hint: string): void {
  const granted = ctx.oauthScopes
  if (granted == null) return // unknown grant → best-effort; the 403 path stays clean
  const set = new Set(granted.split(/\s+/).filter(Boolean))
  if (!set.has(scope)) {
    throw new ConnectorProviderError(`the agent's Google grant is missing the '${scope}' scope — reconnect Google to ${hint}`)
  }
}

function requireGmailMessageId(params: Record<string, unknown>): string {
  const id = str(params.id) || str(params.messageId)
  if (!GMAIL_MSG_ID_RE.test(id)) throw new ConnectorProviderError('invalid or missing message `id`')
  return id
}
function requireCalendarId(params: Record<string, unknown>): string {
  const id = str(params.calendarId) || 'primary'
  // NIT-2: CALENDAR_ID_RE allows '.' (email-form ids); reject a pure '.'/'..' segment so a
  // param can never become a path-traversal segment even within the fixed host.
  if (!CALENDAR_ID_RE.test(id) || id === '.' || id === '..') throw new ConnectorProviderError('invalid `calendarId`')
  return id
}
function requireEventId(params: Record<string, unknown>): string {
  const id = str(params.eventId) || str(params.id)
  if (!EVENT_ID_RE.test(id)) throw new ConnectorProviderError('invalid or missing `eventId`')
  return id
}
function requireDriveFileId(params: Record<string, unknown>): string {
  const id = str(params.fileId) || str(params.id)
  if (!DRIVE_FILE_ID_RE.test(id)) throw new ConnectorProviderError('invalid or missing `fileId`')
  return id
}
/** A bounded positive integer for a page-size param. */
function boundedCount(v: unknown, def: number, max: number): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) return def
  return Math.min(n, max)
}

// ─── base64url (for the RFC 5322 raw Gmail message) ─────────────────────────────
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ─── The request core — hardcoded base + validated/encoded path, never a raw URL ─
async function googleRequest(
  http: HttpClient,
  base: string,       // one of GMAIL_API / GAPIS — a CONSTANT, never param-derived
  token: string,
  method: string,
  path: string,       // MUST start with '/', built from encoded segments + URLSearchParams
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': '7ei-mission-control',
  }
  let payload: string | undefined
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }

  const res = await http(`${base}${path}`, { method, headers, body: payload })
  if (!res.ok) {
    // Surface ONLY Google's short `error.message`, truncated — never the raw body, never
    // the token. 401/403 map to clean, actionable reconnect guidance.
    let message = ''
    try { message = String((await res.json())?.error?.message ?? '') } catch { /* non-JSON error body */ }
    message = message.slice(0, 200)
    if (res.status === 401) {
      throw new ConnectorProviderError("Google rejected the credential (401) — reconnect the agent's Google account", 401)
    }
    if (res.status === 403) {
      throw new ConnectorProviderError(`Google denied the request (403) — the agent's grant may be missing a required scope; reconnect Google${message ? `: ${message}` : ''}`, 403)
    }
    throw new ConnectorProviderError(`Google request failed (${res.status})${message ? `: ${message}` : ''}`, res.status)
  }
  if (res.status === 204) return { ok: true } // e.g. DELETE returns no content
  try { return await res.json() } catch { return null }
}

// ─── GMAIL ──────────────────────────────────────────────────────────────────────

async function gmailList(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_GMAIL_READONLY, 'read Gmail')
  const token = requireAccessToken(ctx)
  const qs = new URLSearchParams({ maxResults: String(boundedCount(ctx.params.maxResults, 25, 100)) })
  const q = str(ctx.params.q).slice(0, MAX_QUERY)
  if (q) qs.set('q', q)
  return googleRequest(ctx.http, GMAIL_API, token, 'GET', `/gmail/v1/users/me/messages?${qs}`)
}

async function gmailGet(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_GMAIL_READONLY, 'read Gmail')
  const token = requireAccessToken(ctx)
  const id = requireGmailMessageId(ctx.params)
  const fmt = ['minimal', 'metadata', 'full'].includes(str(ctx.params.format)) ? str(ctx.params.format) : 'metadata'
  return googleRequest(ctx.http, GMAIL_API, token, 'GET', `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=${fmt}`)
}

async function gmailSend(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_GMAIL_SEND, 'send email as the agent')
  const token = requireAccessToken(ctx)
  const to = str(ctx.params.to)
  if (!EMAIL_RE.test(to) || !noControlChars(to)) throw new ConnectorProviderError('a valid single `to` email address is required')
  const cc = str(ctx.params.cc)
  if (cc && (!EMAIL_RE.test(cc) || !noControlChars(cc))) throw new ConnectorProviderError('`cc` must be a valid email address')
  const subject = str(ctx.params.subject).slice(0, MAX_SUBJECT)
  if (!noControlChars(subject)) throw new ConnectorProviderError('`subject` must not contain control characters')
  const bodyText = str(ctx.params.body).slice(0, MAX_BODY)
  if (!bodyText) throw new ConnectorProviderError('`body` is required to send an email')

  // RFC 5322 message → base64url. To/Cc/Subject are control-char-free (header-injection
  // guard above), so no attacker-supplied newline can inject an extra header.
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
  ]
  const raw = b64url(lines.join('\r\n'))
  return googleRequest(ctx.http, GMAIL_API, token, 'POST', '/gmail/v1/users/me/messages/send', { raw })
}

async function gmailDelete(ctx: ExecutorContext): Promise<unknown> {
  // DESTRUCTIVE. CONN-5 requests only gmail.readonly + gmail.send — NEITHER can trash or
  // delete a message. So this pre-check fails CLOSED with a clean reconnect message until
  // an operator widens the grant (gmail.modify / full mail access). Registered with the
  // correct class so the framework still gates it (approval always, even when trusted).
  requireScope(ctx, SCOPE_GMAIL_MODIFY, 'trash/delete Gmail messages (not granted by default)')
  const token = requireAccessToken(ctx)
  const id = requireGmailMessageId(ctx.params)
  // Prefer TRASH (recoverable) over permanent delete.
  return googleRequest(ctx.http, GMAIL_API, token, 'POST', `/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`)
}

// ─── CALENDAR (v3, under www.googleapis.com/calendar/v3) ────────────────────────

async function calendarList(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_CALENDAR_EVENTS, 'read Calendar events')
  const token = requireAccessToken(ctx)
  const calendarId = requireCalendarId(ctx.params)
  const qs = new URLSearchParams({ maxResults: String(boundedCount(ctx.params.maxResults, 25, 250)), singleEvents: 'true', orderBy: 'startTime' })
  const q = str(ctx.params.q).slice(0, MAX_QUERY)
  if (q) qs.set('q', q)
  const timeMin = str(ctx.params.timeMin)
  if (timeMin && ISO_DATETIME_RE.test(timeMin)) qs.set('timeMin', timeMin)
  return googleRequest(ctx.http, GAPIS, token, 'GET', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${qs}`)
}

async function calendarEventGet(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_CALENDAR_EVENTS, 'read Calendar events')
  const token = requireAccessToken(ctx)
  const calendarId = requireCalendarId(ctx.params)
  const eventId = requireEventId(ctx.params)
  return googleRequest(ctx.http, GAPIS, token, 'GET', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
}

async function calendarEventCreate(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_CALENDAR_EVENTS, 'create Calendar events')
  const token = requireAccessToken(ctx)
  const calendarId = requireCalendarId(ctx.params)
  const summary = str(ctx.params.summary).slice(0, MAX_NAME)
  if (!summary) throw new ConnectorProviderError('`summary` is required to create an event')
  const start = str(ctx.params.start)
  const end = str(ctx.params.end)
  if (!ISO_DATETIME_RE.test(start)) throw new ConnectorProviderError('`start` must be an RFC 3339 date-time (e.g. 2026-07-20T09:00:00Z)')
  if (!ISO_DATETIME_RE.test(end)) throw new ConnectorProviderError('`end` must be an RFC 3339 date-time (e.g. 2026-07-20T10:00:00Z)')
  const description = str(ctx.params.description).slice(0, MAX_BODY)
  const body: Record<string, unknown> = { summary, start: { dateTime: start }, end: { dateTime: end } }
  if (description) body.description = description
  return googleRequest(ctx.http, GAPIS, token, 'POST', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, body)
}

async function calendarEventDelete(ctx: ExecutorContext): Promise<unknown> {
  // DESTRUCTIVE — always needs approval, even when trusted (framework-gated).
  requireScope(ctx, SCOPE_CALENDAR_EVENTS, 'delete Calendar events')
  const token = requireAccessToken(ctx)
  const calendarId = requireCalendarId(ctx.params)
  const eventId = requireEventId(ctx.params)
  return googleRequest(ctx.http, GAPIS, token, 'DELETE', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
}

// ─── DRIVE (v3, under www.googleapis.com/drive/v3) ──────────────────────────────

async function driveList(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_DRIVE_READONLY, 'read Drive files')
  const token = requireAccessToken(ctx)
  const qs = new URLSearchParams({ pageSize: String(boundedCount(ctx.params.pageSize, 25, 100)) })
  const q = str(ctx.params.q).slice(0, MAX_QUERY)
  if (q) qs.set('q', q)
  return googleRequest(ctx.http, GAPIS, token, 'GET', `/drive/v3/files?${qs}`)
}

async function driveFileGet(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_DRIVE_READONLY, 'read Drive files')
  const token = requireAccessToken(ctx)
  const fileId = requireDriveFileId(ctx.params)
  return googleRequest(ctx.http, GAPIS, token, 'GET', `/drive/v3/files/${encodeURIComponent(fileId)}`)
}

async function driveFileCreate(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_DRIVE_FILE, 'create Drive files')
  const token = requireAccessToken(ctx)
  const name = str(ctx.params.name).slice(0, MAX_NAME)
  if (!name) throw new ConnectorProviderError('`name` is required to create a file')
  // Metadata-only create (no content upload in v1 — that needs the multipart/upload host,
  // out of scope here). Creates an empty file / folder record.
  const body: Record<string, unknown> = { name }
  const mimeType = str(ctx.params.mimeType).slice(0, 255)
  if (mimeType) body.mimeType = mimeType
  return googleRequest(ctx.http, GAPIS, token, 'POST', '/drive/v3/files', body)
}

async function driveFileUpdate(ctx: ExecutorContext): Promise<unknown> {
  requireScope(ctx, SCOPE_DRIVE_FILE, 'update Drive files')
  const token = requireAccessToken(ctx)
  const fileId = requireDriveFileId(ctx.params)
  const body: Record<string, unknown> = {}
  const name = str(ctx.params.name).slice(0, MAX_NAME)
  if (name) body.name = name
  const mimeType = str(ctx.params.mimeType).slice(0, 255)
  if (mimeType) body.mimeType = mimeType
  if (Object.keys(body).length === 0) throw new ConnectorProviderError('nothing to update (provide `name` and/or `mimeType`)')
  return googleRequest(ctx.http, GAPIS, token, 'PATCH', `/drive/v3/files/${encodeURIComponent(fileId)}`, body)
}

async function driveFileDelete(ctx: ExecutorContext): Promise<unknown> {
  // DESTRUCTIVE — always needs approval, even when trusted (framework-gated).
  requireScope(ctx, SCOPE_DRIVE_FILE, 'delete Drive files')
  const token = requireAccessToken(ctx)
  const fileId = requireDriveFileId(ctx.params)
  return googleRequest(ctx.http, GAPIS, token, 'DELETE', `/drive/v3/files/${encodeURIComponent(fileId)}`)
}

// ─── The executor ────────────────────────────────────────────────────────────────
// `credentialKind: 'google_oauth'` tells the framework to resolve the credential from
// CONN-5's encrypted agent OAuth store (NOT the env secret bag). Each `class` MUST equal
// classifyConnectorAction('google', <key>) — asserted in connector-google.test.ts.

export const googleExecutor: ConnectorExecutor = {
  connectorId: 'google',
  credentialKind: 'google_oauth',
  actions: {
    // READ — allowed freely by CONN-7.
    'gmail.list': { class: 'read', handler: gmailList },
    'gmail.get': { class: 'read', handler: gmailGet },
    'calendar.list': { class: 'read', handler: calendarList },
    'calendar.event.get': { class: 'read', handler: calendarEventGet },
    'drive.list': { class: 'read', handler: driveList },
    'drive.file.get': { class: 'read', handler: driveFileGet },
    // WRITE — needs approval unless the (agent,google) pair is trusted (auto_write).
    'gmail.send': { class: 'write', handler: gmailSend },
    'calendar.event.create': { class: 'write', handler: calendarEventCreate },
    'drive.file.create': { class: 'write', handler: driveFileCreate },
    'drive.file.update': { class: 'write', handler: driveFileUpdate },
    // DESTRUCTIVE — ALWAYS needs approval, even when trusted. `gmail.delete` additionally
    // fails closed on a missing scope (CONN-5 never requests gmail.modify).
    'gmail.delete': { class: 'destructive', handler: gmailDelete },
    'calendar.event.delete': { class: 'destructive', handler: calendarEventDelete },
    'drive.file.delete': { class: 'destructive', handler: driveFileDelete },
  },
}
