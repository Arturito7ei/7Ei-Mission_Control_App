import { schema } from '../db/client'
import { fireWebhook } from './outbound-webhooks'

// ─── EXTERNAL AGENT RUNTIME HELPERS (MCA-EXT) ──────────────────────────────

type Agent = typeof schema.agents.$inferSelect

/** True when the agent is a self-hosted / bring-your-own runtime, not the
 *  internal LLM executor. Driven by agentType==='external' OR runtime!=='internal'. */
export function isExternalAgent(agent: Pick<Agent, 'agentType' | 'runtime'>): boolean {
  return agent.agentType === 'external' || (!!agent.runtime && agent.runtime !== 'internal')
}

export type Heartbeat = 'green' | 'amber' | 'stale' | 'unknown'

const GREEN_MS = 2 * 60 * 1000    // < 2 min  → green
const AMBER_MS = 10 * 60 * 1000   // < 10 min → amber, else stale

/** Derive heartbeat freshness from the last heartbeat timestamp. */
export function heartbeatFreshness(last: Date | number | null | undefined, now: number = Date.now()): Heartbeat {
  if (last == null) return 'unknown'
  const ts = last instanceof Date ? last.getTime() : Number(last)
  if (!Number.isFinite(ts)) return 'unknown'
  const age = now - ts
  if (age < GREEN_MS) return 'green'
  if (age < AMBER_MS) return 'amber'
  return 'stale'
}

/** Notify an external runtime that a task is waiting. Best-effort, never throws:
 *  fires an outbound webhook the runtime (or a relay) can listen on. Telegram
 *  ping is handled separately by the comms layer when contactChannel is set. */
export async function notifyExternalAgent(
  agent: Pick<Agent, 'id' | 'orgId' | 'name' | 'runtime' | 'externalEndpoint'>,
  task: { taskId: string; input: string },
): Promise<void> {
  try {
    await fireWebhook('agent.task.assigned', agent.orgId, {
      agentId: agent.id,
      agentName: agent.name,
      runtime: agent.runtime,
      taskId: task.taskId,
      inputPreview: task.input.slice(0, 200),
    })
  } catch (err) {
    console.warn('notifyExternalAgent failed (non-critical):', err)
  }
}
