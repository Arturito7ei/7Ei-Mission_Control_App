'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, ui, text, space, density } from './tokens'
import { Button, Card, Pill, SectionLabel, Skeleton, TextInput } from './ui'

// MCA-UI U3 (MCA-72) — Governance panel. Surfaces the MCA-GOV2 backend:
// execution policies (action→approval), per-agent permissions, and config
// revisions with one-click rollback.
// MCA-79: shared api() client + ui.tsx primitives + density scale.

type Getter = () => Promise<string | null>

type Policy = { id: string; action: string; requiresApproval: number }
type Agent = { id: string; name: string; avatarEmoji?: string; permissions?: string | null }
type Revision = { id: string; entity: string; entityId: string; actor?: string | null; createdAt: number }

const CAP_HINTS = ['memory:write', 'attachment:write', 'connector:*', '*']
const parseCaps = (p?: string | null): string[] => { try { return p ? JSON.parse(p) : [] } catch { return [] } }

export default function GovernancePanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [newAction, setNewAction] = useState('')
  const [capEdits, setCapEdits] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false) // MCA-81 — skeletons on initial load

  const load = useCallback(async () => {
    const t = await getToken()
    try {
      const [p, a, r] = await Promise.all([
        api<{ policies: Policy[] }>(`/api/orgs/${orgId}/policies`, { token: t }).catch(() => ({ policies: [] })),
        api<{ agents: Agent[] }>(`/api/orgs/${orgId}/agents`, { token: t }).catch(() => ({ agents: [] })),
        api<{ revisions: Revision[] }>(`/api/orgs/${orgId}/revisions`, { token: t }).catch(() => ({ revisions: [] })),
      ])
      setPolicies(p.policies); setAgents(a.agents); setRevisions(r.revisions)
      const edits: Record<string, string> = {}
      for (const ag of a.agents) edits[ag.id] = parseCaps(ag.permissions).join(', ')
      setCapEdits(edits)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
    setLoaded(true)
  }, [orgId, getToken])
  useEffect(() => { load() }, [load])

  // MCA-81 — skeleton rows while the initial load is in flight.
  const skelRows = (
    <>
      {['74%', '88%', '56%'].map((w, i) => (
        <div key={i} style={s.row}><Skeleton h={14} w={w} /></div>
      ))}
    </>
  )

  const note = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2500) }

  const addPolicy = async () => {
    if (!newAction.trim()) return
    try { await api(`/api/orgs/${orgId}/policies`, { token: await getToken(), method: 'POST', body: JSON.stringify({ action: newAction.trim(), requiresApproval: true }) }); setNewAction(''); await load(); note('Policy added') }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
  }
  const delPolicy = async (id: string) => { try { await api(`/api/policies/${id}`, { token: await getToken(), method: 'DELETE' }); await load() } catch (e: any) { setErr(e?.message ?? 'Failed') } }
  const saveCaps = async (agentId: string) => {
    const caps = (capEdits[agentId] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    try { await api(`/api/agents/${agentId}/permissions`, { token: await getToken(), method: 'PATCH', body: JSON.stringify({ permissions: caps }) }); await load(); note('Permissions saved') }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
  }
  const rollback = async (id: string) => { try { const r = await api<{ restored?: string[] }>(`/api/revisions/${id}/rollback`, { token: await getToken(), method: 'POST', body: '{}' }); await load(); note(`Rolled back (${(r.restored ?? []).length} fields)`) } catch (e: any) { setErr(e?.message ?? 'Failed') } }

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Governance <span style={s.sub}>policies · permissions · rollback</span></h1>
        <Button style={{ color: tk.accent }} onClick={load}>↻ Refresh</Button>
      </div>
      {err && <div style={s.err}>⚠ {err}</div>}
      {msg && <div style={s.ok}>✓ {msg}</div>}

      <section>
        <SectionLabel style={{ margin: '0 0 4px' }}>Execution policies</SectionLabel>
        <p style={s.hint}>Actions listed here require human approval before an agent may perform them (e.g. <code>memory.write</code>). Empty = nothing gated.</p>
        <Card style={s.card}>
          {!loaded && skelRows}
          {loaded && policies.length === 0 && <div style={s.muted}>No policies — agents act freely.</div>}
          {loaded && policies.map(p => (
            <div key={p.id} style={s.row}>
              <span style={{ flex: 1, fontFamily: 'monospace', fontSize: text.md.fontSize }}>{p.action}</span>
              <Pill tone={p.requiresApproval ? 'warn' : 'muted'}>{p.requiresApproval ? 'requires approval' : 'allowed'}</Pill>
              <Button variant="danger" onClick={() => delPolicy(p.id)}>Remove</Button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: space.md, marginTop: space.md }}>
            <TextInput placeholder="action e.g. memory.write, connector.connect" value={newAction} onChange={e => setNewAction(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addPolicy() }} />
            <Button variant="primary" onClick={addPolicy}>Add policy</Button>
          </div>
        </Card>
      </section>

      <section>
        <SectionLabel style={{ margin: '0 0 4px' }}>Per-agent permissions</SectionLabel>
        <p style={s.hint}>Capabilities each agent may use. Empty = allow all. Wildcards: <code>{CAP_HINTS.join('  ·  ')}</code></p>
        <Card style={s.card}>
          {!loaded && skelRows}
          {loaded && agents.map(ag => (
            <div key={ag.id} style={s.row}>
              <span style={{ width: 150, fontSize: text.md.fontSize }}>{ag.avatarEmoji} {ag.name}</span>
              <TextInput style={{ flex: 1 }} placeholder="allow all (empty)" value={capEdits[ag.id] ?? ''} onChange={e => setCapEdits(c => ({ ...c, [ag.id]: e.target.value }))} />
              <Button onClick={() => saveCaps(ag.id)}>Save</Button>
            </div>
          ))}
          {loaded && agents.length === 0 && <div style={s.muted}>No agents.</div>}
        </Card>
      </section>

      <section>
        <SectionLabel style={{ margin: '0 0 4px' }}>Config revisions</SectionLabel>
        <p style={s.hint}>Every agent change is snapshotted. Roll back to restore the prior state.</p>
        <Card style={s.card}>
          {!loaded && skelRows}
          {loaded && revisions.length === 0 && <div style={s.muted}>No revisions yet.</div>}
          {loaded && revisions.slice(0, 30).map(r => (
            <div key={r.id} style={s.row}>
              <span style={{ flex: 1, fontSize: text.sm.fontSize }}>{r.entity} <span style={s.muted}>{r.entityId.slice(0, 8)}</span></span>
              <span style={s.muted}>{r.actor ?? '—'} · {(() => { try { return new Date(r.createdAt).toLocaleString() } catch { return '' } })()}</span>
              <Button onClick={() => rollback(r.id)}>Rollback</Button>
            </div>
          ))}
        </Card>
      </section>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { ...ui.page, maxWidth: 1000, gap: space.xl },
  h1: ui.h1,
  sub: ui.sub,
  hint: ui.hint,
  card: { display: 'flex', flexDirection: 'column', gap: space.sm },
  row: { display: 'flex', gap: space.md, alignItems: 'center', minHeight: density.row },
  muted: { color: tk.muted, fontSize: text.sm.fontSize },
  err: ui.err,
  ok: ui.ok,
}
