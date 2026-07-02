// Scoped budget policies (MCA-PC C2). Pure helpers to compute spend per scope
// and evaluate policies; runtime enforcement pauses agents on a hard-stop breach.

import { db, schema } from '../db/client'
import { eq, and, inArray } from 'drizzle-orm'

export type BudgetScope = 'company' | 'agent' | 'project' | 'goal'
export interface BudgetPolicy {
  id: string; scope: BudgetScope; scopeId?: string | null
  limitUsd: number; warnPct?: number | null; hardStop?: boolean | number | null
}
export interface CostTask { costUsd?: number | null; agentId?: string | null; projectId?: string | null; goalId?: string | null }
export type BudgetState = 'ok' | 'warn' | 'breach'

/** Total spend (USD) of tasks within a scope. */
export function spendForScope(tasks: CostTask[], scope: BudgetScope, scopeId?: string | null): number {
  const key = scope === 'agent' ? 'agentId' : scope === 'project' ? 'projectId' : scope === 'goal' ? 'goalId' : null
  let sum = 0
  for (const t of tasks) {
    if (key && (t as any)[key] !== scopeId) continue   // company scope (key=null) counts all
    sum += Number(t.costUsd ?? 0)
  }
  return sum
}

/** Policies that apply to a task context (company always; others by id match). */
export function applicablePolicies(policies: BudgetPolicy[], ctx: { agentId?: string | null; projectId?: string | null; goalId?: string | null }): BudgetPolicy[] {
  return policies.filter(p => {
    if (p.scope === 'company') return true
    if (p.scope === 'agent') return p.scopeId === ctx.agentId
    if (p.scope === 'project') return !!ctx.projectId && p.scopeId === ctx.projectId
    if (p.scope === 'goal') return !!ctx.goalId && p.scopeId === ctx.goalId
    return false
  })
}

/** Evaluate one policy against current spend. */
export function evaluatePolicy(policy: BudgetPolicy, spend: number): { state: BudgetState; pct: number } {
  const limit = Number(policy.limitUsd) || 0
  if (limit <= 0) return { state: 'ok', pct: 0 }
  const pct = spend / limit
  const warn = policy.warnPct == null ? 0.8 : Number(policy.warnPct)
  if (pct >= 1) return { state: 'breach', pct }
  if (pct >= warn) return { state: 'warn', pct }
  return { state: 'ok', pct }
}

const RANK: Record<BudgetState, number> = { ok: 0, warn: 1, breach: 2 }
export function worstState(states: BudgetState[]): BudgetState {
  return states.reduce<BudgetState>((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok')
}
export const isHardStop = (p: BudgetPolicy) => p.hardStop === true || p.hardStop === 1

/** Enforce policies for an agent's upcoming task. On a hard-stop breach, pause
 *  the agent and return blocked. Best-effort; never throws. */
export async function enforceAgentBudget(orgId: string, agentId: string, ctx: { projectId?: string | null; goalId?: string | null }): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const policies = await db.select().from(schema.budgetPolicies).where(eq(schema.budgetPolicies.orgId, orgId)) as any as BudgetPolicy[]
    if (!policies.length) return { blocked: false }
    const tasks = await db.select({ costUsd: schema.tasks.costUsd, agentId: schema.tasks.agentId, projectId: schema.tasks.projectId, goalId: schema.tasks.goalId })
      .from(schema.tasks).where(eq(schema.tasks.orgId, orgId)) as CostTask[]
    for (const p of applicablePolicies(policies, { agentId, projectId: ctx.projectId, goalId: ctx.goalId })) {
      const spend = spendForScope(tasks, p.scope, p.scope === 'company' ? null : p.scopeId)
      const { state } = evaluatePolicy(p, spend)
      if (state === 'breach' && isHardStop(p)) {
        await db.update(schema.agents).set({ status: 'paused' }).where(eq(schema.agents.id, agentId))
        // MCA-EXEC S1.3: park the agent's queued work so nothing runs after the limit.
        await db.update(schema.tasks)
          .set({ status: 'blocked', kanbanColumn: 'blocked', inboxState: 'needs_attention' })
          .where(and(eq(schema.tasks.agentId, agentId), inArray(schema.tasks.status, ['assigned', 'pending'])))
        return { blocked: true, reason: `Budget hard-stop: ${p.scope} limit $${p.limitUsd} reached (spent $${spend.toFixed(2)}). Agent paused; queued tasks parked.` }
      }
    }
    return { blocked: false }
  } catch {
    return { blocked: false }
  }
}
