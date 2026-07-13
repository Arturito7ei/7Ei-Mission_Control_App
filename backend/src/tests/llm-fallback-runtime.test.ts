import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamLLMWithFallback, breakerSnapshot } from '../services/llm-fallback-runtime'
import { BreakerState } from '../services/llm-fallback'
import type { LLMStreamOpts, LLMResult } from '../services/llm-router'

const CHAIN = [
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'google', model: 'gemini-2.0-flash' },
]

// A fake streamFn: succeeds for models in `okModels`, throws `errByModel` otherwise.
function fakeStream(okModels: Set<string>, errByModel: Record<string, Error> = {}): (o: LLMStreamOpts) => Promise<LLMResult> {
  return async (o) => {
    if (okModels.has(o.model)) {
      return { output: `ok:${o.model}`, model: o.model, provider: o.provider, usage: { inputTokens: 10, outputTokens: 5 } }
    }
    throw errByModel[o.model] ?? new Error(`${o.provider} error 500`)
  }
}

const creds = () => ({})
const base = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }], onToken: () => {} }

test('[F1] single-hop chain: one call, returns the result (identical to bare streamLLM)', async () => {
  const breakers = new Map<string, BreakerState>()
  const r = await streamLLMWithFallback({
    base, chain: [CHAIN[0]], resolveCreds: creds, inputTokens: 100, capUsd: null,
    now: 1000, breakers, streamFn: fakeStream(new Set(['claude-sonnet-4-20250514'])),
  })
  assert.equal(r.used.model, 'claude-sonnet-4-20250514')
  assert.equal(r.result.output, 'ok:claude-sonnet-4-20250514')
  assert.equal(r.attempts.length, 1)
  assert.equal(r.attempts[0].ok, true)
})

test('[J2] local primary success short-circuits — a later cloud hop (bad key) is never called', async () => {
  // The Arturita default chain shape: local Ollama first, cloud last-resort.
  const LOCAL_FIRST = [
    { provider: 'ollama', model: 'llama3.2:3b' },
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514' }, // invalid/expired key IRL
  ]
  const breakers = new Map<string, BreakerState>()
  const called: string[] = []
  const streamFn: (o: LLMStreamOpts) => Promise<LLMResult> = async (o) => {
    called.push(o.provider)
    if (o.provider === 'ollama') return { output: 'ok:local', model: o.model, provider: o.provider, usage: { inputTokens: 10, outputTokens: 5 } }
    throw new Error('anthropic error 401 invalid api key') // must never be reached
  }
  const r = await streamLLMWithFallback({
    base, chain: LOCAL_FIRST, resolveCreds: creds, inputTokens: 100, capUsd: null,
    now: 1000, breakers, streamFn,
  })
  assert.equal(r.used.provider, 'ollama')
  assert.equal(r.result.output, 'ok:local')
  assert.equal(r.attempts.length, 1)            // stopped at the first success
  assert.deepEqual(called, ['ollama'])          // anthropic (bad key) never invoked
})

test('[P2] reasoningEffort in base opts flows through to the LLM call', async () => {
  const breakers = new Map<string, BreakerState>()
  let seenEffort: string | undefined
  const capture: (o: LLMStreamOpts) => Promise<LLMResult> = async (o) => {
    seenEffort = o.reasoningEffort
    return { output: 'ok', model: o.model, provider: o.provider, usage: { inputTokens: 1, outputTokens: 1 } }
  }
  await streamLLMWithFallback({
    base: { ...base, reasoningEffort: 'high' }, chain: [CHAIN[0]], resolveCreds: creds,
    inputTokens: 100, capUsd: null, now: 1000, breakers, streamFn: capture,
  })
  assert.equal(seenEffort, 'high')
})

test('[F1] primary 500 → fails over to the next hop', async () => {
  const breakers = new Map<string, BreakerState>()
  const r = await streamLLMWithFallback({
    base, chain: CHAIN, resolveCreds: creds, inputTokens: 100, capUsd: null,
    now: 1000, breakers, streamFn: fakeStream(new Set(['gpt-4o'])),
  })
  assert.equal(r.used.model, 'gpt-4o')
  assert.equal(r.attempts.length, 2)
  assert.equal(r.attempts[0].ok, false)
  assert.equal(r.attempts[0].errorClass, 'server_error')
  assert.equal(r.attempts[1].ok, true)
})

test('[F1] a 500 trips the breaker for the failed provider', async () => {
  const breakers = new Map<string, BreakerState>()
  await streamLLMWithFallback({
    base, chain: CHAIN, resolveCreds: creds, inputTokens: 100, capUsd: null,
    now: 1000, breakers, streamFn: fakeStream(new Set(['gpt-4o'])),
    breakerCfg: { threshold: 1, windowMs: 60_000, cooldownMs: 120_000 },
  })
  const snap = breakerSnapshot(breakers)
  const primary = snap['anthropic/claude-sonnet-4-20250514']
  assert.ok(primary && primary.openUntil != null, 'primary breaker should be open after threshold=1 failure')
})

test('[F1] auth error fails over too (skip provider, try next)', async () => {
  const breakers = new Map<string, BreakerState>()
  const r = await streamLLMWithFallback({
    base, chain: CHAIN, resolveCreds: creds, inputTokens: 100, capUsd: null,
    now: 1000, breakers,
    streamFn: fakeStream(new Set(['gpt-4o']), { 'claude-sonnet-4-20250514': new Error('anthropic error 401') }),
  })
  assert.equal(r.used.model, 'gpt-4o')
  assert.equal(r.attempts[0].errorClass, 'auth')
})

test('[F1] all hops fail → the original last error is rethrown', async () => {
  const breakers = new Map<string, BreakerState>()
  const boom = new Error('google error 503')
  await assert.rejects(
    streamLLMWithFallback({
      base, chain: CHAIN, resolveCreds: creds, inputTokens: 100, capUsd: null,
      now: 1000, breakers,
      streamFn: fakeStream(new Set(), { 'gemini-2.0-flash': boom }),
    }),
    /error 5\d\d/,
  )
})

test('[F1] an open breaker on the only hop → exhausted, parks with a reason', async () => {
  const breakers = new Map<string, BreakerState>()
  breakers.set('anthropic/claude-sonnet-4-20250514', { failures: 0, windowStart: null, openUntil: 999_999 })
  await assert.rejects(
    streamLLMWithFallback({
      base, chain: [CHAIN[0]], resolveCreds: creds, inputTokens: 100, capUsd: null,
      now: 1000, breakers, streamFn: fakeStream(new Set(['claude-sonnet-4-20250514'])),
    }),
    /No LLM provider available|parked/,
  )
})

test('[F1] a priced hop over the per-wake cost cap is skipped; an unpriced hop survives', async () => {
  const breakers = new Map<string, BreakerState>()
  // A low cap drops the expensive priced primary for a huge wake; the local
  // (unpriced → cost unknown → allowed, matching preflight philosophy) hop runs.
  const chain = [
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514' }, // priced → over cap
    { provider: 'ollama', model: 'llama3.3' },                    // unpriced → survives
  ]
  const r = await streamLLMWithFallback({
    base, chain, resolveCreds: creds, inputTokens: 1_000_000, maxOutputTokens: 4096,
    capUsd: 0.01, now: 1000, breakers,
    streamFn: fakeStream(new Set(['claude-sonnet-4-20250514', 'llama3.3'])),
  })
  assert.equal(r.used.model, 'llama3.3')
  assert.equal(r.result.output, 'ok:llama3.3')
})

test('[F1] empty chain throws (guard)', async () => {
  await assert.rejects(
    streamLLMWithFallback({ base, chain: [], resolveCreds: creds, inputTokens: 10, capUsd: null, now: 1, breakers: new Map(), streamFn: fakeStream(new Set()) }),
    /empty chain/,
  )
})
