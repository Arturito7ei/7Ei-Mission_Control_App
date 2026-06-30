// Plugin registry (MCA-PC D2). A thin core with rich edges: plugins declare a
// manifest with capability-gated permissions and exposed tools. This MVP is the
// registry + manifest validation + capability gating; out-of-process workers
// are future work.

// Capabilities a plugin may request. Anything outside this set is rejected.
export const ALLOWED_CAPABILITIES = [
  'read:tasks', 'write:tasks', 'read:agents', 'read:knowledge', 'write:knowledge',
  'read:goals', 'notify', 'http:outbound', 'schedule',
] as const
export type Capability = (typeof ALLOWED_CAPABILITIES)[number]

export interface PluginManifest {
  name: string
  version: string
  description?: string
  capabilities?: string[]
  tools?: { name: string; description?: string }[]
}

export interface ValidationResult { ok: boolean; errors: string[] }

/** Validate a plugin manifest. Returns all problems (empty = valid). */
export function validateManifest(m: any): ValidationResult {
  const errors: string[] = []
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest must be an object'] }
  if (!m.name || typeof m.name !== 'string') errors.push('name is required')
  else if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(m.name)) errors.push('name must be kebab-case (a-z, 0-9, -)')
  if (!m.version || typeof m.version !== 'string') errors.push('version is required')
  if (m.capabilities != null) {
    if (!Array.isArray(m.capabilities)) errors.push('capabilities must be an array')
    else for (const c of m.capabilities) if (!(ALLOWED_CAPABILITIES as readonly string[]).includes(c)) errors.push(`unknown capability: ${c}`)
  }
  if (m.tools != null) {
    if (!Array.isArray(m.tools)) errors.push('tools must be an array')
    else m.tools.forEach((t: any, i: number) => { if (!t?.name || typeof t.name !== 'string') errors.push(`tools[${i}].name is required`) })
  }
  return { ok: errors.length === 0, errors }
}

/** The capabilities actually granted (validated subset of allowed). */
export function grantedCapabilities(m: PluginManifest): Capability[] {
  return ((m.capabilities ?? []) as string[]).filter(c => (ALLOWED_CAPABILITIES as readonly string[]).includes(c)) as Capability[]
}

/** Names of tools a plugin exposes. */
export function exposedTools(m: PluginManifest): string[] {
  return (m.tools ?? []).map(t => t.name).filter(Boolean)
}
