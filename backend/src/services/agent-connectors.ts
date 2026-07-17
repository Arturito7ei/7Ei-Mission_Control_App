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
}

/**
 * The agent-connector catalog. CONN-1 ships ONE config-only connector end-to-end —
 * a custom MCP server — because it exercises the whole path (NON-secret config write,
 * agent-scoped secret write, masked read, test, delete) WITHOUT needing OAuth.
 * GitHub (PAT) / Jira (basic) / Telegram (token) land in later stages (CONN-4/CONN-6);
 * they are intentionally NOT in the catalog yet so no half-built connector is
 * reachable. Validate every inbound `connectorId` against this list.
 */
export const AGENT_CONNECTORS: AgentConnectorMeta[] = [
  {
    id: 'mcp',
    name: 'Custom MCP Server',
    category: 'Custom',
    authType: 'config',
    icon: '🧩',
    docsUrl: 'https://modelcontextprotocol.io',
    hasSecret: true, // optional bearer/api-key for the server, stored agent-scoped
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
})
  .strict()
  .refine(c => c.transport !== 'http' || !!c.url, { message: 'http transport requires a url', path: ['url'] })
  .refine(c => c.transport !== 'stdio' || !!c.command, { message: 'stdio transport requires a command', path: ['command'] })

const CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  mcp: McpConfigSchema,
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
 *  (agent) already isolate it per agent, so the key need not embed the agent id. */
export function connectorSecretKey(connectorId: string): string {
  return `CONNECTOR_${connectorId.toUpperCase()}_SECRET`
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
