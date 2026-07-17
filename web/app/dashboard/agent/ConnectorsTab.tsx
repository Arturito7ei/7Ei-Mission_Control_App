'use client'
// Epic CONN / CONN-2 — the per-agent Connectors tab: an ACCORDION grouped by
// category (Communication / IT-Project / Google / Custom MCP). Only the custom
// MCP server is REAL in v1 (the CONN-1 pilot) — add/configure/test/delete over
// the owner-gated `/api/orgs/:orgId/agents/:agentId/connectors[...]` API. Every
// other connector is a disabled "coming soon" / "out of scope" row (the backend
// catalog holds only `mcp`, so wiring them would 404 — we never fake a save).
//
// SECURITY: a stored credential is NEVER shown. The read projection carries no
// secret (not even a "secretRef") — only status + non-secret config + a masked
// label. The secret input is WRITE-ONLY (type=password, cleared after a
// successful save; blank on save keeps the existing token).
//
// AUTHZ: the whole surface is owner-only, and the backend is the real gate. The
// list GET is itself owner-gated, so a 403 on load = definitively not an owner →
// we render a clean read-only note instead of a scary error. Any mutating 403
// surfaces in the row's error line with the operator's edits preserved.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import {
  CONNECTOR_GROUPS, MCP_CONNECTOR_ID, GITHUB_CONNECTOR_ID, JIRA_CONNECTOR_ID, GOOGLE_CONNECTOR_ID, isConfigured,
  validateMcpConfig, mcpConfigToForm,
  validateGithubConfig, githubConfigToForm,
  validateJiraConfig, jiraConfigToForm,
  GOOGLE_SERVICES, GOOGLE_SERVICE_LABELS, defaultGoogleServices, hasAnyGoogleService,
  googleServicesFromConfig, googleScopesFromConfig,
  type DisplayConnector, type PublicConnectorState,
  type McpFormInput, type GithubFormInput, type JiraFormInput,
  type GoogleService, type GoogleServiceSelection,
} from '@/lib/agentConnectors'
import { Button, Card, Pill, Select, Skeleton, TextArea, TextInput } from '../ui'
import { FormLabel } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import { ax, type Getter } from './shared'

const rel = (ts: number | null) => {
  if (!ts) return null
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  return `${Math.round(min / 60)}h ago`
}

type StateMap = Record<string, PublicConnectorState>
const blankMcpForm = (): McpFormInput => ({ name: '', transport: 'http', url: '', command: '', args: '' })

export default function ConnectorsTab({ orgId, agentId, getToken }: {
  orgId: string
  agentId: string
  getToken: Getter
}) {
  const [states, setStates] = useState<StateMap>({})
  const [loaded, setLoaded] = useState(false)
  const [ownerOnly, setOwnerOnly] = useState(false)   // a 403 on the gated read
  const [loadErr, setLoadErr] = useState<string | null>(null)
  // A banner after returning from the Google OAuth bounce (?google=connected|error).
  const [oauthNotice, setOauthNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // Which category sections are open. Custom MCP (the real one) opens by default.
  const [open, setOpen] = useState<Record<string, boolean>>({ custom: true })

  // Detect the post-OAuth bounce: the callback redirects to /dashboard?google=…&agent=…
  // Show a banner, open the Google section, and strip the query so a refresh doesn't
  // re-show it. No token is ever in this URL — only a status + the agent id.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const g = params.get('google')
    if (!g) return
    const forThisAgent = !params.get('agent') || params.get('agent') === agentId
    if (forThisAgent) {
      setOpen(o => ({ ...o, google: true }))
      setOauthNotice(g === 'connected'
        ? { kind: 'ok', text: 'Google connected.' }
        : { kind: 'err', text: `Google connection failed${params.get('reason') ? ` (${params.get('reason')})` : ''}.` })
    }
    // Strip google/agent/reason from the URL without a navigation.
    for (const k of ['google', 'agent', 'reason']) params.delete(k)
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [agentId])

  const load = useCallback(async () => {
    setLoadErr(null); setOwnerOnly(false)
    try {
      const { connectors } = await api<{ connectors: PublicConnectorState[] }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors`, { token: await getToken() })
      setStates(Object.fromEntries(connectors.map(c => [c.connectorId, c])))
    } catch (e: any) {
      const m = String(e?.message ?? '')
      if (m.includes('HTTP 403')) setOwnerOnly(true)
      else setLoadErr(m || 'Could not load this agent’s connectors.')
    }
    setLoaded(true)
  }, [orgId, agentId, getToken])

  useEffect(() => { load() }, [load])

  const patchState = (id: string, s: PublicConnectorState | null) =>
    setStates(prev => {
      const next = { ...prev }
      if (s) next[id] = s; else delete next[id]
      return next
    })

  if (!loaded) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
      <Skeleton h={44} /><Skeleton h={44} /><Skeleton h={44} /><Skeleton h={44} />
    </div>
  )

  if (ownerOnly) return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
        <span aria-hidden="true">🔒</span>
        <span style={{ fontWeight: 700, color: tk.text }}>Connectors are owner-only</span>
      </div>
      <p style={{ ...ax.empty }}>
        Only an organization owner can view or configure this agent’s connectors. Ask an owner to make changes here.
      </p>
    </Card>
  )

  if (loadErr) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
      <div style={ax.err}>{loadErr}</div>
      <div><Button onClick={load}>Retry</Button></div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xl }}>
      <p style={{ ...ax.empty, maxWidth: 640 }}>
        Connect this agent to external services. Credentials are stored encrypted at agent scope and are never shown back —
        only their connection status. GitHub, Jira, Google and custom MCP servers are configurable today; the rest arrive in later stages.
      </p>

      {oauthNotice && (
        <div style={oauthNotice.kind === 'ok'
          ? { color: tk.green, fontSize: text.sm.fontSize }
          : ax.err}>
          {oauthNotice.text}
        </div>
      )}

      {CONNECTOR_GROUPS.map(group => {
        const isOpen = open[group.key] ?? false
        const configuredCount = group.connectors.filter(c => isConfigured(states[c.id])).length
        return (
          <section key={group.key} style={{ border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, overflow: 'hidden' }}>
            <button
              onClick={() => setOpen(o => ({ ...o, [group.key]: !isOpen }))}
              aria-expanded={isOpen}
              style={{
                display: 'flex', alignItems: 'center', gap: space.md, width: '100%',
                background: tk.surfaceHigh, border: 'none', cursor: 'pointer',
                padding: `${space.md}px ${space.lg}px`, color: tk.text, textAlign: 'left',
              }}>
              <span aria-hidden="true" style={{ color: tk.muted, fontSize: text.sm.fontSize, width: 12 }}>{isOpen ? '▾' : '▸'}</span>
              <span style={{ fontSize: text.md.fontSize, fontWeight: 700 }}>{group.title}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: space.sm, alignItems: 'center' }}>
                {configuredCount > 0 && <Pill tone="ok">{configuredCount} connected</Pill>}
                <span style={{ ...ax.empty }}>{group.connectors.length}</span>
              </span>
            </button>

            {isOpen && (
              <div>
                {group.connectors.map(conn => (
                  <ConnectorRow
                    key={conn.id} conn={conn} orgId={orgId} agentId={agentId} getToken={getToken}
                    state={states[conn.id] ?? null} onState={s => patchState(conn.id, s)} />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

// ─── One connector row + its inline config panel ──────────────────────────────

function ConnectorRow({ conn, state, orgId, agentId, getToken, onState }: {
  conn: DisplayConnector
  state: PublicConnectorState | null
  orgId: string
  agentId: string
  getToken: Getter
  onState: (s: PublicConnectorState | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const configured = isConfigured(state)
  const available = conn.availability === 'available'

  return (
    <div style={{ borderTop: `1px solid ${tk.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, padding: `${space.md}px ${space.lg}px` }}>
        <span aria-hidden="true" style={{ fontSize: 18 }}>{conn.icon}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
            <span style={{ fontSize: text.md.fontSize, fontWeight: 600, color: tk.text }}>{conn.name}</span>
            {available
              ? (configured ? <Pill tone="ok">Connected</Pill> : <Pill tone="muted">Not connected</Pill>)
              : (conn.availability === 'out_of_scope' ? <Pill tone="muted">Out of scope</Pill> : <Pill tone="warn">Coming soon</Pill>)}
          </div>
          {available && configured && state?.accountLabel && (
            <div style={{ fontSize: text.xs.fontSize, color: tk.muted, marginTop: 2 }}>{state.accountLabel}</div>
          )}
          {!available && conn.note && (
            <div style={{ fontSize: text.xs.fontSize, color: tk.muted, marginTop: 2 }}>{conn.note}</div>
          )}
        </div>
        {available
          ? <Button onClick={() => setExpanded(e => !e)}>{expanded ? 'Close' : configured ? 'Configure' : 'Add'}</Button>
          : <Button disabled>Unavailable</Button>}
      </div>

      {available && expanded && conn.id === MCP_CONNECTOR_ID && (
        <McpConfig orgId={orgId} agentId={agentId} getToken={getToken} state={state}
          onState={onState} onDone={() => setExpanded(false)} />
      )}
      {available && expanded && conn.id === GITHUB_CONNECTOR_ID && (
        <GithubConfig orgId={orgId} agentId={agentId} getToken={getToken} state={state}
          onState={onState} onDone={() => setExpanded(false)} />
      )}
      {available && expanded && conn.id === JIRA_CONNECTOR_ID && (
        <JiraConfig orgId={orgId} agentId={agentId} getToken={getToken} state={state}
          onState={onState} onDone={() => setExpanded(false)} />
      )}
      {available && expanded && conn.id === GOOGLE_CONNECTOR_ID && (
        <GoogleConfig orgId={orgId} agentId={agentId} getToken={getToken} state={state}
          onState={onState} onDone={() => setExpanded(false)} />
      )}
    </div>
  )
}

// ─── Google (OAuth) config panel (CONN-5) ─────────────────────────────────────
//
// No credential form: Google is CONNECTED via the OAuth flow. The operator picks the
// services to grant, hits Connect, and the browser navigates to Google's consent
// screen; the public callback stores the tokens (encrypted, agent-scoped) and bounces
// back to /dashboard?google=connected. When connected we show the account email +
// granted scopes (never a token) and a Disconnect. Owner-only (the start/disconnect
// routes are owner-gated; a member's action 403s and surfaces inline).
function GoogleConfig({ orgId, agentId, getToken, state, onState, onDone }: {
  orgId: string
  agentId: string
  getToken: Getter
  state: PublicConnectorState | null
  onState: (s: PublicConnectorState | null) => void
  onDone: () => void
}) {
  const connected = isConfigured(state)
  // Seed the service selection from the stored grant when connected, else default all.
  const [services, setServices] = useState<GoogleServiceSelection>(() =>
    connected ? googleServicesFromConfig(state?.config) : defaultGoogleServices())
  const [busy, setBusy] = useState<null | 'connect' | 'delete'>(null)
  const [err, setErr] = useState<string | null>(null)

  const grantedScopes = googleScopesFromConfig(state?.config)
  const toggle = (svc: GoogleService) => setServices(s => ({ ...s, [svc]: !s[svc] }))

  const connect = async () => {
    setErr(null)
    if (!hasAnyGoogleService(services)) { setErr('Select at least one Google service to connect.'); return }
    setBusy('connect')
    try {
      // Owner-gated start route → returns the Google consent URL. Navigate the browser
      // there; the flow completes at the public callback and bounces back here.
      const { url } = await api<{ url: string }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors/${GOOGLE_CONNECTOR_ID}/oauth/start`,
        { token: await getToken(), method: 'POST', body: JSON.stringify({ services }) })
      window.location.href = url
    } catch (e: any) {
      setErr(e?.message ?? 'Could not start Google connection.')
      setBusy(null)
    }
  }

  const remove = async () => {
    setErr(null); setBusy('delete')
    try {
      await api(`/api/orgs/${orgId}/agents/${agentId}/connectors/${GOOGLE_CONNECTOR_ID}`,
        { token: await getToken(), method: 'DELETE' })
      onState(null)
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Could not disconnect.'); setBusy(null) }
  }

  return (
    <Card style={{ margin: `0 ${space.lg}px ${space.lg}px`, display: 'flex', flexDirection: 'column', gap: space.lg, background: tk.bg }}>
      {connected && state?.accountLabel && (
        <div style={{ fontSize: text.sm.fontSize, color: tk.text }}>
          Connected as <strong>{state.accountLabel}</strong>
        </div>
      )}

      <div>
        <div style={{ fontSize: text.sm.fontSize, fontWeight: 600, color: tk.text, marginBottom: space.sm }}>
          {connected ? 'Granted services' : 'Services to grant'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.md }}>
          {GOOGLE_SERVICES.map(svc => (
            <label key={svc} style={{ display: 'flex', alignItems: 'center', gap: space.sm, fontSize: text.sm.fontSize, color: tk.text, cursor: 'pointer' }}>
              <input type="checkbox" checked={services[svc]} onChange={() => toggle(svc)} />
              {GOOGLE_SERVICE_LABELS[svc]}
            </label>
          ))}
        </div>
      </div>

      {connected && grantedScopes.length > 0 && (
        <details style={{ fontSize: text.xs.fontSize, color: tk.muted }}>
          <summary style={{ cursor: 'pointer' }}>{grantedScopes.length} granted scope{grantedScopes.length === 1 ? '' : 's'}</summary>
          <ul style={{ margin: `${space.sm}px 0 0`, paddingLeft: 18 }}>
            {grantedScopes.map(s => <li key={s} style={{ wordBreak: 'break-all' }}>{s}</li>)}
          </ul>
        </details>
      )}

      <p style={{ ...ax.empty, fontSize: text.xs.fontSize }}>
        Connecting opens Google’s consent screen. Tokens are stored encrypted at agent scope and are never shown back — this
        agent reads its own Google account. {connected ? 'Reconnect to change the granted services.' : ''}
      </p>

      {err && <div style={ax.err}>{err}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={connect} disabled={busy !== null}>
          {busy === 'connect' ? 'Redirecting…' : connected ? 'Reconnect' : 'Connect Google'}
        </Button>
        {connected && <Button variant="danger" onClick={remove} disabled={busy !== null}>{busy === 'delete' ? 'Removing…' : 'Disconnect'}</Button>}
      </div>
    </Card>
  )
}

// ─── Custom MCP config form (the one connector real in v1) ────────────────────

function McpConfig({ orgId, agentId, getToken, state, onState, onDone }: {
  orgId: string
  agentId: string
  getToken: Getter
  state: PublicConnectorState | null
  onState: (s: PublicConnectorState | null) => void
  onDone: () => void
}) {
  const configured = isConfigured(state)
  const [form, setForm] = useState<McpFormInput>(() => configured ? mcpConfigToForm(state?.config) : blankMcpForm())
  const [secret, setSecret] = useState('')   // WRITE-ONLY — never seeded from a read
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const setF = (k: keyof McpFormInput, v: string) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    setErr(null); setMsg(null)
    const valid = validateMcpConfig(form)
    if (valid.ok !== true) { setErr(valid.error); return }   // edits preserved on invalid input
    setBusy('save')
    try {
      const body: Record<string, unknown> = { config: valid.config }
      if (secret.trim()) body.secret = secret.trim()   // only sent when the operator typed one
      const { connector } = await api<{ connector: PublicConnectorState }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors/${MCP_CONNECTOR_ID}`,
        { token: await getToken(), method: 'POST', body: JSON.stringify(body) })
      onState(connector)                 // reconcile to the server's masked row
      setSecret('')                      // clear the write-only field after success
      setForm(mcpConfigToForm(connector.config))
      setMsg('Saved.')
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save this connector.')   // edits (incl. secret) preserved for retry
    }
    setBusy(null)
  }

  const test = async () => {
    setErr(null); setMsg(null); setBusy('test')
    try {
      const r = await api<{ ok: boolean; detail?: string | null; testedAt?: string }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors/${MCP_CONNECTOR_ID}/test`,
        { token: await getToken(), method: 'POST', body: '{}' })
      setMsg(r.ok ? `✓ ${r.detail ?? 'OK'}` : `✗ ${r.detail ?? 'failed'}`)
      if (state) onState({ ...state, lastTestedAt: r.testedAt ? Date.parse(r.testedAt) : Date.now(), lastError: null })
    } catch (e: any) { setErr(e?.message ?? 'Test failed.') }
    setBusy(null)
  }

  const remove = async () => {
    setErr(null); setMsg(null); setBusy('delete')
    try {
      await api(`/api/orgs/${orgId}/agents/${agentId}/connectors/${MCP_CONNECTOR_ID}`,
        { token: await getToken(), method: 'DELETE' })
      onState(null)
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Could not disconnect.'); setBusy(null) }
  }

  const lastTested = rel(state?.lastTestedAt ?? null)

  return (
    <Card style={{ margin: `0 ${space.lg}px ${space.lg}px`, display: 'flex', flexDirection: 'column', gap: space.lg, background: tk.bg }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: space.lg }}>
        <FormLabel>Name
          <TextInput value={form.name} placeholder="e.g. Weather MCP" onChange={e => setF('name', e.target.value)} />
        </FormLabel>
        <FormLabel>Transport
          <Select value={form.transport} onChange={e => setF('transport', e.target.value)}>
            <option value="http">HTTP (URL)</option>
            <option value="stdio">stdio (command)</option>
          </Select>
        </FormLabel>
      </div>

      {form.transport === 'http' ? (
        <FormLabel>Server URL
          <TextInput value={form.url} placeholder="https://mcp.example.com" inputMode="url"
            onChange={e => setF('url', e.target.value)} />
        </FormLabel>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
          <FormLabel>Command
            <TextInput value={form.command} placeholder="npx" onChange={e => setF('command', e.target.value)} />
          </FormLabel>
          <FormLabel>Arguments <span style={{ fontWeight: 400, color: tk.muted }}>· one per line</span>
            <TextArea value={form.args} placeholder={'@modelcontextprotocol/server-x\n--port\n3000'}
              onChange={e => setF('args', e.target.value)} style={{ minHeight: 64, fontFamily: 'monospace' }} />
          </FormLabel>
        </div>
      )}

      <FormLabel>Authentication token <span style={{ fontWeight: 400, color: tk.muted }}>· optional · write-only</span>
        <TextInput type="password" value={secret} autoComplete="off"
          placeholder={configured ? 'Leave blank to keep the stored token' : 'Bearer token / API key (optional)'}
          onChange={e => setSecret(e.target.value)} />
      </FormLabel>
      <p style={{ ...ax.empty, fontSize: text.xs.fontSize, marginTop: -space.sm }}>
        Stored encrypted at agent scope and injected into this agent’s runtime. It is never displayed back — leave blank to
        keep the existing token.
      </p>

      {err && <div style={ax.err}>{err}</div>}
      {msg && <div style={{ color: tk.green, fontSize: text.sm.fontSize }}>{msg}</div>}
      {configured && lastTested && !msg && (
        <div style={{ ...ax.empty, fontSize: text.xs.fontSize }}>Last tested {lastTested}.</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={save} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : configured ? 'Save changes' : 'Connect'}
        </Button>
        {configured && <Button onClick={test} disabled={busy !== null}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>}
        {configured && <Button variant="danger" onClick={remove} disabled={busy !== null}>{busy === 'delete' ? 'Removing…' : 'Disconnect'}</Button>}
      </div>
    </Card>
  )
}

// ─── GitHub (PAT) config form (CONN-4a, real via the agent-secrets env path) ──
//
// Same shape and security invariants as McpConfig: the PAT is WRITE-ONLY
// (type=password, seeded from '' never a read, cleared after a successful save,
// blank on save keeps the stored token). The only NON-secret config is an optional
// username label. The backend requires a token on FIRST configure — so the form
// blocks a first save with no token, but allows a blank token on re-configure.
function GithubConfig({ orgId, agentId, getToken, state, onState, onDone }: {
  orgId: string
  agentId: string
  getToken: Getter
  state: PublicConnectorState | null
  onState: (s: PublicConnectorState | null) => void
  onDone: () => void
}) {
  const configured = isConfigured(state)
  const [form, setForm] = useState<GithubFormInput>(() => githubConfigToForm(state?.config))
  const [secret, setSecret] = useState('')   // the PAT — WRITE-ONLY, never seeded from a read
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const save = async () => {
    setErr(null); setMsg(null)
    const valid = validateGithubConfig(form)
    if (valid.ok !== true) { setErr(valid.error); return }
    if (!configured && !secret.trim()) { setErr('A personal access token is required to connect GitHub.'); return }
    setBusy('save')
    try {
      const body: Record<string, unknown> = { config: valid.config }
      if (secret.trim()) body.secret = secret.trim()   // only sent when the operator typed one
      const { connector } = await api<{ connector: PublicConnectorState }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors/${GITHUB_CONNECTOR_ID}`,
        { token: await getToken(), method: 'POST', body: JSON.stringify(body) })
      onState(connector)
      setSecret('')                      // clear the write-only field after success
      setForm(githubConfigToForm(connector.config))
      setMsg('Saved.')
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save this connector.')   // edits (incl. token) preserved for retry
    }
    setBusy(null)
  }

  const test = async () => {
    setErr(null); setMsg(null); setBusy('test')
    try {
      const r = await api<{ ok: boolean; detail?: string | null; testedAt?: string }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors/${GITHUB_CONNECTOR_ID}/test`,
        { token: await getToken(), method: 'POST', body: '{}' })
      setMsg(r.ok ? `✓ ${r.detail ?? 'OK'}` : `✗ ${r.detail ?? 'failed'}`)
      if (state) onState({ ...state, lastTestedAt: r.testedAt ? Date.parse(r.testedAt) : Date.now(), lastError: r.ok ? null : (r.detail ?? 'failed') })
    } catch (e: any) { setErr(e?.message ?? 'Test failed.') }
    setBusy(null)
  }

  const remove = async () => {
    setErr(null); setMsg(null); setBusy('delete')
    try {
      await api(`/api/orgs/${orgId}/agents/${agentId}/connectors/${GITHUB_CONNECTOR_ID}`,
        { token: await getToken(), method: 'DELETE' })
      onState(null)
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Could not disconnect.'); setBusy(null) }
  }

  const lastTested = rel(state?.lastTestedAt ?? null)

  return (
    <Card style={{ margin: `0 ${space.lg}px ${space.lg}px`, display: 'flex', flexDirection: 'column', gap: space.lg, background: tk.bg }}>
      <FormLabel>Username <span style={{ fontWeight: 400, color: tk.muted }}>· optional · display label</span>
        <TextInput value={form.username} placeholder="e.g. octocat" autoComplete="off"
          onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
      </FormLabel>

      <FormLabel>Personal access token <span style={{ fontWeight: 400, color: tk.muted }}>· write-only</span>
        <TextInput type="password" value={secret} autoComplete="off"
          placeholder={configured ? 'Leave blank to keep the stored token' : 'ghp_… / github_pat_…'}
          onChange={e => setSecret(e.target.value)} />
      </FormLabel>
      <p style={{ ...ax.empty, fontSize: text.xs.fontSize, marginTop: -space.sm }}>
        Stored encrypted at agent scope as <code>GITHUB_TOKEN</code> and injected into this agent’s runtime. It is never
        displayed back — leave blank to keep the existing token.
      </p>

      {err && <div style={ax.err}>{err}</div>}
      {msg && <div style={{ color: tk.green, fontSize: text.sm.fontSize }}>{msg}</div>}
      {configured && lastTested && !msg && (
        <div style={{ ...ax.empty, fontSize: text.xs.fontSize }}>Last tested {lastTested}.</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={save} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : configured ? 'Save changes' : 'Connect'}
        </Button>
        {configured && <Button onClick={test} disabled={busy !== null}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>}
        {configured && <Button variant="danger" onClick={remove} disabled={busy !== null}>{busy === 'delete' ? 'Removing…' : 'Disconnect'}</Button>}
      </div>
    </Card>
  )
}

// ─── Jira (basic) config form (CONN-4a, real via the agent-secrets env path) ──
//
// Same security invariants as above: the API token is WRITE-ONLY. The NON-secret
// config is baseUrl + email (both returnable and shown). The backend requires a
// token on FIRST configure; blank on re-configure keeps the stored token.
function JiraConfig({ orgId, agentId, getToken, state, onState, onDone }: {
  orgId: string
  agentId: string
  getToken: Getter
  state: PublicConnectorState | null
  onState: (s: PublicConnectorState | null) => void
  onDone: () => void
}) {
  const configured = isConfigured(state)
  const [form, setForm] = useState<JiraFormInput>(() => jiraConfigToForm(state?.config))
  const [secret, setSecret] = useState('')   // the API token — WRITE-ONLY, never seeded from a read
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const setF = (k: keyof JiraFormInput, v: string) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    setErr(null); setMsg(null)
    const valid = validateJiraConfig(form)
    if (valid.ok !== true) { setErr(valid.error); return }
    if (!configured && !secret.trim()) { setErr('An API token is required to connect Jira.'); return }
    setBusy('save')
    try {
      const body: Record<string, unknown> = { config: valid.config }
      if (secret.trim()) body.secret = secret.trim()
      const { connector } = await api<{ connector: PublicConnectorState }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors/${JIRA_CONNECTOR_ID}`,
        { token: await getToken(), method: 'POST', body: JSON.stringify(body) })
      onState(connector)
      setSecret('')
      setForm(jiraConfigToForm(connector.config))
      setMsg('Saved.')
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save this connector.')
    }
    setBusy(null)
  }

  const test = async () => {
    setErr(null); setMsg(null); setBusy('test')
    try {
      const r = await api<{ ok: boolean; detail?: string | null; testedAt?: string }>(
        `/api/orgs/${orgId}/agents/${agentId}/connectors/${JIRA_CONNECTOR_ID}/test`,
        { token: await getToken(), method: 'POST', body: '{}' })
      setMsg(r.ok ? `✓ ${r.detail ?? 'OK'}` : `✗ ${r.detail ?? 'failed'}`)
      if (state) onState({ ...state, lastTestedAt: r.testedAt ? Date.parse(r.testedAt) : Date.now(), lastError: r.ok ? null : (r.detail ?? 'failed') })
    } catch (e: any) { setErr(e?.message ?? 'Test failed.') }
    setBusy(null)
  }

  const remove = async () => {
    setErr(null); setMsg(null); setBusy('delete')
    try {
      await api(`/api/orgs/${orgId}/agents/${agentId}/connectors/${JIRA_CONNECTOR_ID}`,
        { token: await getToken(), method: 'DELETE' })
      onState(null)
      onDone()
    } catch (e: any) { setErr(e?.message ?? 'Could not disconnect.'); setBusy(null) }
  }

  const lastTested = rel(state?.lastTestedAt ?? null)

  return (
    <Card style={{ margin: `0 ${space.lg}px ${space.lg}px`, display: 'flex', flexDirection: 'column', gap: space.lg, background: tk.bg }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: space.lg }}>
        <FormLabel>Site URL
          <TextInput value={form.baseUrl} placeholder="https://your-team.atlassian.net" inputMode="url" autoComplete="off"
            onChange={e => setF('baseUrl', e.target.value)} />
        </FormLabel>
        <FormLabel>Email
          <TextInput value={form.email} placeholder="you@example.com" inputMode="email" autoComplete="off"
            onChange={e => setF('email', e.target.value)} />
        </FormLabel>
      </div>

      <FormLabel>API token <span style={{ fontWeight: 400, color: tk.muted }}>· write-only</span>
        <TextInput type="password" value={secret} autoComplete="off"
          placeholder={configured ? 'Leave blank to keep the stored token' : 'Atlassian API token'}
          onChange={e => setSecret(e.target.value)} />
      </FormLabel>
      <p style={{ ...ax.empty, fontSize: text.xs.fontSize, marginTop: -space.sm }}>
        Stored encrypted at agent scope as <code>JIRA_API_TOKEN</code> (with <code>JIRA_BASE_URL</code> / <code>JIRA_EMAIL</code>)
        and injected into this agent’s runtime. The token is never displayed back — leave blank to keep the existing one.
      </p>

      {err && <div style={ax.err}>{err}</div>}
      {msg && <div style={{ color: tk.green, fontSize: text.sm.fontSize }}>{msg}</div>}
      {configured && lastTested && !msg && (
        <div style={{ ...ax.empty, fontSize: text.xs.fontSize }}>Last tested {lastTested}.</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={save} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : configured ? 'Save changes' : 'Connect'}
        </Button>
        {configured && <Button onClick={test} disabled={busy !== null}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>}
        {configured && <Button variant="danger" onClick={remove} disabled={busy !== null}>{busy === 'delete' ? 'Removing…' : 'Disconnect'}</Button>}
      </div>
    </Card>
  )
}
