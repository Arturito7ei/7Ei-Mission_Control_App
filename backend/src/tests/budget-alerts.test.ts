import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Test the checkMonthlyBudget logic patterns

function computeBudgetCheck(budgetLimit: number | null, usedThisMonth: number) {
  if (budgetLimit == null) return { allowed: true, percentUsed: 0, remaining: Infinity }
  const percentUsed = Math.round((usedThisMonth / budgetLimit) * 100)
  const remaining = Math.max(0, budgetLimit - usedThisMonth)
  return { allowed: percentUsed < 100, percentUsed, remaining }
}

function shouldWarn(percentUsed: number) {
  return percentUsed > 80
}

describe('[WO5] checkMonthlyBudget logic', () => {
  it('returns allowed=true with no budget set', () => {
    const result = computeBudgetCheck(null, 50)
    assert.equal(result.allowed, true)
    assert.equal(result.percentUsed, 0)
    assert.equal(result.remaining, Infinity)
  })

  it('returns correct percentage when under budget', () => {
    const result = computeBudgetCheck(100, 42.5)
    assert.equal(result.percentUsed, 43)
    assert.equal(result.allowed, true)
    assert.ok(Math.abs(result.remaining - 57.5) < 0.01)
  })

  it('returns allowed=false when at 100%', () => {
    const result = computeBudgetCheck(50, 50)
    assert.equal(result.percentUsed, 100)
    assert.equal(result.allowed, false)
    assert.equal(result.remaining, 0)
  })

  it('returns allowed=false when over budget', () => {
    const result = computeBudgetCheck(10, 15)
    assert.equal(result.percentUsed, 150)
    assert.equal(result.allowed, false)
    assert.equal(result.remaining, 0)
  })

  it('0 usage = 0% used', () => {
    const result = computeBudgetCheck(100, 0)
    assert.equal(result.percentUsed, 0)
    assert.equal(result.allowed, true)
    assert.equal(result.remaining, 100)
  })
})

describe('[WO5] Budget warning threshold', () => {
  it('no warning below 80%', () => {
    assert.equal(shouldWarn(79), false)
    assert.equal(shouldWarn(50), false)
    assert.equal(shouldWarn(0), false)
  })

  it('warning at 81%', () => {
    assert.equal(shouldWarn(81), true)
  })

  it('warning at 100%', () => {
    assert.equal(shouldWarn(100), true)
  })

  it('no warning at exactly 80%', () => {
    assert.equal(shouldWarn(80), false)
  })

  it('warning at 150% (over budget)', () => {
    assert.equal(shouldWarn(150), true)
  })
})
