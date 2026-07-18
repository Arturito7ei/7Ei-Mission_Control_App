// Per-agent connector catalog + pure helpers (Epic CONN / CONN-1).
//
// Sibling of services/connectors.ts (the ORG-level registry), but for the AGENT
// level: which connectors an agent may configure, how to validate a connector's
// NON-SECRET config, and how to project a stored `agent_connectors` row down to a
// client-safe shape. The credential itself NEVER lives here — it is written to the
// `secrets` table at `agent` scope and referenced by `agent_connectors.secretRef`.
//
// THE NEVER-LEAK RULE (mirrors services/org-public.ts): a client read returns
// `toPublicConnector(row)` — an ALLOW-LIST projection. `secretRef` is a
// never-projected field, and `agent-connectors.test.ts` fails if a new schema
// column is classified as neither public, secret, nor internal.

import { z } from 'zod'
import { schema } from '../db/client'

export type ConnectorAuthType = 'token' | 'basic' | 'oauth' | 'config'

export interface AgentConnectorMeta {
  id: string
  name: string
  category: 'Communication' | 'Dev' | 'Project' | 'Google' | 'Custom'
  authType: ConnectorAuthType
  icon: string
  docsUrl: string
  /** Whether a POST/PUT may carry an encrypted credential for this connector. */
  hasSecret: boolean
  /** Whether the credential is REQUIRED to configure (unless inheriting the org
   *  connection). MCP's secret is optional; a GitHub/Jira connector with no
   *  credential is not real, so the write is rejected. */
  secretRequired?: boolean
}

/**
 * The agent-connector catalog. CONN-1 shipped ONE config-only connector — a custom
 * MCP server — because it exercised the whole path (NON-secret config write,
 * agent-scoped secret write, masked read, test, delete) WITHOUT OAuth. CONN-4a adds
 * the two token/basic connectors that become REAL immediately via the existing
 * agent-secrets env-injection path (see CONNECTOR_ENV_KEYS below): GitHub (PAT) and
 * Jira (basic). Google (OAuth) and the comms connectors land in later stages and are
 * intentionally NOT in the catalog yet, so no half-built connector is reachable.
 * Validate every inbound `connectorId` against this list.
 */
export const AGENT_CONNECTORS: AgentConnectorMeta[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'Dev',
    authType: 'token',
    icon: '🐙',
    docsUrl: 'https://github.com/settings/tokens',
    hasSecret: true, // the PAT — stored agent-scoped under GITHUB_TOKEN
    secretRequired: true,
  },
  {
    id: 'jira',
    name: 'Atlassian Jira',
    category: 'Project',
    authType: 'basic',
    icon: '🔷',
    docsUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    hasSecret: true, // the API token — stored agent-scoped under JIRA_API_TOKEN
    secretRequired: true,
  },
  {
    id: 'mcp',
    name: 'Custom MCP Server',
    category: 'Custom',
    authType: 'config',
    icon: '🧩',
    docsUrl: 'https://modelcontextprotocol.io',
    hasSecret: true, // optional bearer/api-key for the server, stored agent-scoped
  },
  // ─── Communication connectors (CONN-6) — config + credential storage only ───────
  // Store settings + credential now (encrypted, agent-scoped); the runtime env path
  // carries them to the agent. The backend does NOT yet CALL these providers — the
  // send/receive execution bridge is CONN-8 (decision D). `test` is a safe stub (no
  // provider ping — avoids the SSRF surface of an arbitrary webhook / graph host).
  {
    id: 'telegram',
    name: 'Telegram',
    category: 'Communication',
    authType: 'token',
    icon: '✈️',
    docsUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    hasSecret: true, // the bot token — stored agent-scoped under TELEGRAM_BOT_TOKEN
    secretRequired: true,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    category: 'Communication',
    authType: 'token',
    icon: '🟢',
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    hasSecret: true, // the Cloud API access token — WHATSAPP_ACCESS_TOKEN
    secretRequired: true,
  },
  {
    id: 'google_chat',
    name: 'Google Chat',
    category: 'Communication',
    authType: 'token',
    icon: '💬',
    docsUrl: 'https://developers.google.com/chat/how-tos/webhooks',
    // v1 credential is an incoming-webhook URL (it embeds a key+token in its query,
    // so it IS sensitive — stored as the write-only secret, never in config). A
    // bot/service-account flow can replace it later without a data migration.
    hasSecret: true, // the webhook URL — GOOGLE_CHAT_WEBHOOK_URL
    secretRequired: true,
  },
  {
    id: 'google',
    name: 'Google Workspace',
    category: 'Google',
    authType: 'oauth',
    icon: '🔗',
    docsUrl: 'https://workspace.google.com',
    // The credential is an OAuth token pair, NOT a value POSTed via the `secret`
    // field — it arrives through the CONN-5 start/callback flow and lands ENCRYPTED
    // in `agent_oauth_tokens`, never in the `secrets` env bag. So `hasSecret` is
    // false for the generic configure path: this connector is connected/disconnected
    // via /connectors/google/oauth/start + the callback, and the generic POST/PUT
    // config writes are rejected (see routes/agent-connectors.ts). `secretRef` stays
    // null; the connector row's presence + status='connected' is the connected signal.
    hasSecret: false,
  },
]

export function getAgentConnector(id: string): AgentConnectorMeta | undefined {
  return AGENT_CONNECTORS.find(c => c.id === id)
}

// ─── Per-connector NON-SECRET config validation ──────────────────────────────
//
// Custom MCP: an arbitrary server definition. `name` labels it; `transport` picks
// how the runtime reaches it; `http` needs a `url`, `stdio` needs a `command`
// (+ optional args). NONE of these fields is a credential — the optional secret
// (a bearer token / api key) travels in the request body's `secret` field and is
// encrypted into an agent-scoped `secrets` row, never into `config`.
const McpConfigSchema = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.enum(['http', 'stdio']).default('http'),
  url: z.string().trim().url().max(2048).optional(),
  command: z.string().trim().min(1).max(512).optional(),
  args: z.array(z.string().max(512)).max(50).optional(),
  // CONN-8b-3: the operator's explicit allow-list of MCP tool names permitted to auto-run
  // under `auto_write`. NON-secret. Any tool NOT on this list (and every destructive-named
  // tool) escalates to approval — an empty/absent list means EVERY opaque tool needs
  // approval (fail-closed for the opaque surface).
  autoApproveTools: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
})
  .strict()
  .refine(c => c.transport !== 'http' || !!c.url, { message: 'http transport requires a url', path: ['url'] })
  .refine(c => c.transport !== 'stdio' || !!c.command, { message: 'stdio transport requires a command', path: ['command'] })

// GitHub (PAT): the only NON-secret config is an optional display label for the
// account/username. The PAT itself travels in the request body's `secret` field and
// is encrypted into an agent-scoped `GITHUB_TOKEN` secret — never into `config`.
const GithubConfigSchema = z.object({
  username: z.string().trim().min(1).max(120).optional(),
}).strict()

// Jira (basic auth = email:apiToken): `baseUrl` (the Atlassian site, a validated
// URL) and `email` are NON-secret and returnable; the API token travels in `secret`
// and is encrypted into an agent-scoped `JIRA_API_TOKEN` secret. `baseUrl` + `email`
// are ALSO mirrored into agent-scoped secrets (JIRA_BASE_URL / JIRA_EMAIL) so the
// runtime receives all three as env — see connectorSecretEntries.
const JiraConfigSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  email: z.string().trim().email().max(320),
}).strict()

// Telegram (bot): the NON-secret config is a display username + an optional target
// chat id (mirrored to env as TELEGRAM_CHAT_ID for the completion-ping convention the
// openclaw adapter already reads). The bot token travels in `secret` → TELEGRAM_BOT_TOKEN.
const TelegramConfigSchema = z.object({
  botUsername: z.string().trim().min(1).max(120).optional(),
  chatId: z.string().trim().min(1).max(64).optional(),
}).strict()

// WhatsApp (Cloud API): NON-secret ids (phone number id + business account id), both
// mirrored to env. The access token travels in `secret` → WHATSAPP_ACCESS_TOKEN.
const WhatsappConfigSchema = z.object({
  phoneNumberId: z.string().trim().min(1).max(64).optional(),
  businessAccountId: z.string().trim().min(1).max(64).optional(),
}).strict()

// Google Chat: the only NON-secret config is an optional space label (e.g.
// "spaces/AAAA…"). The incoming-webhook URL is the credential and travels in `secret`
// → GOOGLE_CHAT_WEBHOOK_URL (never config — the URL embeds a key+token).
const GoogleChatConfigSchema = z.object({
  space: z.string().trim().min(1).max(200).optional(),
}).strict()

const CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  github: GithubConfigSchema,
  jira: JiraConfigSchema,
  mcp: McpConfigSchema,
  telegram: TelegramConfigSchema,
  whatsapp: WhatsappConfigSchema,
  google_chat: GoogleChatConfigSchema,
}

export type ValidatedConfig = { ok: true; config: Record<string, unknown> } | { ok: false; error: string }

/** Validate a connector's NON-SECRET config against its catalog schema. Pure. */
export function validateConnectorConfig(connectorId: string, raw: unknown): ValidatedConfig {
  const s = CONFIG_SCHEMAS[connectorId]
  if (!s) return { ok: false, error: `No config schema for connector '${connectorId}'` }
  const r = s.safeParse(raw ?? {})
  if (!r.success) return { ok: false, error: r.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') }
  return { ok: true, config: r.data as Record<string, unknown> }
}

/** The `secrets` key for an agent-scoped connector credential. Deterministic so a
 *  disconnect can find and delete exactly the row a connect wrote. Scope + scopeId
 *  (agent) already isolate it per agent, so the key need not embed the agent id.
 *  Used for connectors whose credential has no established runtime env-var name
 *  (custom MCP); GitHub/Jira use the runtime-expected names via CONNECTOR_ENV_KEYS. */
export function connectorSecretKey(connectorId: string): string {
  return `CONNECTOR_${connectorId.toUpperCase()}_SECRET`
}

// ─── The execution contract: env-var KEYS the runtime injects ─────────────────
//
// THIS IS THE WIRE THAT MAKES A CONNECTOR REAL. `GET /api/agent/secrets` returns
// `resolveSecretsForAgent(...)` — a bag keyed by each `secrets` row's `key` — and the
// adapters inject that bag VERBATIM as env (`os.environ[str(k)] = str(v)` in
// cc_adapter.py / mc_adapter.py). So storing an agent-scoped secret under key
// `GITHUB_TOKEN` means the agent's runtime receives a `GITHUB_TOKEN` env var, which
// its own git/gh tooling reads (the backend's own skills.ts already reads
// `process.env.GITHUB_TOKEN`). The keys below are therefore the names the runtime
// expects, not arbitrary storage keys.
//
//   github → GITHUB_TOKEN                            (matches the org connector's secretKey
//                                                     + backend skills.ts consumer)
//   jira   → JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
//            (conventional basic-auth env; the backend has NO in-repo Jira env
//             consumer — the org Jira path uses a JIRA_CONNECTION JSON blob — so
//             these are the standard names, documented for operator confirmation in
//             docs/DESIGN-per-agent-connectors.md §CONN-4a.)
//   mcp    → CONNECTOR_MCP_SECRET                     (no established runtime name)
//
// Jira's baseUrl/email are non-secret yet still written into the (encrypted) secret
// store: env injection is the ONLY channel to the runtime — `config` is not injected —
// so all three MUST live here for Jira to actually work. `config` still holds
// baseUrl/email too, as the returnable display source of truth.
//   telegram    → TELEGRAM_BOT_TOKEN (secret), TELEGRAM_CHAT_ID (non-secret)
//                 CONFIRMED name: telegram-webhook.ts + the openclaw adapter both read
//                 process.env.TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
//   whatsapp    → WHATSAPP_ACCESS_TOKEN (secret), WHATSAPP_PHONE_NUMBER_ID,
//                 WHATSAPP_BUSINESS_ACCOUNT_ID (non-secret). CONVENTIONAL Meta Cloud API
//                 names — NO in-repo consumer yet (execution is CONN-8), so ⚠️ operator:
//                 confirm your runtime's WhatsApp tooling reads exactly these.
//   google_chat → GOOGLE_CHAT_WEBHOOK_URL (secret = the incoming-webhook URL).
//                 CONVENTIONAL name — NO in-repo consumer yet; ⚠️ operator: confirm.
export const CONNECTOR_ENV_KEYS: Record<string, readonly string[]> = {
  github: ['GITHUB_TOKEN'],
  jira: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
  mcp: [connectorSecretKey('mcp')],
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  whatsapp: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID'],
  google_chat: ['GOOGLE_CHAT_WEBHOOK_URL'],
}

/** The agent-scoped env keys a connector writes (for purge-on-disconnect). */
export function connectorEnvKeys(connectorId: string): readonly string[] {
  return CONNECTOR_ENV_KEYS[connectorId] ?? []
}

/** The single credential key recorded as the row's `secretRef` (the "has a
 *  credential" pointer). For multi-key connectors it is the sensitive one. */
export function primarySecretKey(connectorId: string): string | null {
  if (connectorId === 'github') return 'GITHUB_TOKEN'
  if (connectorId === 'jira') return 'JIRA_API_TOKEN'
  if (connectorId === 'mcp') return connectorSecretKey('mcp')
  if (connectorId === 'telegram') return 'TELEGRAM_BOT_TOKEN'
  if (connectorId === 'whatsapp') return 'WHATSAPP_ACCESS_TOKEN'
  if (connectorId === 'google_chat') return 'GOOGLE_CHAT_WEBHOOK_URL'
  return null
}

/**
 * The `{ envKey: value }` entries to write into the agent-scoped secret store for a
 * configure/update. Pure. NON-secret entries (Jira baseUrl/email) always derive from
 * the validated config; the sensitive credential entry is included only when a new
 * `secret` is supplied (so a re-configure that omits the token keeps the stored one).
 */
export function connectorSecretEntries(
  connectorId: string,
  config: Record<string, unknown>,
  secret: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  const cred = secret?.trim() || undefined
  if (connectorId === 'github') {
    if (cred) out.GITHUB_TOKEN = cred
  } else if (connectorId === 'jira') {
    if (typeof config.baseUrl === 'string') out.JIRA_BASE_URL = config.baseUrl
    if (typeof config.email === 'string') out.JIRA_EMAIL = config.email
    if (cred) out.JIRA_API_TOKEN = cred
  } else if (connectorId === 'mcp') {
    if (cred) out[connectorSecretKey('mcp')] = cred
  } else if (connectorId === 'telegram') {
    if (typeof config.chatId === 'string') out.TELEGRAM_CHAT_ID = config.chatId
    if (cred) out.TELEGRAM_BOT_TOKEN = cred
  } else if (connectorId === 'whatsapp') {
    if (typeof config.phoneNumberId === 'string') out.WHATSAPP_PHONE_NUMBER_ID = config.phoneNumberId
    if (typeof config.businessAccountId === 'string') out.WHATSAPP_BUSINESS_ACCOUNT_ID = config.businessAccountId
    if (cred) out.WHATSAPP_ACCESS_TOKEN = cred
  } else if (connectorId === 'google_chat') {
    if (cred) out.GOOGLE_CHAT_WEBHOOK_URL = cred
  }
  return out
}

/** A masked, credential-free display label derived from the NON-secret config. */
export function connectorAccountLabel(
  connectorId: string,
  config: Record<string, unknown>,
): string | null {
  if (connectorId === 'github') return typeof config.username === 'string' ? config.username : null
  if (connectorId === 'jira') return typeof config.email === 'string' ? config.email : null
  if (connectorId === 'mcp') return typeof config.name === 'string' ? config.name : null
  if (connectorId === 'telegram') return typeof config.botUsername === 'string' ? config.botUsername : (typeof config.chatId === 'string' ? config.chatId : null)
  if (connectorId === 'whatsapp') return typeof config.phoneNumberId === 'string' ? config.phoneNumberId : null
  if (connectorId === 'google_chat') return typeof config.space === 'string' ? config.space : null
  return null
}

/**
 * SSRF guard for the live `test` check: is this URL an Atlassian Cloud host? The
 * backend only ever dials KNOWN provider hosts (api.github.com is hardcoded;
 * Jira must be `*.atlassian.net`), never an arbitrary user-supplied URL. A
 * self-hosted Jira (any other host) is allowed as config but its live test is
 * skipped rather than dialed. Pure.
 */
export function isAtlassianHost(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase()
    return h === 'atlassian.net' || h.endsWith('.atlassian.net')
  } catch {
    return false
  }
}

// ─── Per-connector TRUST level (CONN-7 containment) ──────────────────────────
//
// The owner-set trust for a single (agent, connector) pair. Default is
// 'approval_required' — every WRITE / DESTRUCTIVE connector action routes through
// the approval + step-up flow. 'auto_write' auto-approves WRITE actions for that
// pair; DESTRUCTIVE actions ALWAYS require approval regardless of trust (the
// documented policy — see services/connector-authz.ts). It is an ENUM, never a
// secret, and the only new field `toPublicConnector` may return.
export const TRUST_LEVELS = ['approval_required', 'auto_write'] as const
export type TrustLevel = (typeof TRUST_LEVELS)[number]
export const DEFAULT_TRUST_LEVEL: TrustLevel = 'approval_required'

export function isValidTrustLevel(v: unknown): v is TrustLevel {
  return typeof v === 'string' && (TRUST_LEVELS as readonly string[]).includes(v)
}

/** Coerce a stored/absent trust value to a valid level. Fail-safe: an unknown or
 *  null value reads as the STRICTER 'approval_required', never as auto_write. */
export function normalizeTrustLevel(v: unknown): TrustLevel {
  return isValidTrustLevel(v) ? v : DEFAULT_TRUST_LEVEL
}

// ─── The client-safe projection (twin of toPublicOrg) ────────────────────────

type ConnectorRow = typeof schema.agentConnectors.$inferSelect

/**
 * The COMPLETE set of `agent_connectors` columns a client may see. Everything here
 * is status, non-secret config, or a display label. Adding a column here is a
 * deliberate act — `agent-connectors.test.ts` fails if a new schema column is
 * classified as neither public, secret, nor internal.
 */
export const PUBLIC_CONNECTOR_FIELDS = [
  'connectorId',
  'status',
  'config',
  'accountLabel',
  'useOrgConnection',
  'trustLevel', // CONN-7: the trust ENUM only (approval_required | auto_write) — never a secret.
  'lastTestedAt',
  'lastError',
] as const

/** The credential pointer. Never reaches a client — it names an agent-scoped
 *  `secrets` row, and a secretRef is one dereference away from the token itself. */
export const SECRET_CONNECTOR_FIELDS = ['secretRef'] as const

/** Structural columns: neither shipped to clients nor a credential. Keeping them
 *  OFF the public projection is intentional (row id / tenant ids / timestamps add
 *  nothing a client needs and widen the surface). */
export const INTERNAL_CONNECTOR_FIELDS = ['id', 'orgId', 'agentId', 'createdAt', 'updatedAt'] as const

export type PublicConnector = Pick<ConnectorRow, (typeof PUBLIC_CONNECTOR_FIELDS)[number]>

/**
 * Project an `agent_connectors` row down to its public fields.
 *
 * Allow-list, not deny-list: a column added to the schema is invisible to clients
 * until someone puts it in `PUBLIC_CONNECTOR_FIELDS` on purpose — so a new secret
 * column cannot leak by default. Keys are copied only when PRESENT on the input, so
 * a `null` column still serialises as `null`.
 */
export function toPublicConnector<T extends Partial<ConnectorRow>>(row: T): PublicConnector {
  const out: Record<string, unknown> = {}
  for (const key of PUBLIC_CONNECTOR_FIELDS) {
    if (key in row) out[key] = (row as Record<string, unknown>)[key]
  }
  return out as PublicConnector
}
