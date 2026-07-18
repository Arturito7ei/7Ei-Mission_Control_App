// ACT-1 — the desk's copy of the activity-feed vocabulary.
//
// HAND-COPIED from backend/src/services/activity.ts (ACTIVITY_KINDS / ACTIVITY_OUTCOMES
// / OWNER_ONLY_KINDS). Metro can't import backend source and the browser bundle won't
// either, so this is a copy — pinned by a drift tripwire that reads the backend source
// as TEXT and asserts EQUALITY, not subset: apps/mobile/src/activityKinds.test.ts.
//
// KEEP THIS FILE IMPORT-FREE. The mobile parity test imports it directly, and Mobile CI
// installs ONLY apps/mobile's dependencies — a single import here would drag in web's
// node_modules and SILENTLY DROP that entire test file in CI while it still passed
// locally. (Same rule, same reason, as web/lib/dangerousApprovals.ts. It is asserted,
// not merely requested: the tripwire greps this file for an import statement.)

export const ACTIVITY_KINDS = [
  'approval_filed',
  'approval_decided',
  'connector_execution',
  'agent_run',
  'task',
  'audit_event',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const ACTIVITY_OUTCOMES = ['pending', 'running', 'ok', 'failed', 'rejected', 'info'] as const
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number]

/** Kinds the server drops for a non-owner. The client uses this only to EXPLAIN the
 *  absence ("owner-only") — never to decide access. The server decides. */
export const OWNER_ONLY_KINDS: readonly ActivityKind[] = ['connector_execution', 'audit_event']

/** One row of the feed — mirrors `ActivityEvent` in backend/src/services/activity.ts. */
export interface ActivityEvent {
  id: string
  kind: ActivityKind
  at: number
  title: string
  outcome: ActivityOutcome
  agentId: string | null
  agentName: string | null
  target: string | null
  error: string | null
}

/** Human labels for the filter chips and row badges. Display-only, so these are NOT
 *  parity-pinned to the backend — only the KEYS above are. */
export const KIND_LABEL: Record<ActivityKind, string> = {
  approval_filed: 'Approval filed',
  approval_decided: 'Decision',
  connector_execution: 'Connector',
  agent_run: 'Agent run',
  task: 'Task',
  audit_event: 'Audit',
}

export const KIND_GLYPH: Record<ActivityKind, string> = {
  approval_filed: '🛡',
  approval_decided: '⚖',
  connector_execution: '🔌',
  agent_run: '▶',
  task: '📋',
  audit_event: '📜',
}

export const OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  pending: 'Awaiting decision',
  running: 'Running',
  ok: 'OK',
  failed: 'Failed',
  rejected: 'Refused',
  info: 'Logged',
}

// NOTE: there is deliberately no OUTCOME_TONE here. Colour tone is the ONE piece of
// this vocabulary that is genuinely surface-specific — the web's Pill takes
// 'ok'|'fail'|'warn'|'muted', the phone's Chip takes 'ok'|'warn'|'danger' — so a shared
// tone map would have to invent a third vocabulary that neither surface actually uses,
// and would drift from both. Each surface maps outcome to its own tone locally; what
// must be identical (the kinds, the outcomes, the owner-only set, the copy) is here.

export function isActivityKind(v: unknown): v is ActivityKind {
  return typeof v === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(v)
}

/** Relative age, in the phone's idiom, shared so both surfaces read identically. */
export function activityAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

/** Build the activity-feed query string. SHARED so the desk and the phone provably hit
 *  the endpoint the same way — same param names, same clamp, same "all means omit"
 *  rule. A divergence here is the classic parity bug: two surfaces that look identical
 *  but silently ask different questions. Pinned by activityKinds.test.ts. */
export function activityQuery(input: {
  kind?: ActivityKind | 'all' | null
  agentId?: string | null
  cursor?: string | null
  limit?: number
}): string {
  const parts: string[] = ['limit=' + String(Math.min(Math.max(input.limit ?? 40, 1), 100))]
  if (input.kind && input.kind !== 'all' && isActivityKind(input.kind)) parts.push('kind=' + encodeURIComponent(input.kind))
  if (input.agentId && input.agentId !== 'all') parts.push('agentId=' + encodeURIComponent(input.agentId))
  if (input.cursor) parts.push('cursor=' + encodeURIComponent(input.cursor))
  return parts.join('&')
}
