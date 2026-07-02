'use client'
import { useCallback, useEffect, useState } from 'react'
import { STATUS_COLOR as STATUS_C } from './tokens'

// MCA-UI U2 — Task detail drawer. Surfaces the shipped-but-invisible backend:
// unified timeline, comments, attachments/work-products, run history, subtasks.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
type Getter = () => Promise<string | null>

async function call<T>(path: string, token: string | null, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(opts?.headers ?? {}) } })
  if (res.status === 204) return {} as T
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((j as any)?.error ?? 'Request failed')
  return j as T
}

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
      const [tk, tl, cm, at, rn, st] = await Promise.all([
        call<{ task: Task }>(`/api/tasks/${taskId}`, t).catch(() => ({ task: null as any })),
        call<{ timeline: TL[] }>(`/api/tasks/${taskId}/timeline`, t).catch(() => ({ timeline: [] })),
        call<{ comments: Comment[] }>(`/api/tasks/${taskId}/comments`, t).catch(() => ({ comments: [] })),
        call<{ attachments: Attach[] }>(`/api/tasks/${taskId}/attachments`, t).catch(() => ({ attachments: [] })),
        call<{ runs: Run[] }>(`/api/tasks/${taskId}/runs`, t).catch(() => ({ runs: [] })),
        call<{ subtasks: Task[] }>(`/api/tasks/${taskId}/subtasks`, t).catch(() => ({ subtasks: [] })),
      ])
      setTask(tk.task); setTimeline(tl.timeline); setComments(cm.comments); setAttachments(at.attachments); setRuns(rn.runs); setSubtasks(st.subtasks)
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
    try { await call(`/api/tasks/${taskId}/comments`, await getToken(), { method: 'POST', body: JSON.stringify({ body: draft.trim() }) }); setDraft(''); await load() }
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
            <div style={{ fontSize: 16, fontWeight: 700 }}>{task?.title ?? 'Task'}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ ...s.pill, color: STATUS_C[task?.status ?? ''] ?? '#9aa0a6' }}>{task?.status ?? '—'}</span>
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
                <span style={{ flex: 1 }}><b style={{ color: '#c9cdd3' }}>{e.kind.replace(/_/g, ' ')}</b>{e.text ? ` — ${e.text.slice(0, 120)}` : ''}{e.by ? <span style={s.muted}> · {e.by.slice(0, 8)}</span> : null}</span>
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
                <span style={{ color: r.status === 'done' ? '#22c55e' : r.status === 'failed' ? '#ff8080' : '#e0b000' }}>●</span>
                <span style={{ flex: 1 }}>{r.status} <span style={s.muted}>{fmt(r.startedAt)}</span></span>
                <span style={s.muted}>{r.tokensUsed ? `${r.tokensUsed} tok` : ''}{r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ''}</span>
              </div>
            ))}
          </Section>

          {subtasks.length > 0 && (
            <Section title={`Subtasks (${subtasks.length})`}>
              {subtasks.map(st => <div key={st.id} style={s.tlRow}><span aria-hidden>↳</span><span style={{ flex: 1 }}>{st.title}</span><span style={{ ...s.pill, color: STATUS_C[st.status] ?? '#9aa0a6' }}>{st.status}</span></div>)}
            </Section>
          )}

          <Section title={`Comments (${comments.length})`}>
            {comments.map(c => (
              <div key={c.id} style={s.comment}>
                <div style={s.muted}>{c.authorAgentId ? `agent ${c.authorAgentId.slice(0, 8)}` : (c.authorUser ?? 'user')} · {fmt(c.createdAt)}</div>
                <div style={{ fontSize: 13, marginTop: 2 }}>{c.body}</div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input style={s.input} placeholder="Add a comment…" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addComment() }} />
              <button style={s.btnPrimary} disabled={busy} onClick={addComment}>{busy ? '…' : 'Comment'}</button>
            </div>
          </Section>
        </div>
      </aside>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 18 }}><div style={s.secTitle}>{title}</div>{children}</div>
}
function Empty() { return <div style={{ ...s.muted, fontSize: 12, padding: '4px 0' }}>Nothing yet.</div> }

const s: Record<string, React.CSSProperties> = {
  scrim: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' },
  drawer: { width: 'min(560px, 94vw)', height: '100%', background: '#0d0d0d', borderLeft: '1px solid #262626', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 30px rgba(0,0,0,0.5)' },
  head: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: 18, borderBottom: '1px solid #1f1f1f' },
  close: { background: '#1a1a1a', border: '1px solid #333', color: '#c9cdd3', width: 34, height: 34, borderRadius: 8, cursor: 'pointer', fontSize: 14 },
  body: { padding: 18, overflow: 'auto', flex: 1 },
  secTitle: { fontSize: 11, fontWeight: 700, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  tlRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid #161616' },
  comment: { padding: '7px 0', borderBottom: '1px solid #161616' },
  pill: { fontSize: 11, fontWeight: 700, textTransform: 'capitalize', border: '1px solid #2a2a2a', borderRadius: 999, padding: '2px 9px' },
  label: { fontSize: 11, color: '#c9cdd3', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6, padding: '1px 7px' },
  muted: { color: '#9aa0a6', fontSize: 11.5 },
  mono: { fontFamily: 'monospace', fontSize: 12, color: '#c9cdd3', background: '#0a0a0a', border: '1px solid #1f1f1f', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  link: { color: '#4aa8ff', fontSize: 12.5, textDecoration: 'none', flex: 1 },
  err: { background: '#2a1414', border: '1px solid #5a2a2a', color: '#ff8080', borderRadius: 8, padding: '8px 12px', margin: '0 18px', fontSize: 12.5 },
  input: { flex: 1, background: '#000', border: '1px solid #333', borderRadius: 8, padding: '9px 11px', color: '#eee', fontSize: 13 },
  btnPrimary: { background: '#FFB800', border: '1px solid #FFB800', color: '#000', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 },
}
