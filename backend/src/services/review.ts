// Epic P / P1 — Low-trust review mode (pure decision logic).
//
// The biggest safety gap Paperclip's agent-config surface has and we didn't:
// a per-agent TRUST LEVEL and a QUARANTINE REVIEW QUEUE. A `low_trust_review`
// agent is CONTAINED — it may only act inside a bounded set of resources (its
// "boundary set"), and any gated action it attempts is HELD for explicit human
// approve/reject before it can take effect. Fail-closed throughout.
//
// This module is the pure decision core (no IO). The route wires it: on
// `quarantine` it files a `low_trust_review` approval_requests row (reusing the
// existing tri-state approval / recovery-card machinery — NOT a parallel store);
// on `refuse` it logs + drops; on `allow` the action proceeds as normal.
//
// SAFETY INVARIANT — this gate never *replaces* the A2 dangerous-action gate; it
// stacks IN FRONT of it. For the four A2 danger classes, `requiresStepUp` stays
// true so that approving the quarantined case still demands a fresh command
// session, exactly as a direct A2 approval would. A low-trust agent can never be
// a *cheaper* path to a dangerous action than a standard one.

import { isDangerousType, renderActionSummary, type RenderResult } from './dangerous-approvals'

// ─── Trust mode ──────────────────────────────────────────────────────────────

export const TRUST_MODES = ['standard', 'low_trust_review'] as const
export type TrustMode = (typeof TRUST_MODES)[number]

/** Normalize a persisted trust value. Default (and any unknown value) →
 *  `standard`, so existing agents are untouched and a garbled value never
 *  silently *lowers* containment. */
export function parseTrustMode(mode: string | null | undefined): TrustMode {
  return String(mode ?? '').trim().toLowerCase() === 'low_trust_review'
    ? 'low_trust_review'
    : 'standard'
}

export function isLowTrust(mode: string | null | undefined): boolean {
  return parseTrustMode(mode) === 'low_trust_review'
}

// ─── Gated-action taxonomy ───────────────────────────────────────────────────

/** Action classes a low-trust agent may NOT perform without human review. The
 *  first four ARE the A2 dangerous-action taxonomy, reused verbatim (a low-trust
 *  agent's dangerous action is at least as gated as anyone else's); the last
 *  three are Paperclip's low-trust additions — creating agents/skills and
 *  assigning work to others, which a contained agent should never do unattended. */
export const LOW_TRUST_GATED_ACTIONS = [
  'file_destructive',
  'wallet_tx',
  'email_send',
  'machine_exec',
  'agent_create',
  'skill_create',
  'task_assign',
] as const
export type GatedAction = (typeof LOW_TRUST_GATED_ACTIONS)[number]

function normType(t: string | null | undefined): string {
  return String(t ?? '').trim().toLowerCase().replace(/\s+/g, '_')
}

export function isGatedAction(type: string | null | undefined): type is GatedAction {
  return (LOW_TRUST_GATED_ACTIONS as readonly string[]).includes(normType(type))
}

// ─── Boundary set ────────────────────────────────────────────────────────────

export interface TrustBoundary {
  /** project ids the agent may touch */
  projects: string[]
  /** task/issue ids the agent may touch */
  tasks: string[]
  /** agent ids the agent may delegate to / act on */
  agents: string[]
}

const EMPTY_BOUNDARY: TrustBoundary = { projects: [], tasks: [], agents: [] }

/** Parse the per-agent boundary set. Fail-closed: anything unparseable → an
 *  EMPTY boundary. An empty boundary is the MOST restrictive (the agent may
 *  touch nothing), never the most permissive — the opposite of the capability
 *  list, and deliberately so for a containment feature. */
export function parseBoundary(json: string | TrustBoundary | null | undefined): TrustBoundary {
  if (!json) return { ...EMPTY_BOUNDARY }
  let o: any = json
  if (typeof json === 'string') {
    try { o = JSON.parse(json) } catch { return { ...EMPTY_BOUNDARY } }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...EMPTY_BOUNDARY }
  const arr = (v: any): string[] =>
    Array.isArray(v) ? Array.from(new Set(v.map((x) => String(x).trim()).filter(Boolean))) : []
  return { projects: arr(o.projects), tasks: arr(o.tasks), agents: arr(o.agents) }
}

/** Serialize a boundary for persistence (normalized). */
export function serializeBoundary(b: TrustBoundary): string {
  return JSON.stringify(parseBoundary(b))
}

export type ResourceKind = 'project' | 'task' | 'agent'
export interface Resource { kind: ResourceKind; id: string }

/** A resource is in-boundary iff its id appears under the matching kind. An empty
 *  list for a kind means NOTHING of that kind is reachable (fail-closed). */
export function isWithinBoundary(b: TrustBoundary, r: Resource): boolean {
  if (!r || !r.id) return false
  const list = r.kind === 'project' ? b.projects : r.kind === 'task' ? b.tasks : r.kind === 'agent' ? b.agents : null
  return list != null && list.includes(r.id)
}

// ─── Review-card summary rendering (machine-generated, never model prose) ─────

function renderAgentCreate(a: any): RenderResult {
  const name = String(a?.name ?? '').trim() || 'unnamed'
  const role = a?.role ? ` — ${String(a.role).trim()}` : ''
  return { ok: true, summary: `Create agent "${name}"${role}`, warnings: ['A low-trust agent is attempting to create a new agent.'] }
}

function renderSkillCreate(a: any): RenderResult {
  const name = String(a?.name ?? a?.skill ?? '').trim() || 'unnamed'
  return { ok: true, summary: `Create / import skill "${name}"`, warnings: ['A low-trust agent is attempting to add a skill to the company library.'] }
}

function renderTaskAssign(a: any): RenderResult {
  const to = String(a?.targetName ?? a?.to ?? a?.agentId ?? '').trim() || 'an agent'
  const raw = String(a?.task ?? a?.title ?? '').trim()
  const preview = raw ? ` — "${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}"` : ''
  return { ok: true, summary: `Assign task to ${to}${preview}`, warnings: ['A low-trust agent is attempting to assign work to another agent.'] }
}

/** Render the verbatim review-card summary for a gated action from its structured
 *  payload. Fail-SAFE (not fail-closed to a 400 here — the caller has already
 *  decided to quarantine): if a payload is unrenderable we STILL return a summary,
 *  a safe generic line rather than the model's prose, and surface the reason as a
 *  warning. The human always sees a machine-generated description. */
export function renderReviewSummary(action: { type?: string; payload?: any }): RenderResult {
  const t = normType(action?.type)
  if (isDangerousType(t)) {
    const r = renderActionSummary(t, action?.payload)
    if (r.ok) return r
    return { ok: true, summary: `Low-trust ${t} action (details unavailable) — held for review`, warnings: [r.error ?? 'unrenderable payload'] }
  }
  switch (t) {
    case 'agent_create': return renderAgentCreate(action?.payload)
    case 'skill_create': return renderSkillCreate(action?.payload)
    case 'task_assign':  return renderTaskAssign(action?.payload)
    default:             return { ok: true, summary: `Low-trust ${t || 'unknown'} action — held for review` }
  }
}

// ─── The decision ────────────────────────────────────────────────────────────

export type ReviewDecision = 'allow' | 'quarantine' | 'refuse'

export interface LowTrustAction {
  /** action class — one of LOW_TRUST_GATED_ACTIONS, or any safe verb */
  type: string
  /** resources this action touches, checked against the boundary set */
  resources?: Resource[]
  /** structured payload (the A2 `action` shape for danger types) for the card */
  payload?: any
}

export interface LowTrustEvaluation {
  decision: ReviewDecision
  reason: string
  /** When quarantined: does approving the case still require A2 step-up (a fresh
   *  command session)? True for the four dangerous classes — the review gate
   *  never softens the A2 gate. */
  requiresStepUp: boolean
  /** machine-rendered card summary (only on `quarantine`) */
  summary?: string
  warnings?: string[]
}

/** The approval_requests.type the quarantine queue uses. Reuses the existing
 *  tri-state approval machinery + inbox/approvals UI — no parallel store. */
export const REVIEW_CASE_TYPE = 'low_trust_review'

/**
 * Decide what happens to an action a `low_trust_review` agent is attempting.
 *
 *  - **standard-trust agent** → `allow` (this gate is inert; the normal execution
 *    policies + A2 approvals still apply to it elsewhere).
 *  - **boundary escape** (any touched resource outside the boundary set) →
 *    `refuse`. The agent is contained; it cannot reach outside its set.
 *  - **gated action class** (in-boundary) → `quarantine`: held for human
 *    approve/reject before it takes effect.
 *  - **in-boundary, non-gated action** → `allow`.
 *
 * Fail-closed: a missing/malformed action → `refuse`.
 */
export function evaluateLowTrustAction(input: {
  trustMode: string | null | undefined
  boundary: string | TrustBoundary | null | undefined
  action: LowTrustAction | null | undefined
}): LowTrustEvaluation {
  const action = input.action
  if (!action || typeof action !== 'object' || !action.type) {
    return { decision: 'refuse', reason: 'malformed action (no type) — refused (fail-closed)', requiresStepUp: false }
  }

  // Standard-trust agents are unaffected by low-trust containment.
  if (!isLowTrust(input.trustMode)) {
    return { decision: 'allow', reason: 'agent is standard-trust — low-trust review not applicable', requiresStepUp: false }
  }

  const boundary = parseBoundary(input.boundary as any)
  const resources = Array.isArray(action.resources) ? action.resources : []

  // 1. Boundary escape → refuse (the containment wall).
  const escape = resources.find((r) => !isWithinBoundary(boundary, r))
  if (escape) {
    return {
      decision: 'refuse',
      reason: `boundary escape — low-trust agent may not touch ${escape.kind} ${escape.id} (outside its boundary set)`,
      requiresStepUp: false,
    }
  }

  // 2. Gated action → quarantine for human review.
  if (isGatedAction(action.type)) {
    const dangerous = isDangerousType(action.type)
    const rendered = renderReviewSummary(action)
    return {
      decision: 'quarantine',
      reason: `low-trust agent attempted a gated action (${normType(action.type)}) — held for human review before it takes effect`,
      requiresStepUp: dangerous,
      summary: rendered.summary,
      warnings: rendered.warnings ?? [],
    }
  }

  // 3. In-boundary, non-gated action → allowed.
  return { decision: 'allow', reason: 'in-boundary, non-gated action', requiresStepUp: false }
}

// ─── Review-case row (pure; the caller does the DB insert) ───────────────────

/** Build the `approval_requests` row for a quarantined low-trust action. Pure —
 *  the caller (route or orchestrator) supplies id/now and does the insert, so
 *  review.ts stays IO-free and unit-testable. `payload.requiresStepUp` is read
 *  back by the approvals decide route so a quarantined DANGEROUS action still
 *  demands a fresh command session to approve (the review gate never softens A2). */
export function buildReviewCaseRow(input: {
  id: string
  orgId: string
  agentId: string
  action: LowTrustAction
  evaluation: LowTrustEvaluation
  now: Date
}) {
  const { evaluation, action } = input
  return {
    id: input.id,
    orgId: input.orgId,
    type: REVIEW_CASE_TYPE,
    summary: evaluation.summary ?? 'Low-trust action held for review',
    payload: {
      lowTrustReview: true,
      agentId: input.agentId,
      actionType: normType(action.type),
      action: action.payload ?? null,
      resources: Array.isArray(action.resources) ? action.resources : [],
      warnings: evaluation.warnings ?? [],
      requiresStepUp: evaluation.requiresStepUp,
      reason: evaluation.reason,
    } as Record<string, unknown>,
    status: 'pending' as const,
    requestedByAgentId: input.agentId,
    decidedBy: null,
    decidedAt: null,
    createdAt: input.now,
  }
}

// ─── Promotion (queue outcome) ───────────────────────────────────────────────

export type PromotionOutcome = 'promote' | 'discard' | 'revise' | 'pending'

/** Map a tri-state review decision to what happens to the quarantined work.
 *  `approved` → promote (may take effect); `rejected` → discard; else pending. */
export function promotionOutcome(decision: string | null | undefined): PromotionOutcome {
  switch (String(decision ?? '').trim().toLowerCase()) {
    case 'approved':            return 'promote'
    case 'rejected':            return 'discard'
    case 'revision_requested':  return 'revise'
    default:                    return 'pending'
  }
}
