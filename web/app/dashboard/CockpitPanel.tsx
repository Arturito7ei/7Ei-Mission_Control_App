'use client'
// Mission Control cockpit (MCA-EXT Phase 3; split into cockpit/* in MCA-80).
// Composition root: owns all shared state + mutations (loads on mount, no
// polling; optimistic deletes/decisions), sections render via props.
// Reads GET /api/orgs/:id/cockpit and friends via the shared api() client.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, ui, space } from './tokens'
import { Button, Card, SectionLabel, Skeleton } from './ui'
import { sx, type Approval, type ApprovalDecision, type Budget, type Cockpit, type Getter, type GoalNode, type InboxItem, type OrgNode, type Plugin, type Preflight, type Secret, type Timeline, type Workspace } from './cockpit/shared'
import StatsRow from './cockpit/StatsRow'
import InboxSection from './cockpit/InboxSection'
import VoiceSection from './cockpit/VoiceSection'
import AgentFleet from './cockpit/AgentFleet'
import TimelineSection from './cockpit/TimelineSection'
import OrgChart from './cockpit/OrgChart'
import GoalsSection from './cockpit/GoalsSection'
import BudgetsSection from './cockpit/BudgetsSection'
import PreflightSection from './cockpit/PreflightSection'
import SecretsSection from './cockpit/SecretsSection'
import WorkspacesSection from './cockpit/WorkspacesSection'
import PluginsSection from './cockpit/PluginsSection'
import TaskBoard from './cockpit/TaskBoard'
import AddAgentWizard from './cockpit/AddAgentWizard'
import HireDialog from './cockpit/HireDialog'

// P0b — the same composition root can render either the full operator stack
// (Operations) or a single promoted area. `only` filters which sections render
// (by key); `title` labels a focused area. Absent → the full stack, as before.
export type CockpitSectionKey =
  | 'inbox' | 'voice' | 'agents' | 'activity' | 'org' | 'goals'
  | 'budgets' | 'secrets' | 'workspaces' | 'plugins' | 'tasks'

export default function CockpitPanel({ orgId, getToken, onOpenTask, onOpenAgent, only, title }: { orgId: string; getToken: Getter; onOpenTask?: (taskId: string) => void; onOpenAgent?: (agentId: string) => void; only?: CockpitSectionKey[]; title?: string }) {
  const [data, setData] = useState<Cockpit | null>(null)
  const [chart, setChart] = useState<OrgNode[] | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [goals, setGoals] = useState<GoalNode[] | null>(null)
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [wizard, setWizard] = useState(false)
  const [hire, setHire] = useState(false)

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const [c, tl, oc, ib, gl, bd, pf, se, ws, pl] = await Promise.all([
        api<Cockpit>(`/api/orgs/${orgId}/cockpit`, { token }),
        api<{ timeline: Timeline }>(`/api/orgs/${orgId}/timeline`, { token }),
        api<{ tree: OrgNode[] }>(`/api/orgs/${orgId}/orgchart`, { token }),
        api<{ items: InboxItem[]; approvals: Approval[] }>(`/api/orgs/${orgId}/inbox`, { token }),
        api<{ tree: GoalNode[] }>(`/api/orgs/${orgId}/goals`, { token }),
        api<{ budgets: Budget[] }>(`/api/orgs/${orgId}/budgets`, { token }),
        api<Preflight>(`/api/orgs/${orgId}/preflight`, { token }),
        api<{ secrets: Secret[] }>(`/api/orgs/${orgId}/secrets`, { token }),
        api<{ workspaces: Workspace[] }>(`/api/orgs/${orgId}/workspaces`, { token }),
        api<{ plugins: Plugin[] }>(`/api/orgs/${orgId}/plugins`, { token }),
      ])
      setData(c); setTimeline(tl.timeline); setChart(oc.tree); setInbox(ib.items); setApprovals(ib.approvals ?? []); setGoals(gl.tree); setBudgets(bd.budgets ?? []); setPreflight(pf); setSecrets(se.secrets ?? []); setWorkspaces(ws.workspaces ?? []); setPlugins(pl.plugins ?? []); setErr(null)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  const dismiss = async (taskId: string) => {
    setInbox(x => x.filter(i => i.taskId !== taskId))
    try { await api(`/api/orgs/${orgId}/inbox/dismiss`, { token: await getToken(), method: 'POST', body: JSON.stringify({ taskId }) }) } catch {}
  }
  const decide = async (id: string, decision: ApprovalDecision, note?: string) => {
    setApprovals(x => x.filter(a => a.id !== id))
    try { await api(`/api/approvals/${id}/decide`, { token: await getToken(), method: 'POST', body: JSON.stringify({ decision, note }) }) } catch {}
  }
  // V2: retry a failed inbox row in place — re-execute, drop it, reload once done.
  const retry = async (taskId: string) => {
    setInbox(x => x.filter(i => i.taskId !== taskId))
    try { await api(`/api/tasks/${taskId}/execute`, { token: await getToken(), method: 'POST' }) } catch {}
    load()
  }
  // V2 board read receipts: opening a task marks it read (optimistic clear +
  // durable receipt) then hands off to the page-level drawer.
  const openTask = (taskId: string) => {
    setData(d => d ? { ...d, tasks: d.tasks.map(t => t.id === taskId ? { ...t, unread: false } : t) } : d)
    getToken().then(token => api(`/api/tasks/${taskId}/read`, { token, method: 'POST' }).catch(() => {}))
    onOpenTask?.(taskId)
  }
  // W5 ask-mode: fire a single-turn question at an agent, open its task drawer so
  // the answer streams into the thread, then reload once it lands.
  const askAgent = async (agentId: string, question: string) => {
    const r = await api<{ taskId?: string }>(`/api/agents/${agentId}/ask`, { token: await getToken(), method: 'POST', body: JSON.stringify({ question }) })
    if (r?.taskId) { onOpenTask?.(r.taskId); setTimeout(() => load(), 1500) }
  }
  const agentControl = async (id: string, verb: 'pause' | 'resume' | 'terminate') => {
    try { await api(`/api/agents/${id}/${verb}`, { token: await getToken(), method: 'POST' }) } catch {}
    load()
  }
  const sweep = async () => {
    try { await api(`/api/orgs/${orgId}/heartbeat/sweep`, { token: await getToken(), method: 'POST' }) } catch {}
    load()
  }
  const delBudget = async (id: string) => {
    setBudgets(x => x.filter(b => b.id !== id))
    try { await api(`/api/budgets/${id}`, { token: await getToken(), method: 'DELETE' }) } catch {}
  }
  const delSecret = async (id: string) => {
    setSecrets(x => x.filter(s => s.id !== id))
    try { await api(`/api/secrets/${id}`, { token: await getToken(), method: 'DELETE' }) } catch {}
  }
  const delWorkspace = async (id: string) => {
    setWorkspaces(x => x.filter(w => w.id !== id))
    try { await api(`/api/workspaces/${id}`, { token: await getToken(), method: 'DELETE' }) } catch {}
  }
  const togglePlugin = async (id: string, enabled: boolean) => {
    setPlugins(x => x.map(p => p.id === id ? { ...p, enabled } : p))
    try { await api(`/api/plugins/${id}`, { token: await getToken(), method: 'PATCH', body: JSON.stringify({ enabled }) }) } catch {}
  }
  const delPlugin = async (id: string) => {
    setPlugins(x => x.filter(p => p.id !== id))
    try { await api(`/api/plugins/${id}`, { token: await getToken(), method: 'DELETE' }) } catch {}
  }

  const agentName = (id: string) => data?.agents.find(a => a.id === id)?.name ?? '—'
  const inboxCount = inbox.length + approvals.length
  const initialLoading = !data && !err // MCA-81 — skeletons until the first payload lands
  const focused = !!only // P0b — rendering a single promoted area, not the full stack

  // Keyed section registry — the same nodes power the full Operations stack and
  // the focused single-area views (P0b). Each section self-titles (SectionLabel),
  // so a focused area needs no extra heading beyond the toolbar.
  const sections: { key: CockpitSectionKey; node: React.ReactNode }[] = [
    { key: 'inbox', node: <InboxSection inbox={inbox} approvals={approvals} onDismiss={dismiss} onDecide={decide} onRetry={retry} /> },
    { key: 'voice', node: <VoiceSection orgId={orgId} getToken={getToken} approvals={approvals} onDecide={decide} /> },
    { key: 'agents', node: <AgentFleet agents={data ? data.agents : null} onControl={agentControl} onAsk={askAgent} onOpenAgent={onOpenAgent} /> },
    { key: 'activity', node: <TimelineSection timeline={timeline} /> },
    { key: 'org', node: <OrgChart chart={chart} /> },
    { key: 'goals', node: <GoalsSection orgId={orgId} getToken={getToken} goals={goals} onChanged={load} /> },
    { key: 'budgets', node: <><BudgetsSection orgId={orgId} getToken={getToken} agents={data?.agents ?? []} budgets={budgets} onDelete={delBudget} onChanged={load} /><PreflightSection orgId={orgId} getToken={getToken} preflight={preflight} onChanged={load} /></> },
    { key: 'secrets', node: <SecretsSection orgId={orgId} getToken={getToken} agents={data?.agents ?? []} secrets={secrets} onDelete={delSecret} onChanged={load} /> },
    { key: 'workspaces', node: <WorkspacesSection orgId={orgId} getToken={getToken} workspaces={workspaces} onDelete={delWorkspace} onChanged={load} /> },
    { key: 'plugins', node: <PluginsSection orgId={orgId} getToken={getToken} plugins={plugins} onToggle={togglePlugin} onDelete={delPlugin} onChanged={load} /> },
    { key: 'tasks', node: <TaskBoard tasks={data?.tasks ?? []} agentName={agentName} nextUp={data?.nextUp ?? null} onOpen={openTask} /> },
  ]
  const shown = only ? sections.filter(s => only.includes(s.key)) : sections

  return (
    <div style={{ ...ui.page, maxWidth: 1200, gap: space.xl }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.md }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.md }}>
          <h1 style={ui.h1}>{focused ? (title ?? 'Operations') : 'Mission Control'}</h1>
          {!focused && inboxCount > 0 && <span style={{ ...sx.tag, background: 'var(--accent-dim)', color: tk.accent }}>📥 {inboxCount}</span>}
        </div>
        <div style={{ display: 'flex', gap: space.md, flexWrap: 'wrap' }}>
          <Button style={{ color: tk.accent }} onClick={load}>↻ Refresh</Button>
          {/* Full-stack-only actions — a focused area keeps just Refresh. */}
          {!focused && <>
            <Button style={{ color: tk.accent }} onClick={sweep} title="Run heartbeat engine: recover stalled tasks, refresh statuses, wake due agents">💓 Sweep</Button>
            <Button style={{ color: tk.accent }} onClick={() => setHire(true)}>✨ Hire with a prompt</Button>
            <Button variant="primary" onClick={() => setWizard(true)}>＋ Add agent</Button>
          </>}
        </div>
      </div>

      {err && <div style={ui.err}>⚠ {err}</div>}

      {!focused && <StatsRow sum={data?.summary ?? {}} agents={data?.agents ?? null} budgets={budgets} approvalsPending={approvals.length} loading={initialLoading} />}
      {initialLoading ? (
        // MCA-81 — skeleton rows in place of the sections while the first load is in flight.
        (focused ? [title ?? 'Loading'] : ['Inbox', 'Agent fleet', 'Heartbeat · last 24h', 'Goals', 'Budgets', 'Task board']).map(l => (
          <div key={l}>
            <SectionLabel>{l}</SectionLabel>
            <Card style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
              <Skeleton h={14} w="72%" />
              <Skeleton h={14} w="88%" />
              <Skeleton h={14} w="58%" />
            </Card>
          </div>
        ))
      ) : (
        <>{shown.map(s => <div key={s.key}>{s.node}</div>)}</>
      )}

      {wizard && <AddAgentWizard orgId={orgId} getToken={getToken} onClose={() => setWizard(false)} onDone={() => { setWizard(false); load() }} />}
      {hire && <HireDialog orgId={orgId} getToken={getToken} onClose={() => setHire(false)} onDone={() => { setHire(false); load() }} />}
    </div>
  )
}
