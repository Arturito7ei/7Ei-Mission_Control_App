// Arturita F1 — ordered LLM fallback chain + circuit breaker (pure).
//
// Arturita must keep working when a provider degrades (PRD §6). This module is
// the pure decision layer on top of the existing `llm-router.ts`: it does NOT
// call any provider — it decides, given a chain and live breaker state, which
// provider to try next, whether to try at all, and when to give up. The executor
// wires it around `streamLLM`, re-running the existing preflight per-wake cap on
// every hop so failover can never blow the budget.
//
// Design (all pure, unit-tested):
//  - parseFallbackChain(): read an ordered chain from org.deployConfig.
//  - classifyLlmError(): map a thrown error / status to a failure class and
//    whether it's worth failing over.
//  - Circuit breaker: recordFailure / recordSuccess / isProviderHealthy over a
//    caller-held state map (N failures in a window → cooldown → re-probe).
//  - planFallback(): the next hop — skip unhealthy providers, stop at the
//    per-wake cost cap, surface a plain-language reason when exhausted.

import { estimateWakeCost } from './preflight'

// ─── Chain config ────────────────────────────────────────────────────────────

export interface ChainLink {
  /** provider id understood by llm-router (anthropic|openai|google|deepseek|…|ollama). */
  provider: string
  /** model id (must have a COST_RATES entry to be cost-bounded). */
  model: string
}

/** Split a "provider/model" token. A bare model (no slash) infers the provider
 *  from a small known map, else defaults to 'custom'. */
export function parseChainLink(token: string): ChainLink | null {
  const t = String(token ?? '').trim()
  if (!t) return null
  const slash = t.indexOf('/')
  if (slash > 0) return { provider: t.slice(0, slash).trim(), model: t.slice(slash + 1).trim() }
  // bare model → infer provider
  if (/^claude/i.test(t)) return { provider: 'anthropic', model: t }
  if (/^gpt/i.test(t)) return { provider: 'openai', model: t }
  if (/^gemini/i.test(t)) return { provider: 'google', model: t }
  if (/^deepseek/i.test(t)) return { provider: 'deepseek', model: t }
  return { provider: 'custom', model: t }
}

/** Read the ordered fallback chain for an agent from deployConfig. Prefers a
 *  per-agent key (`arturita_fallback_chain:<id>`) over the org default
 *  (`arturita_fallback_chain`). Accepts a JSON array or a comma/space list.
 *  Returns [] when unset (caller falls back to the agent's single configured
 *  model). */
export function parseFallbackChain(
  deployConfig: Record<string, string> | null | undefined,
  agentId?: string | null,
): ChainLink[] {
  const cfg = deployConfig ?? {}
  const raw = (agentId && cfg[`arturita_fallback_chain:${agentId}`]) || cfg.arturita_fallback_chain
  if (!raw || !String(raw).trim()) return []
  let tokens: string[] = []
  const s = String(raw).trim()
  if (s.startsWith('[')) {
    try { const arr = JSON.parse(s); if (Array.isArray(arr)) tokens = arr.map(String) } catch { tokens = [] }
  }
  if (tokens.length === 0) tokens = s.split(/[,\s]+/)
  return tokens.map(parseChainLink).filter((l): l is ChainLink => l !== null)
}

// ─── Error classification ────────────────────────────────────────────────────

export type FailureClass =
  | 'timeout' | 'server_error' | 'rate_limit' | 'auth' | 'context_overflow' | 'content_filter' | 'unknown'

export interface ErrorClassification {
  class: FailureClass
  /** worth trying the next provider? (auth = skip this provider but do fail over.) */
  failover: boolean
  /** should this provider be marked unhealthy (tripping the breaker)? */
  tripBreaker: boolean
}

/** Classify a thrown LLM error (or an explicit status code) into a failure class
 *  + failover/breaker guidance. llm-router throws `Error("<provider> error <status>")`
 *  and native fetch/timeout errors; we parse either. */
export function classifyLlmError(err: unknown, statusHint?: number): ErrorClassification {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  const status = statusHint ?? (msg.match(/error\s+(\d{3})/)?.[1] ? Number(msg.match(/error\s+(\d{3})/)![1]) : undefined)

  if (status === 429 || /rate.?limit|too many requests/.test(msg)) {
    return { class: 'rate_limit', failover: true, tripBreaker: true }
  }
  if (status === 401 || status === 403 || /unauthor|invalid api key|no api key|forbidden/.test(msg)) {
    // Bad/rotated key: skip THIS provider (breaker) but do fail over + alert.
    return { class: 'auth', failover: true, tripBreaker: true }
  }
  if ((status != null && status >= 500) || /server error|bad gateway|unavailable|overloaded/.test(msg)) {
    return { class: 'server_error', failover: true, tripBreaker: true }
  }
  if (/tim2?e?d?\s?out|timeout|etimedout|econnreset|network|fetch failed|socket hang up/.test(msg)) {
    return { class: 'timeout', failover: true, tripBreaker: true }
  }
  if (/context length|maximum context|too long|token limit|context_length_exceeded/.test(msg)) {
    // Not the provider's fault — fail over to a larger-context model, don't trip.
    return { class: 'context_overflow', failover: true, tripBreaker: false }
  }
  if (/content|refus|safety|filter|blocked/.test(msg)) {
    // Retry once on the next provider; don't blame this one's health.
    return { class: 'content_filter', failover: true, tripBreaker: false }
  }
  return { class: 'unknown', failover: true, tripBreaker: false }
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

export interface BreakerState {
  failures: number
  /** ms epoch of the first failure in the current window. */
  windowStart: number | null
  /** ms epoch until which the provider is considered open (skipped). */
  openUntil: number | null
}

export interface BreakerConfig {
  /** failures within the window that trip the breaker. */
  threshold: number
  /** window length (ms) over which failures accumulate. */
  windowMs: number
  /** cooldown (ms) the breaker stays open before a re-probe. */
  cooldownMs: number
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 3, windowMs: 60_000, cooldownMs: 120_000 }

export function newBreakerState(): BreakerState {
  return { failures: 0, windowStart: null, openUntil: null }
}

/** Is the provider healthy (breaker closed) right now? Open until `openUntil`. */
export function isProviderHealthy(state: BreakerState | null | undefined, now: number): boolean {
  if (!state) return true
  return !(state.openUntil != null && now < state.openUntil)
}

/** Record a failure. Accumulates within the window; on reaching the threshold the
 *  breaker opens for the cooldown. Returns the new state (pure). */
export function recordFailure(
  state: BreakerState | null | undefined,
  now: number,
  cfg: BreakerConfig = DEFAULT_BREAKER,
): BreakerState {
  const s = state ? { ...state } : newBreakerState()
  // reset the window if it elapsed
  if (s.windowStart == null || now - s.windowStart > cfg.windowMs) {
    s.windowStart = now
    s.failures = 0
  }
  s.failures += 1
  if (s.failures >= cfg.threshold) {
    s.openUntil = now + cfg.cooldownMs
    // start a fresh window after tripping so post-cooldown probes get a clean slate
    s.failures = 0
    s.windowStart = null
  }
  return s
}

/** Record a success — closes the breaker and clears the failure window. */
export function recordSuccess(_state?: BreakerState | null): BreakerState {
  return newBreakerState()
}

// ─── Fallback planning ───────────────────────────────────────────────────────

export interface FallbackHop {
  link: ChainLink
  index: number
  estimateUsd: number | null
}

export interface FallbackPlan {
  /** ordered hops to attempt (healthy + under the per-wake cap), in chain order. */
  hops: FallbackHop[]
  /** providers skipped because their breaker is open. */
  skippedUnhealthy: ChainLink[]
  /** providers skipped because their worst-case wake cost exceeds the cap. */
  skippedOverCap: ChainLink[]
  /** true when NO hop is attemptable — the caller parks the task with `reason`. */
  exhausted: boolean
  reason?: string
}

/** Plan the fallback attempt order for one wake: walk the chain, skip providers
 *  whose breaker is open, and drop any hop whose worst-case wake cost exceeds the
 *  per-wake cap (failover must stay within budget — PRD §6, D-g). Pure over a
 *  snapshot of breaker states. */
export function planFallback(input: {
  chain: ChainLink[]
  breakers: Record<string, BreakerState>   // keyed by provider (or provider/model)
  now: number
  inputTokens: number
  maxOutputTokens?: number
  capUsd: number | null
}): FallbackPlan {
  const hops: FallbackHop[] = []
  const skippedUnhealthy: ChainLink[] = []
  const skippedOverCap: ChainLink[] = []

  input.chain.forEach((link, index) => {
    const key = `${link.provider}/${link.model}`
    const state = input.breakers[key] ?? input.breakers[link.provider]
    if (!isProviderHealthy(state, input.now)) { skippedUnhealthy.push(link); return }
    const estimateUsd = estimateWakeCost(link.model, { inputTokens: input.inputTokens, maxOutputTokens: input.maxOutputTokens })
    // Over the per-wake cap → skip (only when the cap is set AND the cost is known
    // and above it; unknown-priced models are allowed but flagged null, matching
    // preflightWake's philosophy).
    if (input.capUsd != null && input.capUsd > 0 && estimateUsd != null && estimateUsd > input.capUsd) {
      skippedOverCap.push(link); return
    }
    hops.push({ link, index, estimateUsd })
  })

  if (hops.length === 0) {
    const parts: string[] = []
    if (skippedUnhealthy.length) parts.push(`${skippedUnhealthy.length} provider(s) in cooldown`)
    if (skippedOverCap.length) parts.push(`${skippedOverCap.length} over the per-wake cost cap`)
    const why = parts.length ? ` (${parts.join('; ')})` : ''
    return {
      hops, skippedUnhealthy, skippedOverCap, exhausted: true,
      reason: `No LLM provider available for this wake${why}. Task parked — check provider health / raise the per-wake cap, or wait for cooldown.`,
    }
  }
  return { hops, skippedUnhealthy, skippedOverCap, exhausted: false }
}
