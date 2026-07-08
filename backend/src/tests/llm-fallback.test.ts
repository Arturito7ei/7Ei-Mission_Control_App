import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseChainLink, parseFallbackChain, classifyLlmError,
  newBreakerState, isProviderHealthy, recordFailure, recordSuccess,
  planFallback, DEFAULT_BREAKER, type BreakerState,
} from '../services/llm-fallback'

// ─── Chain parsing ───────────────────────────────────────────────────────────

test('[F1] parseChainLink splits provider/model and infers bare models', () => {
  assert.deepEqual(parseChainLink('anthropic/claude-sonnet-4-20250514'), { provider: 'anthropic', model: 'claude-sonnet-4-20250514' })
  assert.deepEqual(parseChainLink('ollama/llama3.3'), { provider: 'ollama', model: 'llama3.3' })
  assert.deepEqual(parseChainLink('claude-opus-4-6'), { provider: 'anthropic', model: 'claude-opus-4-6' })
  assert.deepEqual(parseChainLink('gpt-4o'), { provider: 'openai', model: 'gpt-4o' })
  assert.deepEqual(parseChainLink('gemini-2.0-flash'), { provider: 'google', model: 'gemini-2.0-flash' })
  assert.equal(parseChainLink(''), null)
})

test('[F1] parseFallbackChain reads JSON array or list, per-agent overrides org', () => {
  const cfg = {
    arturita_fallback_chain: '["claude-sonnet-4-20250514", "gpt-4o", "ollama/llama3.3"]',
    'arturita_fallback_chain:agent_x': 'gemini-2.0-flash, deepseek-chat',
  }
  const org = parseFallbackChain(cfg)
  assert.equal(org.length, 3)
  assert.equal(org[0].model, 'claude-sonnet-4-20250514')
  assert.equal(org[2].provider, 'ollama')

  const agent = parseFallbackChain(cfg, 'agent_x')
  assert.equal(agent.length, 2)
  assert.equal(agent[0].provider, 'google')
  assert.equal(agent[1].provider, 'deepseek')

  assert.deepEqual(parseFallbackChain(null), [])
  assert.deepEqual(parseFallbackChain({}), [])
})

// ─── Error classification ────────────────────────────────────────────────────

test('[F1] classifyLlmError maps failure classes + failover/breaker guidance', () => {
  assert.deepEqual(classifyLlmError(new Error('openai error 429')), { class: 'rate_limit', failover: true, tripBreaker: true })
  assert.deepEqual(classifyLlmError(new Error('anthropic error 503')), { class: 'server_error', failover: true, tripBreaker: true })
  assert.deepEqual(classifyLlmError(new Error('No API key configured for provider "deepseek"')), { class: 'auth', failover: true, tripBreaker: true })
  assert.deepEqual(classifyLlmError(new Error('fetch failed')), { class: 'timeout', failover: true, tripBreaker: true })
  // context overflow + content filter fail over but DON'T blame the provider
  assert.equal(classifyLlmError(new Error('maximum context length exceeded')).class, 'context_overflow')
  assert.equal(classifyLlmError(new Error('maximum context length exceeded')).tripBreaker, false)
  assert.equal(classifyLlmError(new Error('content policy refusal')).tripBreaker, false)
  // explicit status hint wins
  assert.equal(classifyLlmError(new Error('weird'), 429).class, 'rate_limit')
  assert.equal(classifyLlmError(new Error('mystery')).class, 'unknown')
})

// ─── Circuit breaker ─────────────────────────────────────────────────────────

test('[F1] breaker trips after threshold failures in the window, then cools down', () => {
  const cfg = DEFAULT_BREAKER
  let s: BreakerState = newBreakerState()
  const t0 = 1_000_000
  assert.equal(isProviderHealthy(s, t0), true)

  s = recordFailure(s, t0, cfg)
  s = recordFailure(s, t0 + 1000, cfg)
  assert.equal(isProviderHealthy(s, t0 + 1000), true, 'still healthy below threshold')

  s = recordFailure(s, t0 + 2000, cfg) // 3rd failure → trip
  assert.equal(isProviderHealthy(s, t0 + 2000), false, 'breaker open after threshold')
  // still open just before cooldown ends
  assert.equal(isProviderHealthy(s, t0 + 2000 + cfg.cooldownMs - 1), false)
  // healthy again after cooldown (re-probe)
  assert.equal(isProviderHealthy(s, t0 + 2000 + cfg.cooldownMs + 1), true)
})

test('[F1] failures outside the window do not accumulate', () => {
  const cfg = DEFAULT_BREAKER
  let s = newBreakerState()
  s = recordFailure(s, 0, cfg)
  s = recordFailure(s, cfg.windowMs + 1, cfg) // window reset → count is 1, not 2
  assert.equal(isProviderHealthy(s, cfg.windowMs + 1), true)
})

test('[F1] recordSuccess closes the breaker', () => {
  const cfg = DEFAULT_BREAKER
  let s = newBreakerState()
  s = recordFailure(s, 0, cfg)
  s = recordFailure(s, 1, cfg)
  s = recordSuccess(s)
  assert.deepEqual(s, newBreakerState())
})

// ─── Fallback planning ───────────────────────────────────────────────────────

const CHAIN = parseFallbackChain({ arturita_fallback_chain: 'claude-sonnet-4-20250514, gpt-4o, ollama/llama3.3' })

test('[F1] planFallback returns healthy hops in order under the cap', () => {
  const plan = planFallback({
    chain: CHAIN, breakers: {}, now: 1000, inputTokens: 1000, maxOutputTokens: 1000, capUsd: null,
  })
  assert.equal(plan.exhausted, false)
  assert.equal(plan.hops.length, 3)
  assert.equal(plan.hops[0].link.model, 'claude-sonnet-4-20250514')
})

test('[F1] planFallback skips providers whose breaker is open', () => {
  const openState: BreakerState = { failures: 0, windowStart: null, openUntil: 5000 }
  const plan = planFallback({
    chain: CHAIN, breakers: { 'anthropic/claude-sonnet-4-20250514': openState }, now: 1000,
    inputTokens: 1000, maxOutputTokens: 1000, capUsd: null,
  })
  assert.equal(plan.skippedUnhealthy.length, 1)
  assert.equal(plan.hops[0].link.provider, 'openai')
})

test('[F1] planFallback drops hops over the per-wake cost cap', () => {
  // A tiny cap excludes the priced cloud models but keeps the $0 local model.
  const plan = planFallback({
    chain: CHAIN, breakers: {}, now: 1000, inputTokens: 100_000, maxOutputTokens: 4096, capUsd: 0.001,
  })
  assert.ok(plan.skippedOverCap.length >= 1, 'expensive models dropped')
  assert.ok(plan.hops.some(h => h.link.provider === 'ollama'), 'free local model kept')
})

test('[F1] planFallback is exhausted (parks the task) when nothing is attemptable', () => {
  const open: BreakerState = { failures: 0, windowStart: null, openUntil: 9999 }
  const breakers: Record<string, BreakerState> = {}
  for (const l of CHAIN) breakers[`${l.provider}/${l.model}`] = open
  const plan = planFallback({ chain: CHAIN, breakers, now: 1000, inputTokens: 1000, capUsd: null })
  assert.equal(plan.exhausted, true)
  assert.match(plan.reason!, /parked/i)
})
