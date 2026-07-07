import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateInputTokens, estimateWakeCost, preflightWake, parseCapUsd,
  validateModelConfig, validateRoster, SYSTEM_PROMPT_TOKEN_ALLOWANCE,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../services/preflight.ts'

describe('[MCA-84 V3] estimateInputTokens', () => {
  it('is ~chars/4 plus the system-prompt allowance', () => {
    // 40 chars → 10 tokens + allowance
    assert.equal(estimateInputTokens(['x'.repeat(40)]), 10 + SYSTEM_PROMPT_TOKEN_ALLOWANCE)
  })
  it('sums all fragments and tolerates null/undefined', () => {
    assert.equal(estimateInputTokens(['ab', null, 'cd', undefined]), 1 + SYSTEM_PROMPT_TOKEN_ALLOWANCE)
  })
})

describe('[MCA-84 V3] estimateWakeCost', () => {
  it('prices full input + a full completion at the model rates', () => {
    // sonnet: input 0.000003, output 0.000015
    const cost = estimateWakeCost('claude-sonnet-4-20250514', { inputTokens: 1000, maxOutputTokens: 1000 })
    assert.equal(cost, 1000 * 0.000003 + 1000 * 0.000015)
  })
  it('defaults maxOutputTokens to the llm-router default', () => {
    const cost = estimateWakeCost('claude-haiku-4-5-20251001', { inputTokens: 0 })
    assert.equal(cost, DEFAULT_MAX_OUTPUT_TOKENS * 0.00000125)
  })
  it('is 0 for local/zero-cost models', () => {
    assert.equal(estimateWakeCost('llama3.3', { inputTokens: 5000 }), 0)
  })
  it('returns null for an unpriced model', () => {
    assert.equal(estimateWakeCost('some-unknown-model', { inputTokens: 1000 }), null)
  })
})

describe('[MCA-84 V3] preflightWake', () => {
  it('allows any wake when no cap is set', () => {
    const d = preflightWake('claude-opus-4-6', { inputTokens: 100000, capUsd: null })
    assert.equal(d.allowed, true)
    assert.equal(d.capUsd, null)
  })
  it('blocks a wake whose worst-case cost exceeds the cap', () => {
    // opus output 0.000075 → 4096 * 0.000075 ≈ $0.307 > $0.10
    const d = preflightWake('claude-opus-4-6', { inputTokens: 1000, capUsd: 0.1 })
    assert.equal(d.allowed, false)
    assert.ok((d.estimateUsd ?? 0) > 0.1)
    assert.match(d.reason ?? '', /Preflight cap/)
  })
  it('allows a wake under the cap', () => {
    // haiku is far under a $1 cap
    const d = preflightWake('claude-haiku-4-5-20251001', { inputTokens: 1000, capUsd: 1 })
    assert.equal(d.allowed, true)
    assert.equal(d.unbounded, false)
  })
  it('allows but flags unbounded when the model is unpriced even under a cap', () => {
    const d = preflightWake('mystery-model', { inputTokens: 1000, capUsd: 0.5 })
    assert.equal(d.allowed, true)
    assert.equal(d.unbounded, true)
    assert.equal(d.estimateUsd, null)
    assert.match(d.reason ?? '', /no pricing/)
  })
  it('treats a ≤0 cap as no cap', () => {
    assert.equal(preflightWake('claude-opus-4-6', { inputTokens: 100000, capUsd: 0 }).allowed, true)
  })
})

describe('[MCA-84 V3] parseCapUsd', () => {
  it('reads the org-level cap', () => {
    assert.equal(parseCapUsd({ maxCostPerWakeUsd: '0.25' }), 0.25)
  })
  it('lets a per-agent override win over the org default', () => {
    assert.equal(parseCapUsd({ maxCostPerWakeUsd: '0.25', 'maxCostPerWakeUsd:a1': '1.5' }, 'a1'), 1.5)
    assert.equal(parseCapUsd({ maxCostPerWakeUsd: '0.25', 'maxCostPerWakeUsd:a1': '1.5' }, 'a2'), 0.25)
  })
  it('returns null for missing, empty, non-numeric, or ≤0 values', () => {
    assert.equal(parseCapUsd(undefined), null)
    assert.equal(parseCapUsd({}), null)
    assert.equal(parseCapUsd({ maxCostPerWakeUsd: '' }), null)
    assert.equal(parseCapUsd({ maxCostPerWakeUsd: 'abc' }), null)
    assert.equal(parseCapUsd({ maxCostPerWakeUsd: '0' }), null)
    assert.equal(parseCapUsd({ maxCostPerWakeUsd: '-3' }), null)
  })
})

describe('[MCA-84 V3] validateModelConfig', () => {
  it('passes a cheap priced model', () => {
    const v = validateModelConfig('claude-haiku-4-5-20251001')
    assert.equal(v.level, 'ok')
    assert.equal(v.knownPricing, true)
    assert.equal(v.issues.length, 0)
    assert.ok((v.estMaxWakeCostUsd ?? 0) > 0)
  })
  it('warns on a priced model above the cheap threshold', () => {
    const v = validateModelConfig('claude-opus-4-6')
    assert.equal(v.level, 'warn')
    assert.equal(v.knownPricing, true)
    assert.match(v.issues[0], /exceeds the cheap threshold/)
  })
  it('warns and reports no pricing for an unknown model', () => {
    const v = validateModelConfig('mystery-model')
    assert.equal(v.level, 'warn')
    assert.equal(v.knownPricing, false)
    assert.equal(v.estMaxWakeCostUsd, null)
    assert.match(v.issues[0], /No pricing entry/)
  })
  it('honours a custom cheap threshold', () => {
    // Sonnet output is $15/M; a $20/M threshold should pass it.
    assert.equal(validateModelConfig('claude-sonnet-4-20250514', { cheapMaxOutputRate: 0.00002 }).level, 'ok')
  })
})

describe('[MCA-84 V3] validateRoster', () => {
  it('validates each agent and counts warnings, defaulting a null model', () => {
    const { rows, warnCount } = validateRoster([
      { id: 'a1', name: 'Haiku bot', llmModel: 'claude-haiku-4-5-20251001', llmProvider: 'anthropic' },
      { id: 'a2', name: 'Opus bot', llmModel: 'claude-opus-4-6', llmProvider: 'anthropic' },
      { id: 'a3', name: 'Default bot', llmModel: null, llmProvider: null },
    ])
    assert.equal(rows.length, 3)
    // Opus warns; the null model defaults to Sonnet ($15/M) which also exceeds
    // the $5/M cheap threshold. Only the Haiku agent is "ok".
    assert.equal(warnCount, 2)
    assert.equal(rows[0].agentName, 'Haiku bot')
    assert.equal(rows[0].level, 'ok')
    assert.equal(rows[1].level, 'warn')
    assert.equal(rows[2].model, 'claude-sonnet-4-20250514')
    assert.equal(rows[2].level, 'warn')
  })
})
