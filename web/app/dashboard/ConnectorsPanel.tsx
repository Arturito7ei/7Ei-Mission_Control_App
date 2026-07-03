'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, ui, text, space } from './tokens'
import { Button, Card, DenseRow, DenseTable, Pill, SectionLabel, TextInput, type PillTone } from './ui'

// Connectors tab — unified connection manager for Jira, GitHub, Gmail,
// Google Calendar, Google Drive, and Hugging Face. Credentials go to the
// backend's encrypted secret store; Google rides on one shared OAuth.
// MCA-77: inline token rotation, honest error mapping, per-connector
// health pill (session-local test results), tokenized styles.
// MCA-79: shared api() client + ui.tsx primitives + density scale.

type Getter = () => Promise<string | null>

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
    try { const r = await api<{ connectors: Row[] }>(`/api/orgs/${orgId}/connectors`, { token: await getToken() }); setRows(r.connectors) }
    catch (e: any) { setMsg(m => ({ ...m, _global: e?.message ?? 'Failed to load' })) }
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  const setF = (id: string, k: string, v: string) => setForm(f => ({ ...f, [id]: { ...(f[id] ?? {}), [k]: v } }))
  const note = (id: string, t: string) => setMsg(m => ({ ...m, [id]: t }))

  const test = useCallback(async (row: Row) => {
    setBusy(row.id); note(row.id, 'Testing…')
    try {
      const r = await api<{ ok: boolean; detail: string | null }>(`/api/orgs/${orgId}/connectors/${row.id}/test`, { token: await getToken(), method: 'POST', body: '{}' })
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
        const r = await api<{ authUrl: string }>(`/api/orgs/${orgId}/connectors/${row.id}/connect`, { token: await getToken(), method: 'POST', body: '{}' })
        window.location.href = r.authUrl; return
      }
      const body = replacementBody ?? (row.authType === 'token' ? { token: (form[row.id]?.token ?? '').trim() } : (form[row.id] ?? {}))
      await api(`/api/orgs/${orgId}/connectors/${row.id}/connect`, { token: await getToken(), method: 'POST', body: JSON.stringify(body) })
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
      await api(`/api/orgs/${orgId}/connectors/${row.id}`, { token: await getToken(), method: 'DELETE' })
      setTests(t => { const rest = { ...t }; delete rest[row.id]; return rest })
      if (row.id === 'jira') { setShowIssues(false); setIssues([]) }
      await load()
    } catch (e: any) { note(row.id, e?.message ?? 'Failed') }
    setBusy(null)
  }

  const loadIssues = async () => {
    if (showIssues) { setShowIssues(false); return }
    try { const r = await api<{ issues: JiraIssue[] }>(`/api/orgs/${orgId}/jira/issues`, { token: await getToken() }); setIssues(r.issues); setShowIssues(true) }
    catch (e: any) { note('jira', e?.message ?? 'Could not load issues') }
  }

  // Connected → last test ok · Failing → last test failed · Untested → no test this session.
  const health = (row: Row): { label: string; tone: PillTone; color: string } | null => {
    if (!row.connected) return null
    const t = tests[row.id]
    if (!t) return { label: 'Untested', tone: 'muted', color: tk.muted }
    return t.ok ? { label: 'Connected', tone: 'ok', color: tk.green } : { label: 'Failing', tone: 'fail', color: tk.red }
  }

  const grouped = CATEGORY_ORDER.map(cat => ({ cat, items: rows.filter(r => r.category === cat) })).filter(g => g.items.length)
  const healthyCount = rows.filter(r => r.connected && tests[r.id]?.ok !== false).length

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Connectors <span style={s.sub}>{healthyCount}/{rows.length} connected</span></h1>
        <Button style={{ color: tk.accent }} onClick={load}>↻ Refresh</Button>
      </div>
      {msg._global && <div style={s.err}>⚠ {msg._global}</div>}

      {grouped.map(g => (
        <div key={g.cat}>
          <SectionLabel style={{ margin: '4px 0 8px' }}>{g.cat}</SectionLabel>
          <div style={s.grid}>
            {g.items.map(row => {
              const pill = health(row)
              const t = tests[row.id]
              return (
              <Card key={row.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 26 }}>{row.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: text.lg.fontSize, display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
                      {row.name}
                      {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
                    </div>
                    <div style={{ fontSize: text.sm.fontSize, color: pill ? pill.color : tk.muted }}>
                      {row.connected ? `● ${row.detail ?? 'Connected'}` : '○ Not connected'}
                      {t && <span style={{ color: tk.muted }}> · tested {rel(t.at)}</span>}
                    </div>
                  </div>
                </div>

                {row.connected ? (
                  replacing === row.id ? (
                    <div style={{ marginTop: space.md }}>
                      <TextInput style={s.input} type="password" autoFocus autoComplete="off"
                        placeholder="Paste new token" aria-label={`New ${row.name} token`}
                        value={replaceTok} onChange={e => setReplaceTok(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveReplace(row); if (e.key === 'Escape') cancelReplace(row) }} />
                      <div style={s.actions}>
                        <Button variant="primary" disabled={busy === row.id || !replaceTok.trim()} onClick={() => saveReplace(row)}>{busy === row.id ? 'Saving…' : 'Save'}</Button>
                        <Button onClick={() => cancelReplace(row)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div style={s.actions}>
                      <Button disabled={busy === row.id} onClick={() => test(row)}>Test</Button>
                      {takesToken(row) && <Button disabled={busy === row.id} onClick={() => { setReplacing(row.id); setReplaceTok(''); note(row.id, '') }}>Replace token</Button>}
                      {row.id === 'jira' && <Button onClick={loadIssues}>{showIssues ? 'Hide issues' : 'View issues'}</Button>}
                      <Button variant="danger" disabled={busy === row.id} onClick={() => disconnect(row)}>Disconnect</Button>
                    </div>
                  )
                ) : row.authType === 'oauth' ? (
                  <div style={s.actions}>
                    <Button variant="primary" disabled={busy === row.id} onClick={() => connect(row)}>Connect with Google</Button>
                    <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a>
                  </div>
                ) : openForm === row.id ? (
                  <div style={{ marginTop: space.md }}>
                    {row.authType === 'token' ? (
                      <TextInput style={s.input} type="password" placeholder="Paste token" value={form[row.id]?.token ?? ''} onChange={e => setF(row.id, 'token', e.target.value)} />
                    ) : (
                      row.fields.map(f => (
                        <TextInput key={f} style={s.input}
                          type={/token|secret|apitoken/i.test(f) ? 'password' : 'text'}
                          placeholder={FIELD_LABEL[f] ?? f}
                          value={form[row.id]?.[f] ?? ''}
                          onChange={e => setF(row.id, f, e.target.value)} />
                      ))
                    )}
                    {HINT[row.id] && <p style={s.hint}>{HINT[row.id]} <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a></p>}
                    <div style={s.actions}>
                      <Button variant="primary" disabled={busy === row.id} onClick={() => connect(row)}>{busy === row.id ? 'Connecting…' : 'Connect'}</Button>
                      <Button onClick={() => { setOpenForm(null); note(row.id, '') }}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div style={s.actions}>
                    <Button variant="primary" onClick={() => setOpenForm(row.id)}>Connect</Button>
                    <a style={s.link} href={row.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a>
                  </div>
                )}
                {msg[row.id] && (
                  <div style={{ fontSize: text.sm.fontSize, color: msg[row.id].startsWith('✓') ? tk.green : msg[row.id].startsWith('✗') ? tk.red : msg[row.id] === 'Testing…' ? tk.muted : tk.red, marginTop: space.md }}>
                    {msg[row.id]}
                  </div>
                )}
              </Card>
            )})}
          </div>
        </div>
      ))}

      {showIssues && (
        <div>
          <SectionLabel style={{ margin: '4px 0 8px' }}>Jira issues · {issues.length}</SectionLabel>
          <DenseTable cols="1fr 3fr 1.5fr 1fr 1.5fr" head={['Key', 'Summary', 'Status', 'Priority', 'Assignee']}>
            {issues.map(i => (
              <DenseRow key={i.id}>
                <span style={{ color: tk.accent, fontWeight: 700 }}>{i.key}</span>
                <span>{i.summary.slice(0, 64)}{i.summary.length > 64 ? '…' : ''}</span>
                <span style={{ color: tk.muted }}>{i.status}</span>
                <span style={{ color: tk.muted }}>{i.priority ?? '—'}</span>
                <span style={{ color: tk.muted }}>{i.assignee ?? '—'}</span>
              </DenseRow>
            ))}
          </DenseTable>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { ...ui.page, gap: space.xl },
  h1: ui.h1,
  sub: ui.sub,
  err: ui.err,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: space.lg },
  actions: { display: 'flex', gap: space.md, marginTop: space.lg, alignItems: 'center', flexWrap: 'wrap' },
  link: { color: tk.blue, fontSize: text.sm.fontSize, textDecoration: 'none' },
  input: { width: '100%', marginBottom: space.md },
  hint: { ...ui.hint, fontSize: 11.5, margin: '2px 0 6px' },
}
