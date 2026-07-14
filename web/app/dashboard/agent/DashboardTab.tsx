'use client'
// Epic AG / AG2 — the agent Dashboard tab: latest run, four 14-day mini charts,
// recent tasks, and the costs strip. All numbers come from the backend's pure
// `buildAgentOverview` — this file only renders.
//
// Colorblind rules (DESIGN_SYSTEM v2): every chart series carries a text label
// and a shape/icon, never color alone; success is accent-purple (not green) and
// red is reserved for failure.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Card, Skeleton } from '../ui'
import { tk, text, space } from '../tokens'
import { statusColor, statusIcon } from '../status'
import { ax, type Getter } from './shared'

type Overview = {
  agentId: string
  days: number
  latestRun: { id: string; status: string; taskId: string | null; summary: string; startedAt: number | null; endedAt: number | null } | null
  runActivity: { date: string; total: number; succeeded: number; failed: number }[]
  successRate: { date: string; pct: number | null; settled: number }[]
  tasksByPriority: { key: string; count: number }[]
  tasksByStatus: { key: string; count: number }[]
  costs: { inputTokens: number; outputTokens: number; cachedTokens: number; totalTokens: number; totalCostUsd: number; taskCount: number; hasSplit: boolean }
}
type RecentTask = { id: string; title: string; status: string; priority: string; createdAt: number | null }

/** "8d ago" / "3h ago" / "just now" — compact and locale-free. */
function ago(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const dayLabel = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

export default function DashboardTab({ orgId, agentId, getToken, onViewRuns, onOpenTask }: {
  orgId: string
  agentId: string
  getToken: Getter
  onViewRuns: () => void
  onOpenTask?: (taskId: string) => void
}) {
  const [data, setData] = useState<{ overview: Overview; recentTasks: RecentTask[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setData(await api(`/api/orgs/${orgId}/agents/${agentId}/overview`, { token: await getToken() }))
    } catch (e: any) { setErr(e?.message ?? 'Could not load this agent’s dashboard.') }
  }, [orgId, agentId, getToken])

  useEffect(() => { load() }, [load])

  if (err) return <div style={ax.err}>{err}</div>
  if (!data) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
      <Skeleton h={84} /><Skeleton h={140} /><Skeleton h={120} />
    </div>
  )

  const { overview: o, recentTasks } = data
  const lr = o.latestRun

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xl }}>

      {/* ── Latest run ─────────────────────────────────────────────────── */}
      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.sm }}>
          <h2 style={ax.sectionTitle}>Latest Run</h2>
          {lr && <button onClick={onViewRuns} style={linkBtn}>View details →</button>}
        </div>
        <Card>
          {!lr ? <p style={ax.empty}>This agent has not run yet.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
                <span style={{ color: statusColor(lr.status), fontWeight: 700, fontSize: text.sm.fontSize }}>
                  <span aria-hidden="true">{statusIcon(lr.status)}</span> {lr.status}
                </span>
                <code style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{lr.id.slice(0, 8)}</code>
                <span style={{ marginLeft: 'auto', fontSize: text.xs.fontSize, color: tk.muted }}>{ago(lr.startedAt)}</span>
              </div>
              <p style={{ margin: 0, fontSize: text.md.fontSize, color: tk.text, lineHeight: 1.5 }}>{lr.summary}</p>
            </div>
          )}
        </Card>
      </section>

      {/* ── Mini charts ────────────────────────────────────────────────── */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: space.lg }}>
        <ChartCard title="Run Activity" days={o.days}>
          <Columns
            bars={o.runActivity.map(d => ({ label: dayLabel(d.date), value: d.total, title: `${d.date}: ${d.total} run(s), ${d.succeeded} succeeded, ${d.failed} failed` }))} />
          <Legend items={[
            { icon: '✓', label: 'Succeeded', color: tk.green, value: o.runActivity.reduce((s, d) => s + d.succeeded, 0) },
            { icon: '✕', label: 'Failed', color: tk.red, value: o.runActivity.reduce((s, d) => s + d.failed, 0) },
          ]} />
        </ChartCard>

        <ChartCard title="Tasks by Priority" days={o.days}>
          <Distribution rows={o.tasksByPriority} empty="No tasks in this window." tone={k => PRIORITY_TONE[k] ?? tk.muted} />
        </ChartCard>

        <ChartCard title="Tasks by Status" days={o.days}>
          <Distribution rows={o.tasksByStatus} empty="No tasks in this window." tone={k => statusColor(k)} icon={k => statusIcon(k)} />
        </ChartCard>

        <ChartCard title="Success Rate" days={o.days}>
          <Columns max={100}
            bars={o.successRate.map(d => ({
              label: dayLabel(d.date),
              value: d.pct ?? 0,
              muted: d.pct == null, // no settled run that day = no data, not 0%
              title: d.pct == null ? `${d.date}: no settled runs` : `${d.date}: ${d.pct}% of ${d.settled} run(s)`,
            }))} />
          <Legend items={[{ icon: '⬡', label: 'Settled runs', color: tk.accent, value: o.successRate.reduce((s, d) => s + d.settled, 0) }]} />
        </ChartCard>
      </section>

      {/* ── Recent tasks ───────────────────────────────────────────────── */}
      <section>
        <h2 style={{ ...ax.sectionTitle, marginBottom: space.sm }}>Recent Tasks</h2>
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {recentTasks.length === 0 && <p style={{ ...ax.empty, padding: space.lg }}>No tasks assigned to this agent yet.</p>}
          {recentTasks.map((t, i) => (
            <div key={t.id} role={onOpenTask ? 'button' : undefined} tabIndex={onOpenTask ? 0 : undefined}
              onClick={() => onOpenTask?.(t.id)}
              onKeyDown={e => { if (e.key === 'Enter') onOpenTask?.(t.id) }}
              style={{
                display: 'flex', alignItems: 'center', gap: space.lg, padding: `${space.md}px ${space.lg}px`,
                borderTop: i === 0 ? 'none' : `1px solid ${tk.line}`, cursor: onOpenTask ? 'pointer' : 'default',
              }}>
              <code style={{ fontSize: text.xs.fontSize, color: tk.muted, flexShrink: 0 }}>{t.id.slice(0, 6)}</code>
              <span style={{ flex: 1, minWidth: 0, fontSize: text.md.fontSize, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              <span style={{ color: statusColor(t.status), fontSize: text.xs.fontSize, fontWeight: 700, flexShrink: 0 }}>
                <span aria-hidden="true">{statusIcon(t.status)}</span> {t.status}
              </span>
            </div>
          ))}
        </Card>
      </section>

      {/* ── Costs ──────────────────────────────────────────────────────── */}
      <section>
        <h2 style={{ ...ax.sectionTitle, marginBottom: space.sm }}>Costs</h2>
        <Card style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: space.lg }}>
          {/* The split is null for tasks recorded before AG2 — show — not a fake 0. */}
          <Stat label="Input tokens" value={o.costs.hasSplit ? o.costs.inputTokens.toLocaleString() : '—'} />
          <Stat label="Output tokens" value={o.costs.hasSplit ? o.costs.outputTokens.toLocaleString() : '—'} />
          <Stat label="Cached tokens" value={o.costs.hasSplit ? o.costs.cachedTokens.toLocaleString() : '—'} />
          <Stat label="Total tokens" value={o.costs.totalTokens.toLocaleString()} />
          <Stat label="Total cost" value={`$${o.costs.totalCostUsd.toFixed(2)}`} accent />
        </Card>
        {!o.costs.hasSplit && o.costs.totalTokens > 0 && (
          <p style={{ ...ax.empty, marginTop: space.sm, fontSize: text.xs.fontSize }}>
            The input/output/cached split is recorded from this release onward; earlier tasks carry only the total.
          </p>
        )}
      </section>
    </div>
  )
}

// ─── chart primitives ────────────────────────────────────────────────────────

const PRIORITY_TONE: Record<string, string> = {
  critical: 'var(--danger-text)', high: 'var(--warning-text)', medium: 'var(--accent)', low: 'var(--muted)',
}

function ChartCard({ title, days, children }: { title: string; days: number; children: React.ReactNode }) {
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
      <div>
        <div style={{ fontSize: text.sm.fontSize, fontWeight: 700, color: tk.text }}>{title}</div>
        <div style={{ fontSize: text.xs.fontSize, color: tk.muted }}>Last {days} days</div>
      </div>
      {children}
    </Card>
  )
}

/** 14 day columns. `muted` marks a no-data day so it never reads as a real zero. */
function Columns({ bars, max }: { bars: { label: string; value: number; title: string; muted?: boolean }[]; max?: number }) {
  const peak = max ?? Math.max(1, ...bars.map(b => b.value))
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 68 }} role="img"
        aria-label={bars.map(b => b.title).join('; ')}>
        {bars.map((b, i) => (
          <div key={i} title={b.title} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
            <div style={{
              width: '100%',
              height: `${Math.max((b.value / peak) * 100, b.value > 0 ? 6 : 0)}%`,
              minHeight: b.muted ? 2 : 0,
              background: b.muted ? tk.line : tk.accent,
              borderRadius: 2,
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: space.xs, fontSize: text.xs.fontSize, color: tk.muted }}>
        <span>{bars[0]?.label}</span><span>{bars[Math.floor(bars.length / 2)]?.label}</span><span>{bars.at(-1)?.label}</span>
      </div>
    </div>
  )
}

/** Distribution rows: label + count + proportional bar (label always present). */
function Distribution({ rows, empty, tone, icon }: {
  rows: { key: string; count: number }[]
  empty: string
  tone: (key: string) => string
  icon?: (key: string) => string
}) {
  if (rows.length === 0) return <p style={{ ...ax.empty, fontSize: text.xs.fontSize }}>{empty}</p>
  const peak = Math.max(...rows.map(r => r.count))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
      {rows.map(r => (
        <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          <span style={{ fontSize: text.xs.fontSize, color: tone(r.key), fontWeight: 700, width: 92, textTransform: 'capitalize', flexShrink: 0 }}>
            {icon && <span aria-hidden="true">{icon(r.key)} </span>}{r.key.replace('_', ' ')}
          </span>
          <div style={{ flex: 1, height: 8, background: tk.surfaceHigh, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max((r.count / peak) * 100, 4)}%`, height: '100%', background: tone(r.key), borderRadius: 4 }} />
          </div>
          <span style={{ fontSize: text.xs.fontSize, color: tk.textDim, width: 22, textAlign: 'right', flexShrink: 0 }}>{r.count}</span>
        </div>
      ))}
    </div>
  )
}

function Legend({ items }: { items: { icon: string; label: string; color: string; value: number }[] }) {
  return (
    <div style={{ display: 'flex', gap: space.lg, flexWrap: 'wrap' }}>
      {items.map(it => (
        <span key={it.label} style={{ fontSize: text.xs.fontSize, color: tk.muted }}>
          <span aria-hidden="true" style={{ color: it.color, fontWeight: 700 }}>{it.icon}</span> {it.label} <strong style={{ color: tk.textDim }}>{it.value}</strong>
        </span>
      ))}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 800, color: accent ? tk.accent : tk.text, lineHeight: 1.2 }}>{value}</span>
    </div>
  )
}

const linkBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: tk.accent, cursor: 'pointer',
  fontSize: text.sm.fontSize, fontWeight: 600, padding: 0,
}
