// Unified inbox (MCA-PC A3). Pure aggregation of tasks that need a human's
// attention, minus per-user dismissals.

export interface InboxTask {
  id: string
  title: string
  status: string
  inboxState?: string | null
  priority?: string | null
  agentId: string
  output?: string | null        // MCA-84 V2: last output — the inline error on a failed row
  createdAt: Date | number | null
}

export type InboxKind = 'blocked' | 'failed' | 'review' | 'attention'

export interface InboxItem {
  taskId: string
  title: string
  kind: InboxKind
  priority: string
  agentId: string
  createdAt: number
  retryable: boolean            // MCA-84 V2: failed tasks can be re-executed inline
  error: string | null          // MCA-84 V2: truncated failure text for the row
}

/** Classify a task into an inbox kind, or null if it doesn't need attention. */
export function inboxKind(t: InboxTask): InboxKind | null {
  if (t.status === 'blocked') return 'blocked'
  if (t.status === 'failed') return 'failed'
  if (t.inboxState === 'awaiting_review') return 'review'
  if (t.inboxState === 'needs_attention') return 'attention'
  return null
}

const KIND_RANK: Record<InboxKind, number> = { blocked: 0, failed: 1, review: 2, attention: 3 }

/** Build the inbox: attention-worthy tasks minus dismissals, ranked by kind then recency. */
export function buildInbox(tasks: InboxTask[], dismissed: Set<string> = new Set()): InboxItem[] {
  const items: InboxItem[] = []
  for (const t of tasks) {
    if (dismissed.has(t.id)) continue
    const kind = inboxKind(t)
    if (!kind) continue
    const ts = t.createdAt instanceof Date ? t.createdAt.getTime() : Number(t.createdAt ?? 0)
    // V2: a failed task can be retried in place; carry its output as inline error.
    const retryable = kind === 'failed'
    const error = kind === 'failed' && t.output?.trim() ? t.output.trim().slice(0, 240) : null
    items.push({ taskId: t.id, title: t.title, kind, priority: t.priority ?? 'medium', agentId: t.agentId, createdAt: ts, retryable, error })
  }
  items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.createdAt - a.createdAt)
  return items
}
