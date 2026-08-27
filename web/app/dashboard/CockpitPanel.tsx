'use client'
// Mission Control cockpit (MCA-EXT Phase 3; split into cockpit/* in MCA-80).
// Composition root: owns all shared state + mutations (loads on mount, no
// polling; optimistic deletes/decisions), sections render via props.
// Reads GET /api/orgs/:id/cockpit and friends via the shared api() client.
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { tk, ui, space } from './tokens'
import { Button, Card, SectionLabel, Skeleton } from './ui'
import { sx, type Approval, type ApprovalDecision, type Budget, type Cockpit, type Getter, type GoalNode, type InboxItem, type Plugin, type Preflight, type Secret, type Timeline, type Workspace } from './cockpit/shared'
import StatsRow from './cockpit/StatsRow'
import InboxSection from './cockpit/InboxSection'
import VoiceSection from './cockpit/VoiceSection'
import AgentFleet from './cockpit/AgentFleet'
import TimelineSection from './cockpit/TimelineSection'
import ActivityLogSection from './cockpit/ActivityLogSection'
import OrgChart, { type OrgRosterAgent } from './cockpit/OrgChart'
import GoalsSection from './cockpit/GoalsSection'
import BudgetsSection from './cockpit/BudgetsSection'
import PreflightSection from './cockpit/PreflightSection'
import SecretsSection from './cockpit/SecretsSection'
import TelegramSection from './cockpit/TelegramSection'
import WorkspacesSection from './cockpit/WorkspacesSection'
import PluginsSection from './cockpit/PluginsSection'
import TaskBoard from './cockpit/TaskBoard'
import AddAgentWizard from './cockpit/AddAgentWizard'
import HireDialog from './cockpit/HireDialog'
import InviteAgentDialog from './cockpit/InviteAgentDialog'
import StepUpDialog from './cockpit/StepUpDialog'
import { useOrgRole } from './useOrgRole'
import { approvalNeedsStepUp } from '@/lib/dangerousApprovals'
import type { ActivityEvent } from '@/lib/activityKinds'

// P0b — the same composition root can render either the full operator stack
// (Operations) or a single promoted area. `only` filters which sections render
// (by key); `title` labels a focused area. Absent → the full stack, as before.
export type CockpitSectionKey =
  | 'inbox' | 'voice' | 'agents' | 'activity' | 'org' | 'goals'
  | 'budgets' | 'secrets' | 'telegram' | 'workspaces' | 'plugins' | 'tasks'

export default function CockpitPanel({ orgId, getToken, onOpenTask, onOpenAgent, only, title }: { orgId: string; getToken: Getter; onOpenTask?: (taskId: string) => void; onOpenAgent?: (agentId: string) => void; only?: CockpitSectionKey[]; title?: string }) {
  const [data, setData] = useState<Cockpit | null>(null)
  // P2 — the org canvas derives its own tree, so it takes the flat roster.
  const [roster, setRoster] = useState<OrgRosterAgent[] | null>(null)
  const [orgBusy, setOrgBusy] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  // ACT-1 — the recently DECIDED tail shown under the Inbox queue. Sourced from the
  // unified activity feed so there is ONE projected shape for a decided approval.
  const [decisions, setDecisions] = useState<ActivityEvent[]>([])
  const [goals, setGoals] = useState<GoalNode[] | null>(null)
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [wizard, setWizard] = useState(false)
  const [hire, setHire] = useState(false)
  const [invite, setInvite] = useState(false)
  // APPR-1 — the approval awaiting step-up confirmation, plus per-approval
  // in-flight + error state so a failed decision stays visible on its own card.
  const [stepUp, setStepUp] = useState<Approval | null>(null)
  const [deciding, setDeciding] = useState<Set<string>>(new Set())
  const [decideErr, setDecideErr] = useState<Record<string, string>>({})
  // AAD-2 — the caller's role, server-computed. `null` (unknown / failed) offers
  // nothing; it is never treated as owner.
  const { isOwner } = useOrgRole(orgId, getToken)

  // ACT-1 — the decided tail, on its own so a decision can refresh it WITHOUT
  // re-running the 10-way cockpit load. This is the freshness leg of the APPR-1 lesson:
  // the queue clears a card only on confirmed success, and the decided list is then
  // re-read from the server rather than guessed at locally, so what the operator sees
  // after deciding is what the server actually recorded.
  const loadDecisions = useCallback(async () => {
    try {
      const r = await api<{ events: ActivityEvent[] }>(`/api/orgs/${orgId}/activity?kind=approval_decided&limit=8`, { token: await getToken() })
      setDecisions(r.events ?? [])
    } catch { /* the queue is the load-bearing part; a missing tail must not blank it */ }
  }, [orgId, getToken])

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const [c, tl, oc, ib, gl, bd, pf, se, ws, pl] = await Promise.all([
        api<Cockpit>(`/api/orgs/${orgId}/cockpit`, { token }),
        api<{ timeline: Timeline }>(`/api/orgs/${orgId}/timeline`, { token }),
        api<{ agents: OrgRosterAgent[] }>(`/api/orgs/${orgId}/orgchart`, { token }),
        api<{ items: InboxItem[]; approvals: Approval[] }>(`/api/orgs/${orgId}/inbox`, { token }),
        api<{ tree: GoalNode[] }>(`/api/orgs/${orgId}/goals`, { token }),
        api<{ budgets: Budget[] }>(`/api/orgs/${orgId}/budgets`, { token }),
        api<Preflight>(`/api/orgs/${orgId}/preflight`, { token }),
        api<{ secrets: Secret[] }>(`/api/orgs/${orgId}/secrets`, { token }),
        api<{ workspaces: Workspace[] }>(`/api/orgs/${orgId}/workspaces`, { token }),
        api<{ plugins: Plugin[] }>(`/api/orgs/${orgId}/plugins`, { token }),
      ])
      loadDecisions()
      setData(c); setTimeline(tl.timeline); setRoster(oc.agents ?? []); setInbox(ib.items); setApprovals(ib.approvals ?? []); setGoals(gl.tree); setBudgets(bd.budgets ?? []); setPreflight(pf); setSecrets(se.secrets ?? []); setWorkspaces(ws.workspaces ?? []); setPlugins(pl.plugins ?? []); setErr(null)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
  }, [orgId, getToken, loadDecisions])

  useEffect(() => { load() }, [load])

  const dismiss = async (taskId: string) => {
    setInbox(x => x.filter(i => i.taskId !== taskId))
    try { await api(`/api/orgs/${orgId}/inbox/dismiss`, { token: await getToken(), method: 'POST', body: JSON.stringify({ taskId }) }) } catch {}
  }
  // APPR-1 — deciding an approval is NOT optimistic any more.
  //
  // It used to drop the card first and swallow every failure (`catch {}`), which
  // made the desk LIE: the backend 403s an approve of a dangerous type without a
  // step-up header (which the web never sent), yet the card vanished and the
  // operator believed the action was approved. Now:
  //   • a dangerous APPROVE routes to the step-up dialog (typed confirmation →
  //     fresh session → `x-arturita-session` header) and only IT clears the card;
  //   • everything else awaits the response and clears ONLY on success;
  //   • a failure keeps the card and surfaces the error next to it.
  // Reject / request-changes are never step-up-gated, so the common path is
  // unchanged apart from now being honest about failure.
  const decide = async (id: string, decision: ApprovalDecision, note?: string) => {
    const approval = approvals.find(a => a.id === id)
    // AUDIT nit (a) — a MISS must not fall through to the headerless path. If the
    // row isn't in state we cannot tell whether it is dangerous, and guessing
    // "safe" would send a bare approve that the server correctly 403s: not
    // exploitable (the gate holds, and the failure now surfaces) but a dead end
    // the operator can't act on. Local state is stale in that case, so say so.
    if (decision === 'approved' && !approval) {
      setDecideErr(prev => ({ ...prev, [id]: 'This approval is no longer in view — refresh before deciding.' }))
      return
    }
    if (decision === 'approved' && approval && approvalNeedsStepUp(approval)) {
      setStepUp(approval) // the dialog owns the mint + decide + card removal
      return
    }
    setDeciding(s => new Set(s).add(id))
    setDecideErr(e => { const { [id]: _drop, ...rest } = e; return rest })
    try {
      await api(`/api/approvals/${id}/decide`, { token: await getToken(), method: 'POST', body: JSON.stringify({ decision, note }) })
      setApprovals(x => x.filter(a => a.id !== id)) // ONLY on success
      loadDecisions()                                // and re-read what was recorded
    } catch (e: any) {
      // Keep the card, and say what actually happened — a 403 must never read as success.
      setDecideErr(prev => ({ ...prev, [id]: e?.message ?? 'Decision failed — nothing was recorded.' }))
    } finally {
      setDeciding(s => { const n = new Set(s); n.delete(id); return n })
    }
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

  // P2 — company portability (MCA-PC D3 endpoints). Export downloads the
  // secret-scrubbed bundle; import remaps it into a NEW organisation (the
  // backend never overwrites the current one), so we just report the result.
  const exportOrg = async () => {
    setOrgBusy('Exporting…')
    try {
      const { bundle } = await api<{ bundle: unknown }>(`/api/orgs/${orgId}/export`, { token: await getToken() })
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `7ei-company-${orgId}.json`
      link.click()
      URL.revokeObjectURL(url)
      setOrgBusy(null)
    } catch (e: any) { setOrgBusy(`Export failed: ${e?.message ?? 'unknown error'}`) }
  }
  const importOrg = async (file: File) => {
    setOrgBusy('Importing…')
    try {
      const bundle = JSON.parse(await file.text())
      const r = await api<{ counts: { agents: number } }>('/api/orgs/import', {
        token: await getToken(), method: 'POST', body: JSON.stringify({ bundle: bundle.bundle ?? bundle }),
      })
      setOrgBusy(`Imported ${r.counts.agents} agents into a new company — switch to it to see its chart.`)
    } catch (e: any) { setOrgBusy(`Import failed: ${e?.message ?? 'invalid bundle'}`) }
  }

  const agentName = (id: string) => data?.agents.find(a => a.id === id)?.name ?? '—'
  const inboxCount = inbox.length + approvals.length
  const initialLoading = !data && !err // MCA-81 — skeletons until the first payload lands
  const focused = !!only // P0b — rendering a single promoted area, not the full stack

  // Keyed section registry — the same nodes power the full Operations stack and
  // the focused single-area views (P0b). Each section self-titles (SectionLabel),
  // so a focused area needs no extra heading beyond the toolbar.
  const sections: { key: CockpitSectionKey; node: React.ReactNode }[] = [
    { key: 'inbox', node: <InboxSection inbox={inbox} approvals={approvals} onDismiss={dismiss} onDecide={decide} onRetry={retry} deciding={deciding} decideErr={decideErr} agents={data?.agents ?? []} recentDecisions={decisions} focused={focused} /> },
    { key: 'voice', node: <VoiceSection orgId={orgId} getToken={getToken} approvals={approvals} onDecide={decide} /> },
    { key: 'agents', node: <AgentFleet agents={data ? data.agents : null} onControl={agentControl} onAsk={askAgent} onOpenAgent={onOpenAgent} /> },
    // ACT-1 — Activity is BOTH: the unified log (what actually happened) and the 24h
    // heartbeat swimlane (who was busy, when). The swimlane never knew about approvals,
    // connector runs or the audit trail; the log does.
    //
    // AUDIT-ACT1 UX-1 — the LOG GOES FIRST. It shipped with the swimlane on top, which
    // pushed the log's own filter chips and agent picker a full section down: on a
    // laptop viewport they landed below the fold, so the surface that answers "what has
    // my office been doing" opened looking like a chart with no controls. Ordering is
    // the whole fix — the log is the higher-information surface and it carries the
    // controls, so it earns the top. The swimlane keeps its place directly beneath,
    // where it reads as the supporting view it actually is.
    { key: 'activity', node: <><ActivityLogSection orgId={orgId} getToken={getToken} agents={data?.agents ?? []} onOpenAgent={onOpenAgent} /><div style={{ marginTop: space.xxl }}><TimelineSection timeline={timeline} /></div></> },
    { key: 'org', node: <OrgChart agents={roster} onOpenAgent={onOpenAgent} onExport={exportOrg} onImport={importOrg} busy={orgBusy} /> },
    { key: 'goals', node: <GoalsSection orgId={orgId} getToken={getToken} goals={goals} onChanged={load} /> },
    { key: 'budgets', node: <><BudgetsSection orgId={orgId} getToken={getToken} agents={data?.agents ?? []} budgets={budgets} onDelete={delBudget} onChanged={load} /><PreflightSection orgId={orgId} getToken={getToken} preflight={preflight} onChanged={load} /></> },
    { key: 'secrets', node: <SecretsSection orgId={orgId} getToken={getToken} agents={data?.agents ?? []} secrets={secrets} onDelete={delSecret} onChanged={load} /> },
    { key: 'telegram', node: <TelegramSection orgId={orgId} getToken={getToken} onChanged={load} /> },
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
          {/* AAD-2 — the "+ Agent" entry point for the FOCUSED Org / Agents views.
              The three creation buttons below are `{!focused && …}`, so the Org
              section (which is this panel with `only={['org']}`) showed no add
              affordance at all — its toolbar had Import/Export/zoom and nothing
              else. This mounts the SAME shipped InviteAgentDialog rather than a
              second path, and only for an owner: `POST …/agent-invites` is
              `requireOrgRole('owner')`, so offering it to a member would be a
              button that can only 403. */}
          {focused && (only ?? []).some(k => k === 'org' || k === 'agents') && isOwner === true && (
            <Button variant="primary" onClick={() => setInvite(true)}
              title="Create an invite + a copy-able onboarding prompt to paste into any external agent">＋ Agent</Button>
          )}
          {/* Full-stack-only actions — a focused area keeps just Refresh. */}
          {!focused && <>
            <Button style={{ color: tk.accent }} onClick={sweep} title="Run heartbeat engine: recover stalled tasks, refresh statuses, wake due agents">💓 Sweep</Button>
            <Button style={{ color: tk.accent }} onClick={() => setHire(true)}>✨ Hire with a prompt</Button>
            <Button style={{ color: tk.accent }} onClick={() => setInvite(true)} title="Create an invite + a copy-able onboarding prompt to paste into any external agent">✉ Invite an agent</Button>
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
      {invite && <InviteAgentDialog orgId={orgId} getToken={getToken} onClose={() => { setInvite(false); load() }} />}
      {/* APPR-1 — dangerous approve: typed confirmation → fresh step-up session →
          `x-arturita-session` on decide. The card is removed ONLY on a 2xx. */}
      {stepUp && (
        <StepUpDialog
          approval={stepUp}
          orgId={orgId}
          getToken={getToken}
          onCancel={() => setStepUp(null)}
          onApproved={id => {
            setStepUp(null)
            setApprovals(x => x.filter(a => a.id !== id))
            setDecideErr(e => { const { [id]: _drop, ...rest } = e; return rest })
            // AUDIT-ACT1 H-3 — the step-up path must refresh the tail TOO. Without this
            // the desk drops the card and the row never appears under "Recently decided",
            // so approving the single most dangerous class of action gives the operator
            // the LEAST confirmation — the same "it just vanished" phenomenology APPR-1
            // existed to kill. The phone already did this (ApprovalsPane onApproved);
            // the desk did not. Mirrored by activityFeed.test.ts.
            loadDecisions()
          }}
        />
      )}
    </div>
  )
}
