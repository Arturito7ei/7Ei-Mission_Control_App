import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spendForScope, applicablePolicies, evaluatePolicy, worstState } from '../services/budget.ts'

const tasks = [
  { costUsd: 1, agentId: 'a1', projectId: 'p1', goalId: 'g1' },
  { costUsd: 2, agentId: 'a2', projectId: 'p1', goalId: null },
  { costUsd: 4, agentId: 'a1', projectId: null, goalId: 'g1' },
]

describe('[MCA-PC C2] spendForScope', () => {
  it('company sums everything', () => assert.equal(spendForScope(tasks, 'company'), 7))
  it('agent scope filters by agentId', () => assert.equal(spendForScope(tasks, 'agent', 'a1'), 5))
  it('project scope filters by projectId', () => assert.equal(spendForScope(tasks, 'project', 'p1'), 3))
  it('goal scope filters by goalId', () => assert.equal(spendForScope(tasks, 'goal', 'g1'), 5))
})

describe('[MCA-PC C2] applicablePolicies', () => {
  const policies = [
    { id: '1', scope: 'company' as const, limitUsd: 10 },
    { id: '2', scope: 'agent' as const, scopeId: 'a1', limitUsd: 5 },
    { id: '3', scope: 'agent' as const, scopeId: 'a2', limitUsd: 5 },
    { id: '4', scope: 'goal' as const, scopeId: 'g1', limitUsd: 3 },
  ]
  it('matches company + agent + goal for a1/g1', () => {
    const ap = applicablePolicies(policies, { agentId: 'a1', projectId: null, goalId: 'g1' })
    assert.deepEqual(ap.map(p => p.id).sort(), ['1', '2', '4'])
  })
})

describe('[MCA-PC C2] evaluatePolicy', () => {
  it('ok / warn / breach by pct', () => {
    assert.equal(evaluatePolicy({ id: '1', scope: 'company', limitUsd: 100 }, 50).state, 'ok')
    assert.equal(evaluatePolicy({ id: '1', scope: 'company', limitUsd: 100 }, 85).state, 'warn')
    assert.equal(evaluatePolicy({ id: '1', scope: 'company', limitUsd: 100 }, 100).state, 'breach')
  })
  it('respects custom warnPct', () => {
    assert.equal(evaluatePolicy({ id: '1', scope: 'company', limitUsd: 100, warnPct: 0.5 }, 60).state, 'warn')
  })
  it('zero limit is always ok', () => assert.equal(evaluatePolicy({ id: '1', scope: 'company', limitUsd: 0 }, 99).state, 'ok'))
})

describe('[MCA-PC C2] worstState', () => {
  it('returns the most severe', () => {
    assert.equal(worstState(['ok', 'warn', 'breach']), 'breach')
    assert.equal(worstState(['ok', 'warn']), 'warn')
    assert.equal(worstState(['ok']), 'ok')
  })
})
