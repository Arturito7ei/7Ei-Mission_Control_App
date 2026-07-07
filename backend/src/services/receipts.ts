// MCA-84 V2 — board read receipts. Pure helpers that decide whether a task is
// "unread" for a given operator: they've never opened it, or its state changed
// (a run finished/failed) after they last looked. Lets the board flag cards
// with new activity instead of making the operator re-read the whole board.
//
// No per-event tracking: tasks carry no generic updatedAt, so we use the best
// available activity signal — the latest of createdAt and completedAt (which is
// bumped whenever a run terminates the task). A receipt is one (user, task) row
// with seenAt; unread when activityAt > seenAt, or no receipt exists.

const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(String(d ?? '')) || 0

export interface ReadTask {
  id: string
  createdAt?: unknown
  completedAt?: unknown
}

export interface Receipt {
  taskId: string
  seenAt: unknown
}

/** Latest activity timestamp for a task (ms) — max(createdAt, completedAt). */
export function taskActivityAt(task: ReadTask): number {
  return Math.max(ms(task.createdAt), ms(task.completedAt))
}

/** True when the task has activity the operator hasn't seen (or never opened). */
export function isUnread(task: ReadTask, seenAt: unknown | null | undefined): boolean {
  if (seenAt == null) return true
  return taskActivityAt(task) > ms(seenAt)
}

/** The set of task ids that are unread for this operator, given their receipts. */
export function unreadTaskIds(tasks: ReadTask[], receipts: Receipt[]): Set<string> {
  const seen = new Map<string, number>()
  for (const r of receipts) seen.set(r.taskId, ms(r.seenAt))
  const out = new Set<string>()
  for (const t of tasks) {
    if (isUnread(t, seen.has(t.id) ? seen.get(t.id)! : null)) out.add(t.id)
  }
  return out
}
