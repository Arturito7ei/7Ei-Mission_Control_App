// Epic AG / AG6 — the agent Budget tab.
//
// Reuses the existing scoped-budget machinery (`services/budget.ts`): a per-agent
// cap is just a `budgetPolicies` row with `scope:'agent', scopeId:<agentId>`, and
// the hard-stop enforcement in `enforceAgentBudget` already honours it. This file
// only shapes that data for the tab. Pure.

import { evaluatePolicy, isHardStop, type BudgetPolicy, type BudgetState } from './budget'

export interface AgentBudgetView {
  /** Observed spend for this agent, all-time (the same number the Costs tab shows). */
  observedUsd: number
  /** Null when no cap is configured — spend is unlimited, not "0 budget". */
  limitUsd: number | null
  policyId: string | null
  hardStop: boolean
  warnPct: number
  state: BudgetState
  /** Percent of the cap used; null when there is no cap. */
  pct: number | null
  /** Cap minus spend; null when there is no cap (i.e. unlimited). */
  remainingUsd: number | null
  /** Health chip: healthy until a cap exists AND is being approached/breached. */
  health: 'healthy' | 'warning' | 'breached'
}

/**
 * Shape an agent's budget for display. With no policy the tab reports "Disabled /
 * Unlimited" rather than pretending the cap is zero — a missing budget must never
 * read as an exhausted one.
 */
export function summariseAgentBudget(policy: BudgetPolicy | null | undefined, observedUsd: number): AgentBudgetView {
  const spend = round(observedUsd)

  if (!policy || !(policy.limitUsd > 0)) {
    return {
      observedUsd: spend, limitUsd: null, policyId: (policy as { id?: string } | null | undefined)?.id ?? null,
      hardStop: policy ? isHardStop(policy) : true,
      warnPct: policy?.warnPct ?? 0.8,
      state: 'ok', pct: null, remainingUsd: null, health: 'healthy',
    }
  }

  const { state, pct } = evaluatePolicy(policy, spend)
  return {
    observedUsd: spend,
    limitUsd: policy.limitUsd,
    policyId: (policy as { id?: string }).id ?? null,
    hardStop: isHardStop(policy),
    warnPct: policy.warnPct ?? 0.8,
    state,
    pct,
    remainingUsd: round(Math.max(policy.limitUsd - spend, 0)),
    health: state === 'breach' ? 'breached' : state === 'warn' ? 'warning' : 'healthy',
  }
}

const round = (n: number) => Math.round((n || 0) * 1e6) / 1e6
