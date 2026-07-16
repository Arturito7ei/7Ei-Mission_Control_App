'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api, API } from '@/lib/api'
import CockpitPanel, { type CockpitSectionKey } from './CockpitPanel'
import AssistantPanel from './AssistantPanel'
import MemoryPanel from './MemoryPanel'
import ConnectorsPanel from './ConnectorsPanel'
import TaskDrawer from './TaskDrawer'
import GovernancePanel from './GovernancePanel'
import Sidebar from './Sidebar'
import PlaceholderView from './PlaceholderView'
import PageTabs from './PageTabs'
import AgentDetail from './agent/AgentDetail'
import StaffGrid from './agent/StaffGrid'
import { allSurfaces, isPlaceholder, isSection, navSectionKey, navPageTabs, navSelectedId, navSurfaceTitle } from '@/lib/navModel'
import { DEFAULT_AGENT_TAB, agentRouteHash, parseAgentRoute, type AgentRoute, type AgentTab } from '@/lib/agentRoute'
import { AgentAvatar } from './agent/shared'
import { useTheme } from '../theme'
import { CommandPalette, type Command } from './CommandPalette'
import { statusColor, statusIcon } from './status'
let useAuth: () => { getToken: () => Promise<string | null>; isLoaded: boolean; isSignedIn: boolean }
try {
  useAuth = require('@clerk/nextjs').useAuth
} catch {
  // Epic H / H6 — the PACKAGED (loopback) build ships no Clerk. It authenticates as
  // the single local operator instead: the Electron shell injects the per-install
  // loopback session secret as the Authorization bearer on every request to the
  // backend, so the browser never holds the real token (getToken returns a harmless
  // non-null placeholder only so client guards that check "have a token?" proceed).
  // isSignedIn is true so the dashboard renders as the operator rather than bouncing
  // to the landing route. Gated on NEXT_PUBLIC_MC_PACKAGED so the hosted build (which
  // has a real Clerk key and never reaches this catch) is completely unaffected.
  useAuth = process.env.NEXT_PUBLIC_MC_PACKAGED === '1'
    ? () => ({ getToken: async () => 'mc-loopback', isLoaded: true, isSignedIn: true })
    : () => ({ getToken: async () => null, isLoaded: true, isSignedIn: false })
}

// MCA-80 — thin wrapper over the shared api() client (same call sites as the
// old local helper; base URL, auth header, and error mapping live in lib/api).
const apiFetch = <T,>(path: string, token: string | null, opts?: RequestInit): Promise<T> => api<T>(path, { token, ...opts })

type Org = { id: string; name: string; description?: string; mission?: string; culture?: string }
// avatarUrl is the AG5 uploaded picture; null → avatarEmoji. Every surface that
// shows an agent renders it through <AgentAvatar>, so the Dashboard, the Staff
// grid and the agent header always agree.
type Agent = { id: string; name: string; role: string; status: string; avatarEmoji: string; avatarUrl?: string | null; agentType: string; llmModel: string; skills: string[] }
type Task = { id: string; title: string; status: string; costUsd?: number; tokensUsed?: number; priority: string; createdAt: string; agentId: string; projectId?: string }
type Project = { id: string; name: string; description?: string; createdAt: string }
type Skill = { id: string; name: string; domain: string; description?: string; source: string }
type Notification = { id: string; type: string; title: string; body: string; agentEmoji: string; cost?: number }
type JiraIssue = { id: string; key: string; summary: string; status?: string; priority?: string; issueType?: string; assignee?: string }
type UsageStats = { requestsThisMinute: number; tokensToday: number; costToday: number; concurrentTasks: number; limits: Record<string, number> }

// MCA-86 — status colors/icons come from ./status.ts (design-system table:
// active = purple ⬡, done = green ✓, failed/blocked = red ✕/⛔ — icon always
// rendered next to the color).
const PROVIDER_LABELS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', moonshot: 'Kimi / Moonshot', qwen: 'Qwen', minimax: 'MiniMax', ollama: 'Ollama (local)' }

export default function DashboardPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const { setMode } = useTheme()
  const router = useRouter()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [org, setOrg] = useState<Org | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([])
  const [jiraConnected, setJiraConnected] = useState(false)
  const [usage, setUsage] = useState<UsageStats | null>(null)
  // P2 — how many approvals are waiting. Tasks and approvals are one area now, so
  // the Task Log links across to them rather than leaving the operator to find the
  // Inbox tab on their own. Same source the Inbox tab renders from.
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [tab, setTab] = useState<string>('overview')
  // AG1 — the agent detail page lives inside the `agents` area and deep-links
  // through the URL hash (#agents/<id>/<tab>), parsed by the pure lib/agentRoute.
  const [agentRoute, setAgentRoute] = useState<AgentRoute | null>(null)
  // AG7 — the Agents roster renders as the Staff card grid by default, or a dense table.
  const [agentView, setAgentView] = useState<'staff' | 'table'>('staff')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  // Org creation (web onboarding — backend auto-creates Arturito on first org)
  const [creating, setCreating] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', mission: '', culture: '', deployMode: '', cloudProvider: '', llmChoice: 'anthropic::claude-sonnet-4-20250514', llmApiKey: '', customBaseUrl: '', customModel: '' })
  const [catalogue, setCatalogue] = useState<Record<string, { id: string; label: string; tier: string }[]>>({})
  // Org Settings (editable description/mission/culture + file ingestion)
  const [settings, setSettings] = useState({ description: '', mission: '', culture: '' })
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [uploadingField, setUploadingField] = useState<string | null>(null)
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    try {
      const { orgs: ol } = await apiFetch<{ orgs: Org[] }>('/api/orgs', token)
      if (ol.length > 0) {
        const o = ol[0]; setOrg(o)
        setSettings({ description: o.description ?? '', mission: o.mission ?? '', culture: o.culture ?? '' })
        const [ad, td, pd, nd] = await Promise.all([
          apiFetch<{ agents: Agent[] }>(`/api/orgs/${o.id}/agents`, token),
          apiFetch<{ tasks: Task[] }>(`/api/orgs/${o.id}/tasks`, token),
          apiFetch<{ projects: Project[] }>(`/api/orgs/${o.id}/projects`, token),
          apiFetch<{ notifications: Notification[] }>(`/api/orgs/${o.id}/notifications`, token),
        ])
        setAgents(ad.agents); setTasks(td.tasks); setProjects(pd.projects); setNotifications(nd.notifications)
        // Optional enrichments
        try { const sd = await apiFetch<{ skills: Skill[] }>('/api/skills', token); setSkills(sd.skills) } catch {}
        try { const ib = await apiFetch<{ approvals: unknown[] }>(`/api/orgs/${o.id}/inbox`, token); setPendingApprovals(ib.approvals?.length ?? 0) } catch {}
        try { const ud = await apiFetch<{ usage: UsageStats }>(`/api/orgs/${o.id}/usage`, token); setUsage(ud.usage) } catch {}
        try {
          const jStatus = await apiFetch<{ connected: boolean }>(`/api/orgs/${o.id}/jira/status`, token)
          setJiraConnected(jStatus.connected)
          if (jStatus.connected) {
            const jd = await apiFetch<{ issues: JiraIssue[] }>(`/api/orgs/${o.id}/jira/issues`, token)
            setJiraIssues(jd.issues)
          }
        } catch {}
      }
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [getToken])

  useEffect(() => { if (!isLoaded) return; if (!isSignedIn) { router.push('/'); return }; load() }, [isLoaded, isSignedIn])

  // AG1 — hash → agent route. A deep link (or Back/Forward) lands on the agent
  // detail page with the Agents area selected; no hash = the agent list.
  useEffect(() => {
    const sync = () => {
      const r = parseAgentRoute(window.location.hash)
      setAgentRoute(r)
      if (r) setTab('agents')
    }
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  // Opening an agent from anywhere (fleet, Staff card, table row, palette) lands
  // on DEFAULT_AGENT_TAB — Configuration. The tab bar reaches the rest.
  const openAgent = useCallback((agentId: string, at: AgentTab = DEFAULT_AGENT_TAB) => {
    window.location.hash = agentRouteHash(agentId, at)
  }, [])

  // Leaving the detail page drops the hash without pushing a history entry
  // (replaceState fires no hashchange, so clear the state ourselves).
  const closeAgent = useCallback(() => {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    setAgentRoute(null)
  }, [])

  // Any nav selection leaves the agent detail page behind.
  const selectTab = useCallback((t: string) => { closeAgent(); setTab(t) }, [closeAgent])

  // Model catalogue for the org-creation picker (data-driven from the backend)
  useEffect(() => {
    apiFetch<{ models: Record<string, { id: string; label: string; tier: string }[]> }>('/api/models', null)
      .then(d => setCatalogue(d.models)).catch(() => {})
  }, [])

  const saveSettings = async () => {
    if (!org) return
    setSavingSettings(true); setSettingsSaved(false); setSettingsMsg(null)
    const token = await getToken()
    try {
      await apiFetch(`/api/orgs/${org.id}`, token, { method: 'PATCH', body: JSON.stringify(settings) })
      setOrg({ ...org, ...settings })
      setSettingsSaved(true)
    } catch { setSettingsMsg('Could not save changes.') }
    setSavingSettings(false)
  }

  // Upload a document under a field (mission/culture/knowledge): backend extracts +
  // summarises to Markdown; for mission/culture we drop the summary into the field for review.
  const uploadToField = async (field: 'mission' | 'culture' | 'knowledge', file: File) => {
    if (!org) return
    setUploadingField(field); setSettingsMsg(null); setSettingsSaved(false)
    const token = await getToken()
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch(`${API}/api/orgs/${org.id}/knowledge/ingest-file?target=${field}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Upload failed')
      }
      const { summary } = await res.json() as { summary: string }
      if (field === 'mission' || field === 'culture') {
        setSettings(s => ({ ...s, [field]: s[field] ? `${s[field]}\n\n${summary}` : summary }))
        setSettingsMsg(`Summarised "${file.name}" into ${field === 'mission' ? 'Mission & Vision' : 'Culture & Principles'} — review and Save.`)
      } else {
        setSettingsMsg(`Summarised "${file.name}" and saved to shared knowledge.`)
      }
    } catch (e: any) {
      setSettingsMsg(e?.message ?? 'Upload failed.')
    }
    setUploadingField(null)
  }

  const syncSkills = async () => {
    setSyncing(true)
    const token = await getToken()
    try { await apiFetch('/api/skills/sync', token, { method: 'POST' }); await load() } catch {}
    setSyncing(false)
  }

  const createOrg = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setFormErr('Organisation name is required'); return }
    setCreating(true); setFormErr(null)
    const token = await getToken()
    const payload: Record<string, string> = { name: form.name.trim() }
    if (form.description.trim()) payload.description = form.description.trim()
    if (form.mission.trim()) payload.mission = form.mission.trim()
    if (form.culture.trim()) payload.culture = form.culture.trim()
    if (form.deployMode) payload.deployMode = form.deployMode
    if (form.deployMode === 'cloud' && form.cloudProvider) payload.cloudProvider = form.cloudProvider
    if (form.llmChoice === 'custom') {
      payload.llmProvider = 'custom'
      if (form.customModel.trim()) payload.llmModel = form.customModel.trim()
      if (form.customBaseUrl.trim()) payload.llmBaseUrl = form.customBaseUrl.trim()
    } else {
      const [prov, ...rest] = form.llmChoice.split('::')
      payload.llmProvider = prov
      payload.llmModel = rest.join('::')
    }
    if (form.llmApiKey.trim()) payload.llmApiKey = form.llmApiKey.trim()
    try {
      await apiFetch('/api/orgs', token, { method: 'POST', body: JSON.stringify(payload) })
      setLoading(true)
      await load()
    } catch {
      setFormErr('Could not create organisation. Please try again.')
    }
    setCreating(false)
  }

  if (loading) return <div style={s.center}><span style={{ fontSize: 48 }}>⚡</span><p style={{ color: 'var(--muted)' }}>Loading...</p></div>
  if (!org) return (
    <div style={s.formWrap}>
      <form onSubmit={createOrg} style={s.orgForm}>
        <div style={{ textAlign: 'center' }}>
          <span style={{ fontSize: 48 }}>🏢</span>
          <h2 style={{ ...s.h2, marginTop: 8 }}>Create your organisation</h2>
          <p style={{ color: 'var(--muted)', fontSize: 14, margin: '6px 0 0' }}>Arturito, your Chief of Staff, is set up automatically.</p>
        </div>
        <label style={s.formLabel}>Name *
          <input style={s.formInput} value={form.name} autoFocus placeholder="7Ei"
            onChange={e => setForm({ ...form, name: e.target.value })} />
        </label>
        <label style={s.formLabel}>Description
          <input style={s.formInput} value={form.description} placeholder="What does your org do?"
            onChange={e => setForm({ ...form, description: e.target.value })} />
        </label>
        <label style={s.formLabel}>Mission &amp; Vision
          <textarea style={{ ...s.formInput, minHeight: 58, resize: 'vertical' }} value={form.mission}
            placeholder="Used to give your agents context."
            onChange={e => setForm({ ...form, mission: e.target.value })} />
        </label>
        <label style={s.formLabel}>Culture &amp; Principles
          <textarea style={{ ...s.formInput, minHeight: 58, resize: 'vertical' }} value={form.culture}
            placeholder="How your org works."
            onChange={e => setForm({ ...form, culture: e.target.value })} />
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label style={{ ...s.formLabel, flex: 1 }}>Deployment
            <select style={s.formInput} value={form.deployMode}
              onChange={e => setForm({ ...form, deployMode: e.target.value, cloudProvider: e.target.value === 'cloud' ? form.cloudProvider : '' })}>
              <option value="">—</option>
              <option value="cloud">☁️ Cloud</option>
              <option value="local">💻 Local / On-Premise</option>
            </select>
          </label>
          {form.deployMode === 'cloud' && (
            <label style={{ ...s.formLabel, flex: 1 }}>Cloud provider
              <select style={s.formInput} value={form.cloudProvider}
                onChange={e => setForm({ ...form, cloudProvider: e.target.value })}>
                <option value="">—</option>
                <option value="aws">🟠 AWS Bedrock · Frankfurt (EU)</option>
                <option value="aws_ch">🟠 AWS Bedrock · Zürich (CH)</option>
                <option value="gcp">🔵 Google Vertex · EU</option>
                <option value="gcp_ch">🔵 Google Vertex · Zürich (CH)</option>
                <option value="azure">🟦 Azure OpenAI · Switzerland North</option>
                <option value="oracle">🔴 Oracle Cloud · EU</option>
              </select>
            </label>
          )}
        </div>
        <label style={s.formLabel}>Preferred model
          <select style={s.formInput} value={form.llmChoice}
            onChange={e => setForm({ ...form, llmChoice: e.target.value })}>
            {Object.keys(catalogue).length === 0 && (
              <option value="anthropic::claude-sonnet-4-20250514">Claude Sonnet 4 · balanced</option>
            )}
            {Object.entries(catalogue).map(([prov, models]) => (
              <optgroup key={prov} label={PROVIDER_LABELS[prov] ?? prov}>
                {models.map(m => (
                  <option key={m.id} value={`${prov}::${m.id}`}>{m.label} · {m.tier}</option>
                ))}
              </optgroup>
            ))}
            <option value="custom">⚙️ Custom (OpenAI-compatible)…</option>
          </select>
        </label>
        {form.llmChoice === 'custom' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={s.formLabel}>Base URL
              <input style={s.formInput} value={form.customBaseUrl} placeholder="https://api.deepseek.com/v1"
                onChange={e => setForm({ ...form, customBaseUrl: e.target.value })} />
            </label>
            <label style={s.formLabel}>Model ID
              <input style={s.formInput} value={form.customModel} placeholder="deepseek-chat"
                onChange={e => setForm({ ...form, customModel: e.target.value })} />
            </label>
          </div>
        )}
        {form.llmChoice.split('::')[0] !== 'anthropic' && form.llmChoice.split('::')[0] !== 'ollama' && (
          <label style={s.formLabel}>API key <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· stored per-org{form.llmChoice === 'custom' ? '' : ' (blank = server default if set)'}</span>
            <input style={s.formInput} type="password" value={form.llmApiKey} placeholder="sk-…"
              onChange={e => setForm({ ...form, llmApiKey: e.target.value })} />
          </label>
        )}
        {formErr && <p style={{ color: 'var(--danger-text)', fontSize: 13, margin: 0 }}>{formErr}</p>}
        <button type="submit" disabled={creating} style={{ ...s.primaryBtn, opacity: creating ? 0.6 : 1, cursor: creating ? 'default' : 'pointer' }}>
          {creating ? 'Creating…' : 'Create organisation →'}
        </button>
      </form>
    </div>
  )

  const totalCost = tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
  const agentMap = new Map(agents.map(a => [a.id, a]))
  const unread = notifications.filter(n => n.type === 'task_done').length

  // T2 command-palette shell — navigation + theme. Nav entries come from the
  // Paperclip-style nav model (P0a); selecting a "coming soon" area lands on its
  // placeholder view. Epic V extends this list (jump to task/agent/approval).
  // P1 — this walks *every* surface, not just the rail: the surfaces we folded
  // into tabs (Budgets, Plugins, Comms, Adapters, Secrets) and the ones we took
  // off the rail entirely (Issues, Goals, Workspaces, …) stay one ⌘K away.
  const commands: Command[] = [
    ...allSurfaces().map(n => ({ id: `nav-${n.id}`, label: n.kind === 'placeholder' ? `${n.label} (soon)` : n.label, icon: n.icon, group: 'Navigate', keywords: `go to open view tab ${n.paperclip}`, run: () => selectTab(n.id) })),
    // AG1 — jump straight to an agent's detail page.
    ...agents.map(a => ({ id: `agent-${a.id}`, label: a.name, icon: a.avatarEmoji || '🤖', group: 'Agents', keywords: `agent open ${a.role}`, run: () => openAgent(a.id) })),
    { id: 'theme-light', label: 'Light theme', icon: '☀', group: 'Theme', keywords: 'appearance mode', run: () => setMode('light') },
    { id: 'theme-dark', label: 'Dark theme', icon: '☾', group: 'Theme', keywords: 'appearance mode', run: () => setMode('dark') },
    { id: 'theme-system', label: 'System theme', icon: '🖥', group: 'Theme', keywords: 'appearance mode auto', run: () => setMode('system') },
  ]

  return (
    <div className="mc-layout" style={s.layout}>
      <CommandPalette commands={commands} open={paletteOpen} onOpenChange={setPaletteOpen} />
      {/* P0a — Paperclip-style folded, grouped, collapsible nav rail. P1: when a
          hosted tab is open (e.g. Budgets), the rail keeps its parent (Costs) lit. */}
      <Sidebar orgName={org.name} selected={navSelectedId(tab)} onSelect={selectTab} onOpenPalette={() => setPaletteOpen(true)} unread={unread} />

      <main className="mc-main" style={s.main}>

        {/* P1 — a page that hosts other surfaces as tabs shows them above its body.
            Selecting one swaps the body; the rail selection doesn't move. */}
        <PageTabs tabs={navPageTabs(navSelectedId(tab))} active={tab} onSelect={selectTab} />

        {/* P0a — Paperclip areas not yet built land on an honest "coming soon" view. */}
        {isPlaceholder(tab) && <PlaceholderView id={tab} />}

        {/* P0b — a promoted Cockpit section renders as its own focused area,
            reusing the CockpitPanel composition root (no rebuild). */}
        {isSection(tab) && (
          <CockpitPanel orgId={org.id} getToken={getToken} onOpenTask={setOpenTaskId} onOpenAgent={openAgent}
            only={[navSectionKey(tab) as CockpitSectionKey]} title={navSurfaceTitle(tab)} />
        )}

        {tab === 'cockpit' && <CockpitPanel orgId={org.id} getToken={getToken} onOpenTask={setOpenTaskId} onOpenAgent={openAgent} />}

        {tab === 'assistant' && <AssistantPanel orgId={org.id} getToken={getToken} />}

        {tab === 'memory' && <MemoryPanel orgId={org.id} getToken={getToken} />}

        {tab === 'overview' && (
          <div style={s.page}>
            <h1 style={s.h1}>Mission Control</h1>
            <div style={s.grid4}>
              {[{ label: 'Agents', val: agents.length, color: 'var(--text)' }, { label: 'Active', val: agents.filter(a => a.status === 'active').length, color: statusColor('active') }, { label: 'Tasks', val: tasks.length, color: 'var(--text)' }, { label: 'Total Cost', val: `$${totalCost.toFixed(4)}`, color: 'var(--accent)' }]
                .map(st => <div key={st.label} style={s.statCard}><span style={{ ...s.statVal, color: st.color }}>{st.val}</span><span style={s.statLabel}>{st.label}</span></div>)}
            </div>
            <h2 style={s.h2}>Agent Squad</h2>
            <div style={s.agentGrid}>
              {agents.map(a => (
                <div key={a.id} role="button" tabIndex={0} aria-label={`Open ${a.name}`}
                  onClick={() => openAgent(a.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAgent(a.id) } }}
                  style={{ ...s.agentCard, cursor: 'pointer' }}>
                  <AgentAvatar agent={a} size={36} radius={8} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{a.role}</div>
                  </div>
                  <span title={a.status} aria-label={a.status} style={{ color: statusColor(a.status), fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{statusIcon(a.status)}</span>
                </div>
              ))}
            </div>
            {notifications.length > 0 && (
              <><h2 style={s.h2}>Recent Notifications</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {notifications.slice(0, 5).map(n => (
                    <div key={n.id} style={s.notifRow}>
                      <span>{n.agentEmoji}</span>
                      <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600 }}>{n.title}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>{n.body}</div></div>
                      {n.cost != null && <span style={{ fontSize: 12, color: 'var(--accent)' }}>${n.cost.toFixed(5)}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* AG1 — the Agents area is either the roster or one agent's detail page. */}
        {tab === 'agents' && (agentRoute
          ? <AgentDetail orgId={org.id} agentId={agentRoute.agentId} tab={agentRoute.tab} getToken={getToken}
              onTab={t => openAgent(agentRoute.agentId, t)} onBack={closeAgent} onOpenTask={setOpenTaskId}
              onOpenLibrary={() => selectTab('skills')} />
          : (
          <div style={s.page}>
            {/* AG7 — Staff (card grid, the default) vs the dense table. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={s.h1}>Agents ({agents.length})</h1>
              <div role="tablist" aria-label="Agent view" style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {([['staff', 'Staff'], ['table', 'Table']] as const).map(([v, label]) => (
                  <button key={v} role="tab" aria-selected={agentView === v} onClick={() => setAgentView(v)}
                    style={{
                      background: agentView === v ? 'var(--accent-dim)' : 'transparent',
                      border: `1px solid ${agentView === v ? 'var(--accent-line)' : 'var(--line-strong)'}`,
                      color: agentView === v ? 'var(--accent)' : 'var(--muted)',
                      borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                    }}>{label}</button>
                ))}
              </div>
            </div>

            {agentView === 'staff'
              ? <StaffGrid orgId={org.id} getToken={getToken} onOpenAgent={openAgent} />
              : (
                <div style={s.table}>
                  <div style={{ ...s.thead, gridTemplateColumns: '2fr 2fr 1.5fr 1fr 1fr' }}><span>Name</span><span>Role</span><span>Model</span><span>Skills</span><span>Status</span></div>
                  {agents.map(a => (
                    <div key={a.id} role="button" tabIndex={0} aria-label={`Open ${a.name}`}
                      onClick={() => openAgent(a.id)} onKeyDown={e => { if (e.key === 'Enter') openAgent(a.id) }}
                      style={{ ...s.trow, gridTemplateColumns: '2fr 2fr 1.5fr 1fr 1fr', cursor: 'pointer' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <AgentAvatar agent={a} size={22} radius={6} /> {a.name}
                      </span>
                      <span style={{ color: 'var(--muted)', fontSize: 13 }}>{a.role}</span>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{a.llmModel.split('-').slice(0, 3).join('-')}</span>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{a.skills.length}</span>
                      <span style={{ color: statusColor(a.status), fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{statusIcon(a.status)} {a.status}</span>
                    </div>
                  ))}
                </div>
              )}
          </div>
        ))}

        {tab === 'tasks' && (
          <div style={s.page}>
            {/* P2 — Tasks lives in the Inbox area; the approvals waiting on this
                work are the sibling tab, so say so instead of relying on the
                operator spotting the tab bar. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h1 style={s.h1}>Task Log ({tasks.length})</h1>
              <button onClick={() => selectTab('inbox')} style={{ ...s.approvalsLink, marginLeft: 'auto' }}
                title="Approvals live on the Inbox tab of this area">
                {pendingApprovals > 0
                  ? `⏳ ${pendingApprovals} approval${pendingApprovals > 1 ? 's' : ''} pending — review →`
                  : '✓ No approvals pending — open Inbox →'}
              </button>
            </div>
            <div style={s.table}>
              <div style={{ ...s.thead, gridTemplateColumns: '3fr 1.5fr 1fr 1fr 1fr' }}><span>Task</span><span>Agent</span><span>Status</span><span>Cost</span><span>Tokens</span></div>
              {tasks.slice(0, 100).map(t => {
                const a = agentMap.get(t.agentId)
                return (
                  <div key={t.id} role="button" tabIndex={0} onClick={() => setOpenTaskId(t.id)} onKeyDown={e => { if (e.key === 'Enter') setOpenTaskId(t.id) }} style={{ ...s.trow, gridTemplateColumns: '3fr 1.5fr 1fr 1fr 1fr', cursor: 'pointer' }}>
                    <span style={{ fontSize: 13 }}>{t.title.slice(0, 60)}{t.title.length > 60 ? '…' : ''}</span>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{a?.avatarEmoji} {a?.name ?? '—'}</span>
                    <span style={{ color: statusColor(t.status), fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{statusIcon(t.status)} {t.status}</span>
                    <span style={{ color: 'var(--accent)', fontSize: 12 }}>{t.costUsd != null ? `$${t.costUsd.toFixed(5)}` : '—'}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>{t.tokensUsed?.toLocaleString() ?? '—'}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === 'projects' && (
          <div style={s.page}>
            <h1 style={s.h1}>Projects ({projects.length})</h1>
            <div style={s.cardGrid}>
              {projects.length === 0 && <p style={{ color: 'var(--muted)' }}>No projects yet.</p>}
              {projects.map(p => {
                const pt = tasks.filter(t => t.projectId === p.id); const done = pt.filter(t => t.status === 'done').length
                return (<div key={p.id} style={s.projCard}><div style={{ fontSize: 20, fontWeight: 700 }}>📁 {p.name}</div>{p.description && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{p.description}</div>}<div style={{ marginTop: 12, display: 'flex', gap: 16 }}><span style={{ fontSize: 13, color: 'var(--muted)' }}>{pt.length} tasks</span><span style={{ fontSize: 13, color: statusColor('done') }}>{statusIcon('done')} {done} done</span></div></div>)
              })}
            </div>
          </div>
        )}

        {tab === 'skills' && (
          <div style={s.page}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h1 style={s.h1}>Skill Library ({skills.length})</h1>
              <button onClick={syncSkills} disabled={syncing} style={s.syncBtn}>{syncing ? 'Syncing…' : '↻ Sync GitHub'}</button>
            </div>
            <div style={s.table}>
              <div style={{ ...s.thead, gridTemplateColumns: '2fr 1.5fr 3fr 1fr' }}><span>Skill</span><span>Domain</span><span>Description</span><span>Source</span></div>
              {skills.map(sk => (
                <div key={sk.id} style={{ ...s.trow, gridTemplateColumns: '2fr 1.5fr 3fr 1fr' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>⚡ {sk.name}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'capitalize' }}>{sk.domain}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{sk.description?.slice(0, 80) ?? '—'}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>{sk.source}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'costs' && (
          <div style={s.page}>
            <h1 style={s.h1}>Cost Centre</h1>
            <div style={s.grid4}>
              <div style={s.statCard}><span style={{ ...s.statVal, color: 'var(--accent)' }}>${totalCost.toFixed(4)}</span><span style={s.statLabel}>Total Spend</span></div>
              <div style={s.statCard}><span style={s.statVal}>{(tasks.reduce((s, t) => s + (t.tokensUsed ?? 0), 0) / 1000).toFixed(1)}K</span><span style={s.statLabel}>Total Tokens</span></div>
              <div style={s.statCard}><span style={s.statVal}>{tasks.filter(t => t.status === 'done').length}</span><span style={s.statLabel}>Done</span></div>
              <div style={s.statCard}><span style={{ ...s.statVal, color: 'var(--info)' }}>{agents.length}</span><span style={s.statLabel}>Agents</span></div>
            </div>
            <h2 style={s.h2}>By Agent</h2>
            {agents.map(a => {
              const ac = tasks.filter(t => t.agentId === a.id).reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
              return (<div key={a.id} style={s.costRow}><span style={{ minWidth: 120, fontSize: 14 }}>{a.avatarEmoji} {a.name}</span><div style={s.barTrack}><div style={{ ...s.barFill, width: `${Math.max(totalCost > 0 ? (ac / totalCost) * 100 : 0, 1)}%` }} /></div><span style={{ color: 'var(--accent)', fontSize: 13, minWidth: 70, textAlign: 'right' }}>${ac.toFixed(4)}</span></div>)
            })}
          </div>
        )}

        {tab === 'comms' && (
          <div style={s.page}>
            <h1 style={s.h1}>Communications Hub</h1>
            <div style={s.commsGrid}>
              {[{ icon: '📬', title: 'Unified Inbox', desc: 'All agent messages in one place.' }, { icon: '📧', title: 'Gmail', desc: 'Connect via Google OAuth to read and send email.' }, { icon: '✈️', title: 'Telegram', desc: 'Register a bot token in Org Settings.' }, { icon: '📹', title: 'Google Meet', desc: 'Generate meeting links via the API.' }]
                .map(ch => <div key={ch.title} style={s.commsCard}><span style={{ fontSize: 36 }}>{ch.icon}</span><div style={{ fontWeight: 700, fontSize: 16, marginTop: 8 }}>{ch.title}</div><div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, lineHeight: 1.6 }}>{ch.desc}</div></div>)}
            </div>
          </div>
        )}

        {tab === 'connectors' && org && <ConnectorsPanel orgId={org.id} getToken={getToken} />}

        {tab === 'governance' && org && <GovernancePanel orgId={org.id} getToken={getToken} />}

        {openTaskId && org && <TaskDrawer orgId={org.id} taskId={openTaskId} getToken={getToken} onClose={() => setOpenTaskId(null)} />}

        {tab === 'usage' && (
          <div style={s.page}>
            <h1 style={s.h1}>Usage & Limits</h1>
            {!usage ? <p style={{ color: 'var(--muted)' }}>Loading usage stats...</p> : (
              <>
                <div style={s.grid4}>
                  {[
                    { label: 'Requests / min', val: usage.requestsThisMinute, max: usage.limits.requestsPerMinute ?? 60 },
                    { label: 'Tokens today', val: `${(usage.tokensToday / 1000).toFixed(1)}K`, max: usage.limits.tokensPerDay ?? 500000, raw: usage.tokensToday },
                    { label: 'Cost today', val: `$${usage.costToday.toFixed(4)}`, max: usage.limits.costPerDay ?? 5, raw: usage.costToday },
                    { label: 'Concurrent tasks', val: usage.concurrentTasks, max: usage.limits.concurrentTasks ?? 5 },
                  ].map(st => {
                    const raw = typeof st.raw !== 'undefined' ? st.raw : (typeof st.val === 'number' ? st.val : 0)
                    const pct = st.max > 0 ? Math.min((raw / st.max) * 100, 100) : 0
                    return (
                      <div key={st.label} style={s.statCard}>
                        <span style={{ ...s.statVal, color: pct > 80 ? 'var(--danger-text)' : 'var(--accent)' }}>{st.val}</span>
                        <span style={s.statLabel}>{st.label}</span>
                        <div style={{ ...s.barTrack, marginTop: 8 }}><div style={{ ...s.barFill, width: `${Math.max(pct, 1)}%`, background: pct > 80 ? 'var(--danger-text)' : 'var(--accent)' }} /></div>
                        <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>/ {typeof st.max === 'number' && st.max >= 1000 ? `${(st.max / 1000).toFixed(0)}K` : st.max}</span>
                      </div>
                    )
                  })}
                </div>
                <div style={s.emptyCard}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>ℹ️ Configuring limits</h3>
                  <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0, lineHeight: 1.8 }}>Set these env vars on the backend:<br />
                    <code style={{ color: 'var(--accent)' }}>RATE_LIMIT_RPM</code> · <code style={{ color: 'var(--accent)' }}>RATE_LIMIT_TOKENS_DAY</code> · <code style={{ color: 'var(--accent)' }}>RATE_LIMIT_COST_DAY</code> · <code style={{ color: 'var(--accent)' }}>RATE_LIMIT_CONCURRENT</code>
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div style={s.page}>
            <h1 style={s.h1}>Settings</h1>
            <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: -8, maxWidth: 720 }}>
              Edit your organisation’s description, mission, and culture — or upload a document
              (PDF, Word, PowerPoint, Excel, .txt, .md) to summarise into a field. Mission &amp;
              Culture are read by every agent; each upload is also saved to shared knowledge.
            </p>

            <div style={{ ...s.projCard, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
              <label style={s.formLabel}>Description
                <input style={s.formInput} value={settings.description}
                  onChange={e => setSettings({ ...settings, description: e.target.value })} />
              </label>

              {(['mission', 'culture'] as const).map(field => {
                const label = field === 'mission' ? 'Mission & Vision' : 'Culture & Principles'
                return (
                  <div key={field} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>{label}</span>
                      <label style={{ ...s.uploadChip, ...(uploadingField ? { opacity: 0.6, cursor: 'default' } : {}) }}>
                        {uploadingField === field ? 'Summarising…' : '📎 Upload file'}
                        <input type="file" style={{ display: 'none' }} disabled={uploadingField !== null}
                          accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.csv,.rtf,.html"
                          onChange={e => { const f = e.target.files?.[0]; if (f) uploadToField(field, f); e.target.value = '' }} />
                      </label>
                    </div>
                    <textarea style={{ ...s.formInput, minHeight: 110, resize: 'vertical' }} value={settings[field]}
                      placeholder={field === 'mission' ? 'What you’re building and why.' : 'How your org works.'}
                      onChange={e => setSettings({ ...settings, [field]: e.target.value })} />
                  </div>
                )
              })}

              {settingsMsg && <p style={{ fontSize: 13, margin: 0, color: /could not|fail/i.test(settingsMsg) ? 'var(--danger-text)' : 'var(--ok)' }}>{settingsMsg}</p>}

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button onClick={saveSettings} disabled={savingSettings}
                  style={{ ...s.primaryBtn, width: 'fit-content', opacity: savingSettings ? 0.6 : 1, cursor: savingSettings ? 'default' : 'pointer' }}>
                  {savingSettings ? 'Saving…' : 'Save changes'}
                </button>
                {settingsSaved && <span style={{ color: 'var(--ok)', fontSize: 13 }}>✓ Saved</span>}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, background: 'var(--s0)' },
  layout: { display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--s0)' },
  // Sidebar chrome now lives in Sidebar.tsx (P0a folded nav rail).
  main: { flex: 1, overflow: 'auto' },
  page: { padding: 28, maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
  h1: { fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -0.5 },
  h2: { fontSize: 18, fontWeight: 700, margin: 0 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 },
  statCard: { background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 },
  statVal: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  statLabel: { fontSize: 12, color: 'var(--muted)' },
  agentGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  agentCard: { background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 10, padding: 16, display: 'flex', alignItems: 'center', gap: 12 },
  table: { background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' },
  thead: { display: 'grid', padding: '10px 16px', background: 'var(--s2)', borderBottom: '1px solid var(--line)', fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  trow: { display: 'grid', padding: '12px 16px', borderBottom: '1px solid var(--line)', alignItems: 'center', fontSize: 14 },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 },
  projCard: { background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 12, padding: 20 },
  syncBtn: { background: 'var(--s2)', border: '1px solid var(--line-strong)', color: 'var(--accent)', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  costRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line)' },
  barTrack: { flex: 1, height: 8, background: 'var(--s2)', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', background: 'var(--accent)', borderRadius: 4 },
  notifRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--s1)', borderRadius: 10, border: '1px solid var(--line)' },
  commsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 },
  commsCard: { background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 12, padding: 20 },
  emptyCard: { background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 12, padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' as const },
  formWrap: { minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: 'var(--s0)', padding: '48px 20px', overflow: 'auto' },
  orgForm: { display: 'flex', flexDirection: 'column', gap: 14, width: '100%', maxWidth: 460, background: 'var(--s1)', border: '1px solid var(--line)', borderRadius: 16, padding: 28 },
  formLabel: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--text-2)' },
  formInput: { background: 'var(--s0)', border: '1px solid var(--line-strong)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  primaryBtn: { background: 'var(--accent)', color: 'var(--accent-contrast)', border: 'none', borderRadius: 10, padding: '13px 20px', fontSize: 15, fontWeight: 700, marginTop: 4 },
  uploadChip: { fontSize: 12, fontWeight: 600, color: 'var(--accent)', background: 'var(--s2)', border: '1px solid var(--line-strong)', padding: '5px 12px', borderRadius: 8, cursor: 'pointer' },
  approvalsLink: { fontSize: 12.5, fontWeight: 700, color: 'var(--accent)', background: 'var(--s2)', border: '1px solid var(--line-strong)', padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
}
