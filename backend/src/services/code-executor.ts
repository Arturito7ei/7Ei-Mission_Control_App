// Epic CC / CC3 — secure-by-default registration for code-executor runtimes.
//
// A `claude_code` agent runs a coding agent that can (eventually) execute
// commands on a host. Registering it allow-all / standard-trust — the current
// default for external agents — is a footgun: `permissions == null/[]` means
// allow-all (`governance2.isCapabilityAllowed`), and `trust_mode` defaults to
// `standard`. This module computes the SECURE defaults a code executor must be
// created with, so containment is on from the first heartbeat:
//
//   * trust_mode = 'low_trust_review'  (gated actions quarantined for review)
//   * an EXPLICIT, non-empty capability list (never allow-all)
//   * a trust_boundary seeded from the target workspace/project (empty = most
//     restrictive — the low-trust boundary is fail-closed, unlike capabilities)
//
// Pure decision logic; the routes do the DB insert. Non-code runtimes keep their
// legacy defaults unless the caller passes explicit values (no regression).

import { parseTrustMode, parseBoundary, serializeBoundary, type TrustBoundary } from './review'

/** The capability that gates host command execution (the machine_exec / exec path). */
export const MACHINE_EXEC_CAPABILITY = 'machine_exec'

/** External runtimes that execute code/commands on a host → secure-by-default. */
export const CODE_EXECUTOR_RUNTIMES = ['claude_code'] as const

export function isCodeExecutorRuntime(runtime: string | null | undefined): boolean {
  return (CODE_EXECUTOR_RUNTIMES as readonly string[]).includes(String(runtime ?? '').trim())
}

/** The explicit (never allow-all) capability list a code executor is created
 *  with: exactly what the adapter legitimately uses — vault/session memory,
 *  work-product attachments — plus the machine_exec capability for the
 *  approval-gated exec path. An empty list would be allow-all; that's the footgun. */
export const CODE_EXECUTOR_DEFAULT_PERMISSIONS: string[] = [
  'memory:write',
  'attachment:write',
  MACHINE_EXEC_CAPABILITY,
]

export interface SecureRegistration {
  /** persisted `trust_mode` */
  trustMode: string
  /** persisted `permissions` (JSON string), or null to keep legacy allow-all */
  permissions: string | null
  /** persisted `trust_boundary` (JSON string), or null when none applies */
  trustBoundary: string | null
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs.map((x) => String(x).trim()).filter(Boolean)))
}

/**
 * Compute the secure-by-default registration fields for an external agent.
 *
 *  - **code executor (claude_code)** → `low_trust_review` + the explicit default
 *    capability list (unless the caller supplied one) + a boundary seeded from
 *    the given workspace/project (empty when none — most restrictive).
 *  - **any runtime, explicit values** → the caller's `permissions`/`trustMode`/
 *    `trustBoundary` always win (an operator can widen or narrow deliberately).
 *  - **non-code runtime, no explicit values** → legacy behavior: `permissions`
 *    stays null (allow-all), `trust_mode` standard, `trust_boundary` null.
 */
export function secureRegistration(input: {
  runtime: string
  permissions?: string[] | null
  trustMode?: string | null
  trustBoundary?: TrustBoundary | string | null
  workspaceId?: string | null
  projectId?: string | null
}): SecureRegistration {
  const code = isCodeExecutorRuntime(input.runtime)

  // ── capabilities ──
  let permissions: string | null
  if (Array.isArray(input.permissions) && input.permissions.length > 0) {
    permissions = JSON.stringify(dedupe(input.permissions))
  } else if (code) {
    permissions = JSON.stringify([...CODE_EXECUTOR_DEFAULT_PERMISSIONS])
  } else {
    permissions = null // legacy allow-all for non-code runtimes (unchanged)
  }

  // ── trust mode ──
  const trustMode = input.trustMode
    ? parseTrustMode(input.trustMode)
    : code
      ? 'low_trust_review'
      : 'standard'

  // ── boundary ──
  const seededProjects = input.projectId ? [input.projectId] : []
  const seededTasks: string[] = []
  const boundary: TrustBoundary = input.trustBoundary
    ? parseBoundary(input.trustBoundary as any)
    : { projects: seededProjects, tasks: seededTasks, agents: [] }
  // Persist a boundary for a code executor (even empty → explicit containment),
  // or whenever the caller/seed supplied one; otherwise null (legacy).
  const hasSeed = !!input.trustBoundary || !!input.projectId
  const trustBoundary = code || hasSeed ? serializeBoundary(boundary) : null

  return { trustMode, permissions, trustBoundary }
}
