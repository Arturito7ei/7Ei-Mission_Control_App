'use client'
// MCA-84 V1 — heartbeat 24h timeline. One lane per agent, activity blocks
// projected across the last day (data from GET /api/orgs/:id/timeline). Shows
// the office's pulse: who worked, when, on what. Colorblind-safe — blocks are
// coloured on the status table, every block carries a text tooltip/aria-label,
// and a persistent legend keys colour → status; ongoing runs are striped
// (a shape cue, not colour) so "in progress" reads without relying on hue.
import type { CSSProperties } from 'react'
import { tk, text, space } from '../tokens'
import { Card, SectionLabel } from '../ui'
import { statusColor, statusIcon, canonicalStatus, HEARTBEAT_STATUS } from '../status'
import { sx, type Timeline, type TLBlock, type TLLane } from './shared'

const LABEL_COL = 148                                    // fixed left column width
const TRACK_H = 20
const TICKS = [0, 25, 50, 75, 100]                       // percent stops on the axis
const tickLabel = (pct: number) => (pct === 100 ? 'now' : `${Math.round((24 * (100 - pct)) / 100)}h`)

const laneGrid: CSSProperties = { display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: space.lg, alignItems: 'center' }

function dur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
function ago(msAt: number | null, now: number): string {
  if (msAt == null) return 'never'
  const d = now - msAt
  if (d < 0) return 'in ' + dur(-d)
  if (d < 45_000) return 'just now'
  return dur(d) + ' ago'
}

function Block({ b, now }: { b: TLBlock; now: number }) {
  const color = statusColor(b.status)
  const canon = canonicalStatus(b.status)
  const endMs = b.endMs ?? now
  const label = `${b.title} — ${canon}${b.ongoing ? ' (ongoing)' : ''} · ${dur(endMs - b.startMs)}${b.costUsd > 0 ? ` · $${b.costUsd.toFixed(2)}` : ''}`
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        position: 'absolute',
        left: `${b.startPct}%`,
        width: `${b.widthPct}%`,
        top: 0,
        height: '100%',
        background: color,
        borderRadius: 3,
        opacity: 0.9,
        // Ongoing runs get a diagonal stripe overlay — a shape cue for "in
        // progress" that a red-green-colorblind reader can see without hue.
        backgroundImage: b.ongoing
          ? 'repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 3px, transparent 3px 6px)'
          : undefined,
        boxShadow: `0 0 0 0.5px ${color}`,
      }}
    />
  )
}

function Lane({ lane, now }: { lane: TLLane; now: number }) {
  const hb = HEARTBEAT_STATUS[lane.heartbeat] ?? 'idle'
  return (
    <div style={laneGrid}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, fontSize: text.sm.fontSize, fontWeight: 600, color: tk.text }}>
          <span style={{ fontSize: 15 }}>{lane.avatarEmoji || '🤖'}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lane.name}</span>
          <span title={`heartbeat: ${lane.heartbeat}`} aria-label={`heartbeat: ${lane.heartbeat}`}
            style={{ color: statusColor(hb), fontWeight: 700, flexShrink: 0 }}>{statusIcon(hb)}</span>
        </div>
        <div style={{ fontSize: text.xs.fontSize, color: tk.muted, marginTop: 1 }}>
          {lane.runCount > 0
            ? <>{lane.runCount} run{lane.runCount > 1 ? 's' : ''} · {dur(lane.activeMs)}{lane.totalCost > 0 ? ` · $${lane.totalCost.toFixed(2)}` : ''}</>
            : <>idle · last {ago(lane.lastHeartbeatAt, now)}</>}
        </div>
      </div>
      <div style={{ position: 'relative', height: TRACK_H, background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, overflow: 'hidden' }}>
        {/* faint gridlines aligned to the axis ticks */}
        {TICKS.slice(1, -1).map(p => (
          <span key={p} style={{ position: 'absolute', left: `${p}%`, top: 0, bottom: 0, width: 1, background: tk.line }} />
        ))}
        {lane.blocks.map((b, i) => <Block key={b.runId ?? b.taskId ?? i} b={b} now={now} />)}
      </div>
    </div>
  )
}

const LEGEND: Array<[string, string]> = [
  ['active', 'running'], ['done', 'done'], ['failed', 'failed'], ['paused', 'paused'],
]

export default function TimelineSection({ timeline }: { timeline: Timeline | null }) {
  if (!timeline) return null
  const { lanes, now } = timeline
  const anyActivity = lanes.some(l => l.blocks.length > 0)
  return (
    <div>
      <SectionLabel>Heartbeat · last 24h</SectionLabel>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        {/* axis header — tick labels aligned to the track column */}
        <div style={laneGrid}>
          <span />
          <div style={{ position: 'relative', height: 14 }}>
            {TICKS.map(p => (
              <span key={p} style={{ position: 'absolute', left: `${p}%`, transform: p === 100 ? 'translateX(-100%)' : p === 0 ? 'none' : 'translateX(-50%)', fontSize: text.xs.fontSize, color: tk.mutedSoft, fontWeight: 600 }}>
                {tickLabel(p)}
              </span>
            ))}
          </div>
        </div>

        {lanes.map(l => <Lane key={l.agentId} lane={l} now={now} />)}
        {lanes.length === 0 && <p style={sx.empty}>No agents yet.</p>}
        {lanes.length > 0 && !anyActivity && <p style={sx.hint}>No agent activity in the last 24h.</p>}

        {/* legend — colour → status decoder (colorblind-safe), + ongoing cue */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.lg, paddingTop: space.xs, borderTop: `1px solid ${tk.line}` }}>
          {LEGEND.map(([canon, label]) => (
            <span key={canon} style={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, fontSize: text.xs.fontSize, color: tk.muted }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: statusColor(canon), display: 'inline-block' }} />
              {statusIcon(canon)} {label}
            </span>
          ))}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, fontSize: text.xs.fontSize, color: tk.muted }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: statusColor('active'), backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 2px, transparent 2px 4px)', display: 'inline-block' }} />
            striped = ongoing
          </span>
        </div>
      </Card>
    </div>
  )
}
