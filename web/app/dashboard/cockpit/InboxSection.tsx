'use client'
// MCA-80 — cockpit inbox: pending approvals + attention items. MCA-84 V2:
// approvals are now tri-state (approve / request changes with a note / reject —
// the revision loop), and failed rows carry the inline error + a Retry that
// re-executes the task in place. Colorblind-safe: every action is iconed, red
// is never the lone CTA (✓ approve accent, ↩ request-changes accent, ✕ reject).
import { useEffect, useState } from 'react'
import { tk, text, space } from '../tokens'
import { Button, Card, Pill, SectionLabel, TextInput } from '../ui'
import { EXT_PURPLE, KIND_C, KIND_LABEL, sx, type Approval, type ApprovalDecision, type CAgent, type InboxItem } from './shared'
import { isReviewCase } from '@/lib/trust'
import { isJoinRequestApproval, joinRequestChip } from '@/lib/invites.logic'
import { approvalNeedsStepUp } from '@/lib/dangerousApprovals'
import { activityAgo, outcomeLabel, type ActivityEvent } from '@/lib/activityKinds'
import { OUTCOME_TONE } from './ActivityLogSection'

export default function InboxSection({ inbox, approvals, onDismiss, onDecide, onRetry, deciding, decideErr, agents, recentDecisions, focused }: {
  inbox: InboxItem[]
  approvals: Approval[]
  onDismiss: (taskId: string) => void
  onDecide: (id: string, decision: ApprovalDecision, note?: string) => void
  onRetry: (taskId: string) => void
  /** ACT-1 — to name the requesting agent instead of showing a raw uuid. The phone
   *  already showed `from agent 3f2a1b9c…`; neither is a name, so the desk resolves it. */
  agents?: CAgent[]
  /** ACT-1 — the recently DECIDED tail, newest first, from the activity feed. Read-only:
   *  these are answered, and re-offering buttons on them would invite a second decision
   *  on something already settled. */
  recentDecisions?: ActivityEvent[]
  /** ACT-1 — true when the Inbox is the only section on screen (its own tab). A focused
   *  Inbox must render an empty STATE; inside the full Mission Control stack an empty
   *  Inbox still collapses to nothing, as it always has. */
  focused?: boolean
  /** APPR-1 — approvals with a decision in flight (buttons disabled, no double-fire). */
  deciding?: Set<string>
  /** APPR-1 — per-approval failure text. A decision that did NOT land says so on its
   *  own card; previously every failure (incl. the dangerous-approve 403) was
   *  swallowed and the card disappeared as if it had succeeded. */
  decideErr?: Record<string, string>
}) {
  // Which approval is mid-"request changes" (showing the note composer), and the
  // task currently being retried (button disabled so it can't double-fire).
  const [revising, setRevising] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [retrying, setRetrying] = useState<Set<string>>(new Set())
  // Ages are relative, so they need a "now". Sampled on a timer rather than per render,
  // so a row doesn't renumber itself mid-read — but it MUST keep advancing.
  //
  // AUDIT-ACT1 M-2: this was `useState(() => Date.now())` with no setter, frozen for the
  // life of the mount. The dashboard is a long-lived tab, so a three-hour-old approval
  // still read "10m ago" — and it failed toward FRESH, which is the dangerous direction
  // for a field whose whole purpose is telling a fresh ask from a stale one. Ages are
  // minute-granular, so a 30s tick is the coarsest interval that is always correct.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const decisions = recentDecisions ?? []
  const pendingCount = inbox.length + approvals.length
  const agentName = (id?: string | null) => (id ? agents?.find(a => a.id === id)?.name ?? null : null)
  const ageOf = (v: Approval['createdAt']) => {
    if (v === null || v === undefined) return null
    const ms = typeof v === 'number' ? v : Date.parse(String(v))
    return Number.isFinite(ms) ? activityAgo(ms, now) : null
  }

  // Inside the full stack an empty Inbox still collapses (unchanged). On its own tab it
  // must say so — a page with a title and nothing under it reads as a broken page.
  if (pendingCount + decisions.length === 0 && !focused) return null

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
      <SectionLabel>
        {pendingCount > 0 ? `Inbox · ${pendingCount} awaiting you` : 'Inbox'}
      </SectionLabel>
      {/* AUDIT-ACT1 UX-2 — the pending queue is the LOUD surface. It carries an accent
          left edge that the decided tail deliberately lacks, so "needs me now" is
          legible from across the room and not merely first in the DOM. */}
      <Card style={{ paddingTop: 0, paddingBottom: 0, ...(pendingCount > 0 ? s.pendingCard : null) }}>
        {pendingCount === 0 && (
          <p style={{ ...sx.empty, padding: `${space.lg}px 0` }}>
            Nothing needs a decision right now.{decisions.length > 0 ? ' Recent decisions are below.' : ''}
          </p>
        )}
        {approvals.map(a => {
          // Epic P / P1 — a low-trust review case is a QUARANTINE hold, not a
          // routine approval. Distinct chip (🛡, icon+text+shape — never color
          // alone) + the machine-rendered warnings, but the same tri-state loop.
          const review = isReviewCase(a.type)
          // ONB6 — an agent asking to join (ONB3's board-approval card) reads
          // distinctly from a routine approval, and its machine-generated warnings
          // (self-declared/unverified, containment, host-exec, secrets) surface here
          // too — the same tri-state loop, no forked UI.
          const join = isJoinRequestApproval(a.type)
          // APPR-1 — a DANGEROUS approval (or one whose payload flags step-up) cannot
          // be approved in one click: the button opens the step-up dialog instead, and
          // is labelled so the operator knows a confirmation step is coming. Its
          // machine-rendered warnings surface here too, not only inside the dialog.
          const dangerous = approvalNeedsStepUp(a)
          const warnings: string[] = (review || join || dangerous) && Array.isArray(a.payload?.warnings) ? a.payload.warnings : []
          const busy = deciding?.has(a.id) ?? false
          const err = decideErr?.[a.id]
          return (
          <div key={a.id}>
            <div style={sx.row}>
              <span style={{ ...sx.tag, background: dangerous ? 'var(--danger-bg)' : review || join ? 'var(--warning-dim)' : 'var(--accent-dim)', color: dangerous ? 'var(--danger-text)' : review || join ? 'var(--warning-text)' : EXT_PURPLE }}>
                {dangerous ? `⚠ ${a.type}` : review ? '🛡 Low-trust review' : join ? `${joinRequestChip().icon} ${joinRequestChip().label}` : `Approval · ${a.type}`}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.summary}>{a.summary}</div>
                {/* ACT-1 — who asked, and how long it has been waiting. Both were on the
                    wire already and only the phone showed them; an approval with no age
                    gives the operator no way to tell a fresh ask from a stale one. */}
                {(agentName(a.requestedByAgentId) || ageOf(a.createdAt) || dangerous) && (
                  <div style={{ fontSize: text.xs.fontSize, color: tk.muted, marginTop: 2, display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
                    {agentName(a.requestedByAgentId) && <span>from {agentName(a.requestedByAgentId)}</span>}
                    {ageOf(a.createdAt) && <span>{ageOf(a.createdAt)}</span>}
                    {dangerous && <span style={{ color: 'var(--danger-text)' }}>needs step-up confirmation</span>}
                  </div>
                )}
              </div>
              <Button style={{ color: tk.accent }} disabled={busy} onClick={() => onDecide(a.id, 'approved')}
                title={dangerous ? 'Dangerous action — requires step-up confirmation' : undefined}>
                {busy ? 'Working…' : dangerous ? '✓ Approve…' : '✓ Approve'}
              </Button>
              <Button style={{ color: tk.accent }} disabled={busy} onClick={() => { setRevising(r => r === a.id ? null : a.id); setNote('') }}>↩ Request changes</Button>
              <Button style={{ color: tk.red }} disabled={busy} onClick={() => onDecide(a.id, 'rejected')}>✕ Reject</Button>
            </div>
            {/* A decision that did not land is stated plainly, on the card that failed. */}
            {err && <div style={s.errLine} role="alert" title={err}>{err}</div>}
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

      {/* ACT-1 — RECENTLY DECIDED. Separated from the queue by its own heading rather
          than mixed in, because the whole job of this screen is telling "needs a
          decision now" apart from "already answered". Read-only by design: an answered
          approval has no buttons, so there is nothing here to double-decide.
          The rows come from the activity feed, so they carry the server's projection —
          no payload, no decision note. */}
      {decisions.length > 0 && (
        <div style={{ marginTop: space.lg }}>
          {/* AUDIT-ACT1 UX-2 — DE-EMPHASISED, deliberately. This shipped with the same
              row height, font and card chrome as the pending queue, so a quiet inbox
              read as roughly 80% "already handled" and the eye had no way to find the
              one thing that actually wanted a decision. Answered work is reference
              material: smaller type, muted colour, a denser row, a recessed card, and a
              heading that says so. It stays fully readable — de-emphasis, not hiding. */}
          <SectionLabel style={{ color: tk.muted, fontWeight: 600 }}>
            Recently decided · already handled
          </SectionLabel>
          <Card style={{ paddingTop: 0, paddingBottom: 0, ...s.decidedCard }}>
            {decisions.map(d => (
              <div key={d.id} style={s.decidedRow}>
                <span aria-hidden style={{ width: 14, textAlign: 'center', flexShrink: 0, opacity: 0.7 }}>⚖</span>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.title}>{d.title}</div>
                {d.target && <span style={{ ...sx.badge, flexShrink: 0, fontWeight: 500, opacity: 0.8 }}>{d.target}</span>}
                {d.agentName && <span style={{ ...sx.badge, flexShrink: 0, opacity: 0.8 }}>{d.agentName}</span>}
                <Pill tone={OUTCOME_TONE[d.outcome] ?? 'muted'} style={{ flexShrink: 0, opacity: 0.85 }}>{outcomeLabel(d.kind, d.outcome)}</Pill>
                <span style={{ color: tk.mutedSoft, fontSize: text.xs.fontSize, flexShrink: 0, width: 70, textAlign: 'right' }}>{activityAgo(d.at, now)}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // AUDIT-ACT1 UX-2 — the loud/quiet pair. The accent edge marks the queue that wants a
  // decision; the decided tail is recessed and denser so the two never read as peers.
  pendingCard: { borderLeft: '3px solid var(--accent)' },
  decidedCard: { background: 'transparent', borderStyle: 'dashed', opacity: 0.9 },
  decidedRow: {
    display: 'flex', alignItems: 'center', gap: space.md, boxSizing: 'border-box',
    minHeight: 24, padding: '2px 0', borderBottom: `1px solid ${tk.lineSoft}`,
    fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, color: tk.textDim,
  },
  // Failure evidence: muted, monospace-ish, single-line clamp (full text on hover).
  errLine: { fontSize: text.xs.fontSize, color: 'var(--danger-text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace' },
  // Low-trust review warnings — amber, iconed (⚠), indented under the case.
  warnLine: { fontSize: text.xs.fontSize, color: 'var(--warning-text)', paddingLeft: space.md },
}
