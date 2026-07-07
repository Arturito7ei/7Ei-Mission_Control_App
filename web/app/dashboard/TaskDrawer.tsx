'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { tk, text, space } from './tokens'
import { statusColor, statusIcon } from './status'
import { Button, TextInput, Select } from './ui'
import RecoveryCard, { type Recovery } from './RecoveryCard'

// MCA-UI U2 — Task detail drawer. Surfaces the shipped-but-invisible backend:
// unified timeline, comments, attachments/work-products, run history, subtasks.
// MCA-80: shared api() client + ui.tsx primitives + tokens (dense rows,
// identical palette). Behavior unchanged: ESC closes, Enter posts a comment,
// vault: attachment URLs deep-link into the TARCO repo.

type Getter = () => Promise<string | null>

type Task = { id: string; title: string; status: string; agentId?: string | null; input?: string | null; output?: string | null; labels?: string | null; costUsd?: number | null; tokensUsed?: number | null }
type TL = { kind: string; at: number; by?: string | null; text?: string; ref?: string }
type Comment = { id: string; body: string; kind?: string | null; authorAgentId?: string | null; authorUser?: string | null; authorName?: string | null; authorEmoji?: string | null; createdAt: number }
type Attach = { id: string; kind: string; name: string; url?: string | null }
type Run = { id: string; status: string; startedAt: number; endedAt?: number | null; tokensUsed?: number | null; costUsd?: number | null }
type Rollup = { ownCost: number; subtaskCost: number; totalCost: number; ownTokens: number; subtaskTokens: number; totalTokens: number; subtaskCount: number }
// W4 task watchdogs: declarative checks the scheduler evaluates each tick.
type Watchdog = { id: string; kind: string; threshold: string; state: string; lastMessage?: string | null; enabled: boolean; triggeredAt?: number | null }

// Kind → { label for the add-menu, unit hint for the threshold field }.
const WD_KINDS: { kind: string; label: string; unit: string; placeholder: string }[] = [
  { kind: 'runtime', label: 'Runtime over…', unit: 'min', placeholder: '30' },
  { kind: 'cost', label: 'Cost over…', unit: 'USD', placeholder: '0.50' },
  { kind: 'no_activity', label: 'Idle over…', unit: 'min', placeholder: '45' },
  { kind: 'status', label: 'Status reaches…', unit: '', placeholder: 'blocked' },
]
const WD_STATUSES = ['blocked', 'failed', 'done', 'in_progress']
function watchdogLabel(w: { kind: string; threshold: string }): string {
  switch (w.kind) {
    case 'runtime': return `Runtime over ${w.threshold}m`
    case 'cost': return `Cost over $${w.threshold}`
    case 'no_activity': return `Idle over ${w.threshold}m`
    case 'status': return `Status is ${w.threshold}`
    default: return w.kind
  }
}

const KIND_ICON: Record<string, string> = { created: '🆕', comment: '💬', run_started: '▶️', run_done: '✓', run_failed: '✗', attach_work_product: '📎', attach_link: '🔗', attach_file: '📄', completed: '✅', closed: '⛔' }
const fmt = (t: number) => { try { return new Date(t).toLocaleString() } catch { return '' } }

export default function TaskDrawer({ orgId, taskId, getToken, onClose }: { orgId: string; taskId: string; getToken: Getter; onClose: () => void }) {
  const [task, setTask] = useState<Task | null>(null)
  const [timeline, setTimeline] = useState<TL[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [attachments, setAttachments] = useState<Attach[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [subtasks, setSubtasks] = useState<Task[]>([])
  const [rollup, setRollup] = useState<Rollup | null>(null)
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [watchdogs, setWatchdogs] = useState<Watchdog[]>([])
  const [wdKind, setWdKind] = useState('runtime')
  const [wdThreshold, setWdThreshold] = useState('')
  const [wdBusy, setWdBusy] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [woke, setWoke] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const commentRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const t = await getToken()
    try {
      const [tk_, tl, cm, at, rn, st, rc, wd] = await Promise.all([
        api<{ task: Task }>(`/api/tasks/${taskId}`, { token: t }).catch(() => ({ task: null as any })),
        api<{ timeline: TL[] }>(`/api/tasks/${taskId}/timeline`, { token: t }).catch(() => ({ timeline: [] })),
        api<{ comments: Comment[] }>(`/api/tasks/${taskId}/comments`, { token: t }).catch(() => ({ comments: [] })),
        api<{ attachments: Attach[] }>(`/api/tasks/${taskId}/attachments`, { token: t }).catch(() => ({ attachments: [] })),
        api<{ runs: Run[] }>(`/api/tasks/${taskId}/runs`, { token: t }).catch(() => ({ runs: [] })),
        api<{ subtasks: Task[]; rollup: Rollup | null }>(`/api/tasks/${taskId}/subtasks`, { token: t }).catch(() => ({ subtasks: [], rollup: null })),
        api<{ recovery: Recovery | null }>(`/api/tasks/${taskId}/recovery`, { token: t }).catch(() => ({ recovery: null })),
        api<{ watchdogs: Watchdog[] }>(`/api/tasks/${taskId}/watchdogs`, { token: t }).catch(() => ({ watchdogs: [] })),
      ])
      setTask(tk_.task); setTimeline(tl.timeline); setComments(cm.comments); setAttachments(at.attachments); setRuns(rn.runs); setSubtasks(st.subtasks); setRollup(st.rollup ?? null); setRecovery(rc.recovery); setWatchdogs(wd.watchdogs)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
  }, [taskId, getToken])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onEsc); return () => window.removeEventListener('keydown', onEsc)
  }, [onClose])

  // W3 wake-on-comment: posting a comment on an idle task re-runs the agent with
  // the comment as a follow-up. The server decides + reports `woke`; if it woke,
  // reload after a beat so the new run + "Agent woken" notice show up.
  const addComment = async () => {
    if (!draft.trim()) return
    setBusy(true); setErr(null); setWoke(false)
    try {
      const r = await api<{ woke?: boolean }>(`/api/tasks/${taskId}/comments`, { token: await getToken(), method: 'POST', body: JSON.stringify({ body: draft.trim() }) })
      setDraft('')
      if (r?.woke) { setWoke(true); setTimeout(() => load(), 1500) } else await load()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }

  // W1 recovery action: re-run the task, then reload so the card clears if it
  // succeeds (or re-appears with the new failure if it fails again).
  const retry = async () => {
    setRetrying(true); setErr(null)
    try {
      await api(`/api/tasks/${taskId}/execute`, { token: await getToken(), method: 'POST' })
      setTimeout(() => { load().finally(() => setRetrying(false)) }, 1500)
    } catch (e: any) { setErr(e?.message ?? 'Retry failed'); setRetrying(false) }
  }
  const focusComment = () => { commentRef.current?.focus(); commentRef.current?.scrollIntoView({ block: 'center' }) }

  // W4 watchdogs: attach a declarative check; the scheduler evaluates it each tick
  // and posts a thread notice on a state flip.
  const addWatchdog = async () => {
    const threshold = (wdKind === 'status' ? (wdThreshold || WD_STATUSES[0]) : wdThreshold).trim()
    if (!threshold) return
    setWdBusy(true); setErr(null)
    try {
      await api(`/api/tasks/${taskId}/watchdogs`, { token: await getToken(), method: 'POST', body: JSON.stringify({ kind: wdKind, threshold }) })
      setWdThreshold(''); await load()
    } catch (e: any) { setErr(e?.message ?? 'Failed to add watchdog') }
    setWdBusy(false)
  }
  const removeWatchdog = async (id: string) => {
    setWatchdogs(ws => ws.filter(w => w.id !== id))  // optimistic
    try { await api(`/api/watchdogs/${id}`, { token: await getToken(), method: 'DELETE' }) }
    catch (e: any) { setErr(e?.message ?? 'Failed to remove'); load() }
  }
  const wdMeta = WD_KINDS.find(k => k.kind === wdKind)!

  // W3: mirror the server's wake gate so the composer can promise it up front —
  // a comment on an idle task (with an agent, no in-flight run) will wake it.
  const WAKEABLE = ['pending', 'assigned', 'blocked', 'failed', 'done']
  const agentBusy = runs.some(r => r.status === 'running')
  const wakeable = !!task?.agentId && !agentBusy && WAKEABLE.includes(task?.status ?? '')

  const hasRollup = !!rollup && rollup.subtaskCount > 0 && rollup.totalCost > 0
  const labels: string[] = (() => { try { return task?.labels ? JSON.parse(task.labels) : [] } catch { return [] } })()
  const vaultHref = (url?: string | null) => url?.startsWith('vault:') ? `https://github.com/Arturito7ei/7Ei-MC_TARCO/blob/main/${url.slice(6)}` : (url ?? undefined)

  return (
    <div style={s.scrim} onClick={onClose}>
      <aside className="mc-glass" style={s.drawer} onClick={e => e.stopPropagation()} role="dialog" aria-label="Task detail">
        <div style={s.head}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: text.lg.fontSize, lineHeight: text.lg.lineHeight, fontWeight: 700 }}>{task?.title ?? 'Task'}</div>
            <div style={{ display: 'flex', gap: space.md, alignItems: 'center', marginTop: space.xs, flexWrap: 'wrap' }}>
              <span style={{ ...s.pill, color: task?.status ? statusColor(task.status) : tk.muted }}>{task?.status ? `${statusIcon(task.status)} ${task.status}` : '—'}</span>
              {labels.map(l => <span key={l} style={s.label}>{l}</span>)}
              {hasRollup
                // W2: parent shows the whole subtree's spend, not just its own slice.
                ? <span style={s.muted} title={`own $${rollup!.ownCost.toFixed(5)} + ${rollup!.subtaskCount} subtask${rollup!.subtaskCount === 1 ? '' : 's'} $${rollup!.subtaskCost.toFixed(5)}`}>${rollup!.totalCost.toFixed(5)} <span style={{ opacity: 0.7 }}>incl. subtasks</span></span>
                : task?.costUsd != null && <span style={s.muted}>${task.costUsd.toFixed(5)}</span>}
            </div>
          </div>
          <button style={s.close} onClick={onClose} aria-label="Close">✕</button>
        </div>
        {err && <div style={s.err}>⚠ {err}</div>}
        <div style={s.body}>
          {recovery && <RecoveryCard rec={recovery} retrying={retrying} onRetry={retry} onAddNote={focusComment} />}
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

          {/* W4 watchdogs: declarative checks; triggered ones are ⚠-iconed + amber
              (colorblind-safe, never color-only). Add row lets you attach a check. */}
          <Section title={`Watchdogs (${watchdogs.length})`}>
            {watchdogs.length === 0 && <div style={{ ...s.muted, padding: `${space.xs}px 0` }}>No checks. Add one to be told when this task runs long, costs too much, stalls, or changes status — no babysitting.</div>}
            {watchdogs.map(w => {
              const triggered = w.state === 'triggered'
              return (
                <div key={w.id} style={s.tlRow}>
                  <span aria-hidden style={{ color: triggered ? tk.amber : tk.green, fontWeight: 700 }}>{triggered ? '⚠' : '✓'}</span>
                  <span style={{ flex: 1 }}>
                    {watchdogLabel(w)}
                    {triggered && <span style={{ ...s.muted, color: tk.amber, marginLeft: space.sm }} title={w.lastMessage ?? ''}>triggered{w.lastMessage ? ` — ${w.lastMessage.slice(0, 60)}` : ''}</span>}
                  </span>
                  <button style={s.wdRemove} onClick={() => removeWatchdog(w.id)} aria-label={`Remove watchdog ${watchdogLabel(w)}`}>✕</button>
                </div>
              )
            })}
            <div style={{ display: 'flex', gap: space.sm, marginTop: space.md, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select aria-label="Watchdog type" value={wdKind} onChange={e => { setWdKind(e.target.value); setWdThreshold('') }}>
                {WD_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </Select>
              {wdKind === 'status' ? (
                <Select aria-label="Target status" value={wdThreshold || WD_STATUSES[0]} onChange={e => setWdThreshold(e.target.value)}>
                  {WD_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                </Select>
              ) : (
                <>
                  <TextInput style={{ width: 90 }} inputMode="decimal" placeholder={wdMeta.placeholder} aria-label="Threshold" value={wdThreshold} onChange={e => setWdThreshold(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addWatchdog() }} />
                  <span style={s.muted}>{wdMeta.unit}</span>
                </>
              )}
              <Button disabled={wdBusy} onClick={addWatchdog}>{wdBusy ? '…' : 'Add check'}</Button>
            </div>
          </Section>

          {subtasks.length > 0 && (
            <Section title={`Subtasks (${subtasks.length})`}>
              {subtasks.map(st => (
                <div key={st.id} style={s.tlRow}>
                  <span aria-hidden>↳</span>
                  <span style={{ flex: 1 }}>{st.title}</span>
                  {st.costUsd != null && <span style={s.muted}>${st.costUsd.toFixed(4)}</span>}
                  <span style={{ ...s.pill, color: statusColor(st.status) }}>{statusIcon(st.status)} {st.status}</span>
                </div>
              ))}
              {rollup && rollup.totalCost > 0 && (
                // W2 cost roll-up: own + subtasks = true spend on this piece of work.
                <div style={{ ...s.tlRow, borderBottom: 'none', fontWeight: 700 }}>
                  <span aria-hidden>Σ</span>
                  <span style={{ flex: 1 }}>Total (this task + {rollup.subtaskCount} subtask{rollup.subtaskCount === 1 ? '' : 's'})</span>
                  <span style={s.muted} title={`${rollup.totalTokens} tok · own $${rollup.ownCost.toFixed(4)} + subtasks $${rollup.subtaskCost.toFixed(4)}`}>${rollup.totalCost.toFixed(4)}</span>
                </div>
              )}
            </Section>
          )}

          <Section title={`Comments (${comments.length})`}>
            {comments.map(c => c.kind === 'system_notice' ? (
              // W1 system-notice: failures land in the thread as a durable, iconed record.
              <div key={c.id} style={s.notice}>
                <div style={{ ...s.muted, color: tk.red }}><span aria-hidden>⚠</span> system · {fmt(c.createdAt)}</div>
                <div style={{ fontSize: text.md.fontSize, marginTop: 2 }}>{c.body}</div>
              </div>
            ) : (
              <div key={c.id} style={s.comment}>
                <div style={s.muted}>{c.authorAgentId ? `${c.authorEmoji ?? '🤖'} ${c.authorName ?? `agent ${c.authorAgentId.slice(0, 8)}`}` : (c.authorUser ?? 'user')} · {fmt(c.createdAt)}</div>
                <div style={{ fontSize: text.md.fontSize, marginTop: 2 }}>{c.body}</div>
              </div>
            ))}
            {woke && <div style={s.woke}><span aria-hidden>↩</span> Comment posted — agent woken to address it. Re-running…</div>}
            <div style={{ display: 'flex', gap: space.md, marginTop: space.md }}>
              <TextInput ref={commentRef} style={{ flex: 1 }} placeholder={wakeable ? 'Comment & wake the agent…' : 'Add a comment…'} aria-label="Add a comment" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addComment() }} />
              <Button variant="primary" disabled={busy} onClick={addComment}>{busy ? '…' : wakeable ? 'Comment & wake' : 'Comment'}</Button>
            </div>
            {wakeable && <div style={{ ...s.muted, marginTop: space.xs }}>↩ Posting will wake the agent to pick this task back up.</div>}
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
  // Glass chrome (T2): fill/blur from `.mc-glass`; border + shadow tokenized so
  // the drawer reads right in both themes (no baked-in dark shadow).
  drawer: { width: 'min(560px, 94vw)', height: '100%', borderLeft: '1px solid var(--glass-line)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-drawer)' },
  head: { display: 'flex', gap: space.lg, alignItems: 'flex-start', padding: space.xl, borderBottom: `1px solid ${tk.line}` },
  close: { background: tk.surfaceHigh, border: '1px solid var(--line-strong)', color: tk.textDim, width: 28, height: 28, borderRadius: tk.r.sm, cursor: 'pointer', fontSize: text.sm.fontSize, flexShrink: 0 },
  body: { padding: space.xl, overflow: 'auto', flex: 1 },
  secTitle: { fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, fontWeight: 700, color: tk.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: space.sm },
  tlRow: { display: 'flex', gap: space.md, alignItems: 'center', fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, padding: `${space.xs}px 0`, borderBottom: `1px solid ${tk.lineSoft}` },
  comment: { padding: `${space.sm}px 0`, borderBottom: `1px solid ${tk.lineSoft}` },
  notice: { padding: space.sm, marginBottom: space.xs, borderLeft: '3px solid var(--danger-line)', background: 'var(--danger-bg)', borderRadius: tk.r.sm },
  woke: { marginTop: space.md, padding: space.sm, borderLeft: '3px solid var(--accent)', background: 'var(--accent-dim)', borderRadius: tk.r.sm, fontSize: text.sm.fontSize, color: tk.accent },
  pill: { fontSize: text.xs.fontSize, fontWeight: 700, textTransform: 'capitalize', border: '1px solid var(--line-strong)', borderRadius: tk.r.pill, padding: '1px 8px' },
  label: { fontSize: text.xs.fontSize, color: tk.textDim, background: tk.surfaceHigh, border: '1px solid var(--line-strong)', borderRadius: 6, padding: '1px 7px' },
  wdRemove: { background: 'transparent', border: 'none', color: tk.muted, cursor: 'pointer', fontSize: text.sm.fontSize, padding: '0 4px', flexShrink: 0 },
  muted: { color: tk.muted, fontSize: text.xs.fontSize },
  mono: { fontFamily: 'monospace', fontSize: text.sm.fontSize, color: tk.textDim, background: tk.bg, border: `1px solid ${tk.lineSoft}`, borderRadius: tk.r.sm, padding: space.md, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  link: { color: tk.blue, fontSize: text.sm.fontSize, textDecoration: 'none', flex: 1 },
  err: { background: 'var(--danger-bg)', border: '1px solid var(--danger-line)', color: tk.red, borderRadius: tk.r.md, padding: `${space.sm}px ${space.lg}px`, margin: `0 ${space.xl}px`, fontSize: text.sm.fontSize },
}
