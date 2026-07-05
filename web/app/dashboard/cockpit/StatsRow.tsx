'use client'
// MCA-80 — cockpit summary stat cards (agents / external / in-progress / done).
import { tk, text, space } from '../tokens'
import { Card } from '../ui'
import { EXT_PURPLE } from './shared'

export default function StatsRow({ sum }: { sum: Record<string, number> }) {
  const stats = [
    { l: 'Agents', v: sum.agents ?? 0, c: tk.text },
    { l: 'External', v: sum.external ?? 0, c: EXT_PURPLE },
    { l: 'In progress', v: sum.in_progress ?? 0, c: tk.blue },
    { l: 'Done', v: sum.done ?? 0, c: tk.green },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: space.lg }}>
      {stats.map(k => (
        <Card key={k.l} style={{ display: 'flex', flexDirection: 'column', gap: space.xs, padding: space.lg }}>
          <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1, color: k.c }}>{k.v}</span>
          <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{k.l}</span>
        </Card>
      ))}
    </div>
  )
}
