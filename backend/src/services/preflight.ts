// Per-wake preflight budget cap + cheap-model config validation (MCA-84 V3,
// Paperclip gap G9). Two small, pure levers on top of the existing budget/cost
// code:
//   1. Preflight cap — before a wake runs the LLM, bound its worst-case cost
//      (full input context + a full max_tokens completion at the model's rates)
//      and refuse the wake if it would exceed a configured per-wake ceiling. This
//      is orthogonal to the cumulative scoped budgets in budget.ts: those stop an
//      agent once *total* spend crosses a limit; this stops a *single* wake from
//      being surprisingly expensive (a runaway context, an accidental Opus swap).
//   2. Model config validation — flag agents configured with models that have no
//      pricing entry (spend can't be tracked or capped) or whose output rate is
//      above a "cheap" threshold, so an operator can audit who runs what.
// Both are pure functions; the executor and the /preflight route wire them in.

import { COST_RATES } from './llm-router'

// llm-router's default max_tokens per completion — the output ceiling we price
// the worst case against.
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

// Rough tokens ≈ chars / 4 (English-ish). Only used to bound cost, so a coarse
// over-estimate is the safe direction.
export const CHARS_PER_TOKEN = 4

// System prompt + injected context (memory, RAG, hierarchy, goals) that the
// executor always prepends. A flat allowance so the preflight estimate isn't
// wildly under the real input size before that prompt is built.
export const SYSTEM_PROMPT_TOKEN_ALLOWANCE = 2000

// A model counts as "cheap" when its output rate is at or below this ($/token).
// 0.000005 = $5 per 1M output tokens: passes Haiku, GPT-4o-mini, the Flash/
// DeepSeek/Qwen-turbo tiers and every local (0-cost) model; flags Sonnet, Opus,
// GPT-4o and the other power tiers.
export const CHEAP_OUTPUT_RATE = 0.000005

/** Coarse token estimate for a set of prompt fragments (input, history, …). */
export function estimateInputTokens(parts: Array<string | null | undefined>): number {
  let chars = 0
  for (const p of parts) chars += (p ?? '').length
  return Math.ceil(chars / CHARS_PER_TOKEN) + SYSTEM_PROMPT_TOKEN_ALLOWANCE
}

/** Worst-case USD cost of one wake: the full input priced at the input rate plus
 *  a full max_tokens completion at the output rate. Returns null when the model
 *  has no pricing entry — cost can't be bounded, so a cap can't be enforced. */
export function estimateWakeCost(
  model: string,
  opts: { inputTokens: number; maxOutputTokens?: number },
): number | null {
  const rates = COST_RATES[model]
  if (!rates) return null
  const out = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  return opts.inputTokens * rates.input + out * rates.output
}

export interface PreflightDecision {
  allowed: boolean
  estimateUsd: number | null
  capUsd: number | null
  /** true when the model has no pricing entry, so the cap could not be applied. */
  unbounded: boolean
  reason?: string
}

/** Decide whether a wake fits under the per-wake cap. A null/≤0 cap means "no
 *  cap" (always allowed). Unknown pricing can't be bounded, so it is allowed but
 *  flagged `unbounded` — validation surfaces those models for an operator to fix
 *  rather than silently blocking a working custom/local runtime. */
export function preflightWake(
  model: string,
  opts: { inputTokens: number; maxOutputTokens?: number; capUsd: number | null },
): PreflightDecision {
  const cap = opts.capUsd
  const estimateUsd = estimateWakeCost(model, opts)
  if (cap == null || cap <= 0) {
    return { allowed: true, estimateUsd, capUsd: null, unbounded: estimateUsd === null }
  }
  if (estimateUsd === null) {
    return {
      allowed: true, estimateUsd: null, capUsd: cap, unbounded: true,
      reason: `Per-wake cap $${cap} set but model "${model}" has no pricing — cost cannot be bounded; wake allowed. Configure a priced model to enforce the cap.`,
    }
  }
  if (estimateUsd > cap) {
    return {
      allowed: false, estimateUsd, capUsd: cap, unbounded: false,
      reason: `Preflight cap: worst-case wake cost $${estimateUsd.toFixed(4)} exceeds the per-wake cap $${cap.toFixed(2)} for model "${model}". Wake skipped; task parked for review.`,
    }
  }
  return { allowed: true, estimateUsd, capUsd: cap, unbounded: false }
}

/** Read the per-wake cap from an org's deployConfig. An optional per-agent
 *  override (`maxCostPerWakeUsd:<agentId>`) wins over the org default
 *  (`maxCostPerWakeUsd`). Missing / non-numeric / ≤0 → null (no cap). */
export function parseCapUsd(
  deployConfig: Record<string, string> | null | undefined,
  agentId?: string | null,
): number | null {
  const cfg = deployConfig ?? {}
  const raw = (agentId && cfg[`maxCostPerWakeUsd:${agentId}`]) || cfg.maxCostPerWakeUsd
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export type ModelConfigLevel = 'ok' | 'warn'
export interface ModelConfigValidation {
  model: string
  knownPricing: boolean
  inputRate: number | null
  outputRate: number | null
  /** worst-case cost of a bare wake (allowance input + full completion), for display */
  estMaxWakeCostUsd: number | null
  level: ModelConfigLevel
  issues: string[]
}

/** Validate one agent's model config: is the model priced (spend trackable /
 *  cappable), and is it within the "cheap" output-rate threshold? */
export function validateModelConfig(
  model: string,
  opts: { cheapMaxOutputRate?: number; maxOutputTokens?: number } = {},
): ModelConfigValidation {
  const cheap = opts.cheapMaxOutputRate ?? CHEAP_OUTPUT_RATE
  const rates = COST_RATES[model]
  const issues: string[] = []
  let level: ModelConfigLevel = 'ok'
  if (!rates) {
    level = 'warn'
    issues.push(`No pricing entry for "${model}" — spend cannot be tracked or capped.`)
    return { model, knownPricing: false, inputRate: null, outputRate: null, estMaxWakeCostUsd: null, level, issues }
  }
  if (rates.output > cheap) {
    level = 'warn'
    issues.push(`Output rate $${(rates.output * 1_000_000).toFixed(2)}/M exceeds the cheap threshold $${(cheap * 1_000_000).toFixed(2)}/M.`)
  }
  const estMaxWakeCostUsd = estimateWakeCost(model, {
    inputTokens: SYSTEM_PROMPT_TOKEN_ALLOWANCE, maxOutputTokens: opts.maxOutputTokens,
  })
  return { model, knownPricing: true, inputRate: rates.input, outputRate: rates.output, estMaxWakeCostUsd, level, issues }
}

export interface RosterAgent { id: string; name: string; llmModel?: string | null; llmProvider?: string | null }
export interface RosterValidationRow extends ModelConfigValidation {
  agentId: string
  agentName: string
  provider: string | null
}

/** Validate every agent's model config; returns per-agent rows plus a count of
 *  those needing attention. Pure — the route fetches the roster and cap. */
export function validateRoster(
  agents: RosterAgent[],
  opts: { cheapMaxOutputRate?: number; maxOutputTokens?: number } = {},
): { rows: RosterValidationRow[]; warnCount: number } {
  const rows = agents.map(a => {
    const model = a.llmModel ?? 'claude-sonnet-4-20250514'
    return { agentId: a.id, agentName: a.name, provider: a.llmProvider ?? null, ...validateModelConfig(model, opts) }
  })
  return { rows, warnCount: rows.filter(r => r.level === 'warn').length }
}
