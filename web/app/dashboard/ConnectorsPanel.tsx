'use client'
import { useCallback, useEffect, useState } from 'react'
import { tk, ui } from './tokens'

// Connectors tab — unified connection manager for Jira, GitHub, Gmail,
// Google Calendar, Google Drive, and Hugging Face. Credentials go to the
// backend's encrypted secret store; Google rides on one shared OAuth.
// MCA-77: inline token rotation, honest error mapping, per-connector
// health pill (session-local test results), tokenized styles.

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
type Getter = () => Promise<string | null>

async function call<T>(path: string, token: string | null, opts?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    })
  } catch {
    // fetch rejects (TypeError) only on network-level failure
    throw new Error('Network error — backend unreachable')
  }
  if (res.status === 204) return {} as T
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    let msg = `HTTP ${res.status}: ${(j as any)?.error ?? (res.statusText || 'Request failed')}`
    if (res.status === 401 || res.status === 403) msg += ' — token invalid or revoked. Use Replace token.'
    throw new Error(msg)
  }
  return j as T
}

type Row = { id: string; name: string; category: string; authType: 'token' | 'basic' | 'oauth'; icon: string; docsUrl: string; fields: string[]; connected: boolean; detail: string | null }
type JiraIssue = { id: string; key: string; summary: string; status?: string; priority?: string; assignee?: string }
type TestResult = { ok: boolean; at: number }

const CATEGORY_ORDER = ['Memory', 'Project', 'Dev', 'Google', 'AI']
const HINT: Record<string, string> = {
  github: 'Personal access token (Contents/Repo read).',
  huggingface: 'Access token from huggingface.co/settings/tokens.',
  obsidian: 'Point at your Obsidian vault’s Git repo — every agent reads & writes this one shared memory. Token needs repo read+write.',
}
const FIELD_LABEL: Record<string, string> = {
  domain: 'domain (e.g. 7ei → 7ei.atlassian.net)', email: 'email', apiToken: 'API token', defaultProjectKey: 'default project key (O7MC)',
  repo: 'owner/repo (e.g. Arturito7ei/7Ei-MC_TARCO)', root: 'root folder (vault)', branch: 'branch (main)', token: 'GitHub token (repo scope)',
}

// Connectors whose stored secret can be rotated in place: pure token connectors
// (github, huggingface) plus obsidian, whose non-secret config (repo/root/branch)
// survives in the row detail. Jira is basic auth (email+apiToken) — the email
// isn't recoverable client-side, so it reconnects via the full form instead.
const takesToken = (row: Row) => row.authType === 'token' || (row.id === 'obsidian' && row.fields.includes('token'))

// Status detail for obsidian is rendered by the backend as "repo · root/ (branch)".
const parseVaultDetail = (detail: string | null) => {
  const m = /^(\S+) · (.+)\/ \((.+)\)$/.exec(detail ?? '')
  return m ? { repo: m[1], root: m[2], branch: m[3] } : null
}

const rel = (ts: number) => {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  return `${Math.round(min / 60)}h ago`
}

export default function ConnectorsPanel({ orgId, getToken }: { orgId: string; getToken: Getter }) {
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [form, setForm] = useState<Record<string, any>>({})
  const [openForm, setOpenForm] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<string | null>(null)
  const [replaceTok, setReplaceTok] = useState('')
  const [tests, setTests] = useState<Record<string, TestResult>>({})
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [showIssues, setShowIssues] = useState(false)

  const load = useCallback(async () => {
    try { const r = await call<{ connectors: Row[] }>(`/api/orgs/${orgId}/connectors`, await getToken()); setRows(r.connectors) }
    catch (e: any) { setMsg(m => ({ ...m, _global: e?.message ?? 'Failed to load' })) }
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  const setF = (id: string, k: string, v: string) => setForm(f => ({ ...f, [id]: { ...(f[id] ?? {}), [k]: v } }))
  const note = (id: string, t: string) => setMsg(m => ({ ...m, [id]: t }))

  const test = useCallback(async (row: Row) => {
    setBusy(row.id); note(row.id, 'Testing…')
    try {
      const r = await call<{ ok: boolean; detail: string | null }>(`/api/orgs/${orgId}/connectors/${row.id}/test`, await getToken(), { method: 'POST', body: '{}' })
      setTests(t => ({ ...t, [row.id]: { ok: r.ok, at: Date.now() } }))
      note(row.id, r.ok ? `✓ ${r.detail ?? 'OK'}` : '✗ failed')
    } catch (e: any) {
      setTests(t => ({ ...t, [row.id]: { ok: false, at: Date.now() } }))
      note(row.id, `✗ ${e?.message ?? 'failed'}`)
    }
    setBusy(null)
  }, [orgId, getToken])

  // Shared connect path: initial connect (body from the open form) and token
  // replacement (explicit body) both post to the same /connect endpoint.
  const connect = async (row: Row, replacementBody?: Record<string, string>) => {
    setBusy(row.id); note(row.id, '')
    try {
      if (row.authType === 'oauth') {
        const r = await call<{ authUrl: string }>(`/api/orgs/${orgId}/connectors/${row.id}/connect`, await getToken(), { method: 'POST', body: '{}' })
        window.location.href = r.authUrl; return
      }
      const body = replacementBody ?? (row.authType === 'token' ? { token: (form[row.id]?.token ?? '').trim() } : (form[row.id] ?? {}))
      await call(`/api/orgs/${orgId}/connectors/${row.id}/connect`, await getToken(), { method: 'POST', body: JSON.stringify(body) })
      setOpenForm(null); setForm(f => ({ ...f, [row.id]: {} }))
      await load()
      if (replacementBody) {
        setReplacing(null); setReplaceTok('')
        setBusy(null); await test(row); return // verify the new token right away
      }
    } catch (e: any) { note(row.id, e?.message ?? 'Failed') }
    setBusy(null)
  }

  const saveReplace = async (row: Row) => {
    const token = replaceTok.trim()
    if (!token) return
    if (row.authType === 'token') return connect(row, { token })
    const cfg = parseVaultDetail(row.detail) // obsidian: preserve repo/root/branch
    if (!cfg) { note(row.id, 'Could not read stored vault config — disconnect and reconnect instead.'); return }
    return connect(row, { ...cfg, token })
  }

  const cancelReplace = (row: Row) => { setReplacing(null); setReplaceTok(''); note(row.id, '') }

  const disconnect = async (row: Row) => {
    setBusy(row.id); note(row.id, '')
    try {
      await call(`/api/orgs/${orgId}/connectors/${row.id}`, await getToken(), { method: 'DELETE' })
      setTests(t => { const rest = { ...t }; delete rest[row.id]; return rest })
      if (row.id === 'jira') { setShowIssues(false); setIssues([]) }
      await load()
    } catch (e: any) { note(row.id, e?.message ?? 'Failed') }
    setBusy(null)
  }

  const loadIssues = async () => {
    if (showIssues) { setShowIssues(false); return }
    try { const r = await call<{ issues: JiraIssue[] }>(`/api/orgs/${orgId}/jira/issues`, await getToken()); setIssues(r.issues); setShowIssues(true) }
    catch (e: any) { note('jira', e?.message ?? 'Could not load issues') }
  }

  // Connected → last test ok · Failing → last test failed · Untested → no test this session.
  const health = (row: Row): { label: string; color: string } | null => {
    if (!row.connected) return null
    const t = tests[row.id]
    if (!t) return { label: 'Untested', color: tk.muted }
    return t.ok ? { label: 'Connected', color: tk.green } : { label: 'Failing', color: tk.red }
  }

  const grouped = CATEGORY_ORDER.map(cat => ({ cat, items: rows.filter(r => r.category === cat) })).filter(g => g.items.length)
  const healthyCount = rows.filter(r => r.connected && tests[r.id]?.ok !== false).length

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Connectors <span style={s.sub}>{healthyCount}/{rows.length} connected</span></h1>
        <button style={s.ghost} onClick={load}>↻ Refresh</button>
      </div>
      {msg._global && <div style={s.err}>⚠ {msg._global}</div>}

      {grouped.map(g => (
        <div key={g.cat}>
          <h2 style={s.h2}>{g.cat}</h2>
          <div style={s.grid}>
            {g.items.map(row => {
              const pill = health(row)
              const t = tests[row.id]
              return (
              <div key={row.id} style={s.card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 26 }}>{row.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {row.name}
                      {pill && <span style={{ ...s.pill, color: pill.color, border: `1px solid ${pill.color}` }}>{pill.label}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: pill ? pill.color : tk.muted }}>
                      {row.connected ? `● ${row.detail ?? 'Connected'}` : '○ Not connected'}
                      {t && <span style={{ color: tk.muted }}> · tested {rel(t.at)}</span>}
                    </div>
                  </div>
                </div>

                {row.connected ? (
                  replacing === row.id ? (
                    <div style={{ marginTop: 10 }}>
                      <input style={s.input} type="password" autoFocus autoComplete="off"
                        placeholder="Paste new token" aria-label={`New ${row.name} token`}
                        value={replaceTok} onChange={e => setReplaceTok(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveReplace(row); if (e.key === 'Escape') cancelReplace(row) }} />
                      <div style={s.actions}>
                        <button style={s.btnPrimary} disabled={busy === row.id || !replaceTok.trim()} onClick={() => saveReplace(row)}>{busy === row.id ? 'Saving…' : 'Save'}</button>
                        <button style={s.btn} onClick={() => cancelReplace(row)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={s.actions}>
                      <button style={s.btn} disabled={busy === row.id} onClick={() => test(row)}>Test</button>
                      {takesToken(row) && <button style={s.btn} disabled={busy === row.id} onClick={() => { setReplacing(row.id); setReplaceTok(''); note(row.id, '') }}>Replace token</button>}
                      {row.id === 'jira' && <button style={s.btn} onClick={loadIssues}>{showIssues ? 'Hide issues' : 'View issues'}</button>}
                      <button style={s.btnDanger} disabled={busy === row.id} onClick={() => disconnect(row)}>Disconnect</button>
                    </div>
                  )
                ) : row.authType === 'oauth' ? (
                  <div style={s.actions}>
                    <button style={s.btnPrimary} disabled={busy === row.id} onClick={() => connect(row)}>Connect with Google</button>
                    <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a>
                  </div>
                ) : openForm === row.id ? (
                  <div style={{ marginTop: 10 }}>
                    {row.authType === 'token' ? (
                      <input style={s.input} type="password" placeholder="Paste token" value={form[row.id]?.token ?? ''} onChange={e => setF(row.id, 'token', e.target.value)} />
                    ) : (
                      row.fields.map(f => (
                        <input key={f} style={s.input}
                          type={/token|secret|apitoken/i.test(f) ? 'password' : 'text'}
                          placeholder={FIELD_LABEL[f] ?? f}
                          value={form[row.id]?.[f] ?? ''}
                          onChange={e => setF(row.id, f, e.target.value)} />
                      ))
                    )}
                    {HINT[row.id] && <p style={s.hint}>{HINT[row.id]} <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a></p>}
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
                {msg[row.id] && (
                  <div style={{ fontSize: 12, color: msg[row.id].startsWith('✓') ? tk.green : msg[row.id].startsWith('✗') ? tk.red : msg[row.id] === 'Testing…' ? tk.muted : tk.red, marginTop: 8 }}>
                    {msg[row.id]}
                  </div>
                )}
              </div>
            )})}
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
                <span style={{ color: tk.accent, fontSize: 12, fontWeight: 700 }}>{i.key}</span>
                <span style={{ fontSize: 13 }}>{i.summary.slice(0, 64)}{i.summary.length > 64 ? '…' : ''}</span>
                <span style={{ fontSize: 12, color: tk.muted }}>{i.status}</span>
                <span style={{ fontSize: 12, color: tk.muted }}>{i.priority ?? '—'}</span>
                <span style={{ fontSize: 12, color: tk.muted }}>{i.assignee ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { ...ui.page, gap: 18 },
  h1: ui.h1,
  sub: ui.sub,
  h2: { ...ui.h2, margin: '4px 0 10px' },
  ghost: ui.ghost,
  err: ui.err,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 },
  card: ui.card,
  actions: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' },
  btn: ui.btn,
  btnPrimary: ui.btnPrimary,
  btnDanger: ui.btnDanger,
  pill: ui.pill,
  link: { color: tk.blue, fontSize: 12, textDecoration: 'none' },
  input: { ...ui.input, width: '100%', marginBottom: 8, boxSizing: 'border-box' },
  hint: { ...ui.hint, fontSize: 11.5, margin: '2px 0 6px' },
  table: { border: `1px solid ${tk.line}`, borderRadius: tk.r.md, overflow: 'hidden' },
  thead: { display: 'grid', gap: 10, padding: '10px 14px', background: tk.surfaceHigh, fontSize: 11, color: tk.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 },
  trow: { display: 'grid', gap: 10, padding: '10px 14px', borderTop: `1px solid ${tk.lineSoft}`, alignItems: 'center' },
}
