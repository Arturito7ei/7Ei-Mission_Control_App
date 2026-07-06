'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from './tokens'
import { statusColor, statusIcon } from './status'
import { Button, TextInput } from './ui'

// MCA-UI U2 — Task detail drawer. Surfaces the shipped-but-invisible backend:
// unified timeline, comments, attachments/work-products, run history, subtasks.
// MCA-80: shared api() client + ui.tsx primitives + tokens (dense rows,
// identical palette). Behavior unchanged: ESC closes, Enter posts a comment,
// vault: attachment URLs deep-link into the TARCO repo.

type Getter = () => Promise<string | null>

type Task = { id: string; title: string; status: string; input?: string | null; output?: string | null; labels?: string | null; costUsd?: number | null; tokensUsed?: number | null }
type TL = { kind: string; at: number; by?: string | null; text?: string; ref?: string }
type Comment = { id: string; body: string; authorAgentId?: string | null; authorUser?: string | null; createdAt: number }
type Attach = { id: string; kind: string; name: string; url?: string | null }
type Run = { id: string; status: string; startedAt: number; endedAt?: number | null; tokensUsed?: number | null; costUsd?: number | null }

const KIND_ICON: Record<string, string> = { created: '🆕', comment: '💬', run_started: '▶️', run_done: '✓', run_failed: '✗', attach_work_product: '📎', attach_link: '🔗', attach_file: '📄', completed: '✅', closed: '⛔' }
const fmt = (t: number) => { try { return new Date(t).toLocaleString() } catch { return '' } }

export default function TaskDrawer({ orgId, taskId, getToken, onClose }: { orgId: string; taskId: string; getToken: Getter; onClose: () => void }) {
  const [task, setTask] = useState<Task | null>(null)
  const [timeline, setTimeline] = useState<TL[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [attachments, setAttachments] = useState<Attach[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [subtasks, setSubtasks] = useState<Task[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const t = await getToken()
    try {
      const [tk_, tl, cm, at, rn, st] = await Promise.all([
        api<{ task: Task }>(`/api/tasks/${taskId}`, { token: t }).catch(() => ({ task: null as any })),
        api<{ timeline: TL[] }>(`/api/tasks/${taskId}/timeline`, { token: t }).catch(() => ({ timeline: [] })),
        api<{ comments: Comment[] }>(`/api/tasks/${taskId}/comments`, { token: t }).catch(() => ({ comments: [] })),
        api<{ attachments: Attach[] }>(`/api/tasks/${taskId}/attachments`, { token: t }).catch(() => ({ attachments: [] })),
        api<{ runs: Run[] }>(`/api/tasks/${taskId}/runs`, { token: t }).catch(() => ({ runs: [] })),
        api<{ subtasks: Task[] }>(`/api/tasks/${taskId}/subtasks`, { token: t }).catch(() => ({ subtasks: [] })),
      ])
      setTask(tk_.task); setTimeline(tl.timeline); setComments(cm.comments); setAttachments(at.attachments); setRuns(rn.runs); setSubtasks(st.subtasks)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
  }, [taskId, getToken])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onEsc); return () => window.removeEventListener('keydown', onEsc)
  }, [onClose])

  const addComment = async () => {
    if (!draft.trim()) return
    setBusy(true); setErr(null)
    try { await api(`/api/tasks/${taskId}/comments`, { token: await getToken(), method: 'POST', body: JSON.stringify({ body: draft.trim() }) }); setDraft(''); await load() }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }

  const labels: string[] = (() => { try { return task?.labels ? JSON.parse(task.labels) : [] } catch { return [] } })()
  const vaultHref = (url?: string | null) => url?.startsWith('vault:') ? `https://github.com/Arturito7ei/7Ei-MC_TARCO/blob/main/${url.slice(6)}` : (url ?? undefined)

  return (
    <div style={s.scrim} onClick={onClose}>
      <aside style={s.drawer} onClick={e => e.stopPropagation()} role="dialog" aria-label="Task detail">
        <div style={s.head}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: text.lg.fontSize, lineHeight: text.lg.lineHeight, fontWeight: 700 }}>{task?.title ?? 'Task'}</div>
            <div style={{ display: 'flex', gap: space.md, alignItems: 'center', marginTop: space.xs, flexWrap: 'wrap' }}>
              <span style={{ ...s.pill, color: task?.status ? statusColor(task.status) : tk.muted }}>{task?.status ? `${statusIcon(task.status)} ${task.status}` : '—'}</span>
              {labels.map(l => <span key={l} style={s.label}>{l}</span>)}
              {task?.costUsd != null && <span style={s.muted}>${task.costUsd.toFixed(5)}</span>}
            </div>
          </div>
          <button style={s.close} onClick={onClose} aria-label="Close">✕</button>
        </div>
        {err && <div style={s.err}>⚠ {err}</div>}
        <div style={s.body}>
          {task?.input && <Section title="Input"><div style={s.mono}>{task.input}</div></Section>}
          {task?.output && <Section title="Latest output"><div style={s.mono}>{task.output}</div></Section>}

          <Section title={`Timeline (${timeline.length})`}>
            {timeline.length === 0 ? <Empty /> : timeline.map((e, i) => (
              <div key={i} style={s.tlRow}>
                <span aria-hidden>{KIND_ICON[e.kind] ?? '•'}</span>
                <span style={{ flex: 1 }}><b style={{ color: tk.textDim }}>{e.kind.replace(/_/g, ' ')}</b>{e.text ? ` — ${e.text.slice(0, 120)}` : ''}{e.by ? <span style={s.muted}> · {e.by.slice(0, 8)}</span> : null}</span>
                <span style={s.muted}>{fmt(e.at)}</span>
              </div>
            ))}
          </Section>

          <Section title={`Work products & attachments (${attachments.length})`}>
            {attachments.length === 0 ? <Empty /> : attachments.map(a => (
              <div key={a.id} style={s.tlRow}>
                <span aria-hidden>{a.kind === 'work_product' ? '📎' : a.kind === 'link' ? '🔗' : '📄'}</span>
                <a style={s.link} href={vaultHref(a.url)} target="_blank" rel="noreferrer">{a.name}</a>
                <span style={s.muted}>{a.kind}</span>
              </div>
            ))}
          </Section>

          <Section title={`Runs (${runs.length})`}>
            {runs.length === 0 ? <Empty /> : runs.map(r => (
              <div key={r.id} style={s.tlRow}>
                <span aria-hidden style={{ color: statusColor(r.status === 'done' ? 'done' : r.status === 'failed' ? 'failed' : 'paused'), fontWeight: 700 }}>{statusIcon(r.status === 'done' ? 'done' : r.status === 'failed' ? 'failed' : 'paused')}</span>
                <span style={{ flex: 1 }}>{r.status} <span style={s.muted}>{fmt(r.startedAt)}</span></span>
                <span style={s.muted}>{r.tokensUsed ? `${r.tokensUsed} tok` : ''}{r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ''}</span>
              </div>
            ))}
          </Section>

          {subtasks.length > 0 && (
            <Section title={`Subtasks (${subtasks.length})`}>
              {subtasks.map(st => <div key={st.id} style={s.tlRow}><span aria-hidden>↳</span><span style={{ flex: 1 }}>{st.title}</span><span style={{ ...s.pill, color: statusColor(st.status) }}>{statusIcon(st.status)} {st.status}</span></div>)}
            </Section>
          )}

          <Section title={`Comments (${comments.length})`}>
            {comments.map(c => (
              <div key={c.id} style={s.comment}>
                <div style={s.muted}>{c.authorAgentId ? `agent ${c.authorAgentId.slice(0, 8)}` : (c.authorUser ?? 'user')} · {fmt(c.createdAt)}</div>
                <div style={{ fontSize: text.md.fontSize, marginTop: 2 }}>{c.body}</div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: space.md, marginTop: space.md }}>
              <TextInput style={{ flex: 1 }} placeholder="Add a comment…" aria-label="Add a comment" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addComment() }} />
              <Button variant="primary" disabled={busy} onClick={addComment}>{busy ? '…' : 'Comment'}</Button>
            </div>
          </Section>
        </div>
      </aside>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: space.xl }}><div style={s.secTitle}>{title}</div>{children}</div>
}
function Empty() { return <div style={{ ...s.muted, padding: `${space.xs}px 0` }}>Nothing yet.</div> }

const s: Record<string, React.CSSProperties> = {
  scrim: { position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' },
  drawer: { width: 'min(560px, 94vw)', height: '100%', background: tk.surface, borderLeft: `1px solid ${tk.line}`, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 30px rgba(0,0,0,0.5)' },
  head: { display: 'flex', gap: space.lg, alignItems: 'flex-start', padding: space.xl, borderBottom: `1px solid ${tk.line}` },
  close: { background: tk.surfaceHigh, border: '1px solid var(--line-strong)', color: tk.textDim, width: 28, height: 28, borderRadius: tk.r.sm, cursor: 'pointer', fontSize: text.sm.fontSize, flexShrink: 0 },
  body: { padding: space.xl, overflow: 'auto', flex: 1 },
  secTitle: { fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, fontWeight: 700, color: tk.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: space.sm },
  tlRow: { display: 'flex', gap: space.md, alignItems: 'center', fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, padding: `${space.xs}px 0`, borderBottom: `1px solid ${tk.lineSoft}` },
  comment: { padding: `${space.sm}px 0`, borderBottom: `1px solid ${tk.lineSoft}` },
  pill: { fontSize: text.xs.fontSize, fontWeight: 700, textTransform: 'capitalize', border: '1px solid var(--line-strong)', borderRadius: tk.r.pill, padding: '1px 8px' },
  label: { fontSize: text.xs.fontSize, color: tk.textDim, background: tk.surfaceHigh, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '1px 7px' },
  muted: { color: tk.muted, fontSize: text.xs.fontSize },
  mono: { fontFamily: 'monospace', fontSize: text.sm.fontSize, color: tk.textDim, background: tk.bg, border: `1px solid ${tk.lineSoft}`, borderRadius: tk.r.sm, padding: space.md, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  link: { color: tk.blue, fontSize: text.sm.fontSize, textDecoration: 'none', flex: 1 },
  err: { background: 'var(--danger-bg)', border: '1px solid var(--danger-line)', color: tk.red, borderRadius: tk.r.md, padding: `${space.sm}px ${space.lg}px`, margin: `0 ${space.xl}px`, fontSize: text.sm.fontSize },
}
