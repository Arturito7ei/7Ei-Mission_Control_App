// Epic AG / AG5 — the Configuration tab's write path.
//
// The existing `PATCH /api/agents/:agentId` takes an UNVALIDATED body straight
// into `db.update` and is not owner-gated. The config surface should not widen
// that hole, so this module defines exactly which fields the tab may write and
// validates them — including `reportsTo`, which feeds the org chart and must
// never form a cycle (an agent that reports to itself, directly or through a
// chain, would make the hierarchy unrenderable and the escalation path circular).
//
// Pure. The route does the I/O.

export const CONFIG_FIELDS = [
  'name', 'title', 'role', 'jobDescription', 'avatarEmoji',
  'reportsTo', 'runtime', 'llmProvider', 'llmModel', 'primaryModel',
] as const

export type ConfigField = (typeof CONFIG_FIELDS)[number]

/** Runtimes the UI may select. Mirrors the `agents.runtime` enum. */
export const RUNTIMES = ['internal', 'openclaw', 'cursor', 'claude_code', 'custom'] as const

export interface AgentNode {
  id: string
  reportsTo?: string | null
}

export type ConfigResult =
  | { ok: true; fields: Partial<Record<ConfigField, string | null>> }
  | { ok: false; error: string }

/**
 * True when making `agentId` report to `managerId` would create a cycle —
 * i.e. `agentId` is already somewhere above `managerId` in the chain (or is
 * `managerId` itself).
 */
export function wouldCycle(agents: AgentNode[], agentId: string, managerId: string): boolean {
  if (agentId === managerId) return true
  const byId = new Map(agents.map(a => [a.id, a]))
  const seen = new Set<string>()
  let cursor: string | null | undefined = managerId
  while (cursor) {
    if (cursor === agentId) return true
    if (seen.has(cursor)) return false // a pre-existing cycle upstream; not ours to fail on
    seen.add(cursor)
    cursor = byId.get(cursor)?.reportsTo ?? null
  }
  return false
}

/**
 * Validate + narrow a Configuration-tab body to the fields it is allowed to write.
 * Unknown keys are ignored (never written). Empty strings on optional fields
 * become null, which is how "unset" is stored.
 */
export function validateConfigPatch(
  body: Record<string, unknown>,
  ctx: { agentId: string; agents: AgentNode[] },
): ConfigResult {
  const fields: Partial<Record<ConfigField, string | null>> = {}

  for (const key of CONFIG_FIELDS) {
    if (!(key in body)) continue
    const raw: unknown = body[key]
    if (raw !== null && typeof raw !== 'string') return { ok: false, error: `${key} must be a string` }
    const value: string | null = raw === null ? null : (raw as string).trim()

    switch (key) {
      case 'name':
        if (!value) return { ok: false, error: 'Name is required.' }
        if (value.length > 100) return { ok: false, error: 'Name must be 100 characters or fewer.' }
        fields.name = value
        break
      case 'role':
        if (!value) return { ok: false, error: 'Role is required.' }
        if (value.length > 200) return { ok: false, error: 'Role must be 200 characters or fewer.' }
        fields.role = value
        break
      case 'title':
        fields.title = value || null
        break
      case 'jobDescription':
        if (value && value.length > 4000) return { ok: false, error: 'Description must be 4000 characters or fewer.' }
        fields.jobDescription = value || null
        break
      case 'avatarEmoji':
        // An emoji, not an essay — this is the fallback icon when there's no picture.
        if (value && [...value].length > 4) return { ok: false, error: 'Icon must be a single emoji.' }
        fields.avatarEmoji = value || null
        break
      case 'runtime':
        if (value && !(RUNTIMES as readonly string[]).includes(value)) {
          return { ok: false, error: `Unknown adapter "${value}".` }
        }
        if (value) fields.runtime = value
        break
      case 'reportsTo': {
        if (!value) { fields.reportsTo = null; break } // "reports to nobody" is valid (a root)
        if (!ctx.agents.some(a => a.id === value)) return { ok: false, error: 'That manager is not an agent in this organisation.' }
        if (wouldCycle(ctx.agents, ctx.agentId, value)) {
          return { ok: false, error: 'That would create a reporting loop — an agent cannot end up reporting to itself.' }
        }
        fields.reportsTo = value
        break
      }
      default:
        // llmProvider / llmModel / primaryModel — free-form (the model catalogue
        // is data-driven and orgs can add custom models), only length-bounded.
        if (value && value.length > 200) return { ok: false, error: `${key} must be 200 characters or fewer.` }
        fields[key] = value || null
    }
  }

  if (Object.keys(fields).length === 0) return { ok: false, error: 'No editable fields in the request.' }
  return { ok: true, fields }
}
