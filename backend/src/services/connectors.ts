// Connector registry + pure helpers for the Connectors tab.
// Credentials for token/basic connectors live in the D4 secret store (encrypted);
// Google connectors ride on the shared oauth_tokens 'google' row.

export type AuthType = 'token' | 'basic' | 'oauth'

export interface ConnectorMeta {
  id: string
  name: string
  category: 'Dev' | 'Google' | 'Project' | 'AI' | 'Memory'
  authType: AuthType
  icon: string
  docsUrl: string
  secretKey?: string      // token connectors: where the credential is stored
  accountKey?: string     // token connectors: where the resolved account label is cached
  provider?: string       // oauth connectors: oauth_tokens.provider
  fields?: string[]       // basic connectors: form fields
}

export const CONNECTORS: ConnectorMeta[] = [
  { id: 'jira', name: 'Atlassian Jira', category: 'Project', authType: 'basic', icon: '🔷',
    docsUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    fields: ['domain', 'email', 'apiToken', 'defaultProjectKey'] },
  { id: 'github', name: 'GitHub', category: 'Dev', authType: 'token', icon: '🐙',
    docsUrl: 'https://github.com/settings/tokens', secretKey: 'GITHUB_TOKEN', accountKey: 'GITHUB_ACCOUNT' },
  { id: 'gmail', name: 'Gmail', category: 'Google', authType: 'oauth', icon: '✉️',
    docsUrl: 'https://mail.google.com', provider: 'google' },
  { id: 'gcal', name: 'Google Calendar', category: 'Google', authType: 'oauth', icon: '📅',
    docsUrl: 'https://calendar.google.com', provider: 'google' },
  { id: 'gdrive', name: 'Google Drive', category: 'Google', authType: 'oauth', icon: '📁',
    docsUrl: 'https://drive.google.com', provider: 'google' },
  { id: 'huggingface', name: 'Hugging Face', category: 'AI', authType: 'token', icon: '🤗',
    docsUrl: 'https://huggingface.co/settings/tokens', secretKey: 'HUGGINGFACE_TOKEN', accountKey: 'HUGGINGFACE_ACCOUNT' },
  { id: 'obsidian', name: 'Obsidian Vault (shared memory)', category: 'Memory', authType: 'basic', icon: '🪨',
    docsUrl: 'https://github.com/settings/tokens', fields: ['repo', 'root', 'branch', 'token'] },
]

export const GOOGLE_MEMBERS = CONNECTORS.filter(c => c.provider === 'google').map(c => c.id)

// ─── Google connector config (MCA-81) ───────────────────────────────────────
// Per-connector config stored as a company-scope secret (config-as-secret,
// same pattern as VAULT_CONFIG) — no schema change. Defaults: everything on,
// primary calendar, whole Drive.

export const GOOGLE_CONNECTOR_CONFIG_KEY = 'GOOGLE_CONNECTOR_CONFIG'

export type GoogleService = 'gmail' | 'calendar' | 'drive'

/** Connector id → config service key for the Google trio. */
export const GOOGLE_SERVICE_BY_ID: Record<string, GoogleService> = {
  gmail: 'gmail', gcal: 'calendar', gdrive: 'drive',
}

export interface GoogleConnectorConfig {
  services: Record<GoogleService, boolean>
  calendarId: string
  driveScope: 'all' | 'folder'
  driveFolderId?: string
}

export function defaultGoogleConnectorConfig(): GoogleConnectorConfig {
  return { services: { gmail: true, calendar: true, drive: true }, calendarId: 'primary', driveScope: 'all' }
}

/** Merge a stored GOOGLE_CONNECTOR_CONFIG JSON blob with defaults (parseVaultConfig pattern). */
export function parseGoogleConnectorConfig(json: string | null | undefined): GoogleConnectorConfig {
  const d = defaultGoogleConnectorConfig()
  if (!json) return d
  try {
    const o = JSON.parse(json)
    const svc = (o?.services ?? {}) as Record<string, unknown>
    const folderId = typeof o?.driveFolderId === 'string' ? o.driveFolderId.trim() : ''
    return {
      services: {
        gmail: typeof svc.gmail === 'boolean' ? svc.gmail : d.services.gmail,
        calendar: typeof svc.calendar === 'boolean' ? svc.calendar : d.services.calendar,
        drive: typeof svc.drive === 'boolean' ? svc.drive : d.services.drive,
      },
      calendarId: (typeof o?.calendarId === 'string' && o.calendarId.trim()) || d.calendarId,
      driveScope: o?.driveScope === 'folder' ? 'folder' : d.driveScope,
      ...(folderId ? { driveFolderId: folderId } : {}),
    }
  } catch { return d }
}

export interface GoogleConnectorConfigPatch {
  services?: Partial<Record<GoogleService, boolean>>
  calendarId?: string
  driveScope?: 'all' | 'folder'
  driveFolderId?: string
}

/** Apply a validated PUT patch over the current config (pure — routes persist). */
export function mergeGoogleConnectorConfig(
  current: GoogleConnectorConfig, patch: GoogleConnectorConfigPatch,
): GoogleConnectorConfig {
  const folderId = patch.driveFolderId !== undefined
    ? (patch.driveFolderId.trim() || undefined)
    : current.driveFolderId
  return {
    services: { ...current.services, ...(patch.services ?? {}) },
    calendarId: (patch.calendarId?.trim() || current.calendarId),
    driveScope: patch.driveScope ?? current.driveScope,
    ...(folderId ? { driveFolderId: folderId } : {}),
  }
}

export function getConnector(id: string): ConnectorMeta | undefined {
  return CONNECTORS.find(c => c.id === id)
}

// Build the live validation request for a token connector.
export function tokenTestRequest(id: string, token: string): { url: string; headers: Record<string, string> } | null {
  const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'User-Agent': '7ei-mc', Accept: 'application/json' })
  if (id === 'github') return { url: 'https://api.github.com/user', headers: h(token) }
  if (id === 'huggingface') return { url: 'https://huggingface.co/api/whoami-v2', headers: h(token) }
  return null
}

// Extract a human account label from a validation response.
export function parseAccount(id: string, json: any): string {
  if (!json || typeof json !== 'object') return ''
  if (id === 'github') return String(json.login ?? json.name ?? '')
  if (id === 'huggingface') return String(json.name ?? json.fullname ?? '')
  return ''
}

export interface ConnectorStatus {
  id: string; name: string; category: string; authType: AuthType; icon: string; docsUrl: string
  fields: string[]; connected: boolean; detail: string | null
}

// Compose a status row from resolved inputs (pure — no IO).
export function buildStatus(
  meta: ConnectorMeta,
  opts: { connected: boolean; detail?: string | null },
): ConnectorStatus {
  return {
    id: meta.id, name: meta.name, category: meta.category, authType: meta.authType,
    icon: meta.icon, docsUrl: meta.docsUrl, fields: meta.fields ?? [],
    connected: opts.connected, detail: opts.detail ?? null,
  }
}
