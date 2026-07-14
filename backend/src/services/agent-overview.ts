// Epic AG / AG2 — per-agent Dashboard tab data, as pure functions.
//
// The route hands raw `agent_runs` + `tasks` rows to `buildAgentOverview` and
// returns the result verbatim, so every aggregation below is unit-testable with
// no DB. Nothing here queries or mutates.
//
// Colorblind-safety note: this layer never picks colors — it returns counts
// keyed by status/priority and the UI maps them through the design-system status
// table (icon + label + color, never color alone).

export type Ts = number | string | Date | null | undefined

export interface RunLite {
  id: string
  status: string // running | done | failed | orphaned
  taskId?: string | null
  logs?: unknown // JSON array of { t, msg } — the last entry is the run summary
  tokensUsed?: number | null
  costUsd?: number | null
  startedAt?: Ts
  endedAt?: Ts
}

export interface TaskLite {
  id: string
  title: string
  status: string
  priority?: string | null
  createdAt?: Ts
  tokensUsed?: number | null
  costUsd?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cachedTokens?: number | null
}

export const OVERVIEW_DAYS = 14

/** Milliseconds since epoch, or null when the value is absent/unparseable. */
export function toMs(v: Ts): number | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null // tolerate seconds
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** UTC day key (YYYY-MM-DD) for a timestamp. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The `days` UTC day keys ending today, oldest first. */
export function dayKeys(now: number, days: number = OVERVIEW_DAYS): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(now - i * 86_400_000))
  return out
}

const isSuccess = (status: string) => status === 'done'
const isFailure = (status: string) => status === 'failed' || status === 'orphaned'

/** Runs per day over the window: total, succeeded, failed (failed includes orphaned). */
export function runActivity(runs: RunLite[], now: number, days: number = OVERVIEW_DAYS) {
  const keys = dayKeys(now, days)
  const index = new Map(keys.map(k => [k, { date: k, total: 0, succeeded: 0, failed: 0 }]))
  for (const r of runs) {
    const ms = toMs(r.startedAt)
    if (ms == null) continue
    const bucket = index.get(dayKey(ms))
    if (!bucket) continue // outside the window
    bucket.total++
    if (isSuccess(r.status)) bucket.succeeded++
    else if (isFailure(r.status)) bucket.failed++
  }
  return keys.map(k => index.get(k)!)
}

/**
 * Success rate per day: succeeded / (succeeded + failed). `pct` is null on a day
 * with no *settled* run — an empty day is "no data", not 0%, and the UI must
 * render the gap rather than a zero bar.
 */
export function successRate(runs: RunLite[], now: number, days: number = OVERVIEW_DAYS) {
  return runActivity(runs, now, days).map(d => {
    const settled = d.succeeded + d.failed
    return { date: d.date, pct: settled === 0 ? null : Math.round((d.succeeded / settled) * 100), settled }
  })
}

/** Counts keyed by a field, descending by count then key (stable output order). */
export function countBy<T>(items: T[], pick: (item: T) => string | null | undefined, fallback = 'unknown') {
  const counts = new Map<string, number>()
  for (const it of items) {
    const k = pick(it) || fallback
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/**
 * Token + cost totals for the Costs strip. The input/output/cached split is
 * persisted per task from AG2 onward; tasks that predate it carry only the
 * summed `tokensUsed`, so `totalTokens` stays truthful while the split reads 0.
 */
export function costTotals(tasks: TaskLite[]) {
  let inputTokens = 0, outputTokens = 0, cachedTokens = 0, totalTokens = 0, totalCostUsd = 0
  for (const t of tasks) {
    inputTokens += t.inputTokens ?? 0
    outputTokens += t.outputTokens ?? 0
    cachedTokens += t.cachedTokens ?? 0
    totalTokens += t.tokensUsed ?? 0
    totalCostUsd += t.costUsd ?? 0
  }
  return {
    inputTokens, outputTokens, cachedTokens, totalTokens,
    // Float noise (0.1 + 0.2) has no business in a money field.
    totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
    taskCount: tasks.length,
    /** False when no task carries the split — the UI shows "—" instead of a fake 0. */
    hasSplit: inputTokens + outputTokens + cachedTokens > 0,
  }
}

/** One-line summary of a run: its last log line, else its status. */
export function runSummary(run: RunLite, maxLen = 240): string {
  let logs: unknown = run.logs
  if (typeof logs === 'string') { try { logs = JSON.parse(logs) } catch { logs = null } }
  const last = Array.isArray(logs) ? [...logs].reverse().find(l => typeof (l as any)?.msg === 'string' && (l as any).msg.trim()) : null
  const msg = last ? String((last as any).msg).trim() : ''
  const text = msg || `Run ${run.status}.`
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
}

/** Newest run by startedAt (undated runs sort last). */
export function latestRun(runs: RunLite[]): RunLite | null {
  let best: RunLite | null = null
  let bestMs = -Infinity
  for (const r of runs) {
    const ms = toMs(r.startedAt) ?? -Infinity
    if (ms > bestMs) { best = r; bestMs = ms }
  }
  return best
}

export interface AgentOverview {
  agentId: string
  days: number
  generatedAt: string
  latestRun: { id: string; status: string; taskId: string | null; summary: string; startedAt: number | null; endedAt: number | null } | null
  runActivity: { date: string; total: number; succeeded: number; failed: number }[]
  successRate: { date: string; pct: number | null; settled: number }[]
  tasksByPriority: { key: string; count: number }[]
  tasksByStatus: { key: string; count: number }[]
  recentTasks: { id: string; title: string; status: string; priority: string; createdAt: number | null }[]
  costs: ReturnType<typeof costTotals>
}

/**
 * The whole Dashboard-tab payload. `tasks` are the agent's tasks (newest first
 * is not assumed — we sort); `runs` are the agent's runs. Both are already
 * org-scoped by the caller.
 */
export function buildAgentOverview(input: {
  agentId: string
  runs: RunLite[]
  tasks: TaskLite[]
  now: number
  days?: number
  recentLimit?: number
}): AgentOverview {
  const { agentId, runs, tasks, now } = input
  const days = input.days ?? OVERVIEW_DAYS
  const recentLimit = input.recentLimit ?? 6

  const newest = latestRun(runs)
  const byNewest = [...tasks].sort((a, b) => (toMs(b.createdAt) ?? 0) - (toMs(a.createdAt) ?? 0))

  return {
    agentId,
    days,
    generatedAt: new Date(now).toISOString(),
    latestRun: newest ? {
      id: newest.id,
      status: newest.status,
      taskId: newest.taskId ?? null,
      summary: runSummary(newest),
      startedAt: toMs(newest.startedAt),
      endedAt: toMs(newest.endedAt),
    } : null,
    runActivity: runActivity(runs, now, days),
    successRate: successRate(runs, now, days),
    tasksByPriority: countBy(tasks, t => t.priority, 'medium'),
    tasksByStatus: countBy(tasks, t => t.status, 'pending'),
    recentTasks: byNewest.slice(0, recentLimit).map(t => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority || 'medium', createdAt: toMs(t.createdAt),
    })),
    costs: costTotals(tasks),
  }
}
