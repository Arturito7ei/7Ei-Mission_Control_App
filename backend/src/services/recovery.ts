// MCA-83 W1 — recovery cards. Pure helper that derives a structured "what
// failed and what to do next" card from a task's existing state (status +
// run history + comments). Surfaces the shipped-but-invisible failure data so
// the operator gets owner / source-run / evidence / next-action in one place,
// open until a human decides (retry, reassign, or resolve).
//
// No new failure store: the card is a projection over tasks/agent_runs/
// task_comments. A "decision" is any state change that moves the task out of
// its failure state (a successful retry → done, or a manual move), so the card
// naturally clears itself — nothing to dismiss.

export type RecoveryReason = 'failed' | 'orphaned' | 'blocked'

export interface RecoveryCard {
  reason: RecoveryReason
  ownerAgentId: string | null   // agent responsible for the task
  sourceRunId: string | null    // the run that failed/stalled (evidence anchor)
  sourceRunStatus: string | null
  evidence: string | null       // failure text: system notice → output → last log
  nextAction: string            // the operator's recommended next step
  since: number | null          // when the failure began (open-until-decision)
  blockerCount: number          // upstream blockers, for reason === 'blocked'
}

interface RTask {
  status?: string | null
  output?: string | null
  agentId?: string | null
  assignedTo?: string | null
  blockedBy?: string | null            // JSON array of upstream task ids
  completedAt?: unknown
}
interface RRun {
  id: string
  status: string
  agentId?: string | null
  logs?: string | null                 // JSON array of { t, msg }
  startedAt?: unknown
  endedAt?: unknown
}
interface RComment {
  body: string
  kind?: string | null
  createdAt?: unknown
}

const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(String(d ?? '')) || 0

function parseIdArray(json: string | null | undefined): string[] {
  if (!json) return []
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [] }
  catch { return [] }
}

function lastLogLine(logs: string | null | undefined): string | null {
  if (!logs) return null
  try {
    const arr = JSON.parse(logs)
    if (!Array.isArray(arr) || arr.length === 0) return null
    const last = arr[arr.length - 1]
    const msg = last && typeof last === 'object' ? last.msg : last
    return typeof msg === 'string' && msg.trim() ? msg.trim() : null
  } catch { return null }
}

const NEXT_ACTION: Record<RecoveryReason, string> = {
  failed: 'Review the evidence, then retry the run or reassign the task.',
  orphaned: 'The agent went silent mid-run. Retry to resume, or reassign to another agent.',
  blocked: 'Waiting on upstream work. Resolve or remove the blocker(s) to continue.',
}

/**
 * Derive the recovery card for a task, or null when nothing needs a decision.
 * `runs` may be in any order; `comments` supplies the durable failure evidence
 * (system-notice comments posted when a run fails).
 */
export function buildRecovery(input: {
  task?: RTask | null
  runs?: RRun[]
  comments?: RComment[]
}): RecoveryCard | null {
  const task = input.task
  if (!task) return null
  // A completed task has been decided — no open recovery.
  if (task.status === 'done') return null

  const runs = (input.runs ?? []).slice().sort((a, b) => ms(b.endedAt ?? b.startedAt) - ms(a.endedAt ?? a.startedAt))
  const failedRun = runs.find((r) => r.status === 'failed' || r.status === 'orphaned') ?? null
  const blockers = parseIdArray(task.blockedBy)

  // Precedence: an actual failed/stalled run beats a dependency wait beats a
  // failure-flagged task with no run detail.
  let reason: RecoveryReason | null = null
  if (failedRun) reason = failedRun.status === 'orphaned' ? 'orphaned' : 'failed'
  else if (blockers.length > 0) reason = 'blocked'
  else if (task.status === 'failed' || task.status === 'blocked') reason = 'failed'
  if (!reason) return null

  const notices = (input.comments ?? [])
    .filter((c) => c.kind === 'system_notice')
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
  const latestNotice = notices[0] ?? null

  const evidence =
    (latestNotice?.body?.trim() || null) ??
    (task.output?.trim() || null) ??
    lastLogLine(failedRun?.logs) ??
    null

  const since = ms(failedRun?.endedAt) || ms(latestNotice?.createdAt) || ms(task.completedAt) || null

  return {
    reason,
    ownerAgentId: task.assignedTo || task.agentId || failedRun?.agentId || null,
    sourceRunId: failedRun?.id ?? null,
    sourceRunStatus: failedRun?.status ?? null,
    evidence: evidence ? evidence.slice(0, 2000) : null,
    nextAction: NEXT_ACTION[reason],
    since,
    blockerCount: blockers.length,
  }
}
