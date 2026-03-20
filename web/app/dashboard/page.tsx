'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

async function apiFetch<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error('Request failed')
  return res.json()
}

type Org = { id: string; name: string; description?: string }
type Agent = { id: string; name: string; role: string; status: string; avatarEmoji: string; agentType: string }
type Task = { id: string; title: string; status: string; costUsd?: number; tokensUsed?: number; createdAt: string }

const STATUS_COLORS: Record<string, string> = { idle: '#555', active: '#22c55e', paused: '#f59e0b', stopped: '#ef4444', pending: '#555', in_progress: '#3b82f6', done: '#22c55e', blocked: '#ef4444' }

export default function DashboardPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const router = useRouter()
  const [orgs, setOrgs] = useState<Org[]>([])
  const [currentOrg, setCurrentOrg] = useState<Org | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [tab, setTab] = useState<'overview' | 'agents' | 'tasks' | 'costs'>('overview')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) { router.push('/'); return }
    loadData()
  }, [isLoaded, isSignedIn])

  const loadData = async () => {
    const token = await getToken()
    try {
      const { orgs: orgList } = await apiFetch<{ orgs: Org[] }>('/api/orgs', token)
      setOrgs(orgList)
      if (orgList.length > 0) {
        const org = orgList[0]
        setCurrentOrg(org)
        const [agentData, taskData] = await Promise.all([
          apiFetch<{ agents: Agent[] }>(`/api/orgs/${org.id}/agents`, token),
          apiFetch<{ tasks: Task[] }>(`/api/orgs/${org.id}/tasks`, token),
        ])
        setAgents(agentData.agents)
        setTasks(taskData.tasks)
      }
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  if (loading) return <div style={s.loadingScreen}><div style={s.spinner}>⚡</div><p style={{ color: '#888' }}>Loading...</p></div>
  if (!currentOrg) return (
    <div style={s.emptyScreen}>
      <span style={{ fontSize: 64 }}>🏢</span>
      <h2>No organisation yet</h2>
      <p style={{ color: '#888' }}>Create your first org in the mobile app, then come back here.</p>
    </div>
  )

  const activeAgents = agents.filter(a => a.status === 'active')
  const totalCost = tasks.reduce((s, t) => s + (t.costUsd ?? 0), 0)

  return (
    <div style={s.layout}>
      {/* Sidebar */}
      <aside style={s.sidebar}>
        <div style={s.logo}><span style={s.logoText}>7Ei</span></div>
        <div style={s.orgName}>{currentOrg.name}</div>
        {['overview', 'agents', 'tasks', 'costs'].map(t => (
          <button key={t} onClick={() => setTab(t as any)} style={{ ...s.navBtn, ...(tab === t ? s.navBtnActive : {}) }}>
            {t === 'overview' ? '🏠' : t === 'agents' ? '🤖' : t === 'tasks' ? '📋' : '💰'} {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </aside>

      {/* Main */}
      <main style={s.main}>
        {tab === 'overview' && (
          <div style={s.content}>
            <h1 style={s.pageTitle}>Mission Control</h1>
            <div style={s.statsGrid}>
              {[
                { label: 'Agents', val: agents.length, color: '#fff' },
                { label: 'Active', val: activeAgents.length, color: '#22c55e' },
                { label: 'Tasks', val: tasks.length, color: '#fff' },
                { label: 'Total Cost', val: `$${totalCost.toFixed(4)}`, color: '#FFB800' },
              ].map(stat => (
                <div key={stat.label} style={s.statCard}>
                  <span style={{ ...s.statVal, color: stat.color }}>{stat.val}</span>
                  <span style={s.statLabel}>{stat.label}</span>
                </div>
              ))}
            </div>
            <h2 style={s.sectionTitle}>Agent Squad</h2>
            <div style={s.agentGrid}>
              {agents.map(agent => (
                <div key={agent.id} style={s.agentCard}>
                  <span style={s.agentEmoji}>{agent.avatarEmoji}</span>
                  <div style={s.agentInfo}>
                    <div style={s.agentName}>{agent.name}</div>
                    <div style={s.agentRole}>{agent.role}</div>
                  </div>
                  <span style={{ ...s.statusDot, background: STATUS_COLORS[agent.status] ?? '#555' }} title={agent.status} />
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'agents' && (
          <div style={s.content}>
            <h1 style={s.pageTitle}>Agents ({agents.length})</h1>
            <div style={s.table}>
              <div style={s.tableHead}>
                <span>Agent</span><span>Role</span><span>Model</span><span>Status</span>
              </div>
              {agents.map(agent => (
                <div key={agent.id} style={s.tableRow}>
                  <span>{agent.avatarEmoji} {agent.name}</span>
                  <span style={{ color: '#888', fontSize: 13 }}>{agent.role}</span>
                  <span style={{ color: '#555', fontSize: 12 }}>claude</span>
                  <span style={{ color: STATUS_COLORS[agent.status], fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{agent.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'tasks' && (
          <div style={s.content}>
            <h1 style={s.pageTitle}>Task Log ({tasks.length})</h1>
            <div style={s.table}>
              <div style={s.tableHead}>
                <span>Task</span><span>Status</span><span>Cost</span><span>Tokens</span>
              </div>
              {tasks.map(task => (
                <div key={task.id} style={s.tableRow}>
                  <span style={{ fontSize: 13 }}>{task.title}</span>
                  <span style={{ color: STATUS_COLORS[task.status], fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{task.status}</span>
                  <span style={{ color: '#FFB800', fontSize: 12 }}>{task.costUsd != null ? `$${task.costUsd.toFixed(5)}` : '—'}</span>
                  <span style={{ color: '#888', fontSize: 12 }}>{task.tokensUsed?.toLocaleString() ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'costs' && (
          <div style={s.content}>
            <h1 style={s.pageTitle}>Cost Centre</h1>
            <div style={s.statsGrid}>
              <div style={s.statCard}>
                <span style={{ ...s.statVal, color: '#FFB800' }}>${totalCost.toFixed(4)}</span>
                <span style={s.statLabel}>Total spend</span>
              </div>
              <div style={s.statCard}>
                <span style={{ ...s.statVal, color: '#fff' }}>{tasks.reduce((s, t) => s + (t.tokensUsed ?? 0), 0).toLocaleString()}</span>
                <span style={s.statLabel}>Total tokens</span>
              </div>
            </div>
            <h2 style={s.sectionTitle}>By Agent</h2>
            {agents.map(agent => {
              const agentCost = tasks.filter(t => t.id === agent.id).reduce((s, t) => s + (t.costUsd ?? 0), 0)
              return (
                <div key={agent.id} style={s.costRow}>
                  <span>{agent.avatarEmoji} {agent.name}</span>
                  <div style={s.costBar}>
                    <div style={{ ...s.costFill, width: `${Math.min((agentCost / Math.max(totalCost, 0.0001)) * 100, 100)}%` }} />
                  </div>
                  <span style={{ color: '#FFB800', fontSize: 13, minWidth: 60, textAlign: 'right' }}>${agentCost.toFixed(4)}</span>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  loadingScreen: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16 },
  spinner: { fontSize: 48 },
  emptyScreen: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16 },
  layout: { display: 'flex', height: '100vh', overflow: 'hidden' },
  sidebar: { width: 220, background: '#111', borderRight: '1px solid #222', display: 'flex', flexDirection: 'column', padding: '16px 12px', gap: 4 },
  logo: { width: 44, height: 44, background: '#FFB800', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  logoText: { fontSize: 18, fontWeight: 800, color: '#000' },
  orgName: { fontSize: 14, fontWeight: 700, color: '#fff', padding: '8px 4px', borderBottom: '1px solid #222', marginBottom: 8 },
  navBtn: { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', color: '#888', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 500, width: '100%', textAlign: 'left' as const },
  navBtnActive: { background: '#1a1a1a', color: '#FFB800', fontWeight: 700 },
  main: { flex: 1, overflow: 'auto', background: '#0a0a0a' },
  content: { padding: 24, maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
  pageTitle: { fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -0.5 },
  sectionTitle: { fontSize: 18, fontWeight: 700, margin: 0 },
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 },
  statCard: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 },
  statVal: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  statLabel: { fontSize: 12, color: '#888' },
  agentGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  agentCard: { background: '#111', border: '1px solid #222', borderRadius: 10, padding: 16, display: 'flex', alignItems: 'center', gap: 12 },
  agentEmoji: { fontSize: 28 },
  agentInfo: { flex: 1 },
  agentName: { fontWeight: 700, fontSize: 14 },
  agentRole: { fontSize: 12, color: '#888', marginTop: 2 },
  statusDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  table: { background: '#111', border: '1px solid #222', borderRadius: 10, overflow: 'hidden' },
  tableHead: { display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr', padding: '10px 16px', background: '#1a1a1a', borderBottom: '1px solid #222', fontSize: 12, fontWeight: 700, color: '#888', textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  tableRow: { display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr', padding: '12px 16px', borderBottom: '1px solid #1a1a1a', alignItems: 'center', fontSize: 14 },
  costRow: { display: 'flex', alignItems: 'center', gap: 16, padding: '8px 0' },
  costBar: { flex: 1, height: 8, background: '#1a1a1a', borderRadius: 4, overflow: 'hidden' },
  costFill: { height: '100%', background: '#FFB800', borderRadius: 4 },
}