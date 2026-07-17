// Epic CONN / CONN-8b-1 — the TELEGRAM connector EXECUTOR (Bot API sendMessage).
//
// A fixed-surface executor consumed by the CONN-8a execution framework, following the
// GitHub executor pattern. It maps the single `message.send` action to a real
// api.telegram.org sendMessage call, using the agent-scoped `TELEGRAM_BOT_TOKEN` the
// framework hands it at execution time (CONN-6). Its declared class MUST equal
// `classifyConnectorAction('telegram', 'message.send')` — asserted in the test.
//
// SSRF is closed by construction: the host is HARDCODED to api.telegram.org and the
// only param that lands in the URL — none does; the chat id + text go in the JSON body.
//
// ⚠️ THE TOKEN-IN-URL CONCERN. Telegram embeds the bot token in the URL PATH
// (`/bot<token>/sendMessage`), so the full request URL is itself a secret. This executor
// therefore NEVER puts the URL (or the token) into an error message or any returned
// value: provider errors surface only Telegram's short `description` + status. The
// framework's `redactSecrets` also strips the token VALUE from any result/error as a
// backstop (TELEGRAM_BOT_TOKEN is in the executor's secret bag), but the primary defence
// is not constructing a leak in the first place. The token is validated to a strict
// charset before it is embedded, so it can never break out of the path.

import { ConnectorProviderError, type ConnectorExecutor, type ExecutorContext, type HttpClient } from './connector-execution'

const TELEGRAM_API = 'https://api.telegram.org' // HARDCODED — the ONLY host this executor dials
const TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]+$/       // <bot_id>:<secret> — no URL metacharacters
const CHAT_ID_RE = /^-?[0-9]+$|^@[A-Za-z0-9_]{1,64}$/ // numeric id (may be negative) or @channelusername
const MAX_TEXT = 4_096                            // Telegram's own sendMessage text limit

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }

function requireToken(secrets: Record<string, string>): string {
  const t = str(secrets.TELEGRAM_BOT_TOKEN)
  // Strict charset: a token containing '/', '@', '?', whitespace, etc. is refused — this
  // is what keeps the hardcoded host un-escapable even though the token is in the path.
  if (!TOKEN_RE.test(t)) throw new ConnectorProviderError('Telegram credential is not available or malformed')
  return t
}

function requireChatId(params: Record<string, unknown>, secrets: Record<string, string>): string {
  const id = str(params.chatId) || str(secrets.TELEGRAM_CHAT_ID)
  if (!CHAT_ID_RE.test(id)) throw new ConnectorProviderError('invalid or missing `chatId` (and no stored TELEGRAM_CHAT_ID)')
  return id
}

async function messageSend(ctx: ExecutorContext): Promise<unknown> {
  const token = requireToken(ctx.secrets)
  const chatId = requireChatId(ctx.params, ctx.secrets)
  const text = (str(ctx.params.text) || str(ctx.params.message)).slice(0, MAX_TEXT)
  if (!text) throw new ConnectorProviderError('`text` is required to send a message')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': '7ei-mission-control',
  }
  // Host is fixed; the token (validated) is the ONLY thing after the host in the path.
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`
  const http: HttpClient = ctx.http
  const res = await http(url, { method: 'POST', headers, body: JSON.stringify({ chat_id: chatId, text }) })
  if (!res.ok) {
    // Surface ONLY Telegram's short `description` + status — NEVER the URL (it carries
    // the token) and NEVER the raw body.
    let description = ''
    try { description = String((await res.json())?.description ?? '') } catch { /* non-JSON */ }
    description = description.slice(0, 200)
    throw new ConnectorProviderError(`Telegram request failed (${res.status})${description ? `: ${description}` : ''}`, res.status)
  }
  try { return await res.json() } catch { return null }
}

export const telegramExecutor: ConnectorExecutor = {
  connectorId: 'telegram',
  actions: {
    // WRITE — needs approval unless the (agent,telegram) pair is trusted (auto_write).
    'message.send': { class: 'write', handler: messageSend },
  },
}
