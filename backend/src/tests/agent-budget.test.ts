import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summariseAgentBudget } from '../services/agent-budget'
import type { BudgetPolicy } from '../services/budget'

const policy = (over: Partial<BudgetPolicy> & { id?: string } = {}): BudgetPolicy & { id: string } => ({
  id: 'p1', scope: 'agent', scopeId: 'a1', limitUsd: 100, warnPct: 0.8, hardStop: true, ...over,
} as any)

describe('[AG6] summariseAgentBudget', () => {
  it('reports no cap as unlimited — never as an exhausted zero budget', () => {
    const v = summariseAgentBudget(null, 12.5)
    assert.equal(v.limitUsd, null)
    assert.equal(v.pct, null)
    assert.equal(v.remainingUsd, null)
    assert.equal(v.state, 'ok')
    assert.equal(v.health, 'healthy')
    assert.equal(v.observedUsd, 12.5)
  })

  it('treats a zero/negative limit as no cap', () => {
    assert.equal(summariseAgentBudget(policy({ limitUsd: 0 }), 5).limitUsd, null)
    assert.equal(summariseAgentBudget(policy({ limitUsd: -1 }), 5).health, 'healthy')
  })

  it('computes remaining, pct and healthy state under the cap', () => {
    const v = summariseAgentBudget(policy({ limitUsd: 100 }), 25)
    assert.equal(v.limitUsd, 100)
    assert.equal(v.remainingUsd, 75)
    assert.equal(v.pct, 0.25)
    assert.equal(v.state, 'ok')
    assert.equal(v.health, 'healthy')
  })

  it('warns at the soft threshold and breaches at the cap', () => {
    assert.equal(summariseAgentBudget(policy(), 85).health, 'warning')  // 85% ≥ warnPct 0.8
    assert.equal(summariseAgentBudget(policy(), 100).health, 'breached')
    assert.equal(summariseAgentBudget(policy(), 140).health, 'breached')
  })

  it('never reports negative remaining once the cap is blown', () => {
    assert.equal(summariseAgentBudget(policy(), 140).remainingUsd, 0)
  })

  it('carries the hard-stop flag and the policy id through', () => {
    const v = summariseAgentBudget(policy({ id: 'pol-9', hardStop: false }), 10)
    assert.equal(v.policyId, 'pol-9')
    assert.equal(v.hardStop, false)
  })

  it('rounds money to 6dp instead of leaking float noise', () => {
    assert.equal(summariseAgentBudget(null, 0.1 + 0.2).observedUsd, 0.3)
  })

  it('is safe for an agent that has never spent anything', () => {
    const v = summariseAgentBudget(null, 0)
    assert.equal(v.observedUsd, 0)
    assert.equal(v.health, 'healthy')
  })
})
