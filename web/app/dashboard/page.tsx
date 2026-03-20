'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

async function apiFetch<T>(path: string, token: string | null, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  })
  if (!res.ok) throw new Error('Request failed')
  return res.json()
}

type Org = { id: string; name: string; description?: string }
type Agent = { id: string; name: string; role: string; status: string; avatarEmoji: string; agentType: string; llmModel: string; skills: string[] }
type Task = { id: string; title: string; status: string; costUsd?: number; tokensUsed?: number; durationMs?: number; priority: string; createdAt: string; agentId: string }
type Project = { id: string; name: string; description?: string; createdAt: string }
type Skill = { id: string; name: string; domain: string; description?: string; source: string }
type Notification = { id: string; type: string; title: string; body: string; agentEmoji: string; cost?: number }

const STATUS_COLORS: Record<string, string> = {
  idle: '#555', active: '#22c55e', paused: '#f59e0b', stopped: '#ef4444',
  pending: '#555', in_progress: '#3b82f6', done: '#22c55e', blocked: '#ef4444', failed: '#ef4444',
}
const PRIORITY_COLORS: Record<string, string> = { highest: '#ef4444', high: '#f97316', medium: '#FFB800', low: '#3b82f6', lowest: '#555' }

type Tab = 'overview' | 'agents' | 'tasks' | 'projects' | 'skills' | 'costs' | 'comms'

export default function DashboardPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const router = useRouter()
  const [orgs, setOrgs] = useState<Org[]>([])
  const [org, setOrg] = useState<Org | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    const token = await getToken()
    try {
      const { orgs: ol } = await apiFetch<{ orgs: Org[] }>('/api/orgs', token)
      setOrgs(ol)
      if (ol.length > 0) {
        const o = ol[0]; setOrg(o)
        const [ad, td, pd, notifD] = await Promise.all([
          apiFetch<{ agents: Agent[] }>(`/api/orgs/${o.id}/agents`, token),
          apiFetch<{ tasks: Task[] }>(`/api/orgs/${o.id}/tasks`, token),
          apiFetch<{ projects: Project[] }>(`/api/orgs/${o.id}/projects`, token),
          apiFetch<{ notifications: Notification[] }>(`/api/orgs/${o.id}/notifications`, token),
        ])
        setAgents(ad.agents); setTasks(td.tasks); setProjects(pd.projects)
        setNotifications(notifD.notifications)
      }
      try { const sd = await apiFetch<{ skills: Skill[] }>('/api/skills', token); setSkills(sd.skills) } catch {}
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [getToken])

  useEffect(() => { if (!isLoaded) return; if (!isSignedIn) { router.push('/'); return }; load() }, [isLoaded, isSignedIn])

  const syncSkills = async () => {
    setSyncing(true)
    const token = await getToken()
    try { await apiFetch('/api/skills/sync', token, { method: 'POST' }); await load() } catch {}
    setSyncing(false)
  }

  if (loading) return <div style={s.center}><span style={{ fontSize: 48 }}>⚡</span><p style={{ color: '#888' }}>Loading...</p></div>
  if (!org) return <div style={s.center}><span style={{ fontSize: 64 }}>🏢</span><h2>No organisation</h2><p style={{ color: '#888' }}>Create one in the mobile app first.</p></div>

  const totalCost = tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
  const totalTokens = tasks.reduce((sum, t) => sum + (t.tokensUsed ?? 0), 0)
  const agentMap = new Map(agents.map(a => [a.id, a]))
  const unread = notifications.filter(n => n.type === 'task_done').length

  const NAV: { id: Tab; icon: string; label: string }[] = [
    { id: 'overview', icon: '🏠', label: 'Overview' },
    { id: 'agents', icon: '🤖', label: 'Agents' },
    { id: 'tasks', icon: '📋', label: 'Tasks' },
    { id: 'projects', icon: '📁', label: 'Projects' },
    { id: 'skills', icon: '⚡', label: 'Skills' },
    { id: 'costs', icon: '💰', label: 'Costs' },
    { id: 'comms', icon: '📬', label: 'Comms' },
  ]

  return (
    <div style={s.layout}>
      {/* Sidebar */}
      <aside style={s.sidebar}>
        <div style={s.logoBox}><span style={s.logoText}>7Ei</span></div>
        <div style={s.orgLabel}>{org.name}</div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)} style={{ ...s.navBtn, ...(tab === n.id ? s.navActive : {}) }}>
              <span>{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        {unread > 0 && (
          <div style={s.notifBanner}>
            <span>🔔</span>
            <span style={{ flex: 1, fontSize: 13 }}>{unread} task{unread > 1 ? 's' : ''} done</span>
          </div>
        )}
      </aside>

      {/* Main */}
      <main style={s.main}>

        {/* ─── Overview ─────────────────────────────────── */}
        {tab === 'overview' && (
          <div style={s.page}>
            <h1 style={s.h1}>Mission Control</h1>
            <div style={s.grid4}>
              {[
                { label: 'Agents', val: agents.length, color: '#fff' },
                { label: 'Active', val: agents.filter(a => a.status === 'active').length, color: '#22c55e' },
                { label: 'Tasks', val: tasks.length, color: '#fff' },
                { label: 'Total Cost', val: `$${totalCost.toFixed(4)}`, color: '#FFB800' },
              ].map(st => (
                <div key={st.label} style={s.statCard}>
                  <span style={{ ...s.statVal, color: st.color }}>{st.val}</span>
                  <span style={s.statLabel}>{st.label}</span>
                </div>
              ))}
            </div>
            <h2 style={s.h2}>Agent Squad</h2>
            <div style={s.agentGrid}>
              {agents.map(a => (
                <div key={a.id} style={s.agentCard}>
                  <span style={{ fontSize: 28 }}>{a.avatarEmoji}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{a.role}</div>
                    {a.skills.length > 0 && <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{a.skills.slice(0, 2).join(', ')}{a.skills.length > 2 ? ` +${a.skills.length - 2}` : ''}</div>}
                  </div>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: STATUS_COLORS[a.status] ?? '#555', flexShrink: 0 }} title={a.status} />
                </div>
              ))}
            </div>
            {notifications.length > 0 && (
              <>
                <h2 style={s.h2}>Recent Notifications</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {notifications.slice(0, 5).map(n => (
                    <div key={n.id} style={s.notifRow}>
                      <span>{n.agentEmoji}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{n.title}</div>
                        <div style={{ fontSize: 12, color: '#888' }}>{n.body}</div>
                      </div>
                      {n.cost != null && <span style={{ fontSize: 12, color: '#FFB800' }}>${n.cost.toFixed(5)}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ─── Agents ────────────────────────────────────── */}
        {tab === 'agents' && (
          <div style={s.page}>
            <h1 style={s.h1}>Agents ({agents.length})</h1>
            <div style={s.table}>
              <div style={{ ...s.thead, gridTemplateColumns: '2fr 2fr 1.5fr 1fr 1fr' }}>
                <span>Name</span><span>Role</span><span>Model</span><span>Skills</span><span>Status</span>
              </div>
              {agents.map(a => (
                <div key={a.id} style={{ ...s.trow, gridTemplateColumns: '2fr 2fr 1.5fr 1fr 1fr' }}>
                  <span>{a.avatarEmoji} {a.name}</span>
                  <span style={{ color: '#888', fontSize: 13 }}>{a.role}</span>
                  <span style={{ color: '#555', fontSize: 12 }}>{a.llmModel.split('-').slice(0, 3).join('-')}</span>
                  <span style={{ color: '#888', fontSize: 12 }}>{a.skills.length}</span>
                  <span style={{ color: STATUS_COLORS[a.status], fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{a.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Tasks ─────────────────────────────────────── */}
        {tab === 'tasks' && (
          <div style={s.page}>
            <h1 style={s.h1}>Task Log ({tasks.length})</h1>
            <div style={s.table}>
              <div style={{ ...s.thead, gridTemplateColumns: '3fr 1.5fr 1fr 1fr 1fr' }}>
                <span>Task</span><span>Agent</span><span>Status</span><span>Cost</span><span>Tokens</span>
              </div>
              {tasks.slice(0, 100).map(t => {
                const agent = agentMap.get(t.agentId)
                return (
                  <div key={t.id} style={{ ...s.trow, gridTemplateColumns: '3fr 1.5fr 1fr 1fr 1fr' }}>
                    <span style={{ fontSize: 13 }} title={t.title}>{t.title.slice(0, 60)}{t.title.length > 60 ? '…' : ''}</span>
                    <span style={{ fontSize: 12, color: '#888' }}>{agent?.avatarEmoji} {agent?.name ?? '—'}</span>
                    <span style={{ color: STATUS_COLORS[t.status], fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{t.status}</span>
                    <span style={{ color: '#FFB800', fontSize: 12 }}>{t.costUsd != null ? `$${t.costUsd.toFixed(5)}` : '—'}</span>
                    <span style={{ color: '#888', fontSize: 12 }}>{t.tokensUsed?.toLocaleString() ?? '—'}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ─── Projects ──────────────────────────────────── */}
        {tab === 'projects' && (
          <div style={s.page}>
            <h1 style={s.h1}>Projects ({projects.length})</h1>
            <div style={s.cardGrid}>
              {projects.length === 0 && <p style={{ color: '#888' }}>No projects yet. Create one in the mobile app.</p>}
              {projects.map(p => {
                const pTasks = tasks.filter(t => t.projectId === p.id)
                const done = pTasks.filter(t => t.status === 'done').length
                return (
                  <div key={p.id} style={s.projCard}>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>📁 {p.name}</div>
                    {p.description && <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{p.description}</div>}
                    <div style={{ marginTop: 12, display: 'flex', gap: 16 }}>
                      <span style={{ fontSize: 13, color: '#888' }}>{pTasks.length} tasks</span>
                      <span style={{ fontSize: 13, color: '#22c55e' }}>{done} done</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ─── Skills ────────────────────────────────────── */}
        {tab === 'skills' && (
          <div style={s.page}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h1 style={s.h1}>Skill Library ({skills.length})</h1>
              <button onClick={syncSkills} disabled={syncing} style={s.syncBtn}>{syncing ? 'Syncing…' : '↻ Sync GitHub'}</button>
            </div>
            <div style={s.table}>
              <div style={{ ...s.thead, gridTemplateColumns: '2fr 1.5fr 3fr 1fr' }}>
                <span>Skill</span><span>Domain</span><span>Description</span><span>Source</span>
              </div>
              {skills.map(sk => (
                <div key={sk.id} style={{ ...s.trow, gridTemplateColumns: '2fr 1.5fr 3fr 1fr' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>⚡ {sk.name}</span>
                  <span style={{ color: '#888', fontSize: 12, textTransform: 'capitalize' }}>{sk.domain}</span>
                  <span style={{ color: '#888', fontSize: 12 }}>{sk.description?.slice(0, 80) ?? '—'}</span>
                  <span style={{ color: '#555', fontSize: 11 }}>{sk.source}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Costs ─────────────────────────────────────── */}
        {tab === 'costs' && (
          <div style={s.page}>
            <h1 style={s.h1}>Cost Centre</h1>
            <div style={s.grid4}>
              <div style={s.statCard}><span style={{ ...s.statVal, color: '#FFB800' }}>${totalCost.toFixed(4)}</span><span style={s.statLabel}>Total Spend</span></div>
              <div style={s.statCard}><span style={{ ...s.statVal }}>{(totalTokens / 1000).toFixed(1)}K</span><span style={s.statLabel}>Total Tokens</span></div>
              <div style={s.statCard}><span style={{ ...s.statVal }}>{tasks.filter(t => t.status === 'done').length}</span><span style={s.statLabel}>Completed Tasks</span></div>
              <div style={s.statCard}><span style={{ ...s.statVal, color: '#3b82f6' }}>{agents.length}</span><span style={s.statLabel}>Active Agents</span></div>
            </div>
            <h2 style={s.h2}>By Agent</h2>
            {agents.map(a => {
              const agentTasks = tasks.filter(t => t.agentId === a.id)
              const agentCost = agentTasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
              const pct = totalCost > 0 ? (agentCost / totalCost) * 100 : 0
              return (
                <div key={a.id} style={s.costRow}>
                  <span style={{ minWidth: 120, fontSize: 14 }}>{a.avatarEmoji} {a.name}</span>
                  <div style={s.barTrack}><div style={{ ...s.barFill, width: `${Math.max(pct, 1)}%` }} /></div>
                  <span style={{ color: '#FFB800', fontSize: 13, minWidth: 70, textAlign: 'right' }}>${agentCost.toFixed(4)}</span>
                  <span style={{ color: '#555', fontSize: 12, minWidth: 60, textAlign: 'right' }}>{agentTasks.length} tasks</span>
                </div>
              )
            })}
          </div>
        )}

        {/* ─── Comms ─────────────────────────────────────── */}
        {tab === 'comms' && (
          <div style={s.page}>
            <h1 style={s.h1}>Communications Hub</h1>
            <div style={s.commsGrid}>
              {[
                { icon: '📬', title: 'Unified Inbox', desc: 'All agent messages in one place. Managed from the mobile Comms tab.' },
                { icon: '📧', title: 'Gmail', desc: 'Connect via Google OAuth. Agents can read and send email on your behalf.' },
                { icon: '✈️', title: 'Telegram', desc: 'Register a bot token in Org Settings. Incoming messages route to the inbox.' },
                { icon: '📹', title: 'Google Meet', desc: 'Generate meeting links via the API. Calendar events created automatically.' },
              ].map(ch => (
                <div key={ch.title} style={s.commsCard}>
                  <span style={{ fontSize: 36 }}>{ch.icon}</span>
                  <div style={{ fontWeight: 700, fontSize: 16, marginTop: 8 }}>{ch.title}</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 6, lineHeight: 1.6 }}>{ch.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, background: '#0a0a0a' },
  layout: { display: 'flex', height: '100vh', overflow: 'hidden', background: '#0a0a0a' },
  sidebar: { width: 220, background: '#111', borderRight: '1px solid #222', display: 'flex', flexDirection: 'column', padding: '16px 12px', gap: 4 },
  logoBox: { width: 44, height: 44, background: '#FFB800', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  logoText: { fontSize: 18, fontWeight: 800, color: '#000' },
  orgLabel: { fontSize: 14, fontWeight: 700, color: '#fff', padding: '8px 4px', borderBottom: '1px solid #222', marginBottom: 8 },
  navBtn: { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', color: '#888', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 500, width: '100%', textAlign: 'left' as const },
  navActive: { background: '#1a1a1a', color: '#FFB800', fontWeight: 700 },
  notifBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#1a1a1a', borderRadius: 8, padding: '10px 12px', marginTop: 'auto', fontSize: 13, color: '#fff', border: '1px solid #333' },
  main: { flex: 1, overflow: 'auto' },
  page: { padding: 28, maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
  h1: { fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -0.5 },
  h2: { fontSize: 18, fontWeight: 700, margin: 0 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 },
  statCard: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 },
  statVal: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  statLabel: { fontSize: 12, color: '#888' },
  agentGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  agentCard: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 16, display: 'flex', alignItems: 'center', gap: 12 },
  table: { background: '#111', border: '1px solid #222', borderRadius: 10, overflow: 'hidden' },
  thead: { display: 'grid', padding: '10px 16px', background: '#1a1a1a', borderBottom: '1px solid #222', fontSize: 12, fontWeight: 700, color: '#888', textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  trow: { display: 'grid', padding: '12px 16px', borderBottom: '1px solid #1a1a1a', alignItems: 'center', fontSize: 14 },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 },
  projCard: { background: '#111', border: '1px solid #222', borderRadius: 12, padding: 20 },
  syncBtn: { background: '#1a1a1a', border: '1px solid #333', color: '#FFB800', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  costRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #1a1a1a' },
  barTrack: { flex: 1, height: 8, background: '#1a1a1a', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', background: '#FFB800', borderRadius: 4, transition: 'width 0.3s' },
  notifRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: '#111', borderRadius: 10, border: '1px solid #222' },
  commsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 },
  commsCard: { background: '#111', border: '1px solid #222', borderRadius: 12, padding: 20 },
}
