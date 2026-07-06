// MCA-83 W2 — work-surface helpers. Pure projections over existing task state
// that make the queue and its economics legible without a new store:
//   • nextUp / readyQueue — which task the office picks up next (unblocked,
//     highest priority, oldest first), so the board isn't just four buckets.
//   • rollupCost — a parent task's own cost plus its sub-tasks', so a decomposed
//     piece of work shows its true spend instead of just the coordinator's slice.
// Reasoned blocker chips live in `recovery.ts` (they belong to the recovery card).

// ─── next-up / ready queue ──────────────────────────────────────────────────

export interface NUTask {
  id: string
  title?: string | null
  agentId?: string | null
  priority?: string | null
  status?: string | null
  kanbanColumn?: string | null
  blockedBy?: string | null            // JSON array of upstream task ids
  createdAt?: unknown
}

export interface NextUp {
  id: string
  title: string
  agentId: string | null
  priority: string
  blockedCleared: number               // how many upstream blockers already resolved
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(String(d ?? '')) || 0

function parseIdArray(json: string | null | undefined): string[] {
  if (!json) return []
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [] }
  catch { return [] }
}

// A task is "not yet started": waiting in the backlog, not in-flight, done,
// failed, or parked. These are the only candidates to be picked up next.
function isUnstarted(t: NUTask): boolean {
  const col = t.kanbanColumn ?? 'todo'
  const status = t.status ?? 'pending'
  if (status === 'done' || status === 'in_progress' || status === 'failed' || status === 'blocked') return false
  return col === 'todo' || status === 'pending'
}

/**
 * Order the unstarted tasks that are actually workable right now — every
 * upstream blocker resolved (a blocker id we can't find in the set is treated
 * as still open, so we never claim readiness we can't prove). Highest priority
 * first, then oldest, so the head is the single task the office should pick up.
 */
export function readyQueue(tasks: NUTask[]): NextUp[] {
  const done = new Set(tasks.filter((t) => (t.status ?? '') === 'done').map((t) => t.id))
  const ready = tasks
    .filter(isUnstarted)
    .filter((t) => parseIdArray(t.blockedBy).every((id) => done.has(id)))
  return ready
    .slice()
    .sort((a, b) => {
      const pr = (PRIORITY_RANK[a.priority ?? 'medium'] ?? 1) - (PRIORITY_RANK[b.priority ?? 'medium'] ?? 1)
      if (pr !== 0) return pr
      return ms(a.createdAt) - ms(b.createdAt)
    })
    .map((t) => ({
      id: t.id,
      title: t.title ?? '',
      agentId: t.agentId ?? null,
      priority: t.priority ?? 'medium',
      blockedCleared: parseIdArray(t.blockedBy).length,
    }))
}

/** The single next task to pick up, or null when nothing is ready. */
export function nextUp(tasks: NUTask[]): NextUp | null {
  return readyQueue(tasks)[0] ?? null
}

// ─── sub-task cost roll-up ──────────────────────────────────────────────────

export interface CostTask {
  costUsd?: number | null
  tokensUsed?: number | null
}

export interface CostRollup {
  ownCost: number
  subtaskCost: number
  totalCost: number
  ownTokens: number
  subtaskTokens: number
  totalTokens: number
  subtaskCount: number
}

const num = (n: number | null | undefined): number => (typeof n === 'number' && isFinite(n) ? n : 0)

/**
 * Sum a parent task's own spend with its sub-tasks' spend. The parent's
 * `costUsd` only reflects its own run(s); real cost is the whole subtree.
 */
export function rollupCost(own: CostTask | null | undefined, subtasks: CostTask[] = []): CostRollup {
  const ownCost = num(own?.costUsd)
  const ownTokens = num(own?.tokensUsed)
  const subtaskCost = subtasks.reduce((s, t) => s + num(t.costUsd), 0)
  const subtaskTokens = subtasks.reduce((s, t) => s + num(t.tokensUsed), 0)
  return {
    ownCost,
    subtaskCost,
    totalCost: ownCost + subtaskCost,
    ownTokens,
    subtaskTokens,
    totalTokens: ownTokens + subtaskTokens,
    subtaskCount: subtasks.length,
  }
}
