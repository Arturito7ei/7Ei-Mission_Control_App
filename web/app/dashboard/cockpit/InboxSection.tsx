'use client'
// MCA-80 — cockpit inbox: pending approvals + attention items. MCA-84 V2:
// approvals are now tri-state (approve / request changes with a note / reject —
// the revision loop), and failed rows carry the inline error + a Retry that
// re-executes the task in place. Colorblind-safe: every action is iconed, red
// is never the lone CTA (✓ approve accent, ↩ request-changes accent, ✕ reject).
import { useState } from 'react'
import { tk, text, space } from '../tokens'
import { Button, Card, SectionLabel, TextInput } from '../ui'
import { EXT_PURPLE, KIND_C, KIND_LABEL, sx, type Approval, type ApprovalDecision, type InboxItem } from './shared'
import { isReviewCase } from '@/lib/trust'

export default function InboxSection({ inbox, approvals, onDismiss, onDecide, onRetry }: {
  inbox: InboxItem[]
  approvals: Approval[]
  onDismiss: (taskId: string) => void
  onDecide: (id: string, decision: ApprovalDecision, note?: string) => void
  onRetry: (taskId: string) => void
}) {
  // Which approval is mid-"request changes" (showing the note composer), and the
  // task currently being retried (button disabled so it can't double-fire).
  const [revising, setRevising] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [retrying, setRetrying] = useState<Set<string>>(new Set())

  if (inbox.length + approvals.length === 0) return null

  const sendRevision = (id: string) => {
    const n = note.trim()
    if (!n) return
    onDecide(id, 'revision_requested', n)
    setRevising(null); setNote('')
  }
  const retry = (taskId: string) => {
    setRetrying(s => new Set(s).add(taskId))
    onRetry(taskId)
  }

  return (
    <div>
      <SectionLabel>Inbox · {inbox.length + approvals.length}</SectionLabel>
      <Card style={{ paddingTop: 0, paddingBottom: 0 }}>
        {approvals.map(a => {
          // Epic P / P1 — a low-trust review case is a QUARANTINE hold, not a
          // routine approval. Distinct chip (🛡, icon+text+shape — never color
          // alone) + the machine-rendered warnings, but the same tri-state loop.
          const review = isReviewCase(a.type)
          const warnings: string[] = review && Array.isArray(a.payload?.warnings) ? a.payload.warnings : []
          return (
          <div key={a.id}>
            <div style={sx.row}>
              <span style={{ ...sx.tag, background: review ? 'var(--warning-dim, var(--accent-dim))' : 'var(--accent-dim)', color: review ? 'var(--warning-text, #b45309)' : EXT_PURPLE }}>
                {review ? '🛡 Low-trust review' : `Approval · ${a.type}`}
              </span>
              <div style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{a.summary}</div>
              <Button style={{ color: tk.accent }} onClick={() => onDecide(a.id, 'approved')}>✓ Approve</Button>
              <Button style={{ color: tk.accent }} onClick={() => { setRevising(r => r === a.id ? null : a.id); setNote('') }}>↩ Request changes</Button>
              <Button style={{ color: tk.red }} onClick={() => onDecide(a.id, 'rejected')}>✕ Reject</Button>
            </div>
            {warnings.length > 0 && (
              <div style={{ padding: `0 0 ${space.sm}px`, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {warnings.map((w, i) => <div key={i} style={s.warnLine}>⚠ {w}</div>)}
              </div>
            )}
            {revising === a.id && (
              <div style={{ ...sx.row, gap: space.md, borderBottom: `1px solid ${tk.lineSoft}` }}>
                <TextInput autoFocus value={note} onChange={e => setNote(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') sendRevision(a.id); if (e.key === 'Escape') { setRevising(null); setNote('') } }}
                  placeholder="What needs to change? (sent back to the requester)" style={{ flex: 1 }} />
                <Button variant="primary" disabled={!note.trim()} onClick={() => sendRevision(a.id)}>Send</Button>
                <Button style={{ color: tk.muted }} onClick={() => { setRevising(null); setNote('') }}>Cancel</Button>
              </div>
            )}
          </div>
          )
        })}
        {inbox.map(i => (
          <div key={i.taskId} style={{ ...sx.row, alignItems: i.error ? 'flex-start' : 'center' }}>
            <span style={{ ...sx.tag, background: (KIND_C[i.kind] ?? KIND_C.attention).bg, color: (KIND_C[i.kind] ?? KIND_C.attention).fg, marginTop: i.error ? 3 : 0 }}>{KIND_LABEL[i.kind] ?? i.kind}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: 600 }}>{i.title}</span>
                <span style={{ fontSize: text.xs.fontSize, color: tk.muted, marginLeft: space.md }}>{i.agentEmoji} {i.agentName}</span>
              </div>
              {i.error && <div style={s.errLine} title={i.error}>{i.error}</div>}
            </div>
            {i.retryable && <Button style={{ color: tk.accent }} disabled={retrying.has(i.taskId)} onClick={() => retry(i.taskId)}>{retrying.has(i.taskId) ? 'Retrying…' : '↻ Retry'}</Button>}
            <Button style={{ color: tk.accent }} onClick={() => onDismiss(i.taskId)}>Dismiss</Button>
          </div>
        ))}
      </Card>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // Failure evidence: muted, monospace-ish, single-line clamp (full text on hover).
  errLine: { fontSize: text.xs.fontSize, color: 'var(--danger-text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace' },
  // Low-trust review warnings — amber, iconed (⚠), indented under the case.
  warnLine: { fontSize: text.xs.fontSize, color: 'var(--warning-text, #b45309)', paddingLeft: space.md },
}
