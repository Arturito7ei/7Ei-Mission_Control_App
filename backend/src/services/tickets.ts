// MCA-WORK Phase 3 — pure helpers for labels, attachment kinds, and the unified
// ticket timeline (comments + runs + attachments + lifecycle → one sorted feed).

export function parseLabels(json: string | null | undefined): string[] {
  if (!json) return []
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [] }
  catch { return [] }
}

const KINDS = ['link', 'file', 'work_product']
export function normalizeAttachmentKind(kind: string | null | undefined): string {
  const k = String(kind ?? 'link')
  return KINDS.includes(k) ? k : 'link'
}

const ms = (d: any): number =>
  d instanceof Date ? d.getTime() : (typeof d === 'number' ? d : (Date.parse(d) || 0))

export interface TimelineItem { kind: string; at: number; by?: string | null; text?: string; ref?: string }

export function buildTimeline(input: {
  task?: { createdAt?: any; completedAt?: any; status?: string } | null
  comments?: Array<{ body: string; authorAgentId?: string | null; authorUser?: string | null; createdAt: any }>
  runs?: Array<{ id: string; status: string; startedAt: any; endedAt?: any; agentId?: string | null }>
  attachments?: Array<{ name: string; kind: string; url?: string | null; createdAt: any }>
}): TimelineItem[] {
  const items: TimelineItem[] = []
  if (input.task?.createdAt) items.push({ kind: 'created', at: ms(input.task.createdAt), text: 'task created' })
  for (const c of input.comments ?? []) items.push({ kind: 'comment', at: ms(c.createdAt), by: c.authorAgentId ?? c.authorUser ?? null, text: c.body })
  for (const r of input.runs ?? []) {
    items.push({ kind: 'run_started', at: ms(r.startedAt), by: r.agentId ?? null, ref: r.id })
    if (r.endedAt) items.push({ kind: `run_${r.status}`, at: ms(r.endedAt), by: r.agentId ?? null, ref: r.id })
  }
  for (const a of input.attachments ?? []) items.push({ kind: `attach_${a.kind}`, at: ms(a.createdAt), text: a.name, ref: a.url ?? undefined })
  if (input.task?.completedAt) items.push({ kind: input.task.status === 'done' ? 'completed' : 'closed', at: ms(input.task.completedAt) })
  return items.sort((x, y) => x.at - y.at)
}
