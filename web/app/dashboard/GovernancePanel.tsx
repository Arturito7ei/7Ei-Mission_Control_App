'use client'
import { useCallback, useEffect, useState } from 'react'

// MCA-UI U3 (MCA-72) — Governance panel. Surfaces the MCA-GOV2 backend:
// execution policies (action→approval), per-agent permissions, and config
// revisions with one-click rollback.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
type Getter = () => Promise<string | null>
async function call<T>(path: string, token: string | null, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(opts?.headers ?? {}) } })
  if (res.status === 204) return {} as T
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((j as any)?.error ?? 'Request failed')
  return j as T
}

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

  const load = useCallback(async () => {
    const t = await getToken()
    try {
      const [p, a, r] = await Promise.all([
        call<{ policies: Policy[] }>(`/api/orgs/${orgId}/policies`, t).catch(() => ({ policies: [] })),
        call<{ agents: Agent[] }>(`/api/orgs/${orgId}/agents`, t).catch(() => ({ agents: [] })),
        call<{ revisions: Revision[] }>(`/api/orgs/${orgId}/revisions`, t).catch(() => ({ revisions: [] })),
      ])
      setPolicies(p.policies); setAgents(a.agents); setRevisions(r.revisions)
      const edits: Record<string, string> = {}
      for (const ag of a.agents) edits[ag.id] = parseCaps(ag.permissions).join(', ')
      setCapEdits(edits)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
  }, [orgId, getToken])
  useEffect(() => { load() }, [load])

  const note = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2500) }

  const addPolicy = async () => {
    if (!newAction.trim()) return
    try { await call(`/api/orgs/${orgId}/policies`, await getToken(), { method: 'POST', body: JSON.stringify({ action: newAction.trim(), requiresApproval: true }) }); setNewAction(''); await load(); note('Policy added') }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
  }
  const delPolicy = async (id: string) => { try { await call(`/api/policies/${id}`, await getToken(), { method: 'DELETE' }); await load() } catch (e: any) { setErr(e?.message ?? 'Failed') } }
  const saveCaps = async (agentId: string) => {
    const caps = (capEdits[agentId] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    try { await call(`/api/agents/${agentId}/permissions`, await getToken(), { method: 'PATCH', body: JSON.stringify({ permissions: caps }) }); await load(); note('Permissions saved') }
    catch (e: any) { setErr(e?.message ?? 'Failed') }
  }
  const rollback = async (id: string) => { try { const r = await call<{ restored?: string[] }>(`/api/revisions/${id}/rollback`, await getToken(), { method: 'POST', body: '{}' }); await load(); note(`Rolled back (${(r.restored ?? []).length} fields)`) } catch (e: any) { setErr(e?.message ?? 'Failed') } }

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Governance <span style={s.sub}>policies · permissions · rollback</span></h1>
        <button style={s.ghost} onClick={load}>↻ Refresh</button>
      </div>
      {err && <div style={s.err}>⚠ {err}</div>}
      {msg && <div style={s.ok}>✓ {msg}</div>}

      <section>
        <h2 style={s.h2}>Execution policies</h2>
        <p style={s.hint}>Actions listed here require human approval before an agent may perform them (e.g. <code>memory.write</code>). Empty = nothing gated.</p>
        <div style={s.card}>
          {policies.length === 0 && <div style={s.muted}>No policies — agents act freely.</div>}
          {policies.map(p => (
            <div key={p.id} style={s.row}>
              <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }}>{p.action}</span>
              <span style={{ ...s.pill, color: p.requiresApproval ? '#e0b000' : '#9aa0a6' }}>{p.requiresApproval ? 'requires approval' : 'allowed'}</span>
              <button style={s.btnDanger} onClick={() => delPolicy(p.id)}>Remove</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input style={s.input} placeholder="action e.g. memory.write, connector.connect" value={newAction} onChange={e => setNewAction(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addPolicy() }} />
            <button style={s.btnPrimary} onClick={addPolicy}>Add policy</button>
          </div>
        </div>
      </section>

      <section>
        <h2 style={s.h2}>Per-agent permissions</h2>
        <p style={s.hint}>Capabilities each agent may use. Empty = allow all. Wildcards: <code>{CAP_HINTS.join('  ·  ')}</code></p>
        <div style={s.card}>
          {agents.map(ag => (
            <div key={ag.id} style={s.row}>
              <span style={{ width: 150, fontSize: 13 }}>{ag.avatarEmoji} {ag.name}</span>
              <input style={{ ...s.input, flex: 1 }} placeholder="allow all (empty)" value={capEdits[ag.id] ?? ''} onChange={e => setCapEdits(c => ({ ...c, [ag.id]: e.target.value }))} />
              <button style={s.btn} onClick={() => saveCaps(ag.id)}>Save</button>
            </div>
          ))}
          {agents.length === 0 && <div style={s.muted}>No agents.</div>}
        </div>
      </section>

      <section>
        <h2 style={s.h2}>Config revisions</h2>
        <p style={s.hint}>Every agent change is snapshotted. Roll back to restore the prior state.</p>
        <div style={s.card}>
          {revisions.length === 0 && <div style={s.muted}>No revisions yet.</div>}
          {revisions.slice(0, 30).map(r => (
            <div key={r.id} style={s.row}>
              <span style={{ flex: 1, fontSize: 12.5 }}>{r.entity} <span style={s.muted}>{r.entityId.slice(0, 8)}</span></span>
              <span style={s.muted}>{r.actor ?? '—'} · {(() => { try { return new Date(r.createdAt).toLocaleString() } catch { return '' } })()}</span>
              <button style={s.btn} onClick={() => rollback(r.id)}>Rollback</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { padding: 28, maxWidth: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
  h1: { fontSize: 28, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 12 },
  sub: { fontSize: 12, color: '#9aa0a6', background: '#111', border: '1px solid #222', borderRadius: 999, padding: '3px 11px', fontWeight: 500 },
  h2: { fontSize: 13, fontWeight: 700, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 4px' },
  hint: { fontSize: 12, color: '#8b9096', margin: '0 0 10px' },
  ghost: { background: '#1a1a1a', border: '1px solid #333', color: '#FFB800', padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  card: { background: '#0e0e0e', border: '1px solid #222', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', gap: 10, alignItems: 'center' },
  pill: { fontSize: 11, fontWeight: 700, border: '1px solid #2a2a2a', borderRadius: 999, padding: '2px 9px' },
  muted: { color: '#9aa0a6', fontSize: 12.5 },
  input: { background: '#000', border: '1px solid #333', borderRadius: 8, padding: '8px 11px', color: '#eee', fontSize: 13 },
  btn: { background: '#1a1a1a', border: '1px solid #333', color: '#ddd', padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  btnPrimary: { background: '#FFB800', border: '1px solid #FFB800', color: '#000', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 },
  btnDanger: { background: '#1a1010', border: '1px solid #5a2a2a', color: '#ff8080', padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  err: { background: '#2a1414', border: '1px solid #5a2a2a', color: '#ff8080', borderRadius: 8, padding: '9px 12px', fontSize: 13 },
  ok: { background: '#12210f', border: '1px solid #2a5a2a', color: '#8fe08f', borderRadius: 8, padding: '9px 12px', fontSize: 13 },
}
