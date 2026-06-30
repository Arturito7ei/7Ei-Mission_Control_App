// Unified inbox (MCA-PC A3). Pure aggregation of tasks that need a human's
// attention, minus per-user dismissals.

export interface InboxTask {
  id: string
  title: string
  status: string
  inboxState?: string | null
  priority?: string | null
  agentId: string
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
    items.push({ taskId: t.id, title: t.title, kind, priority: t.priority ?? 'medium', agentId: t.agentId, createdAt: ts })
  }
  items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.createdAt - a.createdAt)
  return items
}
