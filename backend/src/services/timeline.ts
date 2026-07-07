// MCA-84 V1 — heartbeat 24h timeline. Pure projections that turn existing run
// telemetry + task timing into per-agent lanes of activity blocks over the last
// 24 hours, so you can see at a glance who has been working, when, and on what —
// the "heartbeat" of the office. No new store: external agents write agent_runs
// (authoritative start/end per session), internal agents record duration on the
// task itself; mergeActivity() reconciles the two so every wake shows up once.

export const TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000

// A block wide enough to stay visible even for a sub-second run (0.8% ≈ 11.5min).
export const MIN_BLOCK_PCT = 0.8

const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(String(d ?? '')) || 0
const num = (n: number | null | undefined): number => (typeof n === 'number' && isFinite(n) ? n : 0)

export interface TLRun {
  id: string
  agentId: string
  taskId?: string | null
  status: string                       // running | done | failed | orphaned
  startedAt: unknown
  endedAt?: unknown
  costUsd?: number | null
  tokensUsed?: number | null
}

export interface TLTask {
  id: string
  agentId: string
  title?: string | null
  status: string
  createdAt: unknown
  completedAt?: unknown
  durationMs?: number | null
  lockedAt?: unknown
  costUsd?: number | null
  tokensUsed?: number | null
}

export interface TLAgent {
  id: string
  name?: string | null
  avatarEmoji?: string | null
  status?: string | null
  heartbeat?: string | null            // green | amber | stale | unknown
  lastHeartbeatAt?: unknown
  nextWakeAt?: unknown
  heartbeatEverySec?: number | null
}

// A normalized unit of agent activity, before it is projected onto the window.
export interface Activity {
  runId: string | null
  taskId: string | null
  agentId: string
  title: string
  status: string
  startMs: number
  endMs: number
  ongoing: boolean
  costUsd: number
  tokensUsed: number
  source: 'run' | 'task'
}

// ─── normalization ───────────────────────────────────────────────────────────

/** A run → one activity block ([startedAt, endedAt] or open to now if running). */
export function runActivity(run: TLRun, task: TLTask | undefined, now: number): Activity {
  const startMs = ms(run.startedAt)
  const hasEnd = run.endedAt != null
  const ongoing = !hasEnd && run.status === 'running'
  const endMs = hasEnd ? ms(run.endedAt) : now
  return {
    runId: run.id,
    taskId: run.taskId ?? null,
    agentId: run.agentId,
    title: task?.title ?? '[Heartbeat]',
    status: ongoing ? 'running' : run.status,
    startMs,
    endMs: Math.max(endMs, startMs),
    ongoing,
    costUsd: num(run.costUsd),
    tokensUsed: num(run.tokensUsed),
    source: 'run',
  }
}

/**
 * A task with no run row (internal execution) → an activity block from its own
 * timing. Done tasks span [completedAt - durationMs, completedAt]; in-progress
 * runs open to now; failed tasks that never recorded an end get a marker at the
 * last timestamp we have. Tasks that never ran (pending/todo/assigned/blocked)
 * return null — they belong on the board, not the heartbeat.
 */
export function taskActivity(task: TLTask, now: number): Activity | null {
  const base = {
    runId: null,
    taskId: task.id,
    agentId: task.agentId,
    title: task.title ?? '(untitled)',
    costUsd: num(task.costUsd),
    tokensUsed: num(task.tokensUsed),
    source: 'task' as const,
  }
  const status = (task.status ?? '').toLowerCase()
  if (status === 'done') {
    const endMs = task.completedAt != null ? ms(task.completedAt) : ms(task.createdAt)
    const startMs = endMs - Math.max(0, num(task.durationMs))
    return { ...base, status: 'done', startMs, endMs, ongoing: false }
  }
  if (status === 'in_progress') {
    const startMs = task.lockedAt != null ? ms(task.lockedAt) : ms(task.createdAt)
    return { ...base, status: 'running', startMs, endMs: now, ongoing: true }
  }
  if (status === 'failed') {
    // No end recorded for internal failures — mark at the most recent timestamp.
    const endMs = task.completedAt != null ? ms(task.completedAt) : ms(task.createdAt)
    const startMs = endMs - Math.max(0, num(task.durationMs))
    return { ...base, status: 'failed', startMs, endMs, ongoing: false }
  }
  return null
}

/**
 * Reconcile runs and tasks into one activity list. Runs are authoritative, so a
 * task that already has run rows contributes none of its own blocks (external
 * agents write both); tasks without any run are projected from their own timing.
 */
export function mergeActivity(runs: TLRun[], tasks: TLTask[], now: number): Activity[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const tasksWithRuns = new Set(runs.map((r) => r.taskId).filter((x): x is string => !!x))
  const acts: Activity[] = runs.map((r) => runActivity(r, taskById.get(r.taskId ?? ''), now))
  for (const t of tasks) {
    if (tasksWithRuns.has(t.id)) continue
    const a = taskActivity(t, now)
    if (a) acts.push(a)
  }
  return acts
}

// ─── projection onto the window ───────────────────────────────────────────────

export interface TLBlock {
  runId: string | null
  taskId: string | null
  title: string
  status: string
  startPct: number                     // 0–100 across the window (left = oldest)
  widthPct: number
  startMs: number
  endMs: number | null                 // null while ongoing
  ongoing: boolean
  costUsd: number
  tokensUsed: number
}

export interface TLLane {
  agentId: string
  name: string
  avatarEmoji: string
  heartbeat: string
  status: string
  lastHeartbeatAt: number | null
  nextWakeAt: number | null
  blocks: TLBlock[]
  runCount: number
  totalCost: number
  activeMs: number                     // total time spent working in the window
}

export interface Timeline {
  now: number
  windowStart: number
  windowEnd: number
  windowMs: number
  lanes: TLLane[]
}

const tsMs = (d: unknown): number | null => {
  if (d == null) return null
  const v = ms(d)
  return v || null
}

/** Clip an activity to the window and express it as start/width percentages. */
function project(a: Activity, windowStart: number, now: number, windowMs: number): TLBlock | null {
  const end = a.ongoing ? now : a.endMs
  // Overlap test against [windowStart, now].
  if (end <= windowStart || a.startMs >= now) return null
  const s = Math.max(a.startMs, windowStart)
  const e = Math.min(end, now)
  const startPct = ((s - windowStart) / windowMs) * 100
  const rawWidth = ((e - s) / windowMs) * 100
  const widthPct = Math.min(Math.max(rawWidth, MIN_BLOCK_PCT), 100 - startPct)
  return {
    runId: a.runId,
    taskId: a.taskId,
    title: a.title,
    status: a.status,
    startPct,
    widthPct,
    startMs: a.startMs,
    endMs: a.ongoing ? null : a.endMs,
    ongoing: a.ongoing,
    costUsd: a.costUsd,
    tokensUsed: a.tokensUsed,
  }
}

/**
 * Build the 24h timeline: one lane per agent (idle agents included, so you see
 * who is *not* working too), each with its activity blocks projected onto the
 * window, oldest-first, plus per-lane run count / spend / active time.
 */
export function buildHeartbeatTimeline(
  agents: TLAgent[],
  activities: Activity[],
  now: number,
  windowMs: number = TIMELINE_WINDOW_MS,
): Timeline {
  const windowStart = now - windowMs
  const byAgent = new Map<string, Activity[]>()
  for (const a of activities) {
    if (!byAgent.has(a.agentId)) byAgent.set(a.agentId, [])
    byAgent.get(a.agentId)!.push(a)
  }
  const lanes: TLLane[] = agents.map((ag) => {
    const own = byAgent.get(ag.id) ?? []
    const blocks: TLBlock[] = []
    let activeMs = 0
    let totalCost = 0
    for (const a of own) {
      const b = project(a, windowStart, now, windowMs)
      if (!b) continue
      blocks.push(b)
      const end = a.ongoing ? now : a.endMs
      activeMs += Math.min(end, now) - Math.max(a.startMs, windowStart)
      totalCost += a.costUsd
    }
    blocks.sort((x, y) => x.startMs - y.startMs)
    return {
      agentId: ag.id,
      name: ag.name ?? ag.id,
      avatarEmoji: ag.avatarEmoji ?? '🤖',
      heartbeat: ag.heartbeat ?? 'unknown',
      status: ag.status ?? 'idle',
      lastHeartbeatAt: tsMs(ag.lastHeartbeatAt),
      nextWakeAt: tsMs(ag.nextWakeAt),
      blocks,
      runCount: blocks.length,
      totalCost,
      activeMs: Math.max(0, activeMs),
    }
  })
  return { now, windowStart, windowEnd: now, windowMs, lanes }
}
