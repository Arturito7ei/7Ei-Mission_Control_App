'use client'
import { useCallback, useEffect, useState } from 'react'

// Mission Control cockpit (MCA-EXT Phase 3): live roster + task board + health,
// plus onboarding for external / bring-your-own runtimes (OpenClaw, Cursor, …).
// Reads GET /api/orgs/:id/cockpit and POSTs /api/orgs/:id/agents/external.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

type Getter = () => Promise<string | null>
async function call<T>(path: string, token: string | null, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Request failed')
  return res.json()
}

type CAgent = {
  id: string; name: string; role: string; runtime: string; llmProvider: string; llmModel: string
  status: string; agentType: string; avatarEmoji: string; heartbeat: string; lastHeartbeatAt: number | null
}
type CTask = { id: string; title: string; status: string; kanbanColumn: string; priority: string; agentId: string }
type Cockpit = { agents: CAgent[]; tasks: CTask[]; summary: Record<string, number>; generatedAt: string }
type OrgNode = { id: string; name: string; role: string; title?: string | null; runtime?: string; avatarEmoji?: string | null; status?: string; children: OrgNode[] }
type InboxItem = { taskId: string; title: string; kind: string; priority: string; agentName: string; agentEmoji: string }

const HB: Record<string, string> = { green: '#22c55e', amber: '#f59e0b', stale: '#ef4444', unknown: '#555' }
const STATUS_C: Record<string, string> = { idle: '#888', active: '#22c55e', external: '#a96bff' }
const RUNTIME_BADGE: Record<string, string> = { internal: '🧠', openclaw: '📎', cursor: '⌨️', claude_code: '🤖', custom: '⚙️' }
const PRI_C: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#555' }
const KIND_LABEL: Record<string, string> = { blocked: 'Blocked', failed: 'Failed', review: 'Review', attention: 'Attention' }
const KIND_C: Record<string, { bg: string; fg: string }> = {
  blocked: { bg: '#2a1414', fg: '#ff6b6b' }, failed: { bg: '#2a1414', fg: '#ff8080' },
  review: { bg: '#211c08', fg: '#FFB800' }, attention: { bg: '#0d1a2a', fg: '#4aa8ff' },
}
const COLS: { key: string; label: string }[] = [
  { key: 'todo', label: 'To do' }, { key: 'in_progress', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' }, { key: 'done', label: 'Done' },
]

export default function CockpitPanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [data, setData] = useState<Cockpit | null>(null)
  const [chart, setChart] = useState<OrgNode[] | null>(null)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [wizard, setWizard] = useState(false)
  const [hire, setHire] = useState(false)

  const load = useCallback(async () => {
    try {
      const tok = await getToken()
      const [c, oc, ib] = await Promise.all([
        call<Cockpit>(`/api/orgs/${orgId}/cockpit`, tok),
        call<{ tree: OrgNode[] }>(`/api/orgs/${orgId}/orgchart`, tok),
        call<{ items: InboxItem[] }>(`/api/orgs/${orgId}/inbox`, tok),
      ])
      setData(c); setChart(oc.tree); setInbox(ib.items); setErr(null)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
  }, [orgId, getToken])

  const dismiss = async (taskId: string) => {
    setInbox(x => x.filter(i => i.taskId !== taskId))
    try { await call(`/api/orgs/${orgId}/inbox/dismiss`, await getToken(), { method: 'POST', body: JSON.stringify({ taskId }) }) } catch {}
  }

  useEffect(() => { load() }, [load])

  const agentName = (id: string) => data?.agents.find(a => a.id === id)?.name ?? '—'
  const sum = data?.summary ?? {}

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={s.h1}>Mission Control</h1>
          {inbox.length > 0 && <span style={{ ...s.tag, background: '#211c08', color: '#FFB800' }}>📥 {inbox.length}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={s.ghostBtn}>↻ Refresh</button>
          <button onClick={() => setHire(true)} style={s.ghostBtn}>✨ Hire with a prompt</button>
          <button onClick={() => setWizard(true)} style={s.primaryBtn}>＋ Add agent</button>
        </div>
      </div>

      {err && <div style={s.errBox}>⚠ {err}</div>}

      <div style={s.grid4}>
        {[
          { l: 'Agents', v: sum.agents ?? 0, c: '#fff' },
          { l: 'External', v: sum.external ?? 0, c: '#a96bff' },
          { l: 'In progress', v: sum.in_progress ?? 0, c: '#3b82f6' },
          { l: 'Done', v: sum.done ?? 0, c: '#22c55e' },
        ].map(k => <div key={k.l} style={s.statCard}><span style={{ ...s.statVal, color: k.c }}>{k.v}</span><span style={s.statLabel}>{k.l}</span></div>)}
      </div>

      {inbox.length > 0 && (<>
        <h2 style={s.h2}>Inbox <span style={s.colCount}>{inbox.length}</span></h2>
        <div style={s.panel}>
          {inbox.map(i => (
            <div key={i.taskId} style={s.inboxRow}>
              <span style={{ ...s.tag, background: (KIND_C[i.kind] ?? KIND_C.attention).bg, color: (KIND_C[i.kind] ?? KIND_C.attention).fg }}>{KIND_LABEL[i.kind] ?? i.kind}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 560 }}>{i.title}</div>
                <div style={{ fontSize: 11, color: '#888' }}>{i.agentEmoji} {i.agentName}</div>
              </div>
              <button style={s.ghostBtn} onClick={() => dismiss(i.taskId)}>Dismiss</button>
            </div>
          ))}
        </div>
      </>)}

      <h2 style={s.h2}>Agent fleet</h2>
      <div style={s.agentGrid}>
        {(data?.agents ?? []).map(a => (
          <div key={a.id} style={s.agentCard}>
            <span style={{ fontSize: 26 }}>{a.avatarEmoji || '🤖'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                {a.name}
                <span title={a.runtime} style={s.badge}>{RUNTIME_BADGE[a.runtime] ?? '⚙️'} {a.runtime}</span>
              </div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{a.role}</div>
              <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{a.llmProvider} · {a.llmModel}</div>
            </div>
            <span title={`heartbeat: ${a.heartbeat}`} style={{ width: 10, height: 10, borderRadius: 5, background: HB[a.heartbeat] ?? '#555', flexShrink: 0 }} />
          </div>
        ))}
        {data && data.agents.length === 0 && <p style={{ color: '#888' }}>No agents yet — add one.</p>}
      </div>

      <h2 style={s.h2}>Org chart</h2>
      <div style={s.panel}>
        {(chart ?? []).map(n => <OrgNodeRow key={n.id} node={n} depth={0} />)}
        {chart && chart.length === 0 && <p style={{ color: '#888' }}>No agents yet.</p>}
        {!chart && <p style={{ color: '#555', fontSize: 12 }}>Loading…</p>}
      </div>

      <h2 style={s.h2}>Task board</h2>
      <div style={s.board}>
        {COLS.map(col => {
          const items = (data?.tasks ?? []).filter(t => (t.kanbanColumn ?? 'todo') === col.key)
          return (
            <div key={col.key} style={s.col}>
              <div style={s.colHead}>{col.label}<span style={s.colCount}>{items.length}</span></div>
              {items.map(t => (
                <div key={t.id} style={{ ...s.task, borderLeftColor: PRI_C[t.priority] ?? '#555' }}>
                  <div style={{ fontSize: 12.5 }}>{t.title}</div>
                  <div style={{ fontSize: 10.5, color: '#888', marginTop: 6 }}>{agentName(t.agentId)}</div>
                </div>
              ))}
              {items.length === 0 && <div style={{ color: '#444', fontSize: 12, padding: 4 }}>—</div>}
            </div>
          )
        })}
      </div>

      {wizard && <AddAgentWizard orgId={orgId} getToken={getToken} onClose={() => setWizard(false)} onDone={() => { setWizard(false); load() }} />}
      {hire && <HireDialog orgId={orgId} getToken={getToken} onClose={() => setHire(false)} onDone={() => { setHire(false); load() }} />}
    </div>
  )
}

// ─── Hire with a prompt (goal-driven hiring) ─────────────────────────────────

function HireDialog({ orgId, getToken, onClose, onDone }: { orgId: string; getToken: Getter; onClose: () => void; onDone: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [proposal, setProposal] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)

  const propose = async () => {
    if (!prompt.trim()) return
    setBusy(true); setErr(null)
    try {
      const r = await call<{ proposal: any }>(`/api/orgs/${orgId}/agents/hire`, await getToken(), { method: 'POST', body: JSON.stringify({ prompt }) })
      setProposal(r.proposal)
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  const confirmHire = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await call<{ agentToken?: string }>(`/api/orgs/${orgId}/agents/hire`, await getToken(), { method: 'POST', body: JSON.stringify({ confirm: true, profile: proposal }) })
      if (r.agentToken) setToken(r.agentToken); else onDone()
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }
  const set = (k: string, v: string) => setProposal((p: any) => ({ ...p, [k]: v }))

  return (
    <div style={s.modalWrap} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        {token ? (
          <>
            <h2 style={s.h2}>✓ Hired {proposal?.name}</h2>
            <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>External runtime — copy this one-time token into the adapter's <code style={s.code}>mc.env</code>.</p>
            <div style={s.tokenBox}>{token}</div>
            <button style={{ ...s.primaryBtn, marginTop: 8 }} onClick={onDone}>Done</button>
          </>
        ) : !proposal ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={s.h2}>Hire with a prompt</h2><button onClick={onClose} style={s.x}>✕</button>
            </div>
            <p style={{ color: '#888', fontSize: 12.5, margin: '4px 0 0' }}>Describe the agent you need — Arturito proposes a profile, title, and manager from your org chart.</p>
            <textarea style={{ ...s.inp, minHeight: 90, marginTop: 12 }} autoFocus value={prompt}
              placeholder="e.g. A growth marketer who owns SEO and the weekly newsletter, reporting to the CMO."
              onChange={e => setPrompt(e.target.value)} />
            {err && <div style={s.errBox}>⚠ {err}</div>}
            <button style={{ ...s.primaryBtn, marginTop: 14, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={propose}>{busy ? 'Designing…' : '✨ Propose'}</button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={s.h2}>Review &amp; hire</h2><button onClick={onClose} style={s.x}>✕</button>
            </div>
            <div style={s.form}>
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ ...s.lab, flex: 1 }}>Name<input style={s.inp} value={proposal.name} onChange={e => set('name', e.target.value)} /></label>
                <label style={{ ...s.lab, width: 80 }}>Emoji<input style={s.inp} value={proposal.avatarEmoji} onChange={e => set('avatarEmoji', e.target.value)} /></label>
              </div>
              <label style={s.lab}>Title<input style={s.inp} value={proposal.title} onChange={e => set('title', e.target.value)} /></label>
              <label style={s.lab}>Role<input style={s.inp} value={proposal.role} onChange={e => set('role', e.target.value)} /></label>
              <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.7 }}>
                <div>Runtime: <b style={{ color: '#fff' }}>{RUNTIME_BADGE[proposal.runtime] ?? '⚙️'} {proposal.runtime}</b> · Model: <b style={{ color: '#fff' }}>{proposal.llmProvider}·{proposal.llmModel}</b></div>
                <div>Reports to: <b style={{ color: '#fff' }}>{proposal.reportsTo ?? '— (top level)'}</b></div>
                {proposal.skills?.length ? <div>Skills: {proposal.skills.join(', ')}</div> : null}
                {proposal.jobDescription ? <div style={{ color: '#888', marginTop: 4 }}>{proposal.jobDescription}</div> : null}
              </div>
            </div>
            {err && <div style={s.errBox}>⚠ {err}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button style={s.ghostBtn} onClick={() => setProposal(null)}>← Re-prompt</button>
              <button style={{ ...s.primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={confirmHire}>{busy ? 'Hiring…' : 'Hire'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Org chart (recursive reporting tree) ────────────────────────────────────

function OrgNodeRow({ node, depth }: { node: OrgNode; depth: number }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', paddingLeft: depth * 22 }}>
        {depth > 0 && <span style={{ color: '#444' }}>└─</span>}
        <span style={{ fontSize: 18 }}>{node.avatarEmoji || '🤖'}</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{node.name}</span>
        <span style={{ fontSize: 11.5, color: '#888' }}>{node.title || node.role}</span>
        {node.runtime && <span style={s.badge}>{RUNTIME_BADGE[node.runtime] ?? '⚙️'} {node.runtime}</span>}
      </div>
      {node.children.map(c => <OrgNodeRow key={c.id} node={c} depth={depth + 1} />)}
    </>
  )
}

// ─── Add-agent wizard (external runtime onboarding) ──────────────────────────

const RUNTIMES = [
  { id: 'openclaw', label: 'OpenClaw', emoji: '📎', defModel: 'MiniMax-Text-01', defProvider: 'minimax' },
  { id: 'cursor', label: 'Cursor', emoji: '⌨️', defModel: 'claude-sonnet-4-20250514', defProvider: 'anthropic' },
  { id: 'claude_code', label: 'Claude Code', emoji: '🤖', defModel: 'claude-sonnet-4-20250514', defProvider: 'anthropic' },
  { id: 'custom', label: 'Custom', emoji: '⚙️', defModel: 'minimax', defProvider: 'custom' },
]

function AddAgentWizard({ orgId, getToken, onClose, onDone }: { orgId: string; getToken: Getter; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [f, setF] = useState({ name: 'Arturito · Open Claw', role: 'Ops', runtime: 'openclaw', llmProvider: 'minimax', llmModel: 'MiniMax-Text-01', termsOfReference: '', avatarEmoji: '📎' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const pickRuntime = (r: typeof RUNTIMES[number]) =>
    setF({ ...f, runtime: r.id, llmProvider: r.defProvider, llmModel: r.defModel, avatarEmoji: r.emoji })

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await call<{ agentToken: string }>(`/api/orgs/${orgId}/agents/external`, await getToken(),
        { method: 'POST', body: JSON.stringify(f) })
      setToken(res.agentToken)
    } catch (e: any) { setErr(e?.message ?? 'Failed') }
    setBusy(false)
  }

  const envSnippet = token ? `MC_BASE_URL=${API}\nMC_AGENT_TOKEN=${token}\nMC_EXECUTOR=auto\nMC_ALLOW_SHELL=1\nMC_WORKDIR=/Users/artutito/7Ei-MC_TARCO` : ''

  return (
    <div style={s.modalWrap} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        {token ? (
          <>
            <h2 style={s.h2}>✓ {f.name} onboarded</h2>
            <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>Copy this agent token now — it is shown only once. Paste it into the runtime's <code style={s.code}>mc.env</code>.</p>
            <div style={s.tokenBox}>{token}</div>
            <button style={s.ghostBtn} onClick={() => { navigator.clipboard?.writeText(envSnippet); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
              {copied ? '✓ Copied env' : '📋 Copy mc.env block'}
            </button>
            <pre style={s.pre}>{envSnippet}</pre>
            <button style={{ ...s.primaryBtn, marginTop: 8 }} onClick={onDone}>Done</button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={s.h2}>Add an agent</h2>
              <button onClick={onClose} style={s.x}>✕</button>
            </div>
            <div style={s.stepRow}>{['Identity', 'Runtime', 'Model', 'Review'].map((label, i) => (
              <span key={label} style={{ ...s.stepChip, ...(i === step ? s.stepOn : {}) }}>{i + 1}. {label}</span>
            ))}</div>

            {step === 0 && (
              <div style={s.form}>
                <label style={s.lab}>Name<input style={s.inp} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
                <label style={s.lab}>Role<input style={s.inp} value={f.role} onChange={e => setF({ ...f, role: e.target.value })} /></label>
                <label style={s.lab}>Terms of reference (optional)<textarea style={{ ...s.inp, minHeight: 60 }} value={f.termsOfReference} onChange={e => setF({ ...f, termsOfReference: e.target.value })} /></label>
              </div>
            )}
            {step === 1 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                {RUNTIMES.map(r => (
                  <button key={r.id} onClick={() => pickRuntime(r)} style={{ ...s.opt, ...(f.runtime === r.id ? s.optOn : {}) }}>{r.emoji} {r.label}</button>
                ))}
              </div>
            )}
            {step === 2 && (
              <div style={s.form}>
                <label style={s.lab}>LLM provider<input style={s.inp} value={f.llmProvider} onChange={e => setF({ ...f, llmProvider: e.target.value })} /></label>
                <label style={s.lab}>Model<input style={s.inp} value={f.llmModel} onChange={e => setF({ ...f, llmModel: e.target.value })} /></label>
                <p style={{ fontSize: 11.5, color: '#555', margin: 0 }}>External runtimes run their own brain; this is metadata + the model the adapter calls.</p>
              </div>
            )}
            {step === 3 && (
              <div style={{ ...s.form, fontSize: 13, color: '#aaa' }}>
                <div>Name: <b style={{ color: '#fff' }}>{f.name}</b></div>
                <div>Role: <b style={{ color: '#fff' }}>{f.role}</b></div>
                <div>Runtime: <b style={{ color: '#fff' }}>{RUNTIME_BADGE[f.runtime]} {f.runtime}</b></div>
                <div>Model: <b style={{ color: '#fff' }}>{f.llmProvider} · {f.llmModel}</b></div>
                <p style={{ fontSize: 11.5, color: '#555', margin: '6px 0 0' }}>On create you'll get a one-time agent token for the adapter.</p>
              </div>
            )}
            {err && <div style={s.errBox}>⚠ {err}</div>}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              {step > 0 && <button style={s.ghostBtn} onClick={() => setStep(step - 1)}>← Back</button>}
              {step < 3
                ? <button style={s.primaryBtn} onClick={() => setStep(step + 1)}>Next →</button>
                : <button style={{ ...s.primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create agent'}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { padding: 28, maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 },
  h1: { fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -0.5 },
  h2: { fontSize: 18, fontWeight: 700, margin: 0 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 },
  statCard: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 },
  statVal: { fontSize: 28, fontWeight: 800, lineHeight: 1 }, statLabel: { fontSize: 12, color: '#888' },
  agentGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  panel: { background: '#111', border: '1px solid #222', borderRadius: 12, padding: 16 },
  inboxRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #1a1a1a' },
  agentCard: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 16, display: 'flex', alignItems: 'center', gap: 12 },
  badge: { fontSize: 10, color: '#aaa', background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: '1px 6px', fontWeight: 600 },
  board: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },
  col: { background: '#0d0d0d', border: '1px solid #222', borderRadius: 10, padding: 10, minHeight: 80 },
  colHead: { display: 'flex', justifyContent: 'space-between', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#888', fontWeight: 700, marginBottom: 8 },
  colCount: { background: '#1a1a1a', border: '1px solid #333', borderRadius: 10, padding: '0 7px', fontSize: 11 },
  task: { background: '#111', border: '1px solid #222', borderLeft: '3px solid #555', borderRadius: 8, padding: '8px 10px', marginBottom: 8 },
  primaryBtn: { background: '#FFB800', color: '#000', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  ghostBtn: { background: '#1a1a1a', border: '1px solid #333', color: '#FFB800', padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  errBox: { background: '#2a1414', border: '1px solid #5a2a2a', color: '#ff8080', borderRadius: 8, padding: '10px 12px', fontSize: 13 },
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 },
  modal: { background: '#111', border: '1px solid #2a2a2a', borderRadius: 16, padding: 24, width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 8 },
  x: { background: 'transparent', border: 'none', color: '#888', fontSize: 16, cursor: 'pointer' },
  stepRow: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0 4px' },
  stepChip: { fontSize: 11, color: '#888', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 999, padding: '3px 9px' },
  stepOn: { color: '#000', background: '#FFB800', borderColor: '#FFB800', fontWeight: 700 },
  form: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 },
  lab: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#aaa' },
  inp: { background: '#0a0a0a', border: '1px solid #333', borderRadius: 8, padding: '9px 11px', color: '#fff', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box' },
  opt: { fontSize: 13, border: '1px solid #333', background: '#0a0a0a', color: '#aaa', borderRadius: 8, padding: '9px 13px', cursor: 'pointer' },
  optOn: { borderColor: '#FFB800', background: '#211c08', color: '#fff' },
  tokenBox: { background: '#0a0a0a', border: '1px solid #333', borderRadius: 8, padding: 10, fontFamily: 'monospace', fontSize: 12, color: '#FFB800', wordBreak: 'break-all', margin: '10px 0' },
  pre: { background: '#000', border: '1px solid #222', borderRadius: 8, padding: 12, fontSize: 11.5, color: '#cdd3de', whiteSpace: 'pre-wrap', margin: '8px 0 0' },
  code: { background: '#000', border: '1px solid #222', borderRadius: 4, padding: '1px 5px', fontSize: 11, color: '#FFB800' },
}
