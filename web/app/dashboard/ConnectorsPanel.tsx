'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, ui, text, space, density } from './tokens'
import { Button, Card, DenseRow, DenseTable, IconButton, Pill, SectionLabel, Select, Skeleton, TextInput, type PillTone } from './ui'

// Connectors tab — unified connection manager for Jira, GitHub, Google
// (Gmail/Calendar/Drive as one card), Hugging Face, and the Obsidian vault.
// Credentials go to the backend's encrypted secret store; Google rides on one
// shared OAuth.
// MCA-77: inline token rotation, honest error mapping, per-connector
// health pill (session-local test results), tokenized styles.
// MCA-79: shared api() client + ui.tsx primitives + density scale.
// MCA-81: one consolidated Google card (per-service rows + toggles), gear
// settings (Google account/calendar/drive scope; vault repo/root/branch +
// replace-token), initial-load skeletons, auto-fit card grid.

type Getter = () => Promise<string | null>

type Row = { id: string; name: string; category: string; authType: 'token' | 'basic' | 'oauth'; icon: string; docsUrl: string; fields: string[]; connected: boolean; detail: string | null }
type JiraIssue = { id: string; key: string; summary: string; status?: string; priority?: string; assignee?: string }
type TestResult = { ok: boolean; at: number }
type GoogleService = 'gmail' | 'calendar' | 'drive'
type GoogleConfig = { services: Record<GoogleService, boolean>; calendarId: string; driveScope: 'all' | 'folder'; driveFolderId?: string }
type VaultConfig = { repo: string; root: string; branch: string }

const CATEGORY_ORDER = ['Memory', 'Project', 'Dev', 'Google', 'AI']
const GOOGLE_IDS = ['gmail', 'gcal', 'gdrive']
const SVC_KEY: Record<string, GoogleService> = { gmail: 'gmail', gcal: 'calendar', gdrive: 'drive' }
const SVC_LABEL: Record<string, string> = { gmail: 'Gmail', gcal: 'Calendar', gdrive: 'Drive' }
const DEFAULT_GCFG: GoogleConfig = { services: { gmail: true, calendar: true, drive: true }, calendarId: 'primary', driveScope: 'all' }

const HINT: Record<string, string> = {
  github: 'Personal access token (Contents/Repo read).',
  huggingface: 'Access token from huggingface.co/settings/tokens.',
  obsidian: 'Point at your Obsidian vault’s Git repo — every agent reads & writes this one shared memory. Token needs repo read+write.',
}
const FIELD_LABEL: Record<string, string> = {
  domain: 'domain (e.g. 7ei → 7ei.atlassian.net)', email: 'email', apiToken: 'API token', defaultProjectKey: 'default project key (O7MC)',
  repo: 'owner/repo (e.g. Arturito7ei/7Ei-MC_TARCO)', root: 'root folder (vault)', branch: 'branch (main)', token: 'GitHub token (repo scope)',
}

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
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [form, setForm] = useState<Record<string, any>>({})
  const [openForm, setOpenForm] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<string | null>(null)
  const [replaceTok, setReplaceTok] = useState('')
  const [tests, setTests] = useState<Record<string, TestResult>>({})
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [showIssues, setShowIssues] = useState(false)
  // MCA-81 — gear settings state
  const [gear, setGear] = useState<'google' | 'obsidian' | null>(null)
  const [gcfg, setGcfg] = useState<GoogleConfig | null>(null)   // last saved Google config
  const [gform, setGForm] = useState<GoogleConfig | null>(null) // editing copy
  const [vform, setVForm] = useState<VaultConfig | null>(null)  // vault editing copy
  const [vaultTok, setVaultTok] = useState('')                  // vault replace-token (in settings)

  const load = useCallback(async () => {
    try { const r = await api<{ connectors: Row[] }>(`/api/orgs/${orgId}/connectors`, { token: await getToken() }); setRows(r.connectors) }
    catch (e: any) { setMsg(m => ({ ...m, _global: e?.message ?? 'Failed to load' })) }
    setLoaded(true)
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  const googleRows = rows.filter(r => GOOGLE_IDS.includes(r.id))
  const gConnected = googleRows.some(r => r.connected)
  const nonGoogle = rows.filter(r => !GOOGLE_IDS.includes(r.id))

  // Google config rides on the card once connected (service toggles need it).
  const loadGoogleCfg = useCallback(async () => {
    try {
      const r = await api<{ config: GoogleConfig }>(`/api/orgs/${orgId}/connectors/google/config`, { token: await getToken() })
      setGcfg(r.config); setGForm(f => f ?? r.config)
    } catch { /* defaults apply until the endpoint answers */ }
  }, [orgId, getToken])
  useEffect(() => { if (gConnected && !gcfg) loadGoogleCfg() }, [gConnected, gcfg, loadGoogleCfg])

  const setF = (id: string, k: string, v: string) => setForm(f => ({ ...f, [id]: { ...(f[id] ?? {}), [k]: v } }))
  const note = (id: string, t: string) => setMsg(m => ({ ...m, [id]: t }))

  const test = useCallback(async (row: Row) => {
    setBusy(row.id); note(row.id, 'Testing…')
    try {
      const r = await api<{ ok: boolean; detail: string | null }>(`/api/orgs/${orgId}/connectors/${row.id}/test`, { token: await getToken(), method: 'POST', body: '{}' })
      setTests(t => ({ ...t, [row.id]: { ok: r.ok, at: Date.now() } }))
      note(row.id, r.ok ? `✓ ${r.detail ?? 'OK'}` : `✗ ${r.detail ?? 'failed'}`)
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

  // Replace token (MCA-77): pure token connectors keep the inline flow on the
  // card; the vault's replace control lives in its gear settings (MCA-81).
  const saveReplace = async (row: Row) => {
    const token = replaceTok.trim()
    if (!token) return
    return connect(row, { token })
  }
  const cancelReplace = (row: Row) => { setReplacing(null); setReplaceTok(''); note(row.id, '') }

  const disconnect = async (row: Row) => {
    setBusy(row.id); note(row.id, '')
    try {
      await api(`/api/orgs/${orgId}/connectors/${row.id}`, { token: await getToken(), method: 'DELETE' })
      setTests(t => { const rest = { ...t }; delete rest[row.id]; return rest })
      if (row.id === 'jira') { setShowIssues(false); setIssues([]) }
      if (GOOGLE_IDS.includes(row.id)) { // shared OAuth row — all three go together
        setTests(t => { const rest = { ...t }; for (const id of GOOGLE_IDS) delete rest[id]; return rest })
        setGcfg(null); setGForm(null); if (gear === 'google') setGear(null)
      }
      if (row.id === 'obsidian' && gear === 'obsidian') setGear(null)
      await load()
    } catch (e: any) { note(row.id, e?.message ?? 'Failed') }
    setBusy(null)
  }

  const loadIssues = async () => {
    if (showIssues) { setShowIssues(false); return }
    try { const r = await api<{ issues: JiraIssue[] }>(`/api/orgs/${orgId}/jira/issues`, { token: await getToken() }); setIssues(r.issues); setShowIssues(true) }
    catch (e: any) { note('jira', e?.message ?? 'Could not load issues') }
  }

  // ── MCA-81: gear settings ──────────────────────────────────────────────────

  const cancelGear = () => {
    setGear(null); setGForm(gcfg); setVaultTok(''); // restore last-saved values
  }

  const openGoogleGear = () => { setGForm(gcfg ?? DEFAULT_GCFG); setGear('google') }

  const saveGoogleCfg = async () => {
    if (!gform) return
    setBusy('google'); note('google', '')
    // empty calendarId falls back to the stored value server-side (min-length guard)
    const payload = { ...gform, calendarId: gform.calendarId.trim() || undefined }
    try {
      const r = await api<{ config: GoogleConfig }>(`/api/orgs/${orgId}/connectors/google/config`, { token: await getToken(), method: 'PUT', body: JSON.stringify(payload) })
      setGcfg(r.config); setGForm(r.config); setGear(null); note('google', '✓ settings saved')
      setBusy(null)
      for (const row of googleRows) if (r.config.services[SVC_KEY[row.id]]) await test(row) // re-test enabled services
      return
    } catch (e: any) { note('google', `✗ ${e?.message ?? 'Failed'}`) }
    setBusy(null)
  }

  const toggleService = async (rowId: string) => {
    const svc = SVC_KEY[rowId]
    const next = !((gcfg ?? DEFAULT_GCFG).services[svc])
    setBusy(rowId); note(rowId, '')
    try {
      const r = await api<{ config: GoogleConfig }>(`/api/orgs/${orgId}/connectors/google/config`, { token: await getToken(), method: 'PUT', body: JSON.stringify({ services: { [svc]: next } }) })
      setGcfg(r.config); if (gear !== 'google') setGForm(r.config)
    } catch (e: any) { note('google', `✗ ${e?.message ?? 'Failed'}`) }
    setBusy(null)
  }

  // Switch account — same redirect pattern as Connect, with the account chooser forced.
  const switchAccount = async () => {
    setBusy('google')
    try {
      const r = await api<{ url: string }>(`/api/orgs/${orgId}/auth/google?switch=1`, { token: await getToken() })
      window.location.href = r.url; return
    } catch (e: any) { note('google', `✗ ${e?.message ?? 'Failed'}`) }
    setBusy(null)
  }

  const openVaultGear = async (row: Row) => {
    setGear('obsidian'); setVaultTok(''); setVForm(null)
    try { const r = await api<{ config: VaultConfig }>(`/api/orgs/${orgId}/connectors/obsidian/config`, { token: await getToken() }); setVForm(r.config) }
    catch (e: any) { note(row.id, `✗ ${e?.message ?? 'Could not load vault config'}`) }
  }

  const saveVaultCfg = async (row: Row) => {
    if (!vform) return
    setBusy(row.id); note(row.id, '')
    // blank fields fall back to the stored values server-side (min-length guards)
    const payload = { repo: vform.repo.trim() || undefined, root: vform.root.trim() || undefined, branch: vform.branch.trim() || undefined }
    try {
      await api(`/api/orgs/${orgId}/connectors/obsidian/config`, { token: await getToken(), method: 'PUT', body: JSON.stringify(payload) })
      setGear(null)
      await load()
      setBusy(null); await test(row); return // save-and-test
    } catch (e: any) { note(row.id, `✗ ${e?.message ?? 'Failed'}`) }
    setBusy(null)
  }

  const saveVaultToken = async (row: Row) => {
    const token = vaultTok.trim()
    if (!token) return
    const cfg = vform ?? parseVaultDetail(row.detail) // preserve repo/root/branch
    if (!cfg) { note(row.id, 'Could not read stored vault config — disconnect and reconnect instead.'); return }
    setGear(null); setVaultTok('')
    return connect(row, { repo: cfg.repo, root: cfg.root, branch: cfg.branch, token })
  }

  // ── health pills ───────────────────────────────────────────────────────────

  // Connected → last test ok · Failing → last test failed · Untested → no test this session.
  const health = (row: Row): { label: string; tone: PillTone; color: string } | null => {
    if (!row.connected) return null
    const t = tests[row.id]
    if (!t) return { label: 'Untested', tone: 'muted', color: tk.muted }
    return t.ok ? { label: 'Connected', tone: 'ok', color: tk.green } : { label: 'Failing', tone: 'fail', color: tk.red }
  }
  const googleHealth = (): { label: string; tone: PillTone; color: string } | null => {
    if (!gConnected) return null
    const ts = GOOGLE_IDS.map(id => tests[id]).filter(Boolean) as TestResult[]
    if (!ts.length) return { label: 'Untested', tone: 'muted', color: tk.muted }
    return ts.some(t => !t.ok) ? { label: 'Failing', tone: 'fail', color: tk.red } : { label: 'Connected', tone: 'ok', color: tk.green }
  }

  const grouped = CATEGORY_ORDER
    .map(cat => ({ cat, items: nonGoogle.filter(r => r.category === cat) }))
    .filter(g => g.items.length || (g.cat === 'Google' && googleRows.length))

  // Header count treats the Google trio as one connector card.
  const unitTotal = nonGoogle.length + (googleRows.length ? 1 : 0)
  const unitHealthy = nonGoogle.filter(r => r.connected && tests[r.id]?.ok !== false).length
    + (gConnected && !GOOGLE_IDS.some(id => tests[id]?.ok === false) ? 1 : 0)

  const gearBtn = (key: 'google' | 'obsidian', name: string, onOpen: () => void) => (
    <IconButton aria-label={`${name} settings`} aria-expanded={gear === key} title={`${name} settings`}
      style={{ width: 26, height: 26, padding: 0, fontSize: 13, flexShrink: 0, ...(gear === key ? { color: tk.accent, borderColor: tk.accent } : {}) }}
      onClick={() => (gear === key ? cancelGear() : onOpen())}>⚙</IconButton>
  )

  // ── Google card (one card for the gmail/gcal/gdrive backend connectors) ────

  const renderGoogleCard = () => {
    const pill = googleHealth()
    const oauthRow = googleRows[0]
    const cfg = gcfg ?? DEFAULT_GCFG
    const lastTest = GOOGLE_IDS.map(id => tests[id]).filter(Boolean).sort((a, b) => b!.at - a!.at)[0]
    return (
      <Card key="google">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 26 }}>🌐</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: text.lg.fontSize, display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
              Google
              {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
            </div>
            <div style={{ fontSize: text.sm.fontSize, color: pill ? pill.color : tk.muted }}>
              {gConnected ? `● ${oauthRow?.detail ?? 'Connected'}` : '○ Not connected'}
              {lastTest && <span style={{ color: tk.muted }}> · tested {rel(lastTest.at)}</span>}
            </div>
          </div>
          {gConnected && gearBtn('google', 'Google', openGoogleGear)}
        </div>

        {gConnected ? (
          <>
            {/* per-service rows — each tests its own backend connector id */}
            <div style={{ marginTop: space.md }}>
              {googleRows.map(r => {
                const enabled = cfg.services[SVC_KEY[r.id]]
                const t = tests[r.id]
                const status = !enabled ? 'off' : (msg[r.id] || (t ? `${t.ok ? '✓' : '✗'} tested ${rel(t.at)}` : 'untested'))
                const statusColor = !enabled ? tk.mutedSoft : status.startsWith('✓') ? tk.green : status.startsWith('✗') ? tk.red : tk.muted
                return (
                  <div key={r.id} style={s.svcRow}>
                    <span style={{ width: 20, flexShrink: 0 }}>{r.icon}</span>
                    <span style={{ width: 68, fontWeight: 600, flexShrink: 0 }}>{SVC_LABEL[r.id]}</span>
                    <span style={{ flex: 1, color: statusColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status}</span>
                    <IconButton disabled={busy === r.id || !enabled} aria-label={`Test ${SVC_LABEL[r.id]}`} onClick={() => test(r)}>Test</IconButton>
                    <IconButton role="switch" aria-checked={enabled} aria-label={`${SVC_LABEL[r.id]} ${enabled ? 'on' : 'off'}`}
                      disabled={busy === r.id}
                      style={{ width: 34, color: enabled ? tk.green : tk.muted, borderColor: enabled ? tk.green : 'var(--line-strong)' }}
                      onClick={() => toggleService(r.id)}>{enabled ? 'On' : 'Off'}</IconButton>
                  </div>
                )
              })}
            </div>

            {/* gear settings (MCA-81 mockup v2) */}
            {gear === 'google' && gform && (
              <div style={s.settings} onKeyDown={e => { if (e.key === 'Escape') cancelGear() }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: space.md, fontSize: text.sm.fontSize }}>
                  <span style={{ color: tk.muted, width: 88, flexShrink: 0 }}>Account</span>
                  {/* backend doesn't expose the bound email yet — see MCA-81 notes */}
                  <span style={{ flex: 1, color: tk.textDim }}>—</span>
                  <Button disabled={busy === 'google'} onClick={switchAccount}>Switch account</Button>
                </div>
                <label style={s.settingsLabel}>Calendar ID
                  <TextInput value={gform.calendarId} placeholder="primary"
                    onChange={e => setGForm(f => f && { ...f, calendarId: e.target.value })} />
                </label>
                <div style={{ display: 'flex', gap: space.md }}>
                  <label style={{ ...s.settingsLabel, width: 130, flexShrink: 0 }}>Drive scope
                    <Select value={gform.driveScope} onChange={e => setGForm(f => f && { ...f, driveScope: e.target.value as 'all' | 'folder' })}>
                      <option value="all">All of Drive</option>
                      <option value="folder">One folder</option>
                    </Select>
                  </label>
                  {gform.driveScope === 'folder' && (
                    <label style={{ ...s.settingsLabel, flex: 1 }}>Folder ID
                      <TextInput value={gform.driveFolderId ?? ''} placeholder="Drive folder ID"
                        onChange={e => setGForm(f => f && { ...f, driveFolderId: e.target.value })} />
                    </label>
                  )}
                </div>
                <div style={{ display: 'flex', gap: space.lg, flexWrap: 'wrap' }}>
                  {(Object.keys(SVC_KEY) as string[]).map(id => (
                    <label key={id} style={{ display: 'flex', alignItems: 'center', gap: space.sm, fontSize: text.sm.fontSize, color: tk.textDim }}>
                      <input type="checkbox" checked={gform.services[SVC_KEY[id]]}
                        onChange={e => setGForm(f => f && { ...f, services: { ...f.services, [SVC_KEY[id]]: e.target.checked } })} />
                      {SVC_LABEL[id]}
                    </label>
                  ))}
                </div>
                <div style={s.actions}>
                  <Button variant="primary" disabled={busy === 'google'} onClick={saveGoogleCfg}>{busy === 'google' ? 'Saving…' : 'Save'}</Button>
                  <Button onClick={cancelGear}>Cancel</Button>
                </div>
              </div>
            )}

            {gear !== 'google' && (
              <div style={s.actions}>
                <Button variant="danger" disabled={busy === oauthRow?.id} onClick={() => oauthRow && disconnect(oauthRow)}>Disconnect</Button>
                <a style={s.link} href={oauthRow?.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a>
              </div>
            )}
          </>
        ) : (
          <div style={s.actions}>
            <Button variant="primary" disabled={busy === oauthRow?.id} onClick={() => oauthRow && connect(oauthRow)}>Connect with Google</Button>
            <a style={s.link} href={oauthRow?.docsUrl} target="_blank" rel="noreferrer">Docs ↗</a>
          </div>
        )}
        {msg.google && (
          <div style={{ fontSize: text.sm.fontSize, color: msg.google.startsWith('✓') ? tk.green : tk.red, marginTop: space.md }}>{msg.google}</div>
        )}
      </Card>
    )
  }

  // ── generic connector card (incl. obsidian gear settings) ─────────────────

  const renderCard = (row: Row) => {
    const pill = health(row)
    const t = tests[row.id]
    return (
      <Card key={row.id}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 26 }}>{row.icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: text.lg.fontSize, display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
              {row.name}
              {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
            </div>
            <div style={{ fontSize: text.sm.fontSize, color: pill ? pill.color : tk.muted }}>
              {row.connected ? `● ${row.detail ?? 'Connected'}` : '○ Not connected'}
              {t && <span style={{ color: tk.muted }}> · tested {rel(t.at)}</span>}
            </div>
          </div>
          {row.id === 'obsidian' && row.connected && gearBtn('obsidian', 'Vault', () => openVaultGear(row))}
        </div>

        {row.id === 'obsidian' && row.connected && gear === 'obsidian' ? (
          <div style={s.settings} onKeyDown={e => { if (e.key === 'Escape') cancelGear() }}>
            {!vform ? (
              <>
                <Skeleton h={density.ctrl} />
                <Skeleton h={density.ctrl} w="70%" />
              </>
            ) : (
              <>
                {(['repo', 'root', 'branch'] as const).map(f => (
                  <label key={f} style={s.settingsLabel}>{f === 'repo' ? 'Repository (owner/name)' : f === 'root' ? 'Root folder' : 'Branch'}
                    <TextInput value={vform[f]} placeholder={FIELD_LABEL[f]}
                      onChange={e => setVForm(v => v && { ...v, [f]: e.target.value })} />
                  </label>
                ))}
                <div style={s.actions}>
                  <Button variant="primary" disabled={busy === row.id} onClick={() => saveVaultCfg(row)}>{busy === row.id ? 'Saving…' : 'Save & test'}</Button>
                  <Button onClick={cancelGear}>Cancel</Button>
                </div>
                <div style={{ borderTop: `1px solid ${tk.lineSoft}`, paddingTop: space.md }}>
                  <label style={s.settingsLabel}>Replace token
                    <TextInput type="password" autoComplete="off" placeholder="Paste new GitHub token"
                      aria-label="New vault token" value={vaultTok}
                      onChange={e => setVaultTok(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveVaultToken(row) }} />
                  </label>
                  <div style={s.actions}>
                    <Button disabled={busy === row.id || !vaultTok.trim()} onClick={() => saveVaultToken(row)}>Save token</Button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : row.connected ? (
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
              {row.authType === 'token' && <Button disabled={busy === row.id} onClick={() => { setReplacing(row.id); setReplaceTok(''); note(row.id, '') }}>Replace token</Button>}
              {row.id === 'jira' && <Button onClick={loadIssues}>{showIssues ? 'Hide issues' : 'View issues'}</Button>}
              <Button variant="danger" disabled={busy === row.id} onClick={() => disconnect(row)}>Disconnect</Button>
            </div>
          )
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
    )
  }

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={s.h1}>Connectors <span style={s.sub}>{loaded ? `${unitHealthy}/${unitTotal} connected` : '…'}</span></h1>
        <Button style={{ color: tk.accent }} onClick={load}>↻ Refresh</Button>
      </div>
      {msg._global && <div style={s.err}>⚠ {msg._global}</div>}

      {!loaded && !rows.length ? (
        // MCA-81 — skeleton cards while the connector list is in flight.
        <div>
          <Skeleton w={80} h={12} style={{ margin: '4px 0 8px' }} />
          <div style={s.grid}>
            {[0, 1, 2, 3, 4, 5].map(i => (
              <Card key={i}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Skeleton w={26} h={26} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: space.sm }}>
                    <Skeleton w="55%" h={14} />
                    <Skeleton w="75%" h={11} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: space.md, marginTop: space.lg }}>
                  <Skeleton w={88} h={density.ctrl} />
                  <Skeleton w={56} h={density.ctrl} />
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        grouped.map(g => (
          <div key={g.cat}>
            <SectionLabel style={{ margin: '4px 0 8px' }}>{g.cat}</SectionLabel>
            <div style={s.grid}>
              {g.cat === 'Google' && googleRows.length ? renderGoogleCard() : null}
              {g.items.map(renderCard)}
            </div>
          </div>
        ))
      )}

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
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: space.lg },
  actions: { display: 'flex', gap: space.md, marginTop: space.lg, alignItems: 'center', flexWrap: 'wrap' },
  link: { color: tk.blue, fontSize: text.sm.fontSize, textDecoration: 'none' },
  input: { width: '100%', marginBottom: space.md },
  hint: { ...ui.hint, fontSize: 11.5, margin: '2px 0 6px' },
  svcRow: { display: 'flex', alignItems: 'center', gap: space.md, boxSizing: 'border-box', minHeight: density.row, padding: `${density.cellY}px 0`, borderTop: `1px solid ${tk.lineSoft}`, fontSize: text.sm.fontSize, lineHeight: text.sm.lineHeight },
  settings: { marginTop: space.md, borderTop: `1px solid ${tk.lineSoft}`, paddingTop: space.md, display: 'flex', flexDirection: 'column', gap: space.md },
  settingsLabel: { display: 'flex', flexDirection: 'column', gap: space.xs, fontSize: text.xs.fontSize, fontWeight: 600, color: tk.muted },
}
