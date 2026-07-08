// Arturita F1 (runtime) — wire the pure fallback layer into the live LLM path.
//
// `llm-fallback.ts` is the PURE decision layer (parse chain, classify errors,
// plan hops, circuit-breaker math). This module is the thin RUNTIME wrapper that
// actually calls `streamLLM` around it, holding a module-level breaker registry
// so an unhealthy provider is skipped across wakes. Cost stays bounded — every
// hop is dropped by `planFallback` if its worst-case wake cost exceeds the
// per-wake cap (PRD §6, D-g).
//
// Behaviour is IDENTICAL to a bare `streamLLM` when the chain has a single entry
// and no breaker is open (the default for every non-Arturita agent): one attempt,
// same result, and the original error is rethrown on failure. Fallover only
// engages when an agent/org configures `arturita_fallback_chain` in deployConfig.

import { streamLLM, LLMStreamOpts, LLMResult } from './llm-router'
import {
  ChainLink, BreakerState, BreakerConfig, DEFAULT_BREAKER,
  recordFailure, recordSuccess, planFallback, classifyLlmError, FailureClass,
} from './llm-fallback'

// ─── Module-level breaker registry ───────────────────────────────────────────

const registry = new Map<string, BreakerState>()

function keyOf(link: ChainLink): string { return `${link.provider}/${link.model}` }

/** Snapshot of the registry as a plain object (for planFallback + /health). */
export function breakerSnapshot(reg: Map<string, BreakerState> = registry): Record<string, BreakerState> {
  const out: Record<string, BreakerState> = {}
  for (const [k, v] of reg.entries()) out[k] = v
  return out
}

/** Clear the registry — tests only. */
export function resetBreakerRegistry(): void { registry.clear() }

/** Provider health for `/health` + the Cockpit: which providers are in cooldown. */
export function llmProviderHealth(now: number = Date.now()): Array<{ key: string; healthy: boolean; openUntil: number | null; failures: number }> {
  const out: Array<{ key: string; healthy: boolean; openUntil: number | null; failures: number }> = []
  for (const [key, s] of registry.entries()) {
    const healthy = !(s.openUntil != null && now < s.openUntil)
    out.push({ key, healthy, openUntil: s.openUntil, failures: s.failures })
  }
  return out
}

// ─── The wrapper ─────────────────────────────────────────────────────────────

export interface FallbackAttempt {
  link: ChainLink
  ok: boolean
  errorClass?: FailureClass
}

export interface FallbackRunResult {
  result: LLMResult
  used: ChainLink
  attempts: FallbackAttempt[]
}

/** Run `streamLLM` across an ordered fallback chain with the circuit breaker.
 *  Walks `planFallback`'s hops (healthy + under the per-wake cap); on a
 *  failover-classified error, trips the breaker (when warranted) and moves to the
 *  next hop. Returns the first success. Throws the original last error when the
 *  whole chain fails, or the parked reason when no hop is even attemptable. */
export async function streamLLMWithFallback(input: {
  /** everything except the per-hop provider/model/creds. */
  base: Omit<LLMStreamOpts, 'provider' | 'model' | 'orgApiKey' | 'baseURL'>
  /** ordered chain, primary first. Caller passes `[{provider,model}]` when unset. */
  chain: ChainLink[]
  /** per-provider credential lookup (e.g. from org.deployConfig). */
  resolveCreds: (provider: string) => { orgApiKey?: string; baseURL?: string }
  inputTokens: number
  maxOutputTokens?: number
  capUsd?: number | null
  now?: number
  /** injectable for tests; defaults to the real streamLLM. */
  streamFn?: (opts: LLMStreamOpts) => Promise<LLMResult>
  /** injectable for tests; defaults to the module registry. */
  breakers?: Map<string, BreakerState>
  breakerCfg?: BreakerConfig
}): Promise<FallbackRunResult> {
  const reg = input.breakers ?? registry
  const now = input.now ?? Date.now()
  const streamFn = input.streamFn ?? streamLLM
  const cfg = input.breakerCfg ?? DEFAULT_BREAKER
  const chain = input.chain.length > 0 ? input.chain : []
  if (chain.length === 0) throw new Error('streamLLMWithFallback: empty chain')

  const plan = planFallback({
    chain,
    breakers: breakerSnapshot(reg),
    now,
    inputTokens: input.inputTokens,
    maxOutputTokens: input.maxOutputTokens,
    capUsd: input.capUsd ?? null,
  })
  if (plan.exhausted) throw new Error(plan.reason ?? 'No LLM provider available for this wake.')

  const attempts: FallbackAttempt[] = []
  let lastError: unknown = null

  for (const hop of plan.hops) {
    const link = hop.link
    const key = keyOf(link)
    const creds = input.resolveCreds(link.provider)
    try {
      const result = await streamFn({
        ...input.base,
        provider: link.provider,
        model: link.model,
        orgApiKey: creds.orgApiKey,
        baseURL: creds.baseURL,
      })
      reg.set(key, recordSuccess(reg.get(key)))
      attempts.push({ link, ok: true })
      return { result, used: link, attempts }
    } catch (err) {
      lastError = err
      const cls = classifyLlmError(err)
      attempts.push({ link, ok: false, errorClass: cls.class })
      if (cls.tripBreaker) reg.set(key, recordFailure(reg.get(key), now, cfg))
      if (!cls.failover) throw err // non-failover class → surface immediately
      // else: try the next hop
    }
  }

  // Every attemptable hop failed — rethrow the original last error so callers see
  // the true cause (identical semantics to a bare streamLLM for a 1-hop chain).
  throw lastError ?? new Error('all LLM providers in the fallback chain failed')
}
