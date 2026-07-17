// Epic CONN / CONN-8b-1 — the WHATSAPP connector EXECUTOR (Meta Cloud API).
//
// A fixed-surface executor consumed by the CONN-8a execution framework, following the
// GitHub executor pattern. It maps the single `message.send` action to a real
// graph.facebook.com messages call, using the agent-scoped `WHATSAPP_ACCESS_TOKEN` the
// framework hands it at execution time (CONN-6). Its declared class MUST equal
// `classifyConnectorAction('whatsapp', 'message.send')` — asserted in the test.
//
// SSRF is closed by construction: the host is HARDCODED to graph.facebook.com and the
// API version is a fixed constant. The only URL variable is the phone-number id, which
// is validated to digits-only and encoded, so it can never escape the path or change the
// host. The recipient + text go in the JSON body. The access token is a Bearer header
// only — never returned or logged (the framework's redactSecrets strips it as backstop).

import { ConnectorProviderError, type ConnectorExecutor, type ExecutorContext, type HttpClient } from './connector-execution'

const GRAPH_API = 'https://graph.facebook.com' // HARDCODED — the ONLY host this executor dials
const GRAPH_VERSION = 'v21.0'                    // fixed — never param-supplied
const PHONE_NUMBER_ID_RE = /^[0-9]{1,32}$/       // Meta phone-number ids are numeric
const RECIPIENT_RE = /^\+?[0-9]{6,20}$/          // E.164-ish msisdn (digits, optional leading +)
const MAX_TEXT = 4_096

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

function requireToken(secrets: Record<string, string>): string {
  const t = str(secrets.WHATSAPP_ACCESS_TOKEN)
  if (!t) throw new ConnectorProviderError('WhatsApp credential is not available')
  return t
}

function requirePhoneNumberId(params: Record<string, unknown>, secrets: Record<string, string>): string {
  const id = str(params.phoneNumberId) || str(secrets.WHATSAPP_PHONE_NUMBER_ID)
  if (!PHONE_NUMBER_ID_RE.test(id)) throw new ConnectorProviderError('invalid or missing `phoneNumberId` (and no stored WHATSAPP_PHONE_NUMBER_ID)')
  return id
}

async function messageSend(ctx: ExecutorContext): Promise<unknown> {
  const token = requireToken(ctx.secrets)
  const phoneNumberId = requirePhoneNumberId(ctx.params, ctx.secrets)
  const to = str(ctx.params.to)
  if (!RECIPIENT_RE.test(to)) throw new ConnectorProviderError('invalid or missing `to` recipient')
  const text = (str(ctx.params.text) || str(ctx.params.message)).slice(0, MAX_TEXT)
  if (!text) throw new ConnectorProviderError('`text` is required to send a message')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': '7ei-mission-control',
  }
  // Host + version fixed; phoneNumberId validated (digits) and encoded → path-safe.
  const url = `${GRAPH_API}/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`
  const body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
  const http: HttpClient = ctx.http
  const res = await http(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    // Surface ONLY Meta's short `error.message` + status — never the raw body, never the token.
    let message = ''
    try { message = String((await res.json())?.error?.message ?? '') } catch { /* non-JSON */ }
    message = message.slice(0, 200)
    throw new ConnectorProviderError(`WhatsApp request failed (${res.status})${message ? `: ${message}` : ''}`, res.status)
  }
  try { return await res.json() } catch { return null }
}

export const whatsappExecutor: ConnectorExecutor = {
  connectorId: 'whatsapp',
  actions: {
    // WRITE — needs approval unless the (agent,whatsapp) pair is trusted (auto_write).
    'message.send': { class: 'write', handler: messageSend },
  },
}
