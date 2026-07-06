'use client'
// MCA-80 — kanban task board (read-only, priority-coloured left border).
// MCA-83 W2 — "Next up" banner: the single task the office should pick up next
// (backend-ranked: unblocked, highest priority, oldest first), and its card is
// flagged in the To-do column so the queue reads as a queue, not four buckets.
import { tk, density, text, space } from '../tokens'
import { SectionLabel } from '../ui'
import { PRI_C, type CTask, type NextUp } from './shared'

const COLS: { key: string; label: string }[] = [
  { key: 'todo', label: 'To do' }, { key: 'in_progress', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' }, { key: 'done', label: 'Done' },
]

export default function TaskBoard({ tasks, agentName, nextUp }: { tasks: CTask[]; agentName: (id: string) => string; nextUp?: NextUp | null }) {
  return (
    <div>
      <SectionLabel>Task board</SectionLabel>
      {nextUp && (
        <div style={s.nextUp}>
          <span aria-hidden>▶</span>
          <span style={s.nextUpLabel}>Next up</span>
          <span style={s.nextUpTitle}>{nextUp.title}</span>
          <span style={s.nextUpAgent}>{agentName(nextUp.agentId ?? '')}</span>
          {nextUp.blockedCleared > 0 && <span style={s.nextUpMeta} title="upstream blockers cleared">✓ {nextUp.blockedCleared} unblocked</span>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: space.lg }}>
        {COLS.map(col => {
          const items = tasks.filter(t => (t.kanbanColumn ?? 'todo') === col.key)
          return (
            <div key={col.key} style={{ background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.md, padding: space.md, minHeight: 80 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: text.xs.fontSize, textTransform: 'uppercase', letterSpacing: 0.5, color: tk.muted, fontWeight: 700, marginBottom: space.sm }}>
                {col.label}
                <span style={{ background: tk.surfaceHigh, border: '1px solid var(--line-strong)', borderRadius: tk.r.pill, padding: '0 7px', fontSize: text.xs.fontSize }}>{items.length}</span>
              </div>
              {items.map(t => {
                // W1: flag cards that have an open recovery card in the drawer.
                const needsRecovery = t.status === 'failed' || t.status === 'blocked' || col.key === 'blocked'
                const isNext = nextUp?.id === t.id
                return (
                  <div key={t.id} style={{ background: tk.surfaceHigh, border: isNext ? '1px solid var(--accent)' : `1px solid ${tk.line}`, boxShadow: isNext ? '0 0 0 1px var(--accent)' : undefined, borderLeft: `3px solid ${PRI_C[t.priority] ?? 'var(--muted)'}`, borderRadius: tk.r.sm, padding: `${density.cellY}px ${density.cellX}px`, marginBottom: space.sm }}>
                    <div style={{ fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight }}>
                      {needsRecovery ? <span aria-label="needs recovery" title="Needs recovery" style={{ color: tk.red, marginRight: 4 }}>⚠</span> : null}
                      {isNext ? <span aria-label="next up" title="Next up" style={{ color: tk.accent, marginRight: 4 }}>▶</span> : null}{t.title}
                    </div>
                    <div style={{ fontSize: text.xs.fontSize, color: tk.muted, marginTop: 2 }}>{agentName(t.agentId)}</div>
                  </div>
                )
              })}
              {items.length === 0 && <div style={{ color: tk.muted, fontSize: text.sm.fontSize, padding: space.xs }}>—</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // Accent (purple) tint, never a color-only signal — ▶ glyph + "Next up" label.
  nextUp: { display: 'flex', alignItems: 'center', gap: space.md, background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: tk.r.md, padding: `${space.sm}px ${space.lg}px`, marginBottom: space.md, color: tk.accent, fontSize: text.sm.fontSize },
  nextUpLabel: { fontSize: text.xs.fontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 },
  nextUpTitle: { flex: 1, color: tk.text, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  nextUpAgent: { color: tk.muted, fontSize: text.xs.fontSize, whiteSpace: 'nowrap' },
  nextUpMeta: { color: tk.accent, fontSize: text.xs.fontSize, fontWeight: 700, whiteSpace: 'nowrap' },
}
