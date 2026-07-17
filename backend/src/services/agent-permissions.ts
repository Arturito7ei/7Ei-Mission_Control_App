// MCA-GOV2 S4.2 — validation for per-agent permission capabilities.
//
// The WRITE route (`PUT /api/orgs/:orgId/agents/:agentId/permissions`) is
// owner-gated; this module bounds *what* an owner may write. Before this existed
// the route took `body.permissions` straight into `db.update()` after a bare
// `.map(String)`, so any array of arbitrary strings became an agent's caps.
//
// The vocabulary is NOT a closed enum but a small namespaced grammar, derived
// from where capabilities are actually ENFORCED at runtime:
//   - `routes/agent-api.ts` checks `memory:write` (ns `memory`) and
//     `attachment:write` (ns `attachment`) via `governance2.isCapabilityAllowed`.
//   - `services/code-executor.ts` gates the host-exec path on the bare
//     `machine_exec` capability (`MACHINE_EXEC_CAPABILITY`).
//   - `governance2.isCapabilityAllowed` grants on an exact match, a `<ns>:*`
//     namespace wildcard, or the global `*`.
// So a capability is valid iff it is `*`, a known bare cap, or `<known-ns>:<action|*>`.
//
// Keeping this the single source of truth means a new `<ns>:<action>` check that
// lands in the runtime is one array entry away from being writable here — and an
// UNKNOWN namespace/word is rejected with a clean 400 rather than silently
// persisted as an inert (and confusing) cap.

import { MACHINE_EXEC_CAPABILITY } from './code-executor'

/** Namespaces whose `<ns>:<action>` caps are enforced somewhere in the system.
 *  Extend here (and add the runtime check) when a new namespace is introduced. */
export const AGENT_CAP_NAMESPACES = ['memory', 'attachment', 'connector'] as const

/** Capabilities that carry no namespace segment (a single bare token). */
export const AGENT_BARE_CAPS = [MACHINE_EXEC_CAPABILITY] as const

/** The global allow-all wildcard (equivalent to an empty list, but explicit). */
export const ALLOW_ALL_CAP = '*'

export const MAX_AGENT_CAPS = 100
export const MAX_CAP_LEN = 64

const NAMESPACES = new Set<string>(AGENT_CAP_NAMESPACES)
const BARE = new Set<string>(AGENT_BARE_CAPS)
// A single action segment: lower-case slug or the `*` wildcard.
const ACTION_RE = /^[a-z0-9_-]+$/

/** Is a single (already-trimmed, non-empty) capability string from the vocabulary? */
export function isValidCapability(cap: string): boolean {
  if (cap === ALLOW_ALL_CAP) return true
  if (BARE.has(cap)) return true
  const parts = cap.split(':')
  if (parts.length !== 2) return false // exactly one `<ns>:<action>` colon
  const [ns, action] = parts
  if (!NAMESPACES.has(ns)) return false
  return action === '*' || ACTION_RE.test(action)
}

export type PermissionsResult =
  | { ok: true; caps: string[] }
  | { ok: false; error: string }

/**
 * Validate + normalise a permissions write body's `permissions` field into the
 * caps to persist. Semantics of the stored value are UNCHANGED — this only
 * governs which inputs are accepted:
 *
 *  - absent / null → allow-all (empty array), the documented legacy default.
 *  - present but not an array → 400.
 *  - each entry: a string ≤ MAX_CAP_LEN from the known vocabulary; blanks are
 *    dropped (a trailing comma in the web's field yields '').
 *  - deduped; the array length is capped at MAX_AGENT_CAPS.
 *
 * An empty result array (`[]`) is preserved verbatim: `isCapabilityAllowed`
 * treats null/empty as allow-all, so clearing the field keeps allow-all exactly.
 */
export function validatePermissions(raw: unknown): PermissionsResult {
  if (raw === undefined || raw === null) return { ok: true, caps: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'permissions must be an array of capability strings' }
  if (raw.length > MAX_AGENT_CAPS) return { ok: false, error: `too many capabilities (max ${MAX_AGENT_CAPS})` }

  const caps: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, error: 'each capability must be a string' }
    const cap = entry.trim()
    if (!cap) continue // ignore blanks (empty allow-all is expressed by an empty array)
    if (cap.length > MAX_CAP_LEN) return { ok: false, error: `capability too long (max ${MAX_CAP_LEN}): ${cap.slice(0, 24)}…` }
    if (!isValidCapability(cap)) return { ok: false, error: `unknown capability: ${cap}` }
    if (!seen.has(cap)) { seen.add(cap); caps.push(cap) }
  }
  return { ok: true, caps }
}
