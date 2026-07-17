// MOB-6b / MOB-7d — the agent detail screen.
//
// MOB-6b shipped the READ view, mirroring the web's AgentDetail + Dashboard tab.
// MOB-7d adds the WRITE layer: an owner-gated Edit mode that mirrors the web's
// agent-detail EDIT tabs (Configuration, the model profile, Trust, Skills) over
// the SAME owner-gated, validated backend routes the web uses — never the legacy
// unvalidated PATCH. See api.ts (the routes) and agentEdit.ts (the pure decisions).
//
//   GET /api/agents/:agentId                        → identity + status + config
//   GET /api/orgs/:orgId/agents/:agentId/overview   → latest run, tasks, costs
//   PUT /api/orgs/:orgId/agents/:agentId/config         (owner) identity + adapter
//   PUT /api/orgs/:orgId/agents/:agentId/model-profile  (owner) models + effort
//   PUT /api/orgs/:orgId/agents/:agentId/trust          (owner) trust MODE
//   GET/PUT /api/orgs/:orgId/agents/:agentId/skills     (owner PUT) skill selection
//
// OWNER GATING. Every write route is `requireOrgRole('owner')`. The phone offers
// Edit only to an org owner (auth `orgRole`, learned from `/api/orgs`), and — when
// the role is genuinely unknown (a pasted token whose orgs were never listed with a
// role) — offers it with a caution and lets the backend 403 be the real enforcer.
// A known MEMBER gets the read-only screen, the same as the desk shows them. No gate
// is weakened: the backend decides; the phone only decides what to OFFER.
//
// DANGEROUS CHANGES CONFIRM. A model swap (spend + capability) and a trust-mode
// change (containment) each go through a native confirm before the call — mirroring
// how the web treats them. A failed save NEVER loses the operator's edits: the form
// stays, the error is named, and the server response (not an optimistic guess) is
// what replaces the on-screen state.
//
// WHAT STAYS ON THE DESK (named, so a gap reads as a decision — see agentEdit.ts
// DEFERRED_EDITS_NOTE): the instructions bundle (a multi-file markdown editor),
// avatar photo upload, the trust BOUNDARY multiselect, and per-agent permissions
// (whose route isn't owner-gated server-side — flagged in the design doc).
//
// Colorblind-safe throughout: every status is a Chip (label + glyph), never hue.

import React, { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { AgentAvatar } from '../AgentAvatar'
import {
  Api,
  type Agent,
  type AgentOverview,
  type AgentRecentTask,
  type ModelOption,
} from '../api'
import { useAuth } from '../auth'
import {
  ADAPTER_LABEL,
  MODEL_PROFILE_CONFIRM,
  NON_OWNER_EDIT_NOTE,
  REASONING_EFFORTS,
  RUNTIMES,
  TRUST_MODES,
  UNKNOWN_ROLE_EDIT_NOTE,
  buildConfigBody,
  buildModelProfileBody,
  buildTrustBody,
  isOwnerRole,
  nextSelection,
  optimisticSplit,
  parseTrustMode,
  selectionOf,
  trustConfirm,
  validateConfigForm,
  validateModelProfileForm,
  type ConfigForm,
  type ModelProfileForm,
  type SkillsPayload,
  type TrustModeLite,
} from '../agentEdit'
import { heartbeatIcon, heartbeatTone, statusIcon, statusTone } from '../status'
import { formatCost, formatTokens, NONE } from '../taskLog'
import { font, radius, space, theme } from '../theme'
import { Banner, Button, Card, Chip, Empty, Loading } from '../ui'

/** "8d ago" / "3h ago" / "just now" — the web's `ago`, ported from DashboardTab. */
export function ago(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null) return NONE
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

type Data = { overview: AgentOverview; recentTasks: AgentRecentTask[] }

const emptyConfigForm = (a: Agent): ConfigForm => ({
  name: a.name ?? '',
  title: a.title ?? '',
  role: a.role ?? '',
  jobDescription: a.jobDescription ?? '',
  avatarEmoji: a.avatarEmoji ?? '',
  contactChannel: a.contactChannel ?? '',
  reportsTo: a.reportsTo ?? '',
  runtime: a.runtime ?? 'internal',
  model: '', // the primary model is edited in the Model-profile section, not here
})

const emptyModelForm = (a: Agent): ModelProfileForm => ({
  primaryModel: a.primaryModel ?? a.llmModel ?? '',
  cheapModel: a.cheapModel ?? '',
  cheapModelEnabled: !!a.cheapModelEnabled,
  reasoningEffort: (a.reasoningEffort ?? '').toLowerCase(),
})

export default function AgentDetailScreen({ agentId }: { agentId: string }) {
  const { apiUrl, getToken, orgId, orgRole } = useAuth()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // ── Edit state (owner-only) ──────────────────────────────────────────────────
  const [editing, setEditing] = useState(false)
  const [roster, setRoster] = useState<Agent[]>([])
  const [models, setModels] = useState<ModelOption[]>([])

  const owner = isOwnerRole(orgRole)
  const roleUnknown = orgRole == null
  // Offer edit to an owner, OR when we genuinely can't know the role (fail-OPEN to
  // the backend gate, never to a silent client-only allow). A known member: no edit.
  const canOfferEdit = owner || roleUnknown

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token || !orgId) return
    setError(null)
    setLoading(true)
    // Identity and overview settle separately: a missing overview must not blank
    // out the identity the operator navigated here to see.
    const [a, o] = await Promise.allSettled([
      Api.agent(apiUrl, token, agentId),
      Api.agentOverview(apiUrl, token, orgId, agentId),
    ])
    if (a.status === 'fulfilled') setAgent(a.value)
    if (o.status === 'fulfilled') setData(o.value)
    if (a.status === 'rejected') {
      setError(a.reason?.message ?? 'Could not load this agent.')
    } else if (o.status === 'rejected') {
      setError(o.reason?.message ?? 'Could not load this agent’s activity.')
    }
    setLoading(false)
  }, [apiUrl, getToken, orgId, agentId])

  useEffect(() => {
    load()
  }, [load])

  if (loading && !agent && !data) return <Loading text="Loading agent…" />

  if (!agent && !data) {
    return (
      <ScrollView contentContainerStyle={s.wrap}>
        <Banner kind="error">{error ?? 'Could not load this agent.'}</Banner>
      </ScrollView>
    )
  }

  const o = data?.overview
  const lr = o?.latestRun

  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.blue} />}
    >
      {error ? (
        <View style={{ marginBottom: space.lg }}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}

      {/* ── Identity ───────────────────────────────────────────────────────── */}
      {agent ? (
        <Card style={{ marginBottom: space.lg }}>
          <View style={s.head}>
            <AgentAvatar agent={agent} size={52} />
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{agent.name}</Text>
              {agent.role ? <Text style={s.role}>{agent.role}</Text> : null}
            </View>
          </View>
          <View style={s.tags}>
            <Chip
              label={(agent.status || 'unknown').toUpperCase()}
              tone={statusTone(agent.status)}
              glyph={statusIcon(agent.status)}
            />
            <Chip
              label={`heartbeat: ${agent.heartbeatStatus || 'unknown'}`}
              tone={heartbeatTone(agent.heartbeatStatus)}
              glyph={heartbeatIcon(agent.heartbeatStatus)}
            />
          </View>
        </Card>
      ) : null}

      {/* ── Configuration / Settings ───────────────────────────────────────── */}
      {agent ? (
        !editing ? (
          <ConfigReadout
            agent={agent}
            canOfferEdit={canOfferEdit}
            roleUnknown={roleUnknown}
            onEdit={() => enterEdit()}
          />
        ) : (
          <EditPanel
            agent={agent}
            agentId={agentId}
            apiUrl={apiUrl}
            orgId={orgId!}
            getToken={getToken}
            roster={roster}
            models={models}
            roleUnknown={roleUnknown}
            onAgentUpdated={(a) => setAgent(a)}
            onDone={() => setEditing(false)}
          />
        )
      ) : null}

      {/* ── Latest run ─────────────────────────────────────────────────────── */}
      {o ? (
        <Section title="Latest Run">
          <Card>
            {!lr ? (
              <Text style={s.empty}>This agent has not run yet.</Text>
            ) : (
              <View style={{ gap: space.sm }}>
                <View style={s.runHead}>
                  <Chip label={lr.status} tone={statusTone(lr.status)} glyph={statusIcon(lr.status)} />
                  <Text style={s.runId}>{lr.id.slice(0, 8)}</Text>
                  <Text style={s.ago}>{ago(lr.startedAt)}</Text>
                </View>
                <Text style={s.summary}>{lr.summary}</Text>
              </View>
            )}
          </Card>
        </Section>
      ) : null}

      {/* ── Recent tasks ───────────────────────────────────────────────────── */}
      {data ? (
        <Section title="Recent Tasks">
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {data.recentTasks.length === 0 ? (
              <Empty text="No tasks assigned to this agent yet." />
            ) : (
              data.recentTasks.map((t, i) => (
                <View key={t.id} style={[s.task, i > 0 && s.taskDivider]}>
                  <Text style={s.taskTitle} numberOfLines={1}>
                    {t.title}
                  </Text>
                  <Chip label={t.status} tone={statusTone(t.status)} glyph={statusIcon(t.status)} />
                </View>
              ))
            )}
          </Card>
        </Section>
      ) : null}

      {/* ── Task distributions ─────────────────────────────────────────────── */}
      {o ? (
        <Section title={`Tasks · last ${o.days} days`}>
          <Card style={{ gap: space.lg }}>
            <Distribution title="By status" rows={o.tasksByStatus} withGlyph />
            <Distribution title="By priority" rows={o.tasksByPriority} />
          </Card>
        </Section>
      ) : null}

      {/* ── Costs ──────────────────────────────────────────────────────────── */}
      {o ? (
        <Section title="Costs">
          <Card>
            <Row label="Input tokens" value={o.costs.hasSplit ? formatTokens(o.costs.inputTokens) : NONE} />
            <Row label="Output tokens" value={o.costs.hasSplit ? formatTokens(o.costs.outputTokens) : NONE} />
            <Row label="Cached tokens" value={o.costs.hasSplit ? formatTokens(o.costs.cachedTokens) : NONE} />
            <Row label="Total tokens" value={formatTokens(o.costs.totalTokens)} />
            <Row label="Tasks" value={formatTokens(o.costs.taskCount)} />
            <Row label="Total cost" value={formatCost(o.costs.totalCostUsd)} accent />
          </Card>
          {!o.costs.hasSplit && o.costs.totalTokens > 0 ? (
            <Text style={s.note}>
              The input/output/cached split is recorded from this release onward; earlier tasks carry
              only the total.
            </Text>
          ) : null}
        </Section>
      ) : null}
    </ScrollView>
  )

  // Lazily fetch the pickers' data (roster for reports-to + cycle check, the model
  // catalogue) on entering edit — the read view never needs them. A failed fetch
  // degrades: reports-to falls back to no options, the model field to free text.
  async function enterEdit() {
    setEditing(true)
    const token = await getToken()
    if (!token || !orgId) return
    const [r, m] = await Promise.allSettled([
      Api.agents(apiUrl, token, orgId),
      Api.availableModels(apiUrl, token, orgId),
    ])
    if (r.status === 'fulfilled') setRoster(r.value)
    if (m.status === 'fulfilled') setModels(m.value)
  }
}

// ─── Read-only configuration + the Edit affordance ─────────────────────────────

function ConfigReadout({
  agent,
  canOfferEdit,
  roleUnknown,
  onEdit,
}: {
  agent: Agent
  canOfferEdit: boolean
  roleUnknown: boolean
  onEdit: () => void
}) {
  const trust = parseTrustMode(agent.trustMode)
  return (
    <Section title="Configuration">
      <Card>
        <Row label="Runtime" value={agent.runtime ?? agent.agentType ?? NONE} />
        <Row
          label="Model"
          value={
            agent.primaryModel || agent.llmModel
              ? agent.llmProvider
                ? `${agent.llmProvider} · ${agent.primaryModel || agent.llmModel}`
                : (agent.primaryModel || agent.llmModel)!
              : NONE
          }
        />
        <View style={s.row}>
          <Text style={s.rowLabel}>Trust</Text>
          <Chip
            label={trust === 'low_trust_review' ? 'low-trust review' : 'standard'}
            tone={trust === 'low_trust_review' ? 'warn' : 'neutral'}
            glyph={trust === 'low_trust_review' ? '⚠' : '•'}
          />
        </View>
      </Card>
      {canOfferEdit ? (
        <View style={{ marginTop: space.md }}>
          <Button title="✎ Edit settings" tone="ghost" onPress={onEdit} />
          {roleUnknown ? <Text style={s.note}>{UNKNOWN_ROLE_EDIT_NOTE}</Text> : null}
        </View>
      ) : (
        <Text style={s.note}>{NON_OWNER_EDIT_NOTE}</Text>
      )}
    </Section>
  )
}

// ─── The editable panel ────────────────────────────────────────────────────────

function EditPanel({
  agent,
  agentId,
  apiUrl,
  orgId,
  getToken,
  roster,
  models,
  roleUnknown,
  onAgentUpdated,
  onDone,
}: {
  agent: Agent
  agentId: string
  apiUrl: string
  orgId: string
  getToken: () => Promise<string | null>
  roster: Agent[]
  models: ModelOption[]
  roleUnknown: boolean
  onAgentUpdated: (a: Agent) => void
  onDone: () => void
}) {
  return (
    <View style={{ marginBottom: space.xl }}>
      <View style={s.editHead}>
        <Text style={s.sectionTitle}>Edit settings</Text>
        <Pressable onPress={onDone} accessibilityRole="button" hitSlop={8}>
          <Text style={s.doneLink}>Done</Text>
        </Pressable>
      </View>
      {roleUnknown ? (
        <View style={{ marginBottom: space.md }}>
          <Banner kind="info">{UNKNOWN_ROLE_EDIT_NOTE}</Banner>
        </View>
      ) : null}

      <IdentitySection
        agent={agent}
        agentId={agentId}
        apiUrl={apiUrl}
        orgId={orgId}
        getToken={getToken}
        roster={roster}
        onAgentUpdated={onAgentUpdated}
      />
      <ModelProfileSection
        agent={agent}
        agentId={agentId}
        apiUrl={apiUrl}
        orgId={orgId}
        getToken={getToken}
        models={models}
        onAgentUpdated={onAgentUpdated}
      />
      <TrustSection
        agent={agent}
        agentId={agentId}
        apiUrl={apiUrl}
        orgId={orgId}
        getToken={getToken}
        onAgentUpdated={onAgentUpdated}
      />
      <SkillsSection agentId={agentId} apiUrl={apiUrl} orgId={orgId} getToken={getToken} />
    </View>
  )
}

// ── Identity & adapter (PUT …/config) ──────────────────────────────────────────

function IdentitySection({
  agent,
  agentId,
  apiUrl,
  orgId,
  getToken,
  roster,
  onAgentUpdated,
}: {
  agent: Agent
  agentId: string
  apiUrl: string
  orgId: string
  getToken: () => Promise<string | null>
  roster: Agent[]
  onAgentUpdated: (a: Agent) => void
}) {
  const [form, setForm] = useState<ConfigForm>(() => emptyConfigForm(agent))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const set = (patch: Partial<ConfigForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setSaved(false)
  }

  const managerOptions = [
    { label: '— nobody (top of the chart)', value: '' },
    ...roster
      .filter((a) => a.id !== agentId)
      .map((a) => ({ label: `${a.avatarEmoji ?? '🤖'} ${a.name}${a.role ? ` — ${a.role}` : ''}`, value: a.id })),
  ]

  const save = async () => {
    const rosterNodes = roster.map((a) => ({ id: a.id, reportsTo: a.reportsTo ?? null }))
    const v = validateConfigForm(form, { agentId, agents: rosterNodes })
    if (!v.ok) {
      setErr(v.error)
      return
    }
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy(true)
    setErr(null)
    setSaved(false)
    try {
      const updated = await Api.updateAgentConfig(apiUrl, token, orgId, agentId, buildConfigBody(form))
      onAgentUpdated(updated)
      // Reseed from the server's answer, so what's on screen is what landed.
      setForm(emptyConfigForm(updated))
      setSaved(true)
    } catch (e: any) {
      // 400 (validation), 403 (not owner), 409, or network — the edit is KEPT.
      setErr(`${e?.message ?? 'The request failed.'} Your changes are still here.`)
    }
    setBusy(false)
  }

  return (
    <Card style={{ marginBottom: space.lg, gap: space.md }}>
      <Text style={s.cardTitle}>Identity & adapter</Text>
      {err ? <Banner kind="error">{err}</Banner> : null}
      <LabeledInput label="Name" value={form.name} onChangeText={(t) => set({ name: t })} placeholder="Agent name" />
      <LabeledInput label="Role" value={form.role} onChangeText={(t) => set({ role: t })} placeholder="e.g. Engineer" />
      <LabeledInput label="Title" value={form.title} onChangeText={(t) => set({ title: t })} placeholder="e.g. VP of Engineering" />
      <LabeledInput
        label="Icon (emoji · used when there is no picture)"
        value={form.avatarEmoji}
        onChangeText={(t) => set({ avatarEmoji: t })}
        placeholder="🤖"
      />
      <LabeledInput
        label="Email"
        value={form.contactChannel}
        onChangeText={(t) => set({ contactChannel: t })}
        placeholder="agent@7ei.ai"
        keyboardType="email-address"
      />
      <LabeledInput
        label="Description"
        value={form.jobDescription}
        onChangeText={(t) => set({ jobDescription: t })}
        placeholder="What this agent can do…"
        multiline
      />
      <PickerField
        label="Reports to"
        value={form.reportsTo}
        options={managerOptions}
        onSelect={(v) => set({ reportsTo: v })}
      />
      <PickerField
        label="Adapter"
        value={form.runtime}
        options={RUNTIMES.map((r) => ({ label: ADAPTER_LABEL[r], value: r }))}
        onSelect={(v) => set({ runtime: v })}
      />
      <View style={s.saveRow}>
        <Button title="Save identity" tone="primary" busy={busy} disabled={busy} onPress={save} />
        {saved ? <Text style={s.savedNote}>✓ Saved</Text> : null}
      </View>
    </Card>
  )
}

// ── Model profile (PUT …/model-profile) — dangerous → confirm ───────────────────

function ModelProfileSection({
  agent,
  agentId,
  apiUrl,
  orgId,
  getToken,
  models,
  onAgentUpdated,
}: {
  agent: Agent
  agentId: string
  apiUrl: string
  orgId: string
  getToken: () => Promise<string | null>
  models: ModelOption[]
  onAgentUpdated: (a: Agent) => void
}) {
  const [form, setForm] = useState<ModelProfileForm>(() => emptyModelForm(agent))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const set = (patch: Partial<ModelProfileForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setSaved(false)
  }

  // A model picker when the catalogue loaded; free-text otherwise (as the web
  // degrades). The current value stays selectable even if it's not in the list.
  const modelOptions = (current: string) => {
    if (models.length === 0) return null
    const opts = [{ label: '— provider default / unset', value: '' }, ...models.map((m) => ({ label: `${m.label} · ${m.tier}${m.custom ? ' · custom' : ''}`, value: m.id }))]
    if (current && !models.some((m) => m.id === current)) opts.push({ label: `${current} (current)`, value: current })
    return opts
  }

  const doSave = async () => {
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy(true)
    setErr(null)
    setSaved(false)
    try {
      // The route answers with the new profile (not a full agent row); merge it
      // onto the agent we already have so on-screen state IS the server's answer.
      const profile = await Api.updateModelProfile(apiUrl, token, orgId, agentId, buildModelProfileBody(form))
      const updated: Agent = {
        ...agent,
        primaryModel: profile.primaryModel,
        cheapModel: profile.cheapModel,
        cheapModelEnabled: profile.cheapModelEnabled,
        reasoningEffort: profile.reasoningEffort,
      }
      onAgentUpdated(updated)
      setForm(emptyModelForm(updated))
      setSaved(true)
    } catch (e: any) {
      setErr(`${e?.message ?? 'The request failed.'} Your changes are still here.`)
    }
    setBusy(false)
  }

  const save = () => {
    const v = validateModelProfileForm(form)
    if (!v.ok) {
      setErr(v.error)
      return
    }
    // Dangerous: a model swap changes spend + capability → confirm first.
    Alert.alert('Change this agent’s models?', MODEL_PROFILE_CONFIRM, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Change models', style: 'destructive', onPress: doSave },
    ])
  }

  const primaryOpts = modelOptions(form.primaryModel)
  const cheapOpts = modelOptions(form.cheapModel)

  return (
    <Card style={{ marginBottom: space.lg, gap: space.md }}>
      <Text style={s.cardTitle}>Model profile</Text>
      <Text style={s.cardHint}>The models this agent runs on, and how hard it thinks. A change takes effect on its next task.</Text>
      {err ? <Banner kind="error">{err}</Banner> : null}

      {primaryOpts ? (
        <PickerField label="Primary model" value={form.primaryModel} options={primaryOpts} onSelect={(v) => set({ primaryModel: v })} />
      ) : (
        <LabeledInput label="Primary model" value={form.primaryModel} onChangeText={(t) => set({ primaryModel: t })} placeholder="e.g. claude-opus-4-8" autoCapitalize="none" />
      )}

      <ToggleRow
        label="Use a cheap model for light turns"
        value={form.cheapModelEnabled}
        onValueChange={(v) => set({ cheapModelEnabled: v })}
      />
      {cheapOpts ? (
        <PickerField label="Cheap model" value={form.cheapModel} options={cheapOpts} onSelect={(v) => set({ cheapModel: v })} />
      ) : (
        <LabeledInput label="Cheap model" value={form.cheapModel} onChangeText={(t) => set({ cheapModel: t })} placeholder="e.g. claude-haiku-4-5" autoCapitalize="none" />
      )}

      <PickerField
        label="Reasoning effort"
        value={form.reasoningEffort}
        options={[{ label: 'Provider default', value: '' }, ...REASONING_EFFORTS.map((r) => ({ label: r, value: r }))]}
        onSelect={(v) => set({ reasoningEffort: v })}
      />

      <View style={s.saveRow}>
        <Button title="Save model profile" tone="primary" busy={busy} disabled={busy} onPress={save} />
        {saved ? <Text style={s.savedNote}>✓ Saved</Text> : null}
      </View>
    </Card>
  )
}

// ── Trust (PUT …/trust) — safety-critical → confirm ─────────────────────────────

function TrustSection({
  agent,
  agentId,
  apiUrl,
  orgId,
  getToken,
  onAgentUpdated,
}: {
  agent: Agent
  agentId: string
  apiUrl: string
  orgId: string
  getToken: () => Promise<string | null>
  onAgentUpdated: (a: Agent) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const current = parseTrustMode(agent.trustMode)
  const target: TrustModeLite = current === 'low_trust_review' ? 'standard' : 'low_trust_review'

  const doSave = async () => {
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      // The route answers `{ trustMode }`, not a full agent row — merge the new
      // mode onto the current agent so the card reconciles to the server's answer.
      const trustMode = await Api.updateAgentTrust(apiUrl, token, orgId, agentId, buildTrustBody(target))
      onAgentUpdated({ ...agent, trustMode })
    } catch (e: any) {
      setErr(e?.message ?? 'Could not change the trust tier.')
    }
    setBusy(false)
  }

  const change = () => {
    Alert.alert(
      target === 'low_trust_review' ? 'Put under low-trust review?' : 'Return to standard trust?',
      trustConfirm(current, target),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: target === 'low_trust_review' ? 'Contain' : 'Remove containment', style: 'destructive', onPress: doSave },
      ],
    )
  }

  return (
    <Card style={{ marginBottom: space.lg, gap: space.md }}>
      <Text style={s.cardTitle}>Trust tier</Text>
      <Text style={s.cardHint}>Low-trust review makes gated actions (file-destructive, wallet, email, machine-exec, agent/skill create, task-assign) require approval. The boundary set is edited on the desk.</Text>
      {err ? <Banner kind="error">{err}</Banner> : null}
      <View style={s.row}>
        <Text style={s.rowLabel}>Current</Text>
        <Chip
          label={current === 'low_trust_review' ? 'low-trust review' : 'standard'}
          tone={current === 'low_trust_review' ? 'warn' : 'neutral'}
          glyph={current === 'low_trust_review' ? '⚠' : '•'}
        />
      </View>
      <Button
        title={target === 'low_trust_review' ? '⚠ Put under low-trust review' : 'Return to standard trust'}
        tone={target === 'low_trust_review' ? 'danger' : 'ghost'}
        busy={busy}
        disabled={busy}
        onPress={change}
      />
    </Card>
  )
}

// ── Skills (GET/PUT …/skills) — save-as-you-go, optimistic with rollback ────────

function SkillsSection({
  agentId,
  apiUrl,
  orgId,
  getToken,
}: {
  agentId: string
  apiUrl: string
  orgId: string
  getToken: () => Promise<string | null>
}) {
  const [data, setData] = useState<SkillsPayload | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token) return
    setErr(null)
    try {
      setData(await Api.agentSkills(apiUrl, token, orgId, agentId))
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load skills.')
    }
    setLoading(false)
  }, [apiUrl, getToken, orgId, agentId])

  useEffect(() => {
    load()
  }, [load])

  // Tick = install, untick = uninstall; both write the WHOLE selection. The row
  // flips immediately and the server's answer replaces it — a failure rolls the
  // box back and says why, so what you see is never a change that didn't land.
  const toggle = async (name: string) => {
    if (!data || pending) return
    const token = await getToken()
    if (!token) {
      setErr('Not signed in.')
      return
    }
    const before = data
    const next = nextSelection(selectionOf(data), name)
    setPending(name)
    setErr(null)
    setData(optimisticSplit(data, next))
    try {
      setData(await Api.updateAgentSkills(apiUrl, token, orgId, agentId, next))
    } catch (e: any) {
      setData(before)
      const verb = selectionOf(before).includes(name) ? 'uninstall' : 'install'
      setErr(`Could not ${verb} “${name}” — ${e?.message ?? 'the request failed'}. Nothing changed.`)
    }
    setPending(null)
  }

  return (
    <Card style={{ marginBottom: space.lg, gap: space.sm }}>
      <Text style={s.cardTitle}>Skills</Text>
      <Text style={s.cardHint}>Tick to install, untick to uninstall — saved as you go. Applied when the agent runs.</Text>
      {err ? <Banner kind="error">{err}</Banner> : null}
      {loading && !data ? (
        <Loading text="Loading skills…" />
      ) : !data ? (
        <Text style={s.empty}>No skills to show.</Text>
      ) : (
        <View style={{ gap: space.xs }}>
          {data.installed.length === 0 && data.orphaned.length === 0 && data.other.length === 0 ? (
            <Text style={s.empty}>No company-library skills available.</Text>
          ) : null}
          {data.installed.map((sk) => (
            <SkillRow key={sk.id} name={sk.name} domain={sk.domain} on busy={pending === sk.name} onToggle={() => toggle(sk.name)} />
          ))}
          {data.orphaned.map((name) => (
            <SkillRow key={`orph:${name}`} name={name} on orphan busy={pending === name} onToggle={() => toggle(name)} />
          ))}
          {data.other.map((sk) => (
            <SkillRow key={sk.id} name={sk.name} domain={sk.domain} on={false} busy={pending === sk.name} onToggle={() => toggle(sk.name)} />
          ))}
        </View>
      )}
    </Card>
  )
}

function SkillRow({
  name,
  domain,
  on,
  orphan,
  busy,
  onToggle,
}: {
  name: string
  domain?: string | null
  on: boolean
  orphan?: boolean
  busy?: boolean
  onToggle: () => void
}) {
  return (
    <View style={s.skillRow}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.skillName} numberOfLines={1}>
          {name}
        </Text>
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: 2 }}>
          {domain ? <Text style={s.skillMeta}>{domain}</Text> : null}
          {orphan ? <Text style={[s.skillMeta, { color: theme.orange }]}>⚠ no longer in the library</Text> : null}
          {busy ? <Text style={s.skillMeta}>Saving…</Text> : null}
        </View>
      </View>
      <Switch
        value={on}
        onValueChange={onToggle}
        disabled={busy}
        trackColor={{ true: theme.blue, false: theme.s3 }}
        accessibilityLabel={`${on ? 'Uninstall' : 'Install'} ${name}`}
      />
    </View>
  )
}

// ─── Small form primitives (RN only — no native module, no new dep) ────────────

function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
  keyboardType,
  autoCapitalize,
}: {
  label: string
  value: string
  onChangeText: (t: string) => void
  placeholder?: string
  multiline?: boolean
  keyboardType?: 'default' | 'email-address'
  autoCapitalize?: 'none' | 'sentences'
}) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textFaint}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        style={[s.input, multiline && { minHeight: 72, textAlignVertical: 'top' }]}
      />
    </View>
  )
}

function ToggleRow({ label, value, onValueChange }: { label: string; value: boolean; onValueChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <Text style={[s.fieldLabel, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: theme.blue, false: theme.s3 }} />
    </View>
  )
}

function PickerField({
  label,
  value,
  options,
  onSelect,
}: {
  label: string
  value: string
  options: { label: string; value: string }[]
  onSelect: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <View style={{ gap: space.xs }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Pressable style={s.picker} onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={s.pickerValue} numberOfLines={1}>
          {current?.label ?? (value || '— select')}
        </Text>
        <Text style={s.pickerCaret}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setOpen(false)}>
          <View style={s.modalSheet}>
            <Text style={s.modalTitle}>{label}</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {options.map((o) => {
                const sel = o.value === value
                return (
                  <Pressable
                    key={o.value || '∅'}
                    style={[s.optionRow, sel && s.optionRowOn]}
                    onPress={() => {
                      onSelect(o.value)
                      setOpen(false)
                    }}
                  >
                    <Text style={[s.optionText, sel && { color: theme.blue, fontWeight: '700' }]} numberOfLines={2}>
                      {o.label}
                    </Text>
                    {sel ? <Text style={{ color: theme.blue }}>✓</Text> : null}
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

// ─── shared read pieces ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: space.xl }}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, accent && { color: theme.blue, fontWeight: '800' }]}>{value}</Text>
    </View>
  )
}

function Distribution({
  title,
  rows,
  withGlyph,
}: {
  title: string
  rows: { key: string; count: number }[]
  withGlyph?: boolean
}) {
  const peak = Math.max(1, ...rows.map((r) => r.count))
  return (
    <View>
      <Text style={s.distTitle}>{title}</Text>
      {rows.length === 0 ? (
        <Text style={s.empty}>No tasks in this window.</Text>
      ) : (
        rows.map((r) => (
          <View key={r.key} style={s.distRow}>
            <Text style={s.distLabel} numberOfLines={1}>
              {withGlyph ? `${statusIcon(r.key)} ` : ''}
              {r.key.replace('_', ' ')}
            </Text>
            <View style={s.distTrack}>
              <View style={[s.distFill, { width: `${Math.max((r.count / peak) * 100, 4)}%` }]} />
            </View>
            <Text style={s.distCount}>{r.count}</Text>
          </View>
        ))
      )}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { padding: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  role: { color: theme.textDim, fontSize: font.sm, marginTop: 2 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  sectionTitle: {
    color: theme.textDim,
    fontSize: font.sm,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: space.sm,
  },
  editHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  doneLink: { color: theme.blue, fontSize: font.base, fontWeight: '700' },
  cardTitle: { color: theme.text, fontSize: font.base, fontWeight: '800' },
  cardHint: { color: theme.textFaint, fontSize: font.sm - 1, lineHeight: 17 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.sm,
  },
  rowLabel: { color: theme.textDim, fontSize: font.sm },
  rowValue: { color: theme.text, fontSize: font.sm, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  note: { color: theme.textFaint, fontSize: font.sm - 1, marginTop: space.sm, lineHeight: 17 },
  fieldLabel: { color: theme.textDim, fontSize: font.sm - 1, fontWeight: '600' },
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
  picker: {
    backgroundColor: theme.s2,
    borderWidth: 1,
    borderColor: theme.s3,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  pickerValue: { color: theme.text, fontSize: font.base, flex: 1 },
  pickerCaret: { color: theme.textDim, fontSize: font.base },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: space.xl },
  modalSheet: { backgroundColor: theme.s1, borderRadius: radius.lg, borderWidth: 1, borderColor: theme.s3, padding: space.lg, gap: space.sm },
  modalTitle: { color: theme.textDim, fontSize: font.sm, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: space.xs },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md, paddingHorizontal: space.sm, borderRadius: radius.sm },
  optionRowOn: { backgroundColor: theme.s2 },
  optionText: { color: theme.text, fontSize: font.base, flex: 1 },
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xs },
  savedNote: { color: theme.green, fontSize: font.sm, fontWeight: '700' },
  skillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: theme.s3,
  },
  skillName: { color: theme.text, fontSize: font.base, fontWeight: '600' },
  skillMeta: { color: theme.textFaint, fontSize: font.sm - 2 },
  runHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  runId: { color: theme.textFaint, fontSize: font.sm - 1, fontFamily: 'Courier' },
  ago: { color: theme.textFaint, fontSize: font.sm - 1, marginLeft: 'auto' },
  summary: { color: theme.text, fontSize: font.base, lineHeight: 21 },
  empty: { color: theme.textDim, fontSize: font.sm, paddingVertical: space.sm },
  task: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  taskDivider: { borderTopWidth: 1, borderTopColor: theme.s3 },
  taskTitle: { color: theme.text, fontSize: font.sm, flex: 1 },
  distTitle: { color: theme.text, fontSize: font.sm, fontWeight: '700', marginBottom: space.sm },
  distRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  distLabel: { color: theme.textDim, fontSize: font.sm - 1, width: 104, textTransform: 'capitalize' },
  distTrack: { flex: 1, height: 8, backgroundColor: theme.s2, borderRadius: radius.sm, overflow: 'hidden' },
  distFill: { height: '100%', backgroundColor: theme.blue, borderRadius: radius.sm },
  distCount: { color: theme.textDim, fontSize: font.sm - 1, width: 26, textAlign: 'right' },
})
