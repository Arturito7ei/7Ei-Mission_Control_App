// Heartbeat engine (MCA-PC C1). A DB-backed wakeup sweep with per-agent
// schedules, coalescing, agent-status recompute, and orphaned-run recovery.
// Pure helpers are unit-tested; runHeartbeatSweep applies them against the DB.

import { db, schema } from '../db/client'
import { eq, and, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { canAgentRun } from './governance'
import { isExternalAgent, heartbeatFreshness } from './agent-runtime'

export const ORPHAN_STALE_MS = 30 * 60 * 1000  // in_progress > 30 min = orphaned

export interface WakeAgent { id: string; status?: string | null; heartbeatEverySec?: number | null; nextWakeAt?: Date | number | null }

/** Next wake timestamp (ms) for a cadence. */
export function nextWake(nowMs: number, everySec: number): number {
  return nowMs + Math.max(1, everySec) * 1000
}

/** Is the agent due for an auto-wake now? (has cadence, runnable, not already active, due). */
export function dueForWake(agent: WakeAgent, nowMs: number): boolean {
  const every = agent.heartbeatEverySec ?? 0
  if (!every || every <= 0) return false
  if (!canAgentRun(agent.status) || agent.status === 'active') return false
  const next = agent.nextWakeAt == null ? null
    : (agent.nextWakeAt instanceof Date ? agent.nextWakeAt.getTime() : Number(agent.nextWakeAt))
  return next == null || next <= nowMs
}

export interface OrphanTask { id: string; status: string; createdAt: Date | number | null }

/** Tasks stuck in_progress past staleMs (agent likely died) → to recover. */
export function findOrphanedTaskIds(tasks: OrphanTask[], nowMs: number, staleMs = ORPHAN_STALE_MS): string[] {
  return tasks.filter(t => {
    if (t.status !== 'in_progress') return false
    const ts = t.createdAt instanceof Date ? t.createdAt.getTime() : Number(t.createdAt ?? 0)
    return nowMs - ts > staleMs
  }).map(t => t.id)
}

export interface SweepResult { orphansRecovered: number; woken: number; statusUpdated: number }

/** Run one heartbeat sweep. Scope to an org, or all orgs when omitted. */
export async function runHeartbeatSweep(orgId?: string): Promise<SweepResult> {
  const now = Date.now()
  const res: SweepResult = { orphansRecovered: 0, woken: 0, statusUpdated: 0 }

  const agents = await (orgId
    ? db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId))
    : db.select().from(schema.agents))

  // 1. Orphan recovery — reset stuck in_progress tasks for these agents.
  const agentIds = agents.map(a => a.id)
  if (agentIds.length) {
    const inProgress = await db.select({ id: schema.tasks.id, status: schema.tasks.status, createdAt: schema.tasks.createdAt })
      .from(schema.tasks).where(and(inArray(schema.tasks.agentId, agentIds), eq(schema.tasks.status, 'in_progress')))
    const orphanIds = findOrphanedTaskIds(inProgress as any, now)
    if (orphanIds.length) {
      await db.update(schema.tasks).set({ status: 'pending', inboxState: 'needs_attention' } as any)
        .where(inArray(schema.tasks.id, orphanIds))
      res.orphansRecovered = orphanIds.length
    }
  }

  for (const a of agents) {
    // 2. Recompute external agent heartbeat freshness.
    if (isExternalAgent(a)) {
      const fresh = heartbeatFreshness(a.lastHeartbeatAt as any, now)
      if (fresh !== a.heartbeatStatus) {
        await db.update(schema.agents).set({ heartbeatStatus: fresh }).where(eq(schema.agents.id, a.id))
        res.statusUpdated++
      }
    }
    // 3. Wake due agents (coalesced) by enqueuing a heartbeat task.
    if (dueForWake(a as any, now)) {
      const external = isExternalAgent(a)
      await db.insert(schema.tasks).values({
        id: randomUUID(), orgId: a.orgId, agentId: a.id, assignedTo: a.id,
        title: '[Heartbeat] check-in', input: 'Heartbeat wake: review your open work, make progress, and report.',
        status: external ? 'assigned' : 'pending', priority: 'low',
        kanbanColumn: external ? 'in_progress' : 'todo', createdAt: new Date(),
      } as any)
      await db.update(schema.agents).set({ nextWakeAt: new Date(nextWake(now, a.heartbeatEverySec ?? 3600)) })
        .where(eq(schema.agents.id, a.id))
      res.woken++
    }
  }
  return res
}
