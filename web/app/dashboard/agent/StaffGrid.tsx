'use client'
// Epic AG / AG7 — the Staff grid: a card per agent (avatar · name · handle ·
// status dot · Tasks Active / Token Cost today / Last active), matching the
// operator's mockup with design tokens only (glass fill + purple accent ring —
// no raw hex).
//
// Colorblind-safety (DESIGN_SYSTEM v2 rule 3): the dot is never the only signal.
// Each card renders shape + text label next to the colour, and the whole card
// carries an aria-label saying the state out loud.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Skeleton } from '../ui'
import { tk, text, space } from '../tokens'
import { AgentAvatar, ax, type Getter } from './shared'

export type StaffCard = {
  id: string
  name: string
  role: string
  title: string | null
  handle: string
  avatarEmoji: string | null
  avatarUrl: string | null
  runtime: string | null
  status: string
  state: 'running' | 'attention' | 'ok'
  stateLabel: string
  activeTasks: number
  costTodayUsd: number
  tokensToday: number
  lastActiveAt: number | null
}

// Shape + colour per state. Blue = running, yellow = attention, green = idle-ok —
// the mockup's palette, mapped onto theme tokens.
const STATE: Record<StaffCard['state'], { color: string; icon: string }> = {
  running: { color: 'var(--info)', icon: '⬡' },
  attention: { color: 'var(--warn)', icon: '⚠' },
  ok: { color: 'var(--ok)', icon: '✓' },
}

const ago = (ms: number | null): string => {
  if (ms == null) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const money = (n: number) => (n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

export default function StaffGrid({ orgId, getToken, onOpenAgent }: {
  orgId: string
  getToken: Getter
  onOpenAgent: (agentId: string) => void
}) {
  const [staff, setStaff] = useState<StaffCard[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const { staff: s } = await api<{ staff: StaffCard[] }>(`/api/orgs/${orgId}/staff`, { token: await getToken() })
      setStaff(s)
    } catch (e: any) { setErr(e?.message ?? 'Could not load the staff.') }
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  if (err && !staff) return <div style={ax.err}>{err}</div>
  if (!staff) return (
    <div style={grid}>
      {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} h={280} style={{ borderRadius: 16 }} />)}
    </div>
  )
  if (staff.length === 0) return <p style={ax.empty}>No agents yet — hire one from the Operations cockpit.</p>

  return (
    <div style={grid}>
      {staff.map(a => {
        const st = STATE[a.state]
        return (
          <article key={a.id} className="mc-glass" role="button" tabIndex={0}
            aria-label={`${a.name}, ${a.title || a.role}. ${a.stateLabel}. ${a.activeTasks} active task${a.activeTasks === 1 ? '' : 's'}.`}
            onClick={() => onOpenAgent(a.id)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenAgent(a.id) } }}
            style={{
              display: 'flex', flexDirection: 'column', gap: space.lg, cursor: 'pointer',
              border: `1px solid var(--accent-line)`, borderRadius: 16, padding: space.xl,
              boxShadow: `0 0 0 1px var(--accent-glow)`, position: 'relative', overflow: 'hidden',
            }}>

            {/* Name + handle + status dot */}
            <header style={{ display: 'flex', alignItems: 'flex-start', gap: space.md }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: -0.3, color: tk.text, textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.name}
                </h3>
                <div style={{ fontSize: text.sm.fontSize, color: tk.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.handle}</div>
              </div>
              {/* Dot + shape + label — never colour alone. */}
              <span title={a.stateLabel} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <span aria-hidden="true" style={{
                  width: 22, height: 22, borderRadius: '50%', background: st.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--s0)', fontSize: 12, fontWeight: 800, lineHeight: 1,
                }}>{st.icon}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color: st.color, letterSpacing: 0.4, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                  {a.stateLabel}
                </span>
              </span>
            </header>

            {/* Avatar — the uploaded picture, else the icon/emoji */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: `${space.sm}px 0` }}>
              <AgentAvatar agent={a} size={132} radius={14} />
            </div>

            <div style={{ fontSize: text.xs.fontSize, color: tk.muted, textAlign: 'center', marginTop: -space.sm }}>
              {a.title || a.role}
            </div>

            {/* Metric chips */}
            <footer style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap', marginTop: 'auto' }}>
              <Chip label="Tasks Active" value={String(a.activeTasks)} tone={a.activeTasks > 0 ? 'var(--accent)' : tk.muted} />
              <Chip label="Token Cost today" value={money(a.costTodayUsd)} tone={a.costTodayUsd > 0 ? 'var(--accent)' : tk.muted} />
              <Chip label="Last active" value={ago(a.lastActiveAt)} tone={tk.muted} />
            </footer>
          </article>
        )
      })}
    </div>
  )
}

function Chip({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: space.xs,
      border: `1px solid ${tk.line}`, borderRadius: tk.r.pill, padding: `3px ${space.md}px`,
      background: tk.surfaceHigh, fontSize: text.xs.fontSize, whiteSpace: 'nowrap',
    }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: tone, flexShrink: 0 }} />
      <span style={{ color: tk.muted }}>{label}</span>
      <strong style={{ color: tk.text }}>{value}</strong>
    </span>
  )
}

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: space.xl,
}
