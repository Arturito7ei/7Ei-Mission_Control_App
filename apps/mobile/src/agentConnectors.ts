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
//      Custom MCP) is shown IN FULL, but only the connectors REAL in v1 are wired
//      to the CONN-1 API. Today that is exactly ONE — the custom MCP server (the
//      CONN-1 pilot). Every other connector renders as a disabled "coming soon" /
//      "out of scope" row, so we never fake a save against a backend connector
//      that does not exist yet (the backend 404s an unknown connectorId —
//      CONN-1's catalog holds only `mcp`).
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

/** The connectorId of the one config-only connector wired end-to-end in v1. */
export const MCP_CONNECTOR_ID = 'mcp'

/**
 * The accordion, grouped by category exactly as the operator listed them. Order
 * within each group matches the operator's list. Only `mcp` is `available`; the
 * rest carry an honest note pointing at the stage that makes them real.
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
      { id: 'google_chat', name: 'Google Chat', icon: '💬', availability: 'coming_soon', note: 'Comms connectors land in a later stage (CONN-6).' },
      { id: 'telegram', name: 'Telegram', icon: '✈️', availability: 'coming_soon', note: 'Per-agent Telegram (bot token) lands in a later stage (CONN-6).' },
      { id: 'whatsapp', name: 'WhatsApp', icon: '🟢', availability: 'coming_soon', note: 'WhatsApp Cloud API lands in a later stage (CONN-6).' },
      { id: 'signal', name: 'Signal', icon: '🔵', availability: 'out_of_scope', note: 'Out of scope for v1 — Signal has no official API (spike-only if ever).' },
    ],
  },
  {
    key: 'it_project',
    title: 'IT / Project management',
    connectors: [
      { id: 'github', name: 'GitHub', icon: '🐙', availability: 'coming_soon', note: 'GitHub (personal access token) lands in a later stage (CONN-4).' },
      { id: 'jira', name: 'Jira', icon: '📋', availability: 'coming_soon', note: 'Jira (basic auth) lands in a later stage (CONN-4).' },
    ],
  },
  {
    key: 'google',
    title: 'Google Services',
    connectors: [
      { id: 'gcal', name: 'Google Calendar', icon: '📅', availability: 'coming_soon', note: 'Per-agent Google OAuth lands in a later stage (CONN-5, desktop-first).' },
      { id: 'gmail', name: 'Gmail', icon: '📧', availability: 'coming_soon', note: 'Per-agent Google OAuth lands in a later stage (CONN-5, desktop-first).' },
      { id: 'gdrive', name: 'Google Drive', icon: '📁', availability: 'coming_soon', note: 'Per-agent Google OAuth lands in a later stage (CONN-5, desktop-first).' },
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
 * The connector ids that are REAL in v1 — i.e. backed by CONN-1's API. Derived
 * from the groups so there is one source of truth; the parity test asserts this
 * set equals the backend `AGENT_CONNECTORS` catalog.
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
