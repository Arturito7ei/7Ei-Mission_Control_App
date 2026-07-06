'use client'
// MCA-80 — kanban task board (read-only, priority-coloured left border).
import { tk, density, text, space } from '../tokens'
import { SectionLabel } from '../ui'
import { PRI_C, type CTask } from './shared'

const COLS: { key: string; label: string }[] = [
  { key: 'todo', label: 'To do' }, { key: 'in_progress', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' }, { key: 'done', label: 'Done' },
]

export default function TaskBoard({ tasks, agentName }: { tasks: CTask[]; agentName: (id: string) => string }) {
  return (
    <div>
      <SectionLabel>Task board</SectionLabel>
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
                return (
                  <div key={t.id} style={{ background: tk.surfaceHigh, border: `1px solid ${tk.line}`, borderLeft: `3px solid ${PRI_C[t.priority] ?? 'var(--muted)'}`, borderRadius: tk.r.sm, padding: `${density.cellY}px ${density.cellX}px`, marginBottom: space.sm }}>
                    <div style={{ fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight }}>
                      {needsRecovery ? <span aria-label="needs recovery" title="Needs recovery" style={{ color: tk.red, marginRight: 4 }}>⚠</span> : null}{t.title}
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
