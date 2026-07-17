// Epic CONN / CONN-8b-1 — the GOOGLE_CHAT connector EXECUTOR (incoming webhook).
//
// A fixed-surface executor consumed by the CONN-8a execution framework, following the
// GitHub executor pattern. It maps the single `message.send` action to a real POST to
// the STORED `GOOGLE_CHAT_WEBHOOK_URL`, the agent-scoped credential the framework hands
// it at execution time (CONN-6). Its declared class MUST equal
// `classifyConnectorAction('google_chat', 'message.send')` — asserted in the test.
//
// ⚠️ THE WEBHOOK-URL-AS-SECRET CONCERN. Google Chat's incoming-webhook URL embeds a key
// + token in its query string, so the WHOLE URL is a secret AND the dial target. SSRF is
// closed by validating that stored URL on EVERY execution before dialing: it must be
// https, carry no userinfo, and its host must be EXACTLY chat.googleapis.com. The URL is
// NEVER param-supplied and NEVER placed into an error or any returned value — provider
// errors surface only a status. The framework's redactSecrets also strips the URL value
// (GOOGLE_CHAT_WEBHOOK_URL is in the executor's secret bag) from any result/error as a
// backstop, but the primary defence is not constructing a leak in the first place.

import { ConnectorProviderError, type ConnectorExecutor, type ExecutorContext, type HttpClient } from './connector-execution'

const GOOGLE_CHAT_HOST = 'chat.googleapis.com' // the ONLY host a stored webhook may point at
const MAX_TEXT = 4_096

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

/**
 * Validate the STORED webhook URL and return it as the dial target. This is the SSRF
 * boundary: the URL is never param-supplied, and it is re-validated on every call
 * (https, no userinfo, host === chat.googleapis.com). Throws WITHOUT echoing the URL.
 */
function resolveWebhookUrl(secrets: Record<string, string>): string {
  const raw = str(secrets.GOOGLE_CHAT_WEBHOOK_URL)
  if (!raw) throw new ConnectorProviderError('Google Chat webhook is not configured')
  let url: URL
  try { url = new URL(raw) } catch { throw new ConnectorProviderError('Google Chat webhook URL is invalid') }
  if (url.protocol !== 'https:') throw new ConnectorProviderError('Google Chat webhook must be https')
  if (url.username || url.password) throw new ConnectorProviderError('Google Chat webhook must not embed credentials')
  if (url.hostname.toLowerCase() !== GOOGLE_CHAT_HOST) throw new ConnectorProviderError('Google Chat webhook must be a chat.googleapis.com URL')
  return url.toString() // the exact stored URL (host validated) — query key+token preserved for the API
}

async function messageSend(ctx: ExecutorContext): Promise<unknown> {
  const webhookUrl = resolveWebhookUrl(ctx.secrets)
  const text = (str(ctx.params.text) || str(ctx.params.message)).slice(0, MAX_TEXT)
  if (!text) throw new ConnectorProviderError('`text` is required to send a message')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: 'application/json',
    'User-Agent': '7ei-mission-control',
  }
  const http: HttpClient = ctx.http
  const res = await http(webhookUrl, { method: 'POST', headers, body: JSON.stringify({ text }) })
  if (!res.ok) {
    // Surface ONLY the status — NEVER the URL (it is the secret) and NEVER the raw body.
    throw new ConnectorProviderError(`Google Chat request failed (${res.status})`, res.status)
  }
  try { return await res.json() } catch { return null }
}

export const googleChatExecutor: ConnectorExecutor = {
  connectorId: 'google_chat',
  actions: {
    // WRITE — needs approval unless the (agent,google_chat) pair is trusted (auto_write).
    'message.send': { class: 'write', handler: messageSend },
  },
}
