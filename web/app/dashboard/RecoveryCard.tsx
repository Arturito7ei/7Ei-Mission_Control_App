'use client'
// MCA-83 W1 — recovery card. The prominent, structured "this needs a decision"
// surface for a failed / stalled / blocked task. Red left border + ⚠ heading
// (prominence through placement, never red as a CTA — DESIGN_SYSTEM v2 rule 4:
// the action button is purple). Stays visible until the task leaves its failure
// state, so it reads as open-until-decision.
import { tk, text, space } from './tokens'
import { statusColor, statusIcon } from './status'
import { Button } from './ui'

export type Recovery = {
  reason: 'failed' | 'orphaned' | 'blocked'
  ownerAgentId: string | null
  ownerName: string | null
  ownerEmoji: string | null
  sourceRunId: string | null
  sourceRunStatus: string | null
  evidence: string | null
  nextAction: string
  since: number | null
  blockerCount: number
}

const HEADING: Record<Recovery['reason'], string> = {
  failed: 'Run failed — needs recovery',
  orphaned: 'Agent went silent — needs recovery',
  blocked: 'Blocked — needs a decision',
}

const fmtSince = (t: number | null): string => {
  if (!t) return ''
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 90) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 90) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 36) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export default function RecoveryCard({ rec, retrying, onRetry, onAddNote }: {
  rec: Recovery
  retrying?: boolean
  onRetry?: () => void
  onAddNote?: () => void
}) {
  const owner = rec.ownerName || (rec.ownerAgentId ? rec.ownerAgentId.slice(0, 8) : '—')
  return (
    <section style={s.card} role="alert" aria-label="Recovery required">
      <div style={s.head}>
        <span aria-hidden style={s.warnIcon}>⚠</span>
        <span style={s.title}>{HEADING[rec.reason]}</span>
        {rec.since ? <span style={s.since}>open · {fmtSince(rec.since)}</span> : null}
      </div>

      <dl style={s.grid}>
        <Field label="Owner"><span>{rec.ownerEmoji ? `${rec.ownerEmoji} ` : ''}{owner}</span></Field>
        {rec.reason === 'blocked'
          ? <Field label="Blocked by"><span>{rec.blockerCount} upstream task{rec.blockerCount === 1 ? '' : 's'}</span></Field>
          : rec.sourceRunStatus
            ? <Field label="Source run">
                <span style={{ color: statusColor(rec.sourceRunStatus), fontWeight: 700 }}>{statusIcon(rec.sourceRunStatus)} {rec.sourceRunStatus}</span>
                {rec.sourceRunId ? <span style={s.muted}> · {rec.sourceRunId.slice(0, 8)}</span> : null}
              </Field>
            : null}
        <Field label="Next action"><span>{rec.nextAction}</span></Field>
      </dl>

      {rec.evidence ? (
        <div>
          <div style={s.evLabel}>Evidence</div>
          <div style={s.evidence}>{rec.evidence}</div>
        </div>
      ) : null}

      <div style={s.actions}>
        {rec.reason !== 'blocked' && onRetry ? (
          <Button variant="primary" disabled={retrying} onClick={onRetry}>{retrying ? 'Retrying…' : 'Retry run'}</Button>
        ) : null}
        {onAddNote ? <Button variant="default" onClick={onAddNote}>Add a note</Button> : null}
      </div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.field}>
      <dt style={s.dt}>{label}</dt>
      <dd style={s.dd}>{children}</dd>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // Red LEFT border + danger tint: prominent by placement, not a red action fill.
  card: { borderLeft: '4px solid var(--brand-red)', border: '1px solid var(--danger-line)', borderLeftWidth: 4, background: 'var(--danger-bg)', borderRadius: tk.r.md, padding: space.lg, marginBottom: space.xl, display: 'flex', flexDirection: 'column', gap: space.md },
  head: { display: 'flex', alignItems: 'center', gap: space.sm },
  warnIcon: { color: tk.red, fontSize: text.lg.fontSize },
  title: { color: tk.red, fontWeight: 700, fontSize: text.md.fontSize, lineHeight: text.md.lineHeight, flex: 1 },
  since: { color: tk.muted, fontSize: text.xs.fontSize, whiteSpace: 'nowrap' },
  grid: { display: 'flex', flexDirection: 'column', gap: space.xs, margin: 0 },
  field: { display: 'grid', gridTemplateColumns: '92px 1fr', gap: space.md, alignItems: 'baseline' },
  dt: { color: tk.muted, fontSize: text.xs.fontSize, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 },
  dd: { margin: 0, color: tk.text, fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight },
  muted: { color: tk.muted, fontSize: text.xs.fontSize },
  evLabel: { color: tk.muted, fontSize: text.xs.fontSize, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: space.xs },
  evidence: { fontFamily: 'monospace', fontSize: text.sm.fontSize, color: tk.textDim, background: tk.bg, border: `1px solid var(--danger-line)`, borderRadius: tk.r.sm, padding: space.md, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto' },
  actions: { display: 'flex', gap: space.md, marginTop: space.xs },
}
