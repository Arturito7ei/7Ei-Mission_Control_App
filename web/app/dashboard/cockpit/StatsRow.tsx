'use client'
// MCA-80 — cockpit summary stats. MCA-81 — variant A (approved mockup): dense
// single-row auto-fit KPI strip — agents by heartbeat, task pipeline, spend vs
// budget, approvals pending. Derived entirely from data CockpitPanel already
// loads; renders Skeleton cells while the initial load is in flight.
import type { CSSProperties, ReactNode } from 'react'
import { tk, text, space } from '../tokens'
import { Skeleton } from '../ui'
import { HB, type Budget, type CAgent } from './shared'

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: space.md }
// 8px/10px cell padding per the approved mockup (10 has no token step).
const cell: CSSProperties = { background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, padding: `${space.md}px 10px`, display: 'flex', flexDirection: 'column', gap: space.xxs, minWidth: 0 }
const label: CSSProperties = { fontSize: text.xs.fontSize, lineHeight: text.xs.lineHeight, color: tk.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }
const value: CSSProperties = { fontSize: text.lg.fontSize, lineHeight: text.lg.lineHeight, fontWeight: 800, color: tk.text, whiteSpace: 'nowrap', display: 'flex', alignItems: 'baseline', gap: space.sm, overflow: 'hidden' }
const sub: CSSProperties = { fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight, fontWeight: 700 }

function Cell({ l, children }: { l: string; children: ReactNode }) {
  return (
    <div style={cell}>
      <span style={label}>{l}</span>
      <span style={value}>{children}</span>
    </div>
  )
}

export default function StatsRow({ sum, agents, budgets, approvalsPending, loading }: {
  sum: Record<string, number>
  agents: CAgent[] | null
  budgets: Budget[]
  approvalsPending: number
  loading?: boolean
}) {
  if (loading) {
    return (
      <div style={grid}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={cell}>
            <Skeleton w={72} h={11} />
            <Skeleton w={116} h={18} style={{ marginTop: 2 }} />
          </div>
        ))}
      </div>
    )
  }

  const live = (agents ?? []).filter(a => a.status !== 'terminated')
  const hb = (k: string) => live.filter(a => a.heartbeat === k).length
  const company = budgets.find(b => b.scope === 'company')
  const spend = company ? company.spend : budgets.reduce((s, b) => s + b.spend, 0)
  const limit = company ? company.limitUsd : budgets.reduce((s, b) => s + b.limitUsd, 0)

  return (
    <div style={grid}>
      <Cell l="Agents">
        {sum.agents ?? live.length}
        <span style={{ ...sub, color: HB.green }}>{hb('green')}</span>
        <span style={{ ...sub, color: HB.amber }}>{hb('amber')}</span>
        <span style={{ ...sub, color: HB.stale }}>{hb('stale')}</span>
      </Cell>
      <Cell l="Tasks">
        <span style={{ ...sub, color: tk.textDim }}>{sum.todo ?? 0} todo</span>
        <span style={{ color: tk.mutedSoft }}>·</span>
        <span style={{ ...sub, color: tk.blue }}>{sum.in_progress ?? 0} running</span>
        <span style={{ color: tk.mutedSoft }}>·</span>
        <span style={{ ...sub, color: tk.green }}>{sum.done ?? 0} done</span>
      </Cell>
      <Cell l="Spend today">
        <span style={{ color: tk.accent }}>${spend.toFixed(2)}</span>
        <span style={{ ...sub, color: tk.muted }}>/ {budgets.length ? `$${limit.toFixed(0)} budget` : 'no budget'}</span>
      </Cell>
      <Cell l="Approvals pending">
        <span style={{ color: approvalsPending > 0 ? tk.accent : tk.muted }}>{approvalsPending}</span>
      </Cell>
    </div>
  )
}
