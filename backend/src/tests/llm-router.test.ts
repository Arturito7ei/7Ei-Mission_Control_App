import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calcCost, COST_RATES, MODEL_CATALOGUE } from '../services/llm-router'

describe('calcCost', () => {
  it('calculates cost for claude-sonnet-4', () => {
    const cost = calcCost('claude-sonnet-4-20250514', 1000, 500)
    const expected = 1000 * 0.000003 + 500 * 0.000015
    assert.ok(Math.abs(cost - expected) < 0.0000001)
  })

  it('calculates cost for gpt-4o', () => {
    const cost = calcCost('gpt-4o', 2000, 1000)
    const expected = 2000 * 0.000005 + 1000 * 0.000015
    assert.ok(Math.abs(cost - expected) < 0.0000001)
  })

  it('returns 0 for unknown model', () => {
    const cost = calcCost('unknown-model-xyz', 1000, 500)
    assert.equal(cost, 0)
  })

  it('returns 0 for zero tokens', () => {
    const cost = calcCost('claude-sonnet-4-20250514', 0, 0)
    assert.equal(cost, 0)
  })

  it('haiku is cheaper than opus', () => {
    const haiku  = calcCost('claude-haiku-4-5-20251001', 1000, 500)
    const opus   = calcCost('claude-opus-4-6',          1000, 500)
    assert.ok(haiku < opus, 'Haiku should be cheaper than Opus')
  })
})

describe('MODEL_CATALOGUE', () => {
  it('has all three providers', () => {
    assert.ok('anthropic' in MODEL_CATALOGUE)
    assert.ok('openai' in MODEL_CATALOGUE)
    assert.ok('google' in MODEL_CATALOGUE)
  })

  it('each provider has at least one model', () => {
    for (const [provider, models] of Object.entries(MODEL_CATALOGUE)) {
      assert.ok(models.length > 0, `Provider ${provider} has no models`)
    }
  })

  it('all models have id, label, and tier', () => {
    for (const models of Object.values(MODEL_CATALOGUE)) {
      for (const m of models) {
        assert.ok(m.id,    `Model missing id: ${JSON.stringify(m)}`)
        assert.ok(m.label, `Model missing label: ${JSON.stringify(m)}`)
        assert.ok(m.tier,  `Model missing tier: ${JSON.stringify(m)}`)
      }
    }
  })

  it('all models in catalogue have cost rates', () => {
    for (const models of Object.values(MODEL_CATALOGUE)) {
      for (const m of models) {
        assert.ok(m.id in COST_RATES, `Missing cost rate for ${m.id}`)
      }
    }
  })
})
