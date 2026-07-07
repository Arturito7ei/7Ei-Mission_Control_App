// MCA-83 W3 — task thread with wake-on-comment. Pure helpers that decide whether
// a freshly-posted human comment on a task should "wake" the assigned agent
// (re-run it with the comment as a follow-up) and that project the prior comment
// thread into the conversationHistory the executor replays. Paperclip parity:
// commenting on a stalled/failed/blocked/finished ticket picks the work back up —
// the async office loop, closed. No new store: the thread IS task_comments and the
// wake reuses executeAgentTask, which owns every task/run state transition.

export interface WakeComment {
  id?: string
  authorAgentId?: string | null
  kind?: string | null
  body?: string | null
  createdAt?: unknown
}
export interface WakeRun { status?: string | null }

// A comment can only wake an idle agent. `in_progress` is deliberately excluded:
// internal agents don't write a run row, so it's the one status where the agent is
// actively working and `activeRun` can't prove it — waking would double-fire. A
// genuinely stalled in_progress task is normalized back to `pending` (wakeable) by
// the heartbeat orphan-recovery sweep. `done` reopens the ticket (Paperclip parity).
export const WAKEABLE_STATUSES = new Set(['pending', 'assigned', 'blocked', 'failed', 'done'])
export function isWakeableStatus(status?: string | null): boolean {
  return WAKEABLE_STATUSES.has(String(status ?? ''))
}

// A run currently in flight means the agent is already on it — never double-fire.
export function hasActiveRun(runs?: WakeRun[] | null): boolean {
  return (runs ?? []).some((r) => r.status === 'running')
}

export interface WakeDecision { wake: boolean; reason: string }

/**
 * Decide whether a freshly-posted comment should wake the assigned agent.
 * `requested` lets the caller force (true) or suppress (false) the default,
 * status-driven decision. A user comment on a non-running task that has an agent
 * wakes it; an in-flight run, a missing agent, an explicit opt-out, or an
 * agent-authored comment never does (the last guards an agent waking itself into a
 * loop). The active-run gate is checked before `requested === true`, so even a
 * forced wake can't double-fire onto a running task.
 */
export function decideWake(input: {
  status?: string | null
  hasAgent: boolean
  activeRun: boolean
  authorIsUser: boolean
  requested?: boolean
}): WakeDecision {
  const { status, hasAgent, activeRun, authorIsUser, requested } = input
  if (!authorIsUser) return { wake: false, reason: 'author-not-user' }
  if (!hasAgent) return { wake: false, reason: 'no-agent' }
  if (activeRun) return { wake: false, reason: 'already-running' }
  if (requested === false) return { wake: false, reason: 'suppressed' }
  if (requested === true) return { wake: true, reason: 'requested' }
  return isWakeableStatus(status)
    ? { wake: true, reason: `status:${status}` }
    : { wake: false, reason: `status-not-wakeable:${status}` }
}

const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(String(d ?? '')) || 0

/**
 * Project the prior comment thread into the conversationHistory the executor
 * replays before the new instruction. Agent comments become assistant turns; user
 * and system-notice comments become user turns (a system notice is context the
 * agent should re-read — "your last run failed because…"). Oldest-first, capped and
 * truncated so a long thread can't blow the prompt.
 */
export function threadHistory(
  comments: WakeComment[],
  opts: { max?: number; maxLen?: number } = {},
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const max = opts.max ?? 20
  const maxLen = opts.maxLen ?? 2000
  return (comments ?? [])
    .filter((c) => typeof c.body === 'string' && c.body.trim())
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
    .slice(-max)
    .map((c) => {
      const body = String(c.body).trim().slice(0, maxLen)
      if (c.authorAgentId) return { role: 'assistant' as const, content: body }
      if (c.kind === 'system_notice') return { role: 'user' as const, content: `[system] ${body}` }
      return { role: 'user' as const, content: body }
    })
}

/** Frame the waking comment as a follow-up instruction for the re-run. */
export function buildWakeInput(taskTitle: string, commentBody: string): string {
  return `New comment on task "${taskTitle}":\n\n${String(commentBody).trim()}\n\nAddress this comment and continue the task.`
}
