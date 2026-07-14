// Epic AG / AG7 — the Staff grid: one card per agent, as the operator's mockup
// shows them (avatar · name · handle · status dot · Tasks Active / Token Cost
// today / Last active).
//
// Pure: the route fetches agents + tasks and hands them over. Everything here is
// derived from data we already store — no new columns for the grid itself.

export type Ts = number | string | Date | null | undefined

export interface StaffAgent {
  id: string
  name: string
  role: string
  title?: string | null
  status: string                    // idle | active | paused | terminated
  heartbeatStatus?: string | null   // green | amber | stale | unknown
  avatarEmoji?: string | null
  avatarUrl?: string | null
  contactChannel?: string | null    // an email address, when the operator set one
  runtime?: string | null
  lastHeartbeatAt?: Ts
}

export interface StaffTask {
  agentId: string
  status: string
  costUsd?: number | null
  tokensUsed?: number | null
  createdAt?: Ts
  completedAt?: Ts
}

/**
 * The three states the grid dot can carry. Colour is NEVER the only signal — each
 * one ships a shape and a label, because the operator is red-green colorblind
 * (DESIGN_SYSTEM v2, colorblind rule 3).
 */
export type StaffState = 'running' | 'attention' | 'ok'

export interface StaffCard {
  id: string
  name: string
  role: string
  title: string | null
  handle: string
  avatarEmoji: string | null
  avatarUrl: string | null
  runtime: string | null
  status: string
  state: StaffState
  /** Human-readable reason for the state — the label rendered next to the dot. */
  stateLabel: string
  activeTasks: number
  costTodayUsd: number
  tokensToday: number
  lastActiveAt: number | null
}

const ACTIVE_TASK_STATES = new Set(['assigned', 'in_progress'])
const ATTENTION_TASK_STATES = new Set(['blocked', 'failed'])

export function toMs(v: Ts): number | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * The email/handle under the agent's name. Uses the contact channel when the
 * operator set a real email; otherwise a derived @handle — we do NOT invent an
 * email address that does not exist and cannot receive mail.
 */
export function staffHandle(agent: Pick<StaffAgent, 'name' | 'contactChannel'>): string {
  const channel = (agent.contactChannel ?? '').trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(channel)) return channel
  const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
  return `@${slug}`
}

/**
 * Which dot the card shows. Precedence: attention > running > ok — an agent that
 * is busy AND has a blocked task still needs a human, so the card must say so
 * rather than showing a reassuring "running".
 */
export function staffState(agent: StaffAgent, tasks: StaffTask[]): { state: StaffState; stateLabel: string } {
  if (agent.status === 'paused') return { state: 'attention', stateLabel: 'Paused' }
  if (agent.status === 'terminated') return { state: 'attention', stateLabel: 'Terminated' }
  if (agent.heartbeatStatus === 'stale') return { state: 'attention', stateLabel: 'Heartbeat stale' }
  if (tasks.some(t => ATTENTION_TASK_STATES.has(t.status))) return { state: 'attention', stateLabel: 'Needs attention' }
  if (agent.status === 'active' || tasks.some(t => t.status === 'in_progress')) return { state: 'running', stateLabel: 'Running' }
  return { state: 'ok', stateLabel: 'Idle' }
}

/** Cost + tokens booked today (UTC), by when the task finished (else when it was created). */
export function todaySpend(tasks: StaffTask[], now: number): { costTodayUsd: number; tokensToday: number } {
  const today = dayKey(now)
  let costTodayUsd = 0, tokensToday = 0
  for (const t of tasks) {
    const at = toMs(t.completedAt) ?? toMs(t.createdAt)
    if (at == null || dayKey(at) !== today) continue
    costTodayUsd += t.costUsd ?? 0
    tokensToday += t.tokensUsed ?? 0
  }
  return { costTodayUsd: Math.round(costTodayUsd * 1e6) / 1e6, tokensToday }
}

/** When this agent last did something: its heartbeat, or its most recent finished task. */
export function lastActive(agent: StaffAgent, tasks: StaffTask[]): number | null {
  const stamps = [toMs(agent.lastHeartbeatAt), ...tasks.map(t => toMs(t.completedAt))].filter((n): n is number => n != null)
  return stamps.length ? Math.max(...stamps) : null
}

export function buildStaffCards(input: { agents: StaffAgent[]; tasks: StaffTask[]; now: number }): StaffCard[] {
  const { agents, tasks, now } = input

  const byAgent = new Map<string, StaffTask[]>()
  for (const t of tasks) {
    const list = byAgent.get(t.agentId)
    if (list) list.push(t)
    else byAgent.set(t.agentId, [t])
  }

  return agents.map(a => {
    const mine = byAgent.get(a.id) ?? []
    const { state, stateLabel } = staffState(a, mine)
    const { costTodayUsd, tokensToday } = todaySpend(mine, now)
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      title: a.title ?? null,
      handle: staffHandle(a),
      avatarEmoji: a.avatarEmoji ?? null,
      avatarUrl: a.avatarUrl ?? null,
      runtime: a.runtime ?? null,
      status: a.status,
      state,
      stateLabel,
      activeTasks: mine.filter(t => ACTIVE_TASK_STATES.has(t.status)).length,
      costTodayUsd,
      tokensToday,
      lastActiveAt: lastActive(a, mine),
    }
  })
}
