'use client'
import { useCallback, useEffect, useState } from 'react'

// Connectors tab — unified connection manager for Jira, GitHub, Gmail,
// Google Calendar, Google Drive, and Hugging Face. Credentials go to the
// backend's encrypted secret store; Google rides on one shared OAuth.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
type Getter = () => Promise<string | null>

async function call<T>(path: string, token: string | null, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  })
  if (res.status === 204) return {} as T
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((j as any)?.error ?? 'Request failed')
  return j as T
}

type Row = { id: string; name: string; category: string; authType: 'token' | 'basic' | 'oauth'; icon: string; docsUrl: string; connected: boolean; detail: string | null }
type JiraIssue = { id: string; key: string; summary: string; status?: string; priority?: string; assignee?: string }

const CATEGORY_ORDER = ['Project', 'Dev', 'Google', 'AI']
const HINT: Record<string, string> = {
  github: 'Personal access token (Contents/Repo read).',
  huggingface: 'Access token from huggingface.co/settings/tokens.',
}

export default function ConnectorsPanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [form, setForm] = useState<Record<string, any>>({})
  const [openForm, setOpenForm] = useState<string | null>(null)
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [showIssues, setShowIssues] = useState(false)

  const load = useCallback(async () => {
    try { const r = await call<{ connectors: Row[] }>(`/api/orgs/${orgId}/connectors`, await getToken()); setRows(r.connectors) }
    catch (e: any) { setMsg(m => ({ ...m, _global: e?.message ?? 'Failed to load' })) }
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  const setF = (id: string, k: string, v: string) => setForm(f => ({ ...f, [id]: { ...(f[id] ?? {}), [k]: v } }))
  const note = (id: string, t: string) => setMsg(m => ({ ...m, [id]: t }))

  const connect = async (row: Row) => {
    setBusy(row.id); note(row.id, '')
    try {
      if (row.authType === 'oauth') {
        const r = await call<{ authUrl: string }>(`/api/orgs/${orgId}/connectors/${row.id}/connect`, await getToken(), { method: 'POST', body: '{}' })
        window.location.href = r.authUrl; return
      }
      const body = row.authType === 'token' ? { token: (form[row.id]?.token ?? '').trim() } : (form[row.id] ?? {})
      await call(`/api/orgs/${orgId}/connectors/${row.id}/connect`, await getToken(), { method: 'POST', body: JSON.stringify(body) })
      setOpenForm(null); setForm(f => ({ ...f, [row.id]: {} })); await load()
    } catch (e: any) { note(row.id, e?.message ?? 'Failed') }
    setBusy(null)
  }

  const test = async (row: Row) => {
    setBusy(row.id); note(row.id, 'Testing…')
    try { const r = await call<{ ok: boolean; detail: string | null }>(`/api/orgs/${orgId}/connectors/${row.id}/test`, await getToken(), { method: 'POST', body: '{}' }); note(row.id, r.ok ? `✓ ${r.detail ?? 'OK'}` : '✗ failed') }
    catch (e: any) { note(row.id, `✗ ${e?.message ?? 'failed'}`) }
    setBusy(null)
  }

  const disconnect = async (row: Row) => {
    setBusy(row.id); note(row.id, '')
    try { await call(`/api/orgs/${orgId}/connectors/${row.id}`, await getToken(), { method: 'DELETE' }); if (row.id === 'jira') { setShowIssues(false); setIssues([]) } await load() }
    catch (e: any) { note(row.id, e?.message ?? 'Failed') }
    setBusy(null)
  }

  const loadIssues = async () => {
    if (showIssues) { setShowIssues(false); return }
    try { const r = await call<{ issues: JiraIssue[] }>(`/api/orgs/${orgId}/jira/issues`, await getToken()); setIssues(r.issues); setShowIssues(true) }
    catch (e: any) { note('jira', e?.message ?? 'Could not load issues') }
  }

  const grouped = CATEGORY_ORDER.map(cat => ({ cat, items: rows.filter(r => r.category === cat) })).filter(g => g.items.length)

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Connectors <span style={s.sub}>{rows.filter(r => r.connected).length}/{rows.length} connected</span></h1>
        <button style={s.ghost} onClick={load}>↻ Refresh</button>
      </div>
      {msg._global && <div style={s.err}>⚠ {msg._global}</div>}

      {grouped.map(g => (
        <div key={g.cat}>
          <h2 style={s.h2}>{g.cat}</h2>
          <div style={s.grid}>
            {g.items.map(row => (
              <div key={row.id} style={s.card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 26 }}>{row.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{row.name}</div>
                    <div style={{ fontSize: 12, color: row.connected ? '#22c55e' : '#777' }}>
                      {row.connected ? `● ${row.detail ?? 'Connected'}` : '○ Not connected'}
                    </div>
                  </div>
                </div>

                {row.connected ? (
                  <div style={s.actions}>
                    <button style={s.btn} disabled={busy === row.id} onClick={() => test(row)}>Test</button>
                    {row.id === 'jira' && <button style={s.btn} onClick={loadIssues}>{showIssues ? 'Hide issues' : 'View issues'}</button>}
                    <button style={s.btnDanger} disabled={busy === row.id} onClick={() => disconnect(row)}>Disconnect</button>
                  </div>
                ) : row.authType === 'oauth' ? (
                  <div style={s.actions}>
                    <button style={s.btnPrimary} disabled={busy === row.id} onClick={() => connect(row)}>Connect with Google</button>
                    <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Open ↗</a>
                  </div>
                ) : openForm === row.id ? (
                  <div style={{ marginTop: 10 }}>
                    {row.authType === 'token' ? (
                      <input style={s.input} type="password" placeholder="Paste token" value={form[row.id]?.token ?? ''} onChange={e => setF(row.id, 'token', e.target.value)} />
                    ) : (
                      <>
                        <input style={s.input} placeholder="domain (e.g. 7ei → 7ei.atlassian.net)" value={form[row.id]?.domain ?? ''} onChange={e => setF(row.id, 'domain', e.target.value)} />
                        <input style={s.input} placeholder="email" value={form[row.id]?.email ?? ''} onChange={e => setF(row.id, 'email', e.target.value)} />
                        <input style={s.input} type="password" placeholder="API token" value={form[row.id]?.apiToken ?? ''} onChange={e => setF(row.id, 'apiToken', e.target.value)} />
                        <input style={s.input} placeholder="default project key (O7MC)" value={form[row.id]?.defaultProjectKey ?? ''} onChange={e => setF(row.id, 'defaultProjectKey', e.target.value)} />
                      </>
                    )}
                    {HINT[row.id] && <p style={s.hint}>{HINT[row.id]} <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Get one ↗</a></p>}
                    <div style={s.actions}>
                      <button style={s.btnPrimary} disabled={busy === row.id} onClick={() => connect(row)}>{busy === row.id ? 'Connecting…' : 'Connect'}</button>
                      <button style={s.btn} onClick={() => { setOpenForm(null); note(row.id, '') }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={s.actions}>
                    <button style={s.btnPrimary} onClick={() => setOpenForm(row.id)}>Connect</button>
                    <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a>
                  </div>
                )}
                {msg[row.id] && <div style={{ fontSize: 12, color: msg[row.id].startsWith('✓') ? '#22c55e' : '#ff8080', marginTop: 8 }}>{msg[row.id]}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {showIssues && (
        <div>
          <h2 style={s.h2}>Jira issues · {issues.length}</h2>
          <div style={s.table}>
            <div style={{ ...s.thead, gridTemplateColumns: '1fr 3fr 1.5fr 1fr 1.5fr' }}><span>Key</span><span>Summary</span><span>Status</span><span>Priority</span><span>Assignee</span></div>
            {issues.map(i => (
              <div key={i.id} style={{ ...s.trow, gridTemplateColumns: '1fr 3fr 1.5fr 1fr 1.5fr' }}>
                <span style={{ color: '#FFB800', fontSize: 12, fontWeight: 700 }}>{i.key}</span>
                <span style={{ fontSize: 13 }}>{i.summary.slice(0, 64)}{i.summary.length > 64 ? '…' : ''}</span>
                <span style={{ fontSize: 12, color: '#8aa' }}>{i.status}</span>
                <span style={{ fontSize: 12, color: '#888' }}>{i.priority ?? '—'}</span>
                <span style={{ fontSize: 12, color: '#888' }}>{i.assignee ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { padding: 28, maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 },
  h1: { fontSize: 28, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 12 },
  sub: { fontSize: 12, color: '#888', background: '#111', border: '1px solid #222', borderRadius: 999, padding: '3px 11px', fontWeight: 500 },
  h2: { fontSize: 13, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.6, margin: '4px 0 10px' },
  ghost: { background: '#1a1a1a', border: '1px solid #333', color: '#FFB800', padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  err: { background: '#2a1414', border: '1px solid #5a2a2a', color: '#ff8080', borderRadius: 8, padding: '10px 12px', fontSize: 13 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 },
  card: { background: '#0e0e0e', border: '1px solid #222', borderRadius: 12, padding: 16 },
  actions: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' },
  btn: { background: '#1a1a1a', border: '1px solid #333', color: '#ddd', padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  btnPrimary: { background: '#FFB800', border: '1px solid #FFB800', color: '#000', padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 },
  btnDanger: { background: '#1a1010', border: '1px solid #5a2a2a', color: '#ff8080', padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 },
  link: { color: '#4aa8ff', fontSize: 12, textDecoration: 'none' },
  input: { width: '100%', background: '#000', border: '1px solid #333', borderRadius: 8, padding: '9px 11px', color: '#eee', fontSize: 13, marginBottom: 8, boxSizing: 'border-box' },
  hint: { fontSize: 11.5, color: '#777', margin: '2px 0 6px' },
  table: { border: '1px solid #222', borderRadius: 10, overflow: 'hidden' },
  thead: { display: 'grid', gap: 10, padding: '10px 14px', background: '#151515', fontSize: 11, color: '#888', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 },
  trow: { display: 'grid', gap: 10, padding: '10px 14px', borderTop: '1px solid #1a1a1a', alignItems: 'center' },
}
