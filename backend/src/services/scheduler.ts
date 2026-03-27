// ─── Scheduled Tasks Engine ──────────────────────────────────────────────────────
// Cron-based agent task execution.
// Uses a simple interval tick (no external cron library dependency).
// Cron parsing: supports standard 5-field cron expressions.
// Example: '0 9 * * 1-5'  = weekdays at 9am
//          '*/30 * * * *'  = every 30 minutes
//          '0 8 * * 1'     = every Monday at 8am

import { db, schema } from '../db/client'
import { eq, and, lte } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { executeAgentTask } from './agent-executor'
import { sendPushNotification } from '../routes/notifications'

const TICK_INTERVAL_MS = 60_000  // check every minute
let schedulerTimer: NodeJS.Timeout | null = null

export function startScheduler() {
  if (schedulerTimer) return
  console.log('⏰ Scheduler started (1-minute tick)')
  schedulerTimer = setInterval(runDueTasks, TICK_INTERVAL_MS)
  // Also run immediately on startup to catch missed tasks
  runDueTasks().catch(err => console.error('Scheduler startup error:', err))
}

export function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null }
}

async function runDueTasks() {
  const now = new Date()
  try {
    const due = await db.select().from(schema.scheduledTasks)
      .where(and(
        eq(schema.scheduledTasks.enabled, true),
        lte(schema.scheduledTasks.nextRunAt as any, now),
      ))

    for (const scheduled of due) {
      // Don't await — run concurrently but track errors
      runScheduledTask(scheduled, now).catch(err =>
        console.error(`Scheduled task ${scheduled.id} failed:`, err)
      )
    }
  } catch (err) {
    console.error('Scheduler tick error:', err)
  }
}

async function runScheduledTask(scheduled: any, triggerTime: Date) {
  const taskId = randomUUID()

  // Create a task record
  await db.insert(schema.tasks).values({
    id: taskId,
    orgId: scheduled.orgId,
    agentId: scheduled.agentId,
    title: `[Scheduled] ${scheduled.title}`,
    input: scheduled.input ?? scheduled.title,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date(),
  })

  // Execute
  try {
    await executeAgentTask({ agentId: scheduled.agentId, taskId, input: scheduled.input ?? scheduled.title })
  } catch (err) {
    console.error(`Scheduled execution failed for ${scheduled.id}:`, err)
  }

  // Notify org owner
  const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, scheduled.orgId) })
  if (org?.ownerId) {
    sendPushNotification(org.ownerId, `Scheduled task ran: ${scheduled.title}`, `Agent completed the scheduled task`, { taskId, scheduledId: scheduled.id }).catch(() => {})
  }

  // Update last/next run
  const nextRun = calcNextRun(scheduled.cronExpression)
  await db.update(schema.scheduledTasks).set({
    lastRunAt: triggerTime,
    nextRunAt: nextRun,
  }).where(eq(schema.scheduledTasks.id, scheduled.id))
}

// ─ Minimal cron parser ───────────────────────────────────────────────────────
// Parses a 5-field cron and returns the next trigger Date

export function calcNextRun(cron: string, _timezone = 'UTC'): Date {
  const now = new Date()
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    // Default: next minute
    return new Date(now.getTime() + 60_000)
  }
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts

  // Search forward up to 2 years (to avoid infinite loop on bad cron)
  const candidate = new Date(now.getTime() + 60_000)
  candidate.setSeconds(0, 0)

  for (let i = 0; i < 525_600; i++) {  // 525_600 minutes = 1 year
    const min  = candidate.getMinutes()
    const hour = candidate.getHours()
    const dom  = candidate.getDate()
    const mon  = candidate.getMonth() + 1
    const dow  = candidate.getDay()

    if (
      matchCronField(minExpr,  min,  0,  59) &&
      matchCronField(hourExpr, hour, 0,  23) &&
      matchCronField(domExpr,  dom,  1,  31) &&
      matchCronField(monExpr,  mon,  1,  12) &&
      matchCronField(dowExpr,  dow,  0,   6)
    ) {
      return candidate
    }
    candidate.setTime(candidate.getTime() + 60_000)
  }

  return new Date(now.getTime() + 86_400_000) // fallback: +1 day
}

export function matchCronField(expr: string, value: number, min: number, max: number): boolean {
  if (expr === '*') return true

  // */n — every n units
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2))
    return value % step === 0
  }

  // Comma-separated list
  if (expr.includes(',')) {
    return expr.split(',').some(e => matchCronField(e.trim(), value, min, max))
  }

  // Range: a-b or a-b/step
  if (expr.includes('-')) {
    const [range, step] = expr.split('/')
    const [lo, hi] = range.split('-').map(Number)
    if (step) {
      const s = parseInt(step)
      for (let v = lo; v <= hi; v += s) if (v === value) return true
      return false
    }
    return value >= lo && value <= hi
  }

  return parseInt(expr) === value
}
