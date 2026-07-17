// Epic CONN / CONN-3 — the per-agent Connectors ACCORDION on the phone, a mirror
// of the web's ConnectorsTab (CONN-2) over the SAME CONN-1 contract (no backend
// change). Grouped by category exactly as the operator listed them
// (Communication / IT-Project / Google / Custom MCP); each category a collapsible
// section, each connector a row with a colorblind-safe status chip. As of CONN-4b
// THREE connectors are REAL — custom MCP (the CONN-1 pilot), GitHub (PAT) and Jira
// (basic), the two CONN-4a made real via the agent-secrets env path —
// add/configure/test/delete; every other connector is a disabled "coming soon" /
// "out of scope" row (the backend 404s an unknown connectorId — we never fake a
// save). The accordion idiom follows MemoryScreen's collapsible tree (MOB-6e).
//
// SECURITY — a stored credential is NEVER shown. The read projection carries no
// secret (not even a "secretRef") — only status + non-secret config + a masked
// label. The secret input is WRITE-ONLY (secureTextEntry, seeded from '' never
// from a read, cleared after a successful save; blank on save keeps the stored
// token). `agentConnectors.test.ts` asserts the read shape carries no credential.
//
// OWNER GATING — the whole surface is owner-only, and the backend is the real
// gate. The phone offers it to an owner OR when the role is genuinely unknown (a
// pasted token whose orgs were never listed with a role) — fail-OPEN to the
// backend gate, never to a silent client-only allow. The LIST GET is itself
// owner-gated, so a 403 on load = definitively not an owner → a clean read-only
// note. A known MEMBER gets that note without a pointless round-trip. Any mutating
// 403 surfaces in the row with the operator's edits (incl. a typed secret) kept.
//
// RN core only — TextInput / Pressable / Modal / View / Text. No native module, so
// nothing here can sit in the boot path and throw at import (bootSafety.test.ts).

import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Api } from '../api'
import {
  CONNECTOR_GROUPS,
  MCP_CONNECTOR_ID,
  GITHUB_CONNECTOR_ID,
  JIRA_CONNECTOR_ID,
  isConfigured,
  mcpConfigToForm,
  validateMcpConfig,
  githubConfigToForm,
  validateGithubConfig,
  jiraConfigToForm,
  validateJiraConfig,
  type DisplayConnector,
  type McpFormInput,
  type McpTransport,
  type GithubFormInput,
  type JiraFormInput,
  type PublicConnectorState,
} from '../agentConnectors'
import { font, radius, space, theme } from '../theme'
import { Banner, Button, Card, Chip, Loading } from '../ui'

/** "3m ago" / "2h ago" — the last-tested stamp, mirroring the web's `rel`. */
function rel(ts: number | null, now: number = Date.now()): string | null {
  if (!ts) return null
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  return `${Math.round(min / 60)}h ago`
}

type StateMap = Record<string, PublicConnectorState>
const blankMcpForm = (): McpFormInput => ({ name: '', transport: 'http', url: '', command: '', args: '' })

/** The owner-only note, said on the screen so a member isn't left guessing. */
export const CONNECTORS_OWNER_ONLY_NOTE =
  'Only an organization owner can view or configure this agent’s connectors. Ask an owner to make changes here.'

export function ConnectorsSection({
  orgId,
  agentId,
  apiUrl,
  getToken,
  canView,
  roleUnknown,
}: {
  orgId: string
  agentId: string
  apiUrl: string
  getToken: () => Promise<string | null>
  /** owner || roleUnknown — offer the surface; a known member sees the note. */
  canView: boolean
  roleUnknown: boolean
}) {
  const [states, setStates] = useState<StateMap>({})
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [ownerOnly, setOwnerOnly] = useState(false) // a 403 on the gated read
  const [loadErr, setLoadErr] = useState<string | null>(null)
  // Which category sections are open. Custom MCP (the real one) opens by default.
  const [open, setOpen] = useState<Record<string, boolean>>({ custom: true })

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setLoading(true)
    setLoadErr(null)
    setOwnerOnly(false)
    try {
      const connectors = await Api.agentConnectors(apiUrl, token, orgId, agentId)
      setStates(Object.fromEntries(connectors.map((c) => [c.connectorId, c])))
    } catch (e: any) {
      const m = String(e?.message ?? '')
      if (m.includes('HTTP 403')) setOwnerOnly(true)
      else setLoadErr(m || 'Could not load this agent’s connectors.')
    }
    setLoaded(true)
    setLoading(false)
  }, [apiUrl, getToken, orgId, agentId])

  useEffect(() => {
    // A known member never gets to a fetch — the backend would 403 anyway, and the
    // note is the same. An owner or an unknown-role token does load (the 403 path
    // still catches an unknown-role non-owner).
    if (canView) load()
    else setLoaded(true)
  }, [canView, load])

  const patchState = (id: string, s: PublicConnectorState | null) =>
    setStates((prev) => {
      const next = { ...prev }
      if (s) next[id] = s
      else delete next[id]
      return next
    })

  // A known member, or a 403 on the owner-gated read → the read-only note.
  if ((!canView || ownerOnly) && !loading) {
    return (
      <Section>
        <Card style={{ gap: space.sm }}>
          <View style={s.lockRow}>
            <Text style={s.lockGlyph}>🔒</Text>
            <Text style={s.lockTitle}>Connectors are owner-only</Text>
          </View>
          <Text style={s.note}>{CONNECTORS_OWNER_ONLY_NOTE}</Text>
        </Card>
      </Section>
    )
  }

  if (!loaded || loading) {
    return (
      <Section>
        <Loading text="Loading connectors…" />
      </Section>
    )
  }

  if (loadErr) {
    return (
      <Section>
        <Banner kind="error">{loadErr}</Banner>
        <View style={{ marginTop: space.md }}>
          <Button title="Retry" tone="ghost" onPress={load} />
        </View>
      </Section>
    )
  }

  return (
    <Section>
      <Text style={s.blurb}>
        Connect this agent to external services. Credentials are stored encrypted at agent scope and are never shown back
        — only their connection status. GitHub, Jira and custom MCP servers are configurable today; the rest arrive in later stages.
      </Text>

      <View style={{ gap: space.md }}>
        {CONNECTOR_GROUPS.map((group) => {
          const isOpen = open[group.key] ?? false
          const configuredCount = group.connectors.filter((c) => isConfigured(states[c.id])).length
          return (
            <View key={group.key} style={s.group}>
              <Pressable
                onPress={() => setOpen((o) => ({ ...o, [group.key]: !isOpen }))}
                accessibilityRole="button"
                accessibilityState={{ expanded: isOpen }}
                accessibilityLabel={`${group.title} connectors`}
                style={({ pressed }) => [s.groupHead, pressed && { opacity: 0.7 }]}
              >
                <Text style={s.caret}>{isOpen ? '▾' : '▸'}</Text>
                <Text style={s.groupTitle}>{group.title}</Text>
                <View style={s.groupMeta}>
                  {configuredCount > 0 ? <Chip label={`${configuredCount} connected`} tone="ok" glyph="✓" /> : null}
                  <Text style={s.groupCount}>{group.connectors.length}</Text>
                </View>
              </Pressable>

              {isOpen ? (
                <View>
                  {group.connectors.map((conn) => (
                    <ConnectorRow
                      key={conn.id}
                      conn={conn}
                      orgId={orgId}
                      agentId={agentId}
                      apiUrl={apiUrl}
                      getToken={getToken}
                      state={states[conn.id] ?? null}
                      onState={(st) => patchState(conn.id, st)}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          )
        })}
      </View>
    </Section>
  )
}

// ─── One connector row + its inline config panel ──────────────────────────────

function ConnectorRow({
  conn,
  state,
  orgId,
  agentId,
  apiUrl,
  getToken,
  onState,
}: {
  conn: DisplayConnector
  state: PublicConnectorState | null
  orgId: string
  agentId: string
  apiUrl: string
  getToken: () => Promise<string | null>
  onState: (s: PublicConnectorState | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const configured = isConfigured(state)
  const available = conn.availability === 'available'

  const badge = available
    ? configured
      ? { label: 'Connected', tone: 'ok' as const, glyph: '✓' }
      : { label: 'Not connected', tone: 'neutral' as const, glyph: '○' }
    : conn.availability === 'out_of_scope'
      ? { label: 'Out of scope', tone: 'neutral' as const, glyph: '—' }
      : { label: 'Coming soon', tone: 'warn' as const, glyph: '⋯' }

  return (
    <View style={s.row}>
      <View style={s.rowHead}>
        <Text style={s.rowIcon}>{conn.icon}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={s.rowTitleLine}>
            <Text style={s.rowName} numberOfLines={1}>
              {conn.name}
            </Text>
            <Chip label={badge.label} tone={badge.tone} glyph={badge.glyph} />
          </View>
          {available && configured && state?.accountLabel ? (
            <Text style={s.rowSub} numberOfLines={1}>
              {state.accountLabel}
            </Text>
          ) : null}
          {!available && conn.note ? (
            <Text style={s.rowSub} numberOfLines={2}>
              {conn.note}
            </Text>
          ) : null}
        </View>
        {available ? (
          <Button
            title={expanded ? 'Close' : configured ? 'Configure' : 'Add'}
            tone="ghost"
            onPress={() => setExpanded((e) => !e)}
          />
        ) : (
          <Button title="Unavailable" tone="ghost" disabled onPress={() => {}} />
        )}
      </View>

      {available && expanded && conn.id === MCP_CONNECTOR_ID ? (
        <McpConfig
          orgId={orgId}
          agentId={agentId}
          apiUrl={apiUrl}
          getToken={getToken}
          state={state}
          onState={onState}
          onDone={() => setExpanded(false)}
        />
      ) : null}
      {available && expanded && conn.id === GITHUB_CONNECTOR_ID ? (
        <GithubConfig
          orgId={orgId}
          agentId={agentId}
          apiUrl={apiUrl}
          getToken={getToken}
          state={state}
          onState={onState}
          onDone={() => setExpanded(false)}
        />
      ) : null}
      {available && expanded && conn.id === JIRA_CONNECTOR_ID ? (
        <JiraConfig
          orgId={orgId}
          agentId={agentId}
          apiUrl={apiUrl}
          getToken={getToken}
          state={state}
          onState={onState}
          onDone={() => setExpanded(false)}
        />
      ) : null}
    </View>
  )
}

// ─── Custom MCP config form (the one connector real in v1) ────────────────────

function McpConfig({
  orgId,
  agentId,
  apiUrl,
  getToken,
  state,
  onState,
  onDone,
}: {
  orgId: string
  agentId: string
  apiUrl: string
  getToken: () => Promise<string | null>
  state: PublicConnectorState | null
  onState: (s: PublicConnectorState | null) => void
  onDone: () => void
}) {
  const configured = isConfigured(state)
  const [form, setForm] = useState<McpFormInput>(() => (configured ? mcpConfigToForm(state?.config) : blankMcpForm()))
  const [secret, setSecret] = useState('') // WRITE-ONLY — never seeded from a read
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const setF = (k: keyof McpFormInput, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    setErr(null)
    setMsg(null)
    const valid = validateMcpConfig(form)
    if (valid.ok !== true) {
      setErr(valid.error) // edits preserved on invalid input
      return
    }
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('save')
    try {
      // Widen the validated MCP config to the generic request body (it has no index
      // signature); the server re-validates it with the strict zod schema anyway.
      const body: { config: Record<string, unknown>; secret?: string } = {
        config: valid.config as unknown as Record<string, unknown>,
      }
      if (secret.trim()) body.secret = secret.trim() // only sent when the operator typed one
      const connector = await Api.saveAgentConnector(apiUrl, token, orgId, agentId, MCP_CONNECTOR_ID, body)
      onState(connector) // reconcile to the server's masked row
      setSecret('') // clear the write-only field after success
      setForm(mcpConfigToForm(connector.config))
      setMsg('Saved.')
    } catch (e: any) {
      // 400 (validation), 403 (not owner), or network — the edit (incl. the typed
      // secret) is KEPT so the operator can retry without re-entering it.
      setErr(`${e?.message ?? 'Could not save this connector.'} Your changes are still here.`)
    }
    setBusy(null)
  }

  const test = async () => {
    setErr(null)
    setMsg(null)
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('test')
    try {
      const r = await Api.testAgentConnector(apiUrl, token, orgId, agentId, MCP_CONNECTOR_ID)
      setMsg(r.ok ? `✓ ${r.detail ?? 'OK'}` : `✗ ${r.detail ?? 'failed'}`)
      if (state) onState({ ...state, lastTestedAt: r.testedAt ? Date.parse(r.testedAt) : Date.now(), lastError: null })
    } catch (e: any) {
      setErr(e?.message ?? 'Test failed.')
    }
    setBusy(null)
  }

  const remove = async () => {
    setErr(null)
    setMsg(null)
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('delete')
    try {
      await Api.deleteAgentConnector(apiUrl, token, orgId, agentId, MCP_CONNECTOR_ID)
      onState(null)
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not disconnect.')
      setBusy(null)
    }
  }

  const lastTested = rel(state?.lastTestedAt ?? null)

  return (
    <Card style={s.form}>
      <Field label="Name">
        <TextInput
          value={form.name}
          onChangeText={(t) => setF('name', t)}
          placeholder="e.g. Weather MCP"
          placeholderTextColor={theme.textFaint}
          style={s.input}
        />
      </Field>

      <Field label="Transport">
        <Segmented
          value={form.transport}
          options={[
            { value: 'http', label: 'HTTP (URL)' },
            { value: 'stdio', label: 'stdio (command)' },
          ]}
          onSelect={(v) => setF('transport', v as McpTransport)}
        />
      </Field>

      {form.transport === 'http' ? (
        <Field label="Server URL">
          <TextInput
            value={form.url}
            onChangeText={(t) => setF('url', t)}
            placeholder="https://mcp.example.com"
            placeholderTextColor={theme.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={s.input}
          />
        </Field>
      ) : (
        <>
          <Field label="Command">
            <TextInput
              value={form.command}
              onChangeText={(t) => setF('command', t)}
              placeholder="npx"
              placeholderTextColor={theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              style={s.input}
            />
          </Field>
          <Field label="Arguments · one per line">
            <TextInput
              value={form.args}
              onChangeText={(t) => setF('args', t)}
              placeholder={'@modelcontextprotocol/server-x\n--port\n3000'}
              placeholderTextColor={theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={[s.input, s.mono, { minHeight: 72, textAlignVertical: 'top' }]}
            />
          </Field>
        </>
      )}

      <Field label="Authentication token · optional · write-only">
        <TextInput
          value={secret}
          onChangeText={setSecret}
          placeholder={configured ? 'Leave blank to keep the stored token' : 'Bearer token / API key (optional)'}
          placeholderTextColor={theme.textFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          style={s.input}
        />
      </Field>
      <Text style={s.fieldHint}>
        Stored encrypted at agent scope and injected into this agent’s runtime. It is never displayed back — leave blank to
        keep the existing token.
      </Text>

      {err ? <Banner kind="error">{err}</Banner> : null}
      {msg ? <Text style={s.okMsg}>{msg}</Text> : null}
      {configured && lastTested && !msg ? <Text style={s.fieldHint}>Last tested {lastTested}.</Text> : null}

      <View style={s.actions}>
        <Button
          title={busy === 'save' ? 'Saving…' : configured ? 'Save changes' : 'Connect'}
          tone="primary"
          busy={busy === 'save'}
          disabled={busy !== null}
          onPress={save}
        />
        {configured ? (
          <Button title={busy === 'test' ? 'Testing…' : 'Test'} tone="ghost" busy={busy === 'test'} disabled={busy !== null} onPress={test} />
        ) : null}
        {configured ? (
          <Button
            title={busy === 'delete' ? 'Removing…' : 'Disconnect'}
            tone="danger"
            busy={busy === 'delete'}
            disabled={busy !== null}
            onPress={remove}
          />
        ) : null}
      </View>
    </Card>
  )
}

// ─── GitHub (PAT) config form (CONN-4a, real via the agent-secrets env path) ──
//
// Same shape and security invariants as McpConfig: the PAT is WRITE-ONLY
// (secureTextEntry, seeded from '' never a read, cleared after a successful save,
// blank on save keeps the stored token). The only NON-secret config is an optional
// username label. The backend requires a token on FIRST configure — so the form
// blocks a first save with no token, but allows a blank token on re-configure.
function GithubConfig({
  orgId,
  agentId,
  apiUrl,
  getToken,
  state,
  onState,
  onDone,
}: {
  orgId: string
  agentId: string
  apiUrl: string
  getToken: () => Promise<string | null>
  state: PublicConnectorState | null
  onState: (s: PublicConnectorState | null) => void
  onDone: () => void
}) {
  const configured = isConfigured(state)
  const [form, setForm] = useState<GithubFormInput>(() => githubConfigToForm(state?.config))
  const [secret, setSecret] = useState('') // the PAT — WRITE-ONLY, never seeded from a read
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const save = async () => {
    setErr(null)
    setMsg(null)
    const valid = validateGithubConfig(form)
    if (valid.ok !== true) {
      setErr(valid.error)
      return
    }
    if (!configured && !secret.trim()) {
      setErr('A personal access token is required to connect GitHub.')
      return
    }
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('save')
    try {
      const body: { config: Record<string, unknown>; secret?: string } = {
        config: valid.config as unknown as Record<string, unknown>,
      }
      if (secret.trim()) body.secret = secret.trim() // only sent when the operator typed one
      const connector = await Api.saveAgentConnector(apiUrl, token, orgId, agentId, GITHUB_CONNECTOR_ID, body)
      onState(connector)
      setSecret('') // clear the write-only field after success
      setForm(githubConfigToForm(connector.config))
      setMsg('Saved.')
    } catch (e: any) {
      setErr(`${e?.message ?? 'Could not save this connector.'} Your changes are still here.`)
    }
    setBusy(null)
  }

  const test = async () => {
    setErr(null)
    setMsg(null)
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('test')
    try {
      const r = await Api.testAgentConnector(apiUrl, token, orgId, agentId, GITHUB_CONNECTOR_ID)
      setMsg(r.ok ? `✓ ${r.detail ?? 'OK'}` : `✗ ${r.detail ?? 'failed'}`)
      if (state) onState({ ...state, lastTestedAt: r.testedAt ? Date.parse(r.testedAt) : Date.now(), lastError: r.ok ? null : (r.detail ?? 'failed') })
    } catch (e: any) {
      setErr(e?.message ?? 'Test failed.')
    }
    setBusy(null)
  }

  const remove = async () => {
    setErr(null)
    setMsg(null)
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('delete')
    try {
      await Api.deleteAgentConnector(apiUrl, token, orgId, agentId, GITHUB_CONNECTOR_ID)
      onState(null)
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not disconnect.')
      setBusy(null)
    }
  }

  const lastTested = rel(state?.lastTestedAt ?? null)

  return (
    <Card style={s.form}>
      <Field label="Username · optional · display label">
        <TextInput
          value={form.username}
          onChangeText={(t) => setForm((f) => ({ ...f, username: t }))}
          placeholder="e.g. octocat"
          placeholderTextColor={theme.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={s.input}
        />
      </Field>

      <Field label="Personal access token · write-only">
        <TextInput
          value={secret}
          onChangeText={setSecret}
          placeholder={configured ? 'Leave blank to keep the stored token' : 'ghp_… / github_pat_…'}
          placeholderTextColor={theme.textFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          style={s.input}
        />
      </Field>
      <Text style={s.fieldHint}>
        Stored encrypted at agent scope as GITHUB_TOKEN and injected into this agent’s runtime. It is never displayed back —
        leave blank to keep the existing token.
      </Text>

      {err ? <Banner kind="error">{err}</Banner> : null}
      {msg ? <Text style={s.okMsg}>{msg}</Text> : null}
      {configured && lastTested && !msg ? <Text style={s.fieldHint}>Last tested {lastTested}.</Text> : null}

      <View style={s.actions}>
        <Button
          title={busy === 'save' ? 'Saving…' : configured ? 'Save changes' : 'Connect'}
          tone="primary"
          busy={busy === 'save'}
          disabled={busy !== null}
          onPress={save}
        />
        {configured ? (
          <Button title={busy === 'test' ? 'Testing…' : 'Test'} tone="ghost" busy={busy === 'test'} disabled={busy !== null} onPress={test} />
        ) : null}
        {configured ? (
          <Button
            title={busy === 'delete' ? 'Removing…' : 'Disconnect'}
            tone="danger"
            busy={busy === 'delete'}
            disabled={busy !== null}
            onPress={remove}
          />
        ) : null}
      </View>
    </Card>
  )
}

// ─── Jira (basic) config form (CONN-4a, real via the agent-secrets env path) ──
//
// Same security invariants: the API token is WRITE-ONLY. The NON-secret config is
// baseUrl + email (both returnable and shown). The backend requires a token on
// FIRST configure; blank on re-configure keeps the stored token.
function JiraConfig({
  orgId,
  agentId,
  apiUrl,
  getToken,
  state,
  onState,
  onDone,
}: {
  orgId: string
  agentId: string
  apiUrl: string
  getToken: () => Promise<string | null>
  state: PublicConnectorState | null
  onState: (s: PublicConnectorState | null) => void
  onDone: () => void
}) {
  const configured = isConfigured(state)
  const [form, setForm] = useState<JiraFormInput>(() => jiraConfigToForm(state?.config))
  const [secret, setSecret] = useState('') // the API token — WRITE-ONLY, never seeded from a read
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const setF = (k: keyof JiraFormInput, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    setErr(null)
    setMsg(null)
    const valid = validateJiraConfig(form)
    if (valid.ok !== true) {
      setErr(valid.error)
      return
    }
    if (!configured && !secret.trim()) {
      setErr('An API token is required to connect Jira.')
      return
    }
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('save')
    try {
      const body: { config: Record<string, unknown>; secret?: string } = {
        config: valid.config as unknown as Record<string, unknown>,
      }
      if (secret.trim()) body.secret = secret.trim()
      const connector = await Api.saveAgentConnector(apiUrl, token, orgId, agentId, JIRA_CONNECTOR_ID, body)
      onState(connector)
      setSecret('')
      setForm(jiraConfigToForm(connector.config))
      setMsg('Saved.')
    } catch (e: any) {
      setErr(`${e?.message ?? 'Could not save this connector.'} Your changes are still here.`)
    }
    setBusy(null)
  }

  const test = async () => {
    setErr(null)
    setMsg(null)
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('test')
    try {
      const r = await Api.testAgentConnector(apiUrl, token, orgId, agentId, JIRA_CONNECTOR_ID)
      setMsg(r.ok ? `✓ ${r.detail ?? 'OK'}` : `✗ ${r.detail ?? 'failed'}`)
      if (state) onState({ ...state, lastTestedAt: r.testedAt ? Date.parse(r.testedAt) : Date.now(), lastError: r.ok ? null : (r.detail ?? 'failed') })
    } catch (e: any) {
      setErr(e?.message ?? 'Test failed.')
    }
    setBusy(null)
  }

  const remove = async () => {
    setErr(null)
    setMsg(null)
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy('delete')
    try {
      await Api.deleteAgentConnector(apiUrl, token, orgId, agentId, JIRA_CONNECTOR_ID)
      onState(null)
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not disconnect.')
      setBusy(null)
    }
  }

  const lastTested = rel(state?.lastTestedAt ?? null)

  return (
    <Card style={s.form}>
      <Field label="Site URL">
        <TextInput
          value={form.baseUrl}
          onChangeText={(t) => setF('baseUrl', t)}
          placeholder="https://your-team.atlassian.net"
          placeholderTextColor={theme.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={s.input}
        />
      </Field>

      <Field label="Email">
        <TextInput
          value={form.email}
          onChangeText={(t) => setF('email', t)}
          placeholder="you@example.com"
          placeholderTextColor={theme.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          style={s.input}
        />
      </Field>

      <Field label="API token · write-only">
        <TextInput
          value={secret}
          onChangeText={setSecret}
          placeholder={configured ? 'Leave blank to keep the stored token' : 'Atlassian API token'}
          placeholderTextColor={theme.textFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          style={s.input}
        />
      </Field>
      <Text style={s.fieldHint}>
        Stored encrypted at agent scope as JIRA_API_TOKEN (with JIRA_BASE_URL / JIRA_EMAIL) and injected into this agent’s
        runtime. The token is never displayed back — leave blank to keep the existing one.
      </Text>

      {err ? <Banner kind="error">{err}</Banner> : null}
      {msg ? <Text style={s.okMsg}>{msg}</Text> : null}
      {configured && lastTested && !msg ? <Text style={s.fieldHint}>Last tested {lastTested}.</Text> : null}

      <View style={s.actions}>
        <Button
          title={busy === 'save' ? 'Saving…' : configured ? 'Save changes' : 'Connect'}
          tone="primary"
          busy={busy === 'save'}
          disabled={busy !== null}
          onPress={save}
        />
        {configured ? (
          <Button title={busy === 'test' ? 'Testing…' : 'Test'} tone="ghost" busy={busy === 'test'} disabled={busy !== null} onPress={test} />
        ) : null}
        {configured ? (
          <Button
            title={busy === 'delete' ? 'Removing…' : 'Disconnect'}
            tone="danger"
            busy={busy === 'delete'}
            disabled={busy !== null}
            onPress={remove}
          />
        ) : null}
      </View>
    </Card>
  )
}

// ─── Small local primitives (RN core only) ────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={s.fieldLabel}>{label}</Text>
      {children}
    </View>
  )
}

/** A two-option segmented control — a picker is overkill for http|stdio. */
function Segmented({
  value,
  options,
  onSelect,
}: {
  value: string
  options: { value: string; label: string }[]
  onSelect: (v: string) => void
}) {
  return (
    <View style={s.segment}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => onSelect(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={[s.segmentItem, on && s.segmentItemOn]}
          >
            <Text style={[s.segmentText, on && s.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: space.xl }}>
      <Text style={s.sectionTitle}>Connectors</Text>
      {children}
    </View>
  )
}

const s = StyleSheet.create({
  sectionTitle: {
    color: theme.textDim,
    fontSize: font.sm,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: space.sm,
  },
  blurb: { color: theme.textFaint, fontSize: font.sm, lineHeight: 19, marginBottom: space.md },
  note: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 18 },
  lockRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  lockGlyph: { fontSize: font.base },
  lockTitle: { color: theme.text, fontSize: font.base, fontWeight: '800' },
  group: {
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: theme.s1,
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: theme.s2,
    minHeight: 48,
  },
  caret: { color: theme.textDim, fontSize: font.sm, width: 12 },
  groupTitle: { color: theme.text, fontSize: font.base, fontWeight: '700', flex: 1 },
  groupMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  groupCount: { color: theme.textFaint, fontSize: font.sm },
  row: { borderTopWidth: 1, borderTopColor: theme.s3 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg },
  rowIcon: { fontSize: 20 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  rowName: { color: theme.text, fontSize: font.base, fontWeight: '600', flexShrink: 1 },
  rowSub: { color: theme.textFaint, fontSize: font.sm - 1, marginTop: 2, lineHeight: 17 },
  form: { margin: space.lg, marginTop: 0, gap: space.md, backgroundColor: theme.bg },
  fieldLabel: { color: theme.textDim, fontSize: font.sm - 1, fontWeight: '600' },
  fieldHint: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 17 },
  input: {
    backgroundColor: theme.s2,
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: radius.md,
    color: theme.text,
    fontSize: font.base,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  mono: { fontFamily: 'Menlo' },
  segment: { flexDirection: 'row', backgroundColor: theme.s2, borderRadius: radius.md, borderWidth: 1, borderColor: theme.s3, padding: 3, gap: 3 },
  segmentItem: { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm, alignItems: 'center' },
  segmentItemOn: { backgroundColor: theme.blue },
  segmentText: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  segmentTextOn: { color: '#08131F', fontWeight: '800' },
  okMsg: { color: theme.green, fontSize: font.sm, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
})
