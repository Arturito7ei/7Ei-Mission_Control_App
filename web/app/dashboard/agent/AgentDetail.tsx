'use client'
// Epic AG / AG1 — per-agent detail page: header (avatar · name · role · status
// pill · actions) + the six-tab bar, mirroring the Paperclip agent page. Routing
// is the pure `lib/agentRoute` hash contract; the tab panels land in AG2–AG6.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { AGENT_TABS, AGENT_TAB_LABEL, type AgentTab } from '@/lib/agentRoute'
import { Button, Skeleton, TextInput } from '../ui'
import { Modal, ModalTitle, FormLabel } from '../cockpit/shared'
import { tk, text, space } from '../tokens'
import { AgentAvatar, StatusPill, ax, type DAgent, type Getter } from './shared'
import DashboardTab from './DashboardTab'
import InstructionsTab from './InstructionsTab'
import SkillsTab from './SkillsTab'
import ConfigurationTab from './ConfigurationTab'
import RunsTab from './RunsTab'
import BudgetTab from './BudgetTab'

export default function AgentDetail({ orgId, agentId, tab, onTab, onBack, getToken, onOpenTask, onOpenLibrary }: {
  orgId: string
  agentId: string
  tab: AgentTab
  onTab: (t: AgentTab) => void
  onBack: () => void
  getToken: Getter
  onOpenTask?: (taskId: string) => void
  /** AG4 — jump to the company skills library area. */
  onOpenLibrary?: () => void
}) {
  const [agent, setAgent] = useState<DAgent | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')

  const load = useCallback(async () => {
    setErr(null)
    try {
      const { agent: a } = await api<{ agent: DAgent }>(`/api/agents/${agentId}`, { token: await getToken() })
      setAgent(a)
    } catch (e: any) { setErr(e?.message ?? 'Could not load this agent.') }
  }, [agentId, getToken])

  useEffect(() => { load() }, [load])

  // Header actions. Pause/resume/terminate reuse the existing agent controls;
  // "Run heartbeat" reuses the org heartbeat sweep (which wakes due agents —
  // there is no per-agent wake endpoint, so the label says sweep in its title).
  const control = async (verb: 'pause' | 'resume' | 'terminate') => {
    setBusy(true); setMsg(null)
    try {
      await api(`/api/agents/${agentId}/${verb}`, { token: await getToken(), method: 'POST' })
      await load()
    } catch (e: any) { setErr(e?.message ?? `Could not ${verb} this agent.`) }
    setBusy(false)
  }

  const heartbeat = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/heartbeat/sweep`, { token: await getToken(), method: 'POST' })
      setMsg('Heartbeat sweep ran — any due agent was woken.')
      await load()
    } catch (e: any) { setErr(e?.message ?? 'Heartbeat sweep failed.') }
    setBusy(false)
  }

  const assign = async () => {
    const title = taskTitle.trim()
    if (!title) return
    setBusy(true); setErr(null)
    try {
      await api(`/api/orgs/${orgId}/tasks`, { token: await getToken(), method: 'POST', body: JSON.stringify({ agentId, title }) })
      setAssignOpen(false); setTaskTitle('')
      setMsg(`Assigned "${title}".`)
    } catch (e: any) { setErr(e?.message ?? 'Could not assign the task.') }
    setBusy(false)
  }

  if (err && !agent) return (
    <div style={ax.page}>
      <button style={ax.crumbLink} onClick={onBack}>← Agents</button>
      <div style={ax.err}>{err}</div>
    </div>
  )

  if (!agent) return (
    <div style={ax.page}>
      <div style={{ display: 'flex', gap: space.lg, alignItems: 'center' }}>
        <Skeleton w={56} h={56} /><div style={{ flex: 1 }}><Skeleton w={180} h={20} /><Skeleton w={110} h={12} style={{ marginTop: 8 }} /></div>
      </div>
      <Skeleton h={32} />
    </div>
  )

  const paused = agent.status === 'paused'

  return (
    <div style={ax.page}>
      <nav style={ax.crumbs} aria-label="Breadcrumb">
        <button style={ax.crumbLink} onClick={onBack}>Agents</button>
        <span aria-hidden="true">›</span>
        <span style={{ color: tk.text }}>{agent.name}</span>
      </nav>

      <header style={ax.header}>
        <AgentAvatar agent={agent} size={56} />
        <div style={{ minWidth: 0 }}>
          <h1 style={ax.name}>{agent.name}</h1>
          <div style={ax.role}>{agent.title || agent.role}</div>
        </div>
        <div style={ax.actions}>
          <Button onClick={() => setAssignOpen(true)} disabled={busy}>＋ Assign Task</Button>
          <Button onClick={heartbeat} disabled={busy} title="Runs the org heartbeat sweep — wakes any agent that is due">▷ Run Heartbeat</Button>
          {paused
            ? <Button onClick={() => control('resume')} disabled={busy}>▶ Resume</Button>
            : <Button onClick={() => control('pause')} disabled={busy}>❙❙ Pause</Button>}
          <StatusPill status={agent.status} />
        </div>
      </header>

      {msg && <p style={{ ...ax.empty, color: tk.green }}>{msg}</p>}
      {err && <div style={ax.err}>{err}</div>}

      <div role="tablist" aria-label="Agent sections" style={ax.tabbar}>
        {AGENT_TABS.map(t => (
          <button key={t} role="tab" aria-selected={t === tab} id={`agent-tab-${t}`} aria-controls={`agent-panel-${t}`}
            onClick={() => onTab(t)}
            style={{ ...ax.tab, ...(t === tab ? ax.tabOn : {}) }}>
            {AGENT_TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`agent-panel-${tab}`} aria-labelledby={`agent-tab-${tab}`}>
        {tab === 'dashboard' && <DashboardTab orgId={orgId} agentId={agentId} getToken={getToken}
          onViewRuns={() => onTab('runs')} onOpenTask={onOpenTask} />}
        {tab === 'instructions' && <InstructionsTab orgId={orgId} agentId={agentId} getToken={getToken} />}
        {tab === 'skills' && <SkillsTab orgId={orgId} agentId={agentId} getToken={getToken} onOpenLibrary={onOpenLibrary} />}
        {tab === 'configuration' && <ConfigurationTab orgId={orgId} agentId={agentId} getToken={getToken} onSaved={load} />}
        {tab === 'runs' && <RunsTab orgId={orgId} agentId={agentId} getToken={getToken} onOpenTask={onOpenTask} />}
        {tab === 'budget' && <BudgetTab orgId={orgId} agentId={agentId} agentName={agent.name} getToken={getToken} />}
      </div>

      {assignOpen && (
        <Modal onClose={() => setAssignOpen(false)}>
          <ModalTitle onClose={() => setAssignOpen(false)}>Assign a task to {agent.name}</ModalTitle>
          <FormLabel>Title
            <TextInput autoFocus value={taskTitle} placeholder="What should this agent do?"
              onChange={e => setTaskTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') assign() }} />
          </FormLabel>
          <div style={{ display: 'flex', gap: space.sm, justifyContent: 'flex-end' }}>
            <Button onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={assign} disabled={busy || !taskTitle.trim()}>Assign</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

