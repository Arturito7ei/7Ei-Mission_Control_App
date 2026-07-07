'use client'
// MCA-80 — live agent roster + pause/resume/terminate controls. MCA-86: the
// color-only heartbeat dot is now a status icon on the design-system table
// (⬡ active purple / ⏸ paused / ✕ stale-failed) — shape + color, never color
// alone. `agents` is null while the cockpit payload loads so the empty state
// only shows after data arrives.
import { useState } from 'react'
import { tk, text, space } from '../tokens'
import { Button, Card, IconButton, SectionLabel, TextInput } from '../ui'
import { statusColor, statusIcon, HEARTBEAT_STATUS } from '../status'
import { RUNTIME_BADGE, sx, type CAgent } from './shared'

export default function AgentFleet({ agents, onControl, onAsk }: {
  agents: CAgent[] | null
  onControl: (id: string, verb: 'pause' | 'resume' | 'terminate') => void
  // W5 ask-mode: fire a single-turn question at an agent; the answer opens in the
  // task drawer thread. Undefined = the ask affordance is hidden.
  onAsk?: (agentId: string, question: string) => Promise<void>
}) {
  // Which card's ask composer is open, its draft, and whether it's in flight.
  const [askId, setAskId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const submitAsk = async (agentId: string) => {
    const q = draft.trim()
    if (!q || !onAsk) return
    setBusy(true)
    try { await onAsk(agentId, q); setAskId(null); setDraft('') }
    finally { setBusy(false) }
  }

  return (
    <div>
      <SectionLabel>Agent fleet</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: space.lg }}>
        {(agents ?? []).map(a => (
          <Card key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: space.md, padding: space.lg }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: space.lg }}>
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
              {(() => {
                const st = a.status === 'terminated' ? 'idle' : (HEARTBEAT_STATUS[a.heartbeat] ?? 'idle')
                return (
                  <span title={`heartbeat: ${a.heartbeat}`} aria-label={`heartbeat: ${a.heartbeat}`}
                    style={{ color: statusColor(st), fontSize: text.sm.fontSize, fontWeight: 700, lineHeight: 1 }}>
                    {statusIcon(st)}
                  </span>
                )
              })()}
              <div style={{ display: 'flex', gap: space.xs }}>
                {onAsk && <IconButton title="Ask a question" aria-label={`Ask ${a.name} a question`} onClick={() => { setAskId(id => id === a.id ? null : a.id); setDraft('') }}>💬</IconButton>}
                {a.status === 'paused'
                  ? <IconButton title="Resume" aria-label={`Resume ${a.name}`} onClick={() => onControl(a.id, 'resume')}>▶</IconButton>
                  : <IconButton title="Pause" aria-label={`Pause ${a.name}`} onClick={() => onControl(a.id, 'pause')}>⏸</IconButton>}
                <IconButton title="Terminate" aria-label={`Terminate ${a.name}`} onClick={() => onControl(a.id, 'terminate')}>⏹</IconButton>
              </div>
            </div>
           </div>
           {/* W5: ask composer — a single-turn question; the answer opens in the
               task drawer thread. Enter or Ask sends. */}
           {onAsk && askId === a.id && (
             <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
               <TextInput autoFocus style={{ flex: 1 }} placeholder={`Ask ${a.name}…`} aria-label={`Question for ${a.name}`}
                 value={draft} onChange={e => setDraft(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') submitAsk(a.id); if (e.key === 'Escape') { setAskId(null); setDraft('') } }} />
               <Button variant="primary" disabled={busy || !draft.trim()} onClick={() => submitAsk(a.id)}>{busy ? '…' : 'Ask'}</Button>
             </div>
           )}
          </Card>
        ))}
        {agents && agents.length === 0 && <p style={sx.empty}>No agents yet — add one.</p>}
      </div>
    </div>
  )
}
