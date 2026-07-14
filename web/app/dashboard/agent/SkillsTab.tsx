'use client'
// Epic AG / AG4 — Skills tab: the company skills library as a checkbox list,
// split into Installed and Other, with the adapter + selected count in the footer.
// Toggling writes the WHOLE selection (install and uninstall are one idempotent
// call), so the list on screen is always what the agent actually has.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { nextSelection, optimisticSplit, selectionOf, type SkillView as Skill, type SkillsPayload as Payload } from '@/lib/agentSkills'
import { Card, Skeleton } from '../ui'
import { sx } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import { ax, type Getter } from './shared'

const ADAPTER_LABEL: Record<string, string> = {
  internal: 'Internal (7Ei executor)', openclaw: 'OpenClaw', cursor: 'Cursor', claude_code: 'Claude Code', custom: 'Custom runtime',
}

export default function SkillsTab({ orgId, agentId, getToken, onOpenLibrary }: {
  orgId: string
  agentId: string
  getToken: Getter
  onOpenLibrary?: () => void
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const base = `/api/orgs/${orgId}/agents/${agentId}/skills`

  const load = useCallback(async () => {
    setErr(null)
    try { setData(await api<Payload>(base, { token: await getToken() })) }
    catch (e: any) { setErr(e?.message ?? 'Could not load skills.') }
  }, [base, getToken])

  useEffect(() => { load() }, [load])

  // Tick = install, untick = uninstall. Both write the WHOLE selection, so there
  // is no half-applied state to reconcile. The checkbox flips immediately and
  // the server's answer replaces it; a failure rolls the box back and says why,
  // so what you see is never a change that didn't land.
  const toggle = async (name: string) => {
    if (!data || pending) return
    const next = nextSelection(selectionOf(data), name)
    const before = data
    setPending(name); setErr(null)
    setData(optimisticSplit(data, next))
    try {
      setData(await api<Payload>(base, { token: await getToken(), method: 'PUT', body: JSON.stringify({ skills: next }) }))
    } catch (e: any) {
      setData(before)
      const verb = selectionOf(before).includes(name) ? 'uninstall' : 'install'
      setErr(`Could not ${verb} “${name}” — ${e?.message ?? 'the request failed'}. Nothing changed.`)
    }
    setPending(null)
  }

  if (err && !data) return <div style={ax.err}>{err}</div>
  if (!data) return <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}><Skeleton h={40} /><Skeleton h={180} /></div>

  const row = (s: Skill) => (
    <div key={s.id} style={{ display: 'flex', gap: space.md, padding: `${space.md}px ${space.lg}px`, borderTop: `1px solid ${tk.line}` }}>
      <input type="checkbox" checked={s.installed} disabled={!!pending} onChange={() => toggle(s.name)}
        aria-label={`${s.installed ? 'Uninstall' : 'Install'} ${s.name}`}
        aria-busy={pending === s.name}
        style={{ marginTop: 3, accentColor: tk.accent, cursor: pending ? 'default' : 'pointer', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          <span style={{ fontSize: text.md.fontSize, fontWeight: 600 }}>{s.name}</span>
          {s.domain && <span style={sx.badge}>{s.domain}</span>}
          {/* Progress is stated in words, not colour alone. */}
          {pending === s.name && <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>Saving…</span>}
        </div>
        {s.description && (
          <p style={{
            margin: `${space.xs}px 0 0`, fontSize: text.sm.fontSize, color: tk.muted, lineHeight: 1.55,
            ...(expanded === s.id ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
          }}>{s.description}</p>
        )}
      </div>
      <button onClick={() => setExpanded(e => e === s.id ? null : s.id)}
        style={{ background: 'transparent', border: 'none', color: tk.accent, cursor: 'pointer', fontSize: text.sm.fontSize, fontWeight: 600, alignSelf: 'flex-start', flexShrink: 0 }}>
        {expanded === s.id ? 'Hide' : 'View'}
      </button>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
      {onOpenLibrary && (
        <button onClick={onOpenLibrary} style={{ background: 'transparent', border: 'none', color: tk.accent, cursor: 'pointer', fontSize: text.sm.fontSize, fontWeight: 600, padding: 0, alignSelf: 'flex-start' }}>
          View company skills library →
        </button>
      )}
      {err && <div style={ax.err}>{err}</div>}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <SectionHead>Installed skills</SectionHead>
        {data.installed.length === 0 && data.orphaned.length === 0
          ? <p style={{ ...ax.empty, padding: `${space.lg}px` }}>No company-library skills installed on this agent.</p>
          : data.installed.map(row)}
        {/* A name stored on the agent that no longer exists in the library — say so
            rather than quietly dropping it. */}
        {data.orphaned.map(name => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: `${space.md}px ${space.lg}px`, borderTop: `1px solid ${tk.line}` }}>
            <input type="checkbox" checked disabled={!!pending} onChange={() => toggle(name)} aria-label={`Remove ${name}`}
              aria-busy={pending === name} style={{ accentColor: tk.accent, cursor: pending ? 'default' : 'pointer' }} />
            <span style={{ fontSize: text.md.fontSize, fontWeight: 600 }}>{name}</span>
            <span style={{ ...sx.tag, color: tk.amber, border: `1px solid ${tk.amber}` }}>⚠ no longer in the library</span>
            {pending === name && <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>Saving…</span>}
          </div>
        ))}
      </Card>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <SectionHead>Other skills</SectionHead>
        {data.other.length === 0
          ? <p style={{ ...ax.empty, padding: `${space.lg}px` }}>Every library skill is installed on this agent.</p>
          : data.other.map(row)}
      </Card>

      <Card style={{ display: 'flex', gap: space.xl, flexWrap: 'wrap', alignItems: 'center' }}>
        <Foot label="Adapter" value={ADAPTER_LABEL[data.adapter] ?? data.adapter} />
        <Foot label="Model" value={data.model} />
        <Foot label="Selected skills" value={String(data.selectedCount)} />
        <span style={{ marginLeft: 'auto', fontSize: text.xs.fontSize, color: tk.muted }}>
          Tick to install, untick to uninstall — saved as you go. Skills are applied when the agent runs.
        </span>
      </Card>
    </div>
  )
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: `${space.md}px ${space.lg}px`, background: tk.surfaceHigh, fontSize: text.sm.fontSize, fontWeight: 700, color: tk.textDim }}>
      {children}
    </div>
  )
}

function Foot({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: text.xs.fontSize, color: tk.muted }}>{label}</span>
      <span style={{ fontSize: text.sm.fontSize, fontWeight: 700, color: tk.text }}>{value}</span>
    </span>
  )
}
