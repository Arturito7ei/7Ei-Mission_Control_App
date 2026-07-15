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
import { sendPushNotification } from './push'
import { runHeartbeatSweep } from './heartbeat-engine'
import { runWatchdogSweep } from './watchdogs'
import {
  resolveVaultForOrg, formatKvExport, appendSection,
  agentKvPath, agentRecentPath, agentArchiveRecentPath, agentLessonsPath, slugifyAgentName,
} from './agent-memory'
import { vaultRead, vaultWrite } from './vault-connector'
import {
  parseSessionBlocks, partitionByAge, rebuildRecent, buildArchiveAppend,
  countLessonEntries, isOrchestratorRole, buildConsolidationReport,
} from './consolidation'
import { isExternalAgent } from './agent-runtime'
import { auditRetentionDue, auditRetentionDays, pruneAuditLogs } from './audit-retention'
import type { MemoryEntry } from './memory'

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
    // MCA-PC C1: heartbeat engine sweep (orphan recovery, status recompute, wakes).
    runHeartbeatSweep().catch(err => console.error('Heartbeat sweep error:', err))
    // MCA-83 W4: task watchdogs — evaluate declarative per-task checks, post
    // in-thread notices on a state flip. Never blocks the tick.
    runWatchdogSweep().catch(err => console.error('Watchdog sweep error:', err))
    // MCA-75: nightly memory KV export (once per day, on the 03:00 UTC tick).
    maybeRunNightlyKvExport(now).catch(err => console.error('KV export error:', err))
    // MCA-76: weekly memory consolidation (Sundays at/after 04:00 UTC, once per day).
    maybeRunWeeklyConsolidation(now).catch(err => console.error('Weekly consolidation error:', err))
    // Epic ONB / audit H-1: prune audit_logs older than the retention window
    // (default 90d) once per UTC day. Bounds the now-live trail's storage growth.
    maybeRunAuditRetention(now).catch(err => console.error('Audit retention error:', err))
  } catch (err) {
    console.error('Scheduler tick error:', err)
  }
}

async function runScheduledTask(scheduled: any, triggerTime: Date) {
  await fireRoutine(scheduled, triggerTime)
}

// MCA-75: nightly memory KV export — mirror each agent's DB memory (memoryLongTerm)
// into the vault at Memory/agents/<slug>/kv.md. Runs on the first scheduler tick
// at or after KV_EXPORT_HOUR_UTC, at most once per UTC day. Writes are
// unconditional: the generated-at line changes nightly anyway, and vaultWrite
// already does the sha-lookup read — a compare read would only double the GETs.
const KV_EXPORT_HOUR_UTC = 3
let lastKvExportDay: string | null = null

export async function maybeRunNightlyKvExport(now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10)
  if (now.getUTCHours() !== KV_EXPORT_HOUR_UTC || lastKvExportDay === day) return
  lastKvExportDay = day
  const orgs = await db.select({ id: schema.organisations.id }).from(schema.organisations)
  for (const org of orgs) {
    const { token, cfg } = await resolveVaultForOrg(org.id)
    if (!token) continue
    const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, org.id))
    for (const agent of agents) {
      const memory = (agent.memoryLongTerm ?? {}) as Record<string, MemoryEntry>
      const entries = Object.values(memory)
      if (entries.length === 0) continue
      const kvs = entries.map(e => ({ key: e.key, value: e.value, updatedAt: e.updatedAt ? new Date(e.updatedAt) : null }))
      // Fire-and-forget per agent — one bad write must not sink the sweep.
      vaultWrite(token, cfg, agentKvPath(agent.name, cfg.root), formatKvExport(agent.name, kvs),
        `mc(system): nightly memory KV export ${day}`, { name: 'Mission Control (7Ei system)', email: 'agents@7ei.ai' })
        .catch(err => console.warn(`KV export failed for ${agent.name} (non-critical):`, err))
    }
  }
}

// MCA-76: weekly memory consolidation — prune session blocks strictly older than
// 7 days from each agent's recent.md into archive-recent.md, then hand the org's
// orchestrator one review task quoting the Memory-Protocol promotion rules.
// Runs on the first scheduler tick at/after CONSOLIDATION_HOUR_UTC on Sundays,
// at most once per UTC day. Per-org work never breaks the scheduler tick.
const CONSOLIDATION_DOW_UTC = 0   // Sunday
const CONSOLIDATION_HOUR_UTC = 4
const LESSON_REVIEW_THRESHOLD = 5
let lastConsolidationDay: string | null = null

export async function maybeRunWeeklyConsolidation(now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10)
  if (now.getUTCDay() !== CONSOLIDATION_DOW_UTC || now.getUTCHours() < CONSOLIDATION_HOUR_UTC || lastConsolidationDay === day) return
  lastConsolidationDay = day
  const orgs = await db.select({ id: schema.organisations.id, name: schema.organisations.name }).from(schema.organisations)
  for (const org of orgs) {
    try {
      await consolidateOrgMemory(org, now, day)
    } catch (err) {
      console.warn(`Weekly consolidation failed for org ${org.id} (non-critical):`, err)
    }
  }
}

async function consolidateOrgMemory(org: { id: string; name: string | null }, now: Date, day: string): Promise<void> {
  const { token, cfg } = await resolveVaultForOrg(org.id)
  if (!token) return
  const committer = { name: 'Mission Control (7Ei system)', email: 'agents@7ei.ai' }
  const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, org.id))
  const perAgent: Array<{ agent: string; archivedCount: number; keptCount: number; lessonCount: number }> = []

  for (const agent of agents) {
    const slug = slugifyAgentName(agent.name)
    const recent = await vaultRead(token, cfg, agentRecentPath(agent.name, cfg.root))
    if (!recent.ok) continue   // no recent.md yet → nothing to consolidate
    const { preamble, blocks } = parseSessionBlocks(recent.markdown ?? '')
    const { keep, stale } = partitionByAge(blocks, now)
    const lessons = await vaultRead(token, cfg, agentLessonsPath(agent.name, cfg.root))
    const lessonCount = lessons.ok ? countLessonEntries(lessons.markdown ?? '') : 0

    if (stale.length > 0) {
      const pruned = await vaultWrite(token, cfg, agentRecentPath(agent.name, cfg.root),
        rebuildRecent(preamble, keep), `mc(system): weekly consolidation — prune ${slug} recent.md ${day}`, committer)
      if (pruned.ok) {
        // Prune commit landed (recoverable from git history) → append to the archive.
        const archivePath = agentArchiveRecentPath(agent.name, cfg.root)
        const existing = await vaultRead(token, cfg, archivePath)
        const archived = await vaultWrite(token, cfg, archivePath,
          appendSection(existing.ok ? existing.markdown : undefined, buildArchiveAppend(stale, now)),
          `mc(system): weekly consolidation — archive ${slug} ${day}`, committer)
        if (!archived.ok) console.warn(`Weekly consolidation: archive write failed for ${slug} (${archived.status}) — blocks remain in git history`)
      } else {
        console.warn(`Weekly consolidation: prune write failed for ${slug} (${pruned.status}) — skipping archive`)
      }
    }
    perAgent.push({ agent: slug, archivedCount: stale.length, keptCount: keep.length, lessonCount })
  }

  const needsReview = perAgent.some(a => a.archivedCount > 0 || a.lessonCount >= LESSON_REVIEW_THRESHOLD)
  if (!needsReview) return
  const orchestrator = agents.find(a => isOrchestratorRole(a.role))
  if (!orchestrator) {
    console.warn(`Weekly consolidation: org ${org.id} has no orchestrator agent — skipping review task`)
    return
  }
  const external = isExternalAgent(orchestrator)
  await db.insert(schema.tasks).values({
    id: randomUUID(), orgId: org.id, agentId: orchestrator.id, assignedTo: orchestrator.id,
    title: `Weekly memory consolidation ${day}`,
    input: buildConsolidationReport({ orgName: org.name ?? undefined, date: day, perAgent }),
    status: external ? 'assigned' : 'pending', priority: 'medium',
    kanbanColumn: external ? 'in_progress' : 'todo', createdAt: new Date(),
  } as any)
}

// Epic ONB / audit H-1: audit-log retention. Runs on the first scheduler tick at or
// after AUDIT_RETENTION_HOUR_UTC each day, at most once per UTC day (same shape as the
// KV export / consolidation sweeps). The retention window is resolved from the env
// HERE, at the orchestration boundary, and passed into the pure prune executor.
let lastAuditRetentionDay: string | null = null

export async function maybeRunAuditRetention(now: Date): Promise<void> {
  if (!auditRetentionDue(now, lastAuditRetentionDay)) return
  lastAuditRetentionDay = now.toISOString().slice(0, 10)
  const retentionDays = auditRetentionDays(process.env)
  const pruned = await pruneAuditLogs({ now, retentionDays })
  if (pruned > 0) console.log(`🧹 Audit retention: pruned ${pruned} audit_logs rows older than ${retentionDays}d`)
}

// MCA-PC C3: fire a routine from any trigger (cron, webhook, or API). Creates a
// tracked task, executes it, notifies, and advances the schedule (cron only).
export async function fireRoutine(routine: any, triggerTime: Date): Promise<string> {
  const taskId = randomUUID()
  const label = routine.triggerType && routine.triggerType !== 'cron' ? 'Routine' : 'Scheduled'

  await db.insert(schema.tasks).values({
    id: taskId, orgId: routine.orgId, agentId: routine.agentId,
    title: `[${label}] ${routine.title}`, input: routine.input ?? routine.title,
    status: 'pending', priority: 'medium', createdAt: new Date(),
  })

  try {
    await executeAgentTask({ agentId: routine.agentId, taskId, input: routine.input ?? routine.title })
  } catch (err) {
    console.error(`Routine execution failed for ${routine.id}:`, err)
  }

  const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, routine.orgId) })
  if (org?.ownerId) {
    sendPushNotification(org.ownerId, `Routine ran: ${routine.title}`, 'Agent completed the routine', { taskId, routineId: routine.id }).catch(() => {})
  }

  const update: any = { lastRunAt: triggerTime, lastTriggeredAt: triggerTime }
  if (!routine.triggerType || routine.triggerType === 'cron') update.nextRunAt = calcNextRun(routine.cronExpression)
  await db.update(schema.scheduledTasks).set(update).where(eq(schema.scheduledTasks.id, routine.id))
  return taskId
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
