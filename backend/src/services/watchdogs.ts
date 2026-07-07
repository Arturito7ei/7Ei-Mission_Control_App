// MCA-83 W4 — task watchdogs. Declarative checks a user attaches to a task
// ("alert me if this run passes 30m", "if it costs more than $0.50", "if it goes
// idle", "if it hits blocked"). Evaluated on the scheduler tick; a check flipping
// state posts a system-notice comment to the ticket thread, so the operator stops
// babysitting long runs and gets told when something needs a look.
//
// Design notes:
//  - Pure helpers (parse/describe/evaluate/transition) are unit-tested; the sweep
//    at the bottom applies them against the DB (mirrors heartbeat-engine.ts).
//  - EDGE-TRIGGERED: `state` is ok|triggered and a notice fires only on a flip, so
//    a task that sits over-threshold for an hour posts once, not sixty times. The
//    teardown of a competitor's instance showed the opposite (activity log drowned
//    in per-tick spam) — this is the deliberate correction.
//  - No new failure store: watchdog notices are ordinary `system_notice` comments,
//    so they render in the thread and feed the W1 recovery card's evidence for free.

import { db, schema } from '../db/client'
import { eq, and, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'

export type WatchdogKind = 'runtime' | 'cost' | 'no_activity' | 'status'
export const WATCHDOG_KINDS: WatchdogKind[] = ['runtime', 'cost', 'no_activity', 'status']

// Statuses a `status` watchdog may watch for. Kept to the ones an operator would
// actually alert on — transient/in-flight states aren't useful targets.
export const WATCHABLE_STATUSES = ['blocked', 'failed', 'done', 'in_progress'] as const

export interface WatchdogSpec { kind: WatchdogKind; threshold: string }

/**
 * Validate + normalize a create request into a stored spec. Throws on bad input
 * (the route turns the throw into a 400). Numeric thresholds are stored as a
 * canonical string; the status threshold is lowercased against the allowlist.
 */
export function parseWatchdogSpec(input: { kind?: unknown; threshold?: unknown }): WatchdogSpec {
  const kind = String(input.kind ?? '') as WatchdogKind
  if (!WATCHDOG_KINDS.includes(kind)) throw new Error(`unknown watchdog kind: ${input.kind}`)

  if (kind === 'status') {
    const s = String(input.threshold ?? '').trim().toLowerCase()
    if (!(WATCHABLE_STATUSES as readonly string[]).includes(s))
      throw new Error(`status watchdog must target one of: ${WATCHABLE_STATUSES.join(', ')}`)
    return { kind, threshold: s }
  }

  const n = Number(input.threshold)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${kind} watchdog needs a positive threshold`)
  // Runtime/idle are whole minutes; cost keeps cents.
  const threshold = kind === 'cost' ? String(n) : String(Math.round(n))
  return { kind, threshold }
}

/** Short human label for the UI + notice text. */
export function describeWatchdog(w: WatchdogSpec): string {
  switch (w.kind) {
    case 'runtime': return `Runtime over ${w.threshold}m`
    case 'cost': return `Cost over $${w.threshold}`
    case 'no_activity': return `Idle over ${w.threshold}m`
    case 'status': return `Status is ${w.threshold}`
  }
}

export interface WatchdogContext {
  status: string
  runningRunStartedMs: number | null   // startedAt of an in-flight run, else null
  costUsd: number | null               // task's own cost so far
  lastActivityMs: number | null        // newest of created/run/comment activity
}

export interface WatchdogEval { triggered: boolean; message: string }

const mins = (deltaMs: number) => Math.floor(deltaMs / 60_000)

/**
 * Evaluate one watchdog against a task's current context. Pure; `nowMs` is passed
 * so tests are deterministic. `message` is only meaningful when `triggered`.
 */
export function evaluateWatchdog(w: WatchdogSpec, ctx: WatchdogContext, nowMs: number): WatchdogEval {
  switch (w.kind) {
    case 'runtime': {
      const limit = Number(w.threshold)
      if (ctx.runningRunStartedMs == null) return { triggered: false, message: '' }
      const elapsed = mins(nowMs - ctx.runningRunStartedMs)
      return elapsed > limit
        ? { triggered: true, message: `run has been active ${elapsed}m (limit ${limit}m)` }
        : { triggered: false, message: '' }
    }
    case 'cost': {
      const limit = Number(w.threshold)
      if (ctx.costUsd == null) return { triggered: false, message: '' }
      return ctx.costUsd > limit
        ? { triggered: true, message: `task cost $${ctx.costUsd.toFixed(4)} exceeds $${limit}` }
        : { triggered: false, message: '' }
    }
    case 'no_activity': {
      const limit = Number(w.threshold)
      // A finished task is meant to be idle — never alert on it.
      if (ctx.status === 'done') return { triggered: false, message: '' }
      if (ctx.lastActivityMs == null) return { triggered: false, message: '' }
      const idle = mins(nowMs - ctx.lastActivityMs)
      return idle > limit
        ? { triggered: true, message: `no activity for ${idle}m (limit ${limit}m)` }
        : { triggered: false, message: '' }
    }
    case 'status': {
      return ctx.status === w.threshold
        ? { triggered: true, message: `task reached status "${w.threshold}"` }
        : { triggered: false, message: '' }
    }
  }
}

export interface WatchdogTransition { post: boolean; newState: 'ok' | 'triggered'; notice: string | null }

/**
 * Given the watchdog's stored state and a fresh evaluation, decide the new state
 * and whether to post a thread notice. Edge-triggered: post only on a flip.
 * `label` (describeWatchdog) names the check in the "cleared" notice, where the
 * eval carries no message.
 */
export function watchdogTransition(prevState: string | null | undefined, ev: WatchdogEval, label: string): WatchdogTransition {
  const newState: 'ok' | 'triggered' = ev.triggered ? 'triggered' : 'ok'
  if (newState === (prevState ?? 'ok')) return { post: false, newState, notice: null }
  const notice = ev.triggered
    ? `⚠ Watchdog triggered — ${ev.message}.`
    : `✓ Watchdog cleared — ${label}.`
  return { post: true, newState, notice }
}

// ─── Sweep ─────────────────────────────────────────────────────────────────────
// Loads enabled watchdogs, builds each task's context once, evaluates every check
// on it, and on a state flip updates the row + posts a system-notice comment.

const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(String(d ?? '')) || 0

export interface WatchdogSweepResult { evaluated: number; posted: number }

export async function runWatchdogSweep(orgId?: string): Promise<WatchdogSweepResult> {
  const now = Date.now()
  const res: WatchdogSweepResult = { evaluated: 0, posted: 0 }

  const watchdogs = await (orgId
    ? db.select().from(schema.taskWatchdogs).where(and(eq(schema.taskWatchdogs.enabled, true), eq(schema.taskWatchdogs.orgId, orgId)))
    : db.select().from(schema.taskWatchdogs).where(eq(schema.taskWatchdogs.enabled, true)))
  if (watchdogs.length === 0) return res

  // Group by task so each task's context is built once, however many checks it has.
  const byTask = new Map<string, typeof watchdogs>()
  for (const w of watchdogs) {
    const arr = byTask.get(w.taskId) ?? []
    arr.push(w)
    byTask.set(w.taskId, arr)
  }

  const taskIds = [...byTask.keys()]
  const tasks = await db.select().from(schema.tasks).where(inArray(schema.tasks.id, taskIds))
  const taskById = new Map(tasks.map(t => [t.id, t]))

  for (const [taskId, checks] of byTask) {
    const task = taskById.get(taskId)
    if (!task) {
      // Task was deleted out from under the watchdogs — retire them so the sweep
      // stops scanning a dangling id.
      await db.update(schema.taskWatchdogs).set({ enabled: false }).where(eq(schema.taskWatchdogs.taskId, taskId)).catch(() => {})
      continue
    }

    const ctx = await buildWatchdogContext(task, now)

    for (const w of checks) {
      res.evaluated++
      const spec: WatchdogSpec = { kind: w.kind as WatchdogKind, threshold: w.threshold }
      const ev = evaluateWatchdog(spec, ctx, now)
      const tr = watchdogTransition(w.state, ev, describeWatchdog(spec))

      const patch: Record<string, unknown> = { state: tr.newState, lastEvaluatedAt: new Date(now) }
      if (tr.newState === 'triggered' && w.state !== 'triggered') patch.triggeredAt = new Date(now)
      if (ev.triggered) patch.lastMessage = ev.message
      await db.update(schema.taskWatchdogs).set(patch as any).where(eq(schema.taskWatchdogs.id, w.id))

      if (tr.post && tr.notice) {
        await db.insert(schema.taskComments).values({
          id: randomUUID(), orgId: task.orgId, taskId, authorAgentId: null, authorUser: null,
          kind: 'system_notice', body: tr.notice, createdAt: new Date(),
        }).then(() => { res.posted++ }).catch(() => {})
      }
    }
  }
  return res
}

async function buildWatchdogContext(task: typeof schema.tasks.$inferSelect, now: number): Promise<WatchdogContext> {
  const [runs, comments] = await Promise.all([
    db.select({ status: schema.agentRuns.status, startedAt: schema.agentRuns.startedAt, updatedAt: schema.agentRuns.updatedAt, endedAt: schema.agentRuns.endedAt })
      .from(schema.agentRuns).where(eq(schema.agentRuns.taskId, task.id)),
    db.select({ kind: schema.taskComments.kind, createdAt: schema.taskComments.createdAt }).from(schema.taskComments).where(eq(schema.taskComments.taskId, task.id)),
  ])

  const runningRunStartedMs = runs
    .filter(r => r.status === 'running')
    .reduce<number | null>((acc, r) => Math.max(acc ?? 0, ms(r.startedAt)) || null, null)

  // Only real progress counts as activity — runs and human/agent comments. A
  // system-notice (incl. this watchdog's own) is bookkeeping, not progress; if it
  // counted, a no_activity watchdog would post "triggered" then immediately
  // "cleared" on the next tick (its notice resetting the idle clock).
  const activity = [
    ms(task.createdAt), ms(task.completedAt),
    ...runs.flatMap(r => [ms(r.startedAt), ms(r.updatedAt), ms(r.endedAt)]),
    ...comments.filter(c => c.kind !== 'system_notice').map(c => ms(c.createdAt)),
  ].filter(n => n > 0)
  const lastActivityMs = activity.length ? Math.max(...activity) : null

  return { status: task.status, runningRunStartedMs, costUsd: task.costUsd ?? null, lastActivityMs }
}
