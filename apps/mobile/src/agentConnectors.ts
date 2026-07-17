// Epic CONN / CONN-3 — the phone's pure half of the per-agent Connectors
// accordion. No React, no react-native, so `agentConnectors.test.ts` can load it
// (and the DEP-FREE web module + a text read of the backend catalog) under
// `node --test` and prove the phone hasn't drifted from the desk or the server.
//
// This is a hand-copied MIRROR of web/lib/agentConnectors.ts (CONN-2). Metro
// can't import from web/, so the copy is pinned by a parity tripwire that imports
// the web module directly (it is dependency-free) and asserts the two agree —
// the standing web⇄mobile rule for any list copied across the boundary.
//
// TWO honesty rules this module encodes (same as the web):
//   1. The operator's category grouping (Communication / IT-Project / Google /
//      Custom MCP) is shown IN FULL, but only the connectors REAL are wired to the
//      CONN-1/CONN-4a API. As of CONN-4b that is THREE — the custom MCP server
//      (the CONN-1 pilot), GitHub (PAT) and Jira (basic), the two token/basic
//      connectors CONN-4a made real via the agent-secrets env path. Every other
//      connector renders as a disabled "coming soon" / "out of scope" row, so we
//      never fake a save against a backend connector that does not exist yet (the
//      backend 404s an unknown connectorId).
//   2. `AVAILABLE_CONNECTOR_IDS` is a mirror of the backend `AGENT_CONNECTORS`
//      catalog. `agentConnectors.test.ts` text-reads the backend source and fails
//      if the two drift (the backend module pulls zod + drizzle at module scope,
//      so it can't be imported here — Mobile CI installs only apps/mobile; a
//      real-dep import would SILENTLY drop the whole test file, per the memory on
//      cross-workspace test imports — so we read it as text, exactly as the web's
//      tripwire does).

export type ConnectorAvailability = 'available' | 'coming_soon' | 'out_of_scope'

export interface DisplayConnector {
  /** Catalog id. For an `available` connector this MUST match a backend
   *  AGENT_CONNECTORS id (enforced by the parity tripwire test). */
  id: string
  name: string
  icon: string
  availability: ConnectorAvailability
  /** Why a non-available connector is not yet configurable — shown on its row. */
  note?: string
}

export interface ConnectorGroup {
  key: string
  /** The section header, exactly as the operator worded the category. */
  title: string
  connectors: DisplayConnector[]
}

/** The connectorId of the config-only connector wired end-to-end at CONN-1. */
export const MCP_CONNECTOR_ID = 'mcp'
/** The token/basic connectors CONN-4a made real; enabled in the UI at CONN-4b. */
export const GITHUB_CONNECTOR_ID = 'github'
export const JIRA_CONNECTOR_ID = 'jira'
/** The Communication connectors CONN-6 makes real for STORAGE (config + credential);
 *  the runtime env path carries them to the agent — send/receive execution is CONN-8. */
export const TELEGRAM_CONNECTOR_ID = 'telegram'
export const WHATSAPP_CONNECTOR_ID = 'whatsapp'
export const GOOGLE_CHAT_CONNECTOR_ID = 'google_chat'
/** The per-agent Google OAuth connector (CONN-5). On the phone this row is
 *  CONFIG-ONLY — it shows connected/disconnected status + the account email + a note
 *  pointing at the web dashboard; the phone cannot complete OAuth without a dev build,
 *  so there is no Connect button or flow here (the web/desktop does the full flow). */
export const GOOGLE_CONNECTOR_ID = 'google'

/**
 * The accordion, grouped by category exactly as the operator listed them. Order
 * within each group matches the operator's list. `mcp`, `github` and `jira` are
 * `available`; the rest carry an honest note pointing at the stage that makes them
 * real.
 *
 * Kept field-for-field identical to the web's CONNECTOR_GROUPS (CONN-2) — the
 * parity test asserts the two are the same object, so a note or an icon can't
 * drift on one platform.
 */
export const CONNECTOR_GROUPS: ConnectorGroup[] = [
  {
    key: 'communication',
    title: 'Communication',
    connectors: [
      // CONN-6: config + credential storage now (execution is CONN-8). Signal stays out.
      { id: GOOGLE_CHAT_CONNECTOR_ID, name: 'Google Chat', icon: '💬', availability: 'available' },
      { id: TELEGRAM_CONNECTOR_ID, name: 'Telegram', icon: '✈️', availability: 'available' },
      { id: WHATSAPP_CONNECTOR_ID, name: 'WhatsApp', icon: '🟢', availability: 'available' },
      { id: 'signal', name: 'Signal', icon: '🔵', availability: 'out_of_scope', note: 'Out of scope for v1 — Signal has no official API (spike-only if ever).' },
    ],
  },
  {
    key: 'it_project',
    title: 'IT / Project management',
    connectors: [
      { id: GITHUB_CONNECTOR_ID, name: 'GitHub', icon: '🐙', availability: 'available' },
      { id: JIRA_CONNECTOR_ID, name: 'Jira', icon: '📋', availability: 'available' },
    ],
  },
  {
    key: 'google',
    title: 'Google Services',
    connectors: [
      // ONE Google connection per agent (CONN-5), granting the selected Calendar /
      // Gmail / Drive scopes via OAuth. Real on web/desktop; config-only on the phone.
      { id: GOOGLE_CONNECTOR_ID, name: 'Google Workspace', icon: '🔗', availability: 'available' },
    ],
  },
  {
    key: 'custom',
    title: 'Custom MCP servers',
    connectors: [
      { id: MCP_CONNECTOR_ID, name: 'Custom MCP Server', icon: '🧩', availability: 'available' },
    ],
  },
]

/**
 * The connector ids that are REAL — i.e. backed by the CONN-1/CONN-4a API.
 * Derived from the groups so there is one source of truth; the parity test
 * asserts this set is a SUBSET of the backend `AGENT_CONNECTORS` catalog.
 */
export const AVAILABLE_CONNECTOR_IDS: string[] = CONNECTOR_GROUPS
  .flatMap(g => g.connectors)
  .filter(c => c.availability === 'available')
  .map(c => c.id)

export function isAvailableConnector(id: string): boolean {
  return AVAILABLE_CONNECTOR_IDS.includes(id)
}

/** Flat lookup of every display connector by id (available or not). */
export function findDisplayConnector(id: string): DisplayConnector | undefined {
  return CONNECTOR_GROUPS.flatMap(g => g.connectors).find(c => c.id === id)
}

// ─── The shape a masked read returns (CONN-1 `toPublicConnector` + meta) ──────
//
// This mirrors the GET list item. NOTE the security invariant: there is NO
// secret/token field here — the API projects an allow-list that never carries a
// credential or even a "secretRef". The client shows status + non-secret config
// + a derived label only. A secret is WRITE-ONLY: sent up in a form, never read
// back.
export interface PublicConnectorState {
  connectorId: string
  name?: string
  category?: string
  authType?: string
  icon?: string
  docsUrl?: string
  status: string
  config: Record<string, unknown> | null
  accountLabel: string | null
  useOrgConnection: boolean
  lastTestedAt: number | null
  lastError: string | null
}

export function isConfigured(state: Pick<PublicConnectorState, 'status'> | null | undefined): boolean {
  return !!state && state.status !== 'not_configured'
}

// ─── Custom MCP config — a client mirror of the backend zod schema ────────────
//
// backend/src/services/agent-connectors.ts `McpConfigSchema`:
//   name      string, trimmed, 1..120, required
//   transport 'http' | 'stdio', default 'http'
//   url       string, trimmed, valid URL, <=2048, optional  (required when http)
//   command   string, trimmed, 1..512, optional             (required when stdio)
//   args      string[], each <=512, <=50 entries, optional
// The server stays the FINAL validator (`.strict()` there rejects unknown keys);
// this gives the operator instant feedback and builds a clean request body.

export type McpTransport = 'http' | 'stdio'

export interface McpConfig {
  name: string
  transport: McpTransport
  url?: string
  command?: string
  args?: string[]
}

export type McpValidation = { ok: true; config: McpConfig } | { ok: false; error: string }

/** The raw form fields, as the screen holds them (args as one-per-line text). */
export interface McpFormInput {
  name: string
  transport: McpTransport
  url: string
  command: string
  args: string
}

/** Split the args textarea into a trimmed, non-empty list (one arg per line). */
export function parseArgs(raw: string): string[] {
  return (raw ?? '').split('\n').map(s => s.trim()).filter(Boolean)
}

function isHttpUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' }
  catch { return false }
}

/** Validate + normalize a custom-MCP config into the request body's `config`. */
export function validateMcpConfig(input: McpFormInput): McpValidation {
  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, error: 'Name is required.' }
  if (name.length > 120) return { ok: false, error: 'Name must be 120 characters or fewer.' }

  const transport: McpTransport = input.transport === 'stdio' ? 'stdio' : 'http'
  const url = (input.url ?? '').trim()
  const command = (input.command ?? '').trim()
  const args = parseArgs(input.args)

  if (transport === 'http') {
    if (!url) return { ok: false, error: 'HTTP transport requires a URL.' }
    if (url.length > 2048) return { ok: false, error: 'URL must be 2048 characters or fewer.' }
    if (!isHttpUrl(url)) return { ok: false, error: 'Enter a valid http(s) URL.' }
  } else {
    if (!command) return { ok: false, error: 'stdio transport requires a command.' }
    if (command.length > 512) return { ok: false, error: 'Command must be 512 characters or fewer.' }
  }
  if (args.length > 50) return { ok: false, error: 'At most 50 arguments.' }
  if (args.some(a => a.length > 512)) return { ok: false, error: 'Each argument must be 512 characters or fewer.' }

  // Build only the fields the chosen transport uses, so the .strict() server
  // schema never sees a stray key (an http config carries no `command`).
  const config: McpConfig = { name, transport }
  if (transport === 'http') config.url = url
  else { config.command = command; if (args.length) config.args = args }
  return { ok: true, config }
}

/** Seed a blank/edit form from a stored config (never carries a secret). */
export function mcpConfigToForm(config: Record<string, unknown> | null | undefined): McpFormInput {
  const c = (config ?? {}) as Partial<McpConfig>
  return {
    name: typeof c.name === 'string' ? c.name : '',
    transport: c.transport === 'stdio' ? 'stdio' : 'http',
    url: typeof c.url === 'string' ? c.url : '',
    command: typeof c.command === 'string' ? c.command : '',
    args: Array.isArray(c.args) ? c.args.join('\n') : '',
  }
}

// ─── GitHub (PAT) config — a client mirror of the backend zod schema ──────────
//
// backend/src/services/agent-connectors.ts `GithubConfigSchema`:
//   username  string, trimmed, 1..120, optional   (display label only — NOT a credential)
// The PAT itself is the WRITE-ONLY `secret` field, stored agent-scoped under
// GITHUB_TOKEN; it is NEVER config and NEVER read back. `secretRequired` on the
// backend, so a first configure must carry a token — the screen enforces this only
// when the connector is not already configured (blank keeps the stored token).
// Kept identical to web/lib/agentConnectors.ts (the parity test asserts agreement).

export interface GithubConfig { username?: string }
export interface GithubFormInput { username: string }
export type GithubValidation = { ok: true; config: GithubConfig } | { ok: false; error: string }

/** Validate the NON-SECRET GitHub config (the optional username label). The token
 *  is validated separately by the screen (required on first configure). */
export function validateGithubConfig(input: GithubFormInput): GithubValidation {
  const username = (input.username ?? '').trim()
  if (username.length > 120) return { ok: false, error: 'Username must be 120 characters or fewer.' }
  const config: GithubConfig = {}
  if (username) config.username = username   // omitted when blank so .strict()+.optional() are happy
  return { ok: true, config }
}

/** Seed a blank/edit GitHub form from a stored config (never carries a secret). */
export function githubConfigToForm(config: Record<string, unknown> | null | undefined): GithubFormInput {
  const c = (config ?? {}) as Partial<GithubConfig>
  return { username: typeof c.username === 'string' ? c.username : '' }
}

// ─── Jira (basic) config — a client mirror of the backend zod schema ──────────
//
// backend/src/services/agent-connectors.ts `JiraConfigSchema`:
//   baseUrl  string, trimmed, valid URL, <=2048, required   (the Atlassian site)
//   email    string, trimmed, valid email, <=320, required
// Both are NON-secret and returnable; the API token is the WRITE-ONLY `secret`
// field, stored agent-scoped under JIRA_API_TOKEN (baseUrl/email are ALSO mirrored
// into agent-scoped secrets by the backend so the runtime gets all three as env —
// see CONN-4a). `secretRequired`, so a first configure must carry a token.

export interface JiraConfig { baseUrl: string; email: string }
export interface JiraFormInput { baseUrl: string; email: string }
export type JiraValidation = { ok: true; config: JiraConfig } | { ok: false; error: string }

function isUrl(s: string): boolean {
  try { new URL(s); return true } catch { return false }
}
function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

/** Validate the NON-SECRET Jira config (baseUrl + email). The API token is
 *  validated separately by the screen (required on first configure). */
export function validateJiraConfig(input: JiraFormInput): JiraValidation {
  const baseUrl = (input.baseUrl ?? '').trim()
  const email = (input.email ?? '').trim()
  if (!baseUrl) return { ok: false, error: 'Base URL is required.' }
  if (baseUrl.length > 2048) return { ok: false, error: 'Base URL must be 2048 characters or fewer.' }
  if (!isUrl(baseUrl)) return { ok: false, error: 'Enter a valid URL (e.g. https://your-team.atlassian.net).' }
  if (!email) return { ok: false, error: 'Email is required.' }
  if (email.length > 320) return { ok: false, error: 'Email must be 320 characters or fewer.' }
  if (!isEmail(email)) return { ok: false, error: 'Enter a valid email address.' }
  return { ok: true, config: { baseUrl, email } }
}

/** Seed a blank/edit Jira form from a stored config (never carries a secret). */
export function jiraConfigToForm(config: Record<string, unknown> | null | undefined): JiraFormInput {
  const c = (config ?? {}) as Partial<JiraConfig>
  return {
    baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '',
    email: typeof c.email === 'string' ? c.email : '',
  }
}

// ─── Communication connectors (CONN-6) — client mirrors of the backend zod ────
//
// All three store a WRITE-ONLY credential (the secret) plus optional NON-secret
// config, exactly like GitHub/Jira. The credential is never read back. Kept identical
// to web/lib/agentConnectors.ts (the parity test asserts agreement).
//
// backend/src/services/agent-connectors.ts:
//   telegram    TelegramConfigSchema  { botUsername? 1..120, chatId? 1..64 }   secret = bot token
//   whatsapp    WhatsappConfigSchema  { phoneNumberId? 1..64, businessAccountId? 1..64 }  secret = access token
//   google_chat GoogleChatConfigSchema { space? 1..200 }                       secret = incoming-webhook URL

export interface TelegramConfig { botUsername?: string; chatId?: string }
export interface TelegramFormInput { botUsername: string; chatId: string }
export type TelegramValidation = { ok: true; config: TelegramConfig } | { ok: false; error: string }

/** Validate the NON-SECRET Telegram config. The bot token is validated separately by
 *  the screen (required on first configure). */
export function validateTelegramConfig(input: TelegramFormInput): TelegramValidation {
  const botUsername = (input.botUsername ?? '').trim()
  const chatId = (input.chatId ?? '').trim()
  if (botUsername.length > 120) return { ok: false, error: 'Bot username must be 120 characters or fewer.' }
  if (chatId.length > 64) return { ok: false, error: 'Chat ID must be 64 characters or fewer.' }
  const config: TelegramConfig = {}
  if (botUsername) config.botUsername = botUsername
  if (chatId) config.chatId = chatId
  return { ok: true, config }
}

/** Seed a blank/edit Telegram form from a stored config (never carries a secret). */
export function telegramConfigToForm(config: Record<string, unknown> | null | undefined): TelegramFormInput {
  const c = (config ?? {}) as Partial<TelegramConfig>
  return {
    botUsername: typeof c.botUsername === 'string' ? c.botUsername : '',
    chatId: typeof c.chatId === 'string' ? c.chatId : '',
  }
}

export interface WhatsappConfig { phoneNumberId?: string; businessAccountId?: string }
export interface WhatsappFormInput { phoneNumberId: string; businessAccountId: string }
export type WhatsappValidation = { ok: true; config: WhatsappConfig } | { ok: false; error: string }

/** Validate the NON-SECRET WhatsApp config. The access token is validated separately. */
export function validateWhatsappConfig(input: WhatsappFormInput): WhatsappValidation {
  const phoneNumberId = (input.phoneNumberId ?? '').trim()
  const businessAccountId = (input.businessAccountId ?? '').trim()
  if (phoneNumberId.length > 64) return { ok: false, error: 'Phone number ID must be 64 characters or fewer.' }
  if (businessAccountId.length > 64) return { ok: false, error: 'Business account ID must be 64 characters or fewer.' }
  const config: WhatsappConfig = {}
  if (phoneNumberId) config.phoneNumberId = phoneNumberId
  if (businessAccountId) config.businessAccountId = businessAccountId
  return { ok: true, config }
}

/** Seed a blank/edit WhatsApp form from a stored config (never carries a secret). */
export function whatsappConfigToForm(config: Record<string, unknown> | null | undefined): WhatsappFormInput {
  const c = (config ?? {}) as Partial<WhatsappConfig>
  return {
    phoneNumberId: typeof c.phoneNumberId === 'string' ? c.phoneNumberId : '',
    businessAccountId: typeof c.businessAccountId === 'string' ? c.businessAccountId : '',
  }
}

export interface GoogleChatConfig { space?: string }
export interface GoogleChatFormInput { space: string }
export type GoogleChatValidation = { ok: true; config: GoogleChatConfig } | { ok: false; error: string }

/** Validate the NON-SECRET Google Chat config (an optional space label). The webhook
 *  URL is the WRITE-ONLY secret, validated separately (required on first configure). */
export function validateGoogleChatConfig(input: GoogleChatFormInput): GoogleChatValidation {
  const space = (input.space ?? '').trim()
  if (space.length > 200) return { ok: false, error: 'Space must be 200 characters or fewer.' }
  const config: GoogleChatConfig = {}
  if (space) config.space = space
  return { ok: true, config }
}

/** Seed a blank/edit Google Chat form from a stored config (never carries a secret). */
export function googleChatConfigToForm(config: Record<string, unknown> | null | undefined): GoogleChatFormInput {
  const c = (config ?? {}) as Partial<GoogleChatConfig>
  return { space: typeof c.space === 'string' ? c.space : '' }
}

// ─── Google (OAuth) — CONN-5, CONFIG-ONLY on the phone ────────────────────────
//
// The phone does NOT run the OAuth flow (it can't complete the redirect without an
// EAS dev build). This connector row is read-only on mobile: it shows the connection
// status + the account email + granted services, and points the operator at the web
// dashboard to connect/disconnect. These pure read helpers mirror web/lib/
// agentConnectors.ts so the display derives from the SAME masked `config` the backend
// returns (never a token). Kept identical to the web module (the parity test agrees).

export type GoogleService = 'calendar' | 'gmail' | 'drive'
export const GOOGLE_SERVICES: readonly GoogleService[] = ['calendar', 'gmail', 'drive']

/** Human labels for the three services, in display order. */
export const GOOGLE_SERVICE_LABELS: Record<GoogleService, string> = {
  calendar: 'Calendar',
  gmail: 'Gmail',
  drive: 'Drive',
}

export type GoogleServiceSelection = Record<GoogleService, boolean>

/** Read the enabled-service map out of a stored connector `config`. Never a token. Pure. */
export function googleServicesFromConfig(config: Record<string, unknown> | null | undefined): GoogleServiceSelection {
  const svc = ((config ?? {}) as any).services ?? {}
  return {
    calendar: svc.calendar === true,
    gmail: svc.gmail === true,
    drive: svc.drive === true,
  }
}

/** Read the granted scope list out of a stored connector `config` (display only). Pure. */
export function googleScopesFromConfig(config: Record<string, unknown> | null | undefined): string[] {
  const raw = ((config ?? {}) as any).scopes
  return Array.isArray(raw) ? raw.filter((s: unknown): s is string => typeof s === 'string') : []
}

/** A compact "Calendar · Gmail" summary of the enabled services (or null if none). Pure. */
export function googleServicesSummary(sel: GoogleServiceSelection): string | null {
  const on = GOOGLE_SERVICES.filter((s) => sel[s]).map((s) => GOOGLE_SERVICE_LABELS[s])
  return on.length ? on.join(' · ') : null
}
