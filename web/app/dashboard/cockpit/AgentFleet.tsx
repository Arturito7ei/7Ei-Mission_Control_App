'use client'
// MCA-80 — live agent roster: heartbeat dot (green/amber/stale, grey when
// terminated) + pause/resume/terminate controls. `agents` is null while the
// cockpit payload loads so the empty state only shows after data arrives.
import { tk, text, space } from '../tokens'
import { Card, IconButton, SectionLabel } from '../ui'
import { HB, RUNTIME_BADGE, sx, type CAgent } from './shared'

export default function AgentFleet({ agents, onControl }: {
  agents: CAgent[] | null
  onControl: (id: string, verb: 'pause' | 'resume' | 'terminate') => void
}) {
  return (
    <div>
      <SectionLabel>Agent fleet</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: space.lg }}>
        {(agents ?? []).map(a => (
          <Card key={a.id} style={{ display: 'flex', alignItems: 'center', gap: space.lg, padding: space.lg }}>
            <span style={{ fontSize: 24 }}>{a.avatarEmoji || '🤖'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: text.lg.fontSize, display: 'flex', alignItems: 'center', gap: space.sm }}>
                {a.name}
                <span title={a.runtime} style={sx.badge}>{RUNTIME_BADGE[a.runtime] ?? '⚙️'} {a.runtime}</span>
              </div>
              <div style={{ fontSize: text.sm.fontSize, color: tk.muted, marginTop: 2 }}>{a.role}</div>
              <div style={{ fontSize: text.xs.fontSize, color: tk.mutedSoft, marginTop: 2 }}>{a.llmProvider} · {a.llmModel}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: space.sm, flexShrink: 0 }}>
              <span title={`heartbeat: ${a.heartbeat}`} style={{ width: 10, height: 10, borderRadius: 5, background: a.status === 'terminated' ? '#444' : (HB[a.heartbeat] ?? '#555') }} />
              <div style={{ display: 'flex', gap: space.xs }}>
                {a.status === 'paused'
                  ? <IconButton title="Resume" aria-label={`Resume ${a.name}`} onClick={() => onControl(a.id, 'resume')}>▶</IconButton>
                  : <IconButton title="Pause" aria-label={`Pause ${a.name}`} onClick={() => onControl(a.id, 'pause')}>⏸</IconButton>}
                <IconButton title="Terminate" aria-label={`Terminate ${a.name}`} onClick={() => onControl(a.id, 'terminate')}>⏹</IconButton>
              </div>
            </div>
          </Card>
        ))}
        {agents && agents.length === 0 && <p style={sx.empty}>No agents yet — add one.</p>}
      </div>
    </div>
  )
}
