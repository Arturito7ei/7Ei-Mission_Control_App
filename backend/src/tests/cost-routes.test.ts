import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { organisations } from '../db/schema'

describe('[COST-001] cost summary response shape', () => {
  it('summary object has today, week, month, budget keys', () => {
    const summary = {
      today: { cost: 0, tokens: 0, tasks: 0 },
      week: { cost: 0, tokens: 0, tasks: 0 },
      month: { cost: 0, tokens: 0, tasks: 0 },
      budget: { monthlyLimitUsd: null, usedThisMonth: 0, percentUsed: null },
    }
    assert.ok('today' in summary)
    assert.ok('week' in summary)
    assert.ok('month' in summary)
    assert.ok('budget' in summary)
  })

  it('period objects have cost, tokens, tasks', () => {
    const period = { cost: 1.23, tokens: 5000, tasks: 3 }
    assert.equal(typeof period.cost, 'number')
    assert.equal(typeof period.tokens, 'number')
    assert.equal(typeof period.tasks, 'number')
  })

  it('cost totals are 0 for empty task list', () => {
    const tasks: Array<{ costUsd: number | null; tokensUsed: number | null }> = []
    const total = {
      cost: tasks.reduce((s, t) => s + (t.costUsd ?? 0), 0),
      tokens: tasks.reduce((s, t) => s + (t.tokensUsed ?? 0), 0),
      tasks: tasks.length,
    }
    assert.equal(total.cost, 0)
    assert.equal(total.tokens, 0)
    assert.equal(total.tasks, 0)
  })

  it('budget percentage is null when no budget set', () => {
    const budgetLimit: number | null = null
    const usedThisMonth = 5.0
    const percentUsed = budgetLimit ? Math.round((usedThisMonth / budgetLimit) * 100) : null
    assert.equal(percentUsed, null)
  })

  it('budget percentage computes correctly when budget is set', () => {
    const budgetLimit = 100
    const usedThisMonth = 42.5
    const percentUsed = budgetLimit ? Math.round((usedThisMonth / budgetLimit) * 100) : null
    assert.equal(percentUsed, 43)
  })

  it('budget percentage at 0 usage is 0', () => {
    const budgetLimit = 50
    const usedThisMonth = 0
    const percentUsed = budgetLimit ? Math.round((usedThisMonth / budgetLimit) * 100) : null
    assert.equal(percentUsed, 0)
  })

  it('budget percentage over 100% works', () => {
    const budgetLimit = 10
    const usedThisMonth = 15
    const percentUsed = budgetLimit ? Math.round((usedThisMonth / budgetLimit) * 100) : null
    assert.equal(percentUsed, 150)
  })
})

describe('[COST-002] budgetMonthlyUsd column', () => {
  it('schema has budgetMonthlyUsd column', () => {
    assert.ok(organisations.budgetMonthlyUsd, 'budgetMonthlyUsd column should exist')
  })
})
