'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, ui, text, space, density } from './tokens'
import { Button, Card, Pill, Select, SectionLabel, Skeleton, TextInput } from './ui'
import { parseTrustMode, boundaryToFields, parseBoundaryFields, trustBadge, isContainedToNothing, type TrustMode, type TrustBoundary } from '@/lib/trust'
import { parseReasoningEffort, cheapUsable, tierBadge, effortBadge, routingSummary, REASONING_EFFORTS, type ReasoningEffortField } from '@/lib/modelProfile'

// MCA-UI U3 (MCA-72) — Governance panel. Surfaces the MCA-GOV2 backend:
// execution policies (action→approval), per-agent permissions, and config
// revisions with one-click rollback.
// MCA-79: shared api() client + ui.tsx primitives + density scale.

type Getter = () => Promise<string | null>

type Policy = { id: string; action: string; requiresApproval: number }
type Agent = {
  id: string; name: string; avatarEmoji?: string; permissions?: string | null
  trustMode?: string | null; trustBoundary?: string | null
  // Epic P / P2 — model-profile fields (returned inline on the agents list).
  llmModel?: string | null; primaryModel?: string | null; cheapModel?: string | null
  cheapModelEnabled?: boolean | number | null; reasoningEffort?: string | null
}
type TrustEdit = { mode: TrustMode; projects: string; tasks: string; agents: string }
type MpEdit = { primaryModel: string; cheapModel: string; cheapModelEnabled: boolean; reasoningEffort: ReasoningEffortField }
type ModelOption = { id: string; label: string; provider: string; tier: string; custom?: boolean }
const parseBoundaryJson = (j?: string | null): Partial<TrustBoundary> => { try { return j ? JSON.parse(j) : {} } catch { return {} } }
type Revision = { id: string; entity: string; entityId: string; actor?: string | null; createdAt: number }

const CAP_HINTS = ['memory:write', 'attachment:write', 'connector:*', '*']
const parseCaps = (p?: string | null): string[] => { try { return p ? JSON.parse(p) : [] } catch { return [] } }

export default function GovernancePanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [newAction, setNewAction] = useState('')
  const [capEdits, setCapEdits] = useState<Record<string, string>>({})
  const [trustEdits, setTrustEdits] = useState<Record<string, TrustEdit>>({})
  const [mpEdits, setMpEdits] = useState<Record<string, MpEdit>>({})
  const [models, setModels] = useState<ModelOption[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false) // MCA-81 — skeletons on initial load

  const load = useCallback(async () => {
    const t = await getToken()
    try {
      const [p, a, r, m] = await Promise.all([
        api<{ policies: Policy[] }>(`/api/orgs/${orgId}/policies`, { token: t }).catch(() => ({ policies: [] })),
        api<{ agents: Agent[] }>(`/api/orgs/${orgId}/agents`, { token: t }).catch(() => ({ agents: [] })),
        api<{ revisions: Revision[] }>(`/api/orgs/${orgId}/revisions`, { token: t }).catch(() => ({ revisions: [] })),
        api<{ models: ModelOption[] }>(`/api/orgs/${orgId}/available-models`, { token: t }).catch(() => ({ models: [] })),
      ])
      setPolicies(p.policies); setAgents(a.agents); setRevisions(r.revisions); setModels(m.models)
      const edits: Record<string, string> = {}
      const tEdits: Record<string, TrustEdit> = {}
      const mEdits: Record<string, MpEdit> = {}
      for (const ag of a.agents) {
        edits[ag.id] = parseCaps(ag.permissions).join(', ')
        const bf = boundaryToFields(parseBoundaryJson(ag.trustBoundary))
        tEdits[ag.id] = { mode: parseTrustMode(ag.trustMode), ...bf }
        mEdits[ag.id] = {
          primaryModel: String(ag.primaryModel ?? ''),
          cheapModel: String(ag.cheapModel ?? ''),
          cheapModelEnabled: ag.cheapModelEnabled === true || ag.cheapModelEnabled === 1,
          reasoningEffort: parseReasoningEffort(ag.reasoningEffort),
        }
      }
      setCapEdits(edits); setTrustEdits(tEdits); setMpEdits(mEdits)
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
  // Epic P / P1 — owner-gated trust level + boundary set. PUT is owner-only on the
  // backend; a member sees a 403 surfaced here rather than a silent no-op.
  const setTrust = (id: string, patch: Partial<TrustEdit>) => setTrustEdits(t => ({ ...t, [id]: { ...t[id], ...patch } }))
  const saveTrust = async (agentId: string) => {
    const e = trustEdits[agentId]; if (!e) return
    const boundary = parseBoundaryFields({ projects: e.projects, tasks: e.tasks, agents: e.agents })
    try { await api(`/api/orgs/${orgId}/agents/${agentId}/trust`, { token: await getToken(), method: 'PUT', body: JSON.stringify({ trustMode: e.mode, boundary }) }); await load(); note('Trust level saved') }
    catch (e: any) { setErr(e?.message ?? 'Failed (owner role required)') }
  }
  // Epic P / P2 — owner-gated model profile (primary / cheap / reasoning effort).
  const setMp = (id: string, patch: Partial<MpEdit>) => setMpEdits(m => ({ ...m, [id]: { ...m[id], ...patch } }))
  const saveMp = async (agentId: string) => {
    const e = mpEdits[agentId]; if (!e) return
    try {
      await api(`/api/orgs/${orgId}/agents/${agentId}/model-profile`, {
        token: await getToken(), method: 'PUT',
        body: JSON.stringify({ primaryModel: e.primaryModel, cheapModel: e.cheapModel, cheapModelEnabled: e.cheapModelEnabled, reasoningEffort: e.reasoningEffort }),
      })
      await load(); note('Model profile saved')
    } catch (e: any) { setErr(e?.message ?? 'Failed (owner role required)') }
  }

  // Model <select> options — always include the current value even if it's a
  // custom id not in the catalogue, so a saved model never silently disappears.
  const modelOptions = (current: string, emptyLabel: string) => {
    const present = !current || models.some(m => m.id === current)
    return (
      <>
        <option value="">{emptyLabel}</option>
        {models.map(m => <option key={m.id} value={m.id}>{m.label} · {m.provider}{m.custom ? ' (custom)' : ''}</option>)}
        {!present && <option value={current}>{current} (current)</option>}
      </>
    )
  }

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
        <SectionLabel style={{ margin: '0 0 4px' }}>Trust &amp; containment <span style={s.muted}>(owner only)</span></SectionLabel>
        <p style={s.hint}>A <strong>low-trust</strong> agent is contained: it may only touch the resources in its <em>boundary set</em> (project / task / agent ids), and every gated action — <code>file_destructive</code>, <code>wallet_tx</code>, <code>email_send</code>, <code>machine_exec</code>, create-agents/skills, assign-tasks — is held for your review before it takes effect. Default is <strong>Standard</strong> (no change).</p>
        <Card style={s.card}>
          {!loaded && skelRows}
          {loaded && agents.map(ag => {
            const e = trustEdits[ag.id] ?? { mode: 'standard' as TrustMode, projects: '', tasks: '', agents: '' }
            const low = e.mode === 'low_trust_review'
            const badge = trustBadge(e.mode)
            const stranded = isContainedToNothing(e.mode, parseBoundaryFields({ projects: e.projects, tasks: e.tasks, agents: e.agents }))
            return (
              <div key={ag.id} style={{ display: 'flex', flexDirection: 'column', gap: space.sm, padding: `${space.sm}px 0`, borderBottom: `1px solid ${tk.lineSoft}` }}>
                <div style={s.row}>
                  <span style={{ width: 150, fontSize: text.md.fontSize }}>{ag.avatarEmoji} {ag.name}</span>
                  <Pill tone={badge.tone}>{badge.icon} {badge.label}</Pill>
                  <div style={{ flex: 1 }} />
                  <Button style={{ color: low ? tk.muted : tk.accent }} onClick={() => setTrust(ag.id, { mode: 'standard' })} aria-pressed={!low}>● Standard</Button>
                  <Button style={{ color: low ? tk.accent : tk.muted }} onClick={() => setTrust(ag.id, { mode: 'low_trust_review' })} aria-pressed={low}>🛡 Low-trust</Button>
                  <Button variant="primary" onClick={() => saveTrust(ag.id)}>Save</Button>
                </div>
                {low && (
                  <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap', paddingLeft: 150 }}>
                    <label style={s.bLabel}>Projects<TextInput placeholder="p1, p2" value={e.projects} onChange={ev => setTrust(ag.id, { projects: ev.target.value })} /></label>
                    <label style={s.bLabel}>Tasks<TextInput placeholder="t1, t2" value={e.tasks} onChange={ev => setTrust(ag.id, { tasks: ev.target.value })} /></label>
                    <label style={s.bLabel}>Agents<TextInput placeholder="a1, a2" value={e.agents} onChange={ev => setTrust(ag.id, { agents: ev.target.value })} /></label>
                  </div>
                )}
                {stranded && <div style={{ ...s.hint, color: 'var(--warning-text, #b45309)', paddingLeft: 150, margin: 0 }}>⚠ Empty boundary — this agent can touch nothing (fully contained).</div>}
              </div>
            )
          })}
          {loaded && agents.length === 0 && <div style={s.muted}>No agents.</div>}
        </Card>
      </section>

      <section>
        <SectionLabel style={{ margin: '0 0 4px' }}>Model profiles <span style={s.muted}>(owner only)</span></SectionLabel>
        <p style={s.hint}>Each agent runs a <strong>primary</strong> model, with an optional <strong>cheap</strong> model the router auto-picks for lightweight turns — <em>ask-mode &amp; low-stakes → cheap; execute &amp; heavier reasoning → primary</em>. A cheap tier lowers spend while the per-wake preflight cap &amp; scoped budgets still apply. <strong>Reasoning effort</strong> maps to the provider (Claude thinking · OpenAI reasoning · Gemini thinking). Leaving primary blank keeps the agent&apos;s current model.</p>
        <Card style={s.card}>
          {!loaded && skelRows}
          {loaded && agents.map(ag => {
            const e = mpEdits[ag.id] ?? { primaryModel: '', cheapModel: '', cheapModelEnabled: false, reasoningEffort: '' as ReasoningEffortField }
            const usesCheap = cheapUsable(e)
            const tb = tierBadge(usesCheap ? 'cheap' : 'primary')
            const eb = effortBadge(e.reasoningEffort)
            return (
              <div key={ag.id} style={{ display: 'flex', flexDirection: 'column', gap: space.sm, padding: `${space.sm}px 0`, borderBottom: `1px solid ${tk.lineSoft}` }}>
                <div style={s.row}>
                  <span style={{ width: 150, fontSize: text.md.fontSize }}>{ag.avatarEmoji} {ag.name}</span>
                  <Pill tone={tb.tone}>{tb.icon} {usesCheap ? 'Cheap tier on' : 'Primary only'}</Pill>
                  <Pill tone={eb.tone}>{eb.icon} {eb.label}</Pill>
                  <div style={{ flex: 1 }} />
                  <Button variant="primary" onClick={() => saveMp(ag.id)}>Save</Button>
                </div>
                <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap', paddingLeft: 150 }}>
                  <label style={s.bLabel}>Primary model
                    <Select value={e.primaryModel} onChange={ev => setMp(ag.id, { primaryModel: ev.target.value })}>
                      {modelOptions(e.primaryModel, `— default (${ag.llmModel ?? 'agent model'}) —`)}
                    </Select>
                  </label>
                  <label style={s.bLabel}>Cheap model
                    <Select value={e.cheapModel} onChange={ev => setMp(ag.id, { cheapModel: ev.target.value })}>
                      {modelOptions(e.cheapModel, '— none —')}
                    </Select>
                  </label>
                  <label style={s.bLabel}>Reasoning effort
                    <Select value={e.reasoningEffort} onChange={ev => setMp(ag.id, { reasoningEffort: ev.target.value as ReasoningEffortField })}>
                      <option value="">— provider default —</option>
                      {REASONING_EFFORTS.map(r => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </label>
                  <label style={{ ...s.bLabel, flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'flex-end', minHeight: density.ctrl }}>
                    <input type="checkbox" checked={e.cheapModelEnabled} onChange={ev => setMp(ag.id, { cheapModelEnabled: ev.target.checked })} />
                    Route light turns to cheap
                  </label>
                </div>
                <div style={{ ...s.hint, paddingLeft: 150, margin: 0 }}>{routingSummary(e)}</div>
                {e.cheapModelEnabled && !e.cheapModel.trim() && (
                  <div style={{ ...s.hint, color: 'var(--warning-text, #b45309)', paddingLeft: 150, margin: 0 }}>⚠ Cheap routing on but no cheap model set — every turn still uses the primary.</div>
                )}
              </div>
            )
          })}
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
  bLabel: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: text.xs.fontSize, color: tk.muted },
  err: ui.err,
  ok: ui.ok,
}
