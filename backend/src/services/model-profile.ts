// Epic P / P2 — model profiles (Paperclip `modelProfiles` parity).
//
// Each agent gets a PRIMARY model + an optional CHEAP model profile, plus a
// reasoning-effort setting. This module is the PURE decision layer:
//   - resolveModelProfile(): read the profile off an agent row (with the
//     existing `llmModel` as the effective primary when no override is set, so
//     nothing changes for existing agents).
//   - decideModelTier(): pick cheap vs primary for a given turn — cheap for
//     lightweight / ask-mode / low-stakes turns, primary for heavier reasoning /
//     execute turns — with an explicit operator override that wins.
//   - providerForModel(): resolve the provider slug for a chosen model id.
//   - planWakeModel(): the one call the executor makes — profile → routed tier →
//     concrete {provider, model, reasoningEffort}.
//   - mapReasoningEffort(): map low|medium|high to the per-provider request
//     representation (Anthropic thinking budget · OpenAI reasoning_effort ·
//     Gemini thinking budget) so it flows to the live LLM call.
//
// It interoperates with the F1 fallback chain (the routed model is the chain
// HEAD when no explicit chain is configured; an explicit chain stays the
// operator's override), the preflight per-wake cap (which prices the routed
// model), and scoped budgets (a cheap model genuinely lowers spend, and the
// existing cost-rates / unbounded flags still apply — see preflight.ts).
//
// Pure — no DB, no network, no env. The executor + routes wire it in.

import { MODEL_CATALOGUE } from './llm-router'

// ─── Reasoning effort ─────────────────────────────────────────────────────────

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** Parse a stored/inbound reasoning-effort value. Anything unknown → null
 *  (provider default), so a garbled value never silently changes behaviour. */
export function parseReasoningEffort(raw: unknown): ReasoningEffort | null {
  const s = String(raw ?? '').trim().toLowerCase()
  return (REASONING_EFFORTS as readonly string[]).includes(s) ? (s as ReasoningEffort) : null
}

/** The per-provider request representation of a reasoning-effort level. Only the
 *  fields relevant to a provider are set; the router includes them additively and
 *  ONLY when an effort is configured, so default (null-effort) calls are
 *  byte-identical to before. Budgets are conservative and stay below a typical
 *  max_tokens ceiling. */
export interface ReasoningParams {
  /** Anthropic extended-thinking budget_tokens (must be < max_tokens). */
  anthropicThinkingBudget?: number
  /** OpenAI (and OpenAI-compatible reasoning models) `reasoning_effort`. */
  openaiReasoningEffort?: ReasoningEffort
  /** Gemini `thinkingConfig.thinkingBudget`. */
  geminiThinkingBudget?: number
}

const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = { low: 1024, medium: 4096, high: 8192 }
const GEMINI_THINKING_BUDGET: Record<ReasoningEffort, number> = { low: 1024, medium: 4096, high: 8192 }

/** Map a reasoning-effort level to the request params for a given provider.
 *  Returns {} for null effort or a provider with no thinking knob. */
export function mapReasoningEffort(provider: string, effort: ReasoningEffort | null | undefined): ReasoningParams {
  const e = parseReasoningEffort(effort)
  if (!e) return {}
  const p = String(provider ?? '').trim().toLowerCase()
  switch (p) {
    case 'anthropic':
      return { anthropicThinkingBudget: ANTHROPIC_THINKING_BUDGET[e] }
    case 'google':
    case 'gemini':
      return { geminiThinkingBudget: GEMINI_THINKING_BUDGET[e] }
    // OpenAI + every OpenAI-compatible host accept `reasoning_effort` on their
    // reasoning models; non-reasoning models ignore it. Passed through as-is.
    default:
      return { openaiReasoningEffort: e }
  }
}

// ─── Profile ──────────────────────────────────────────────────────────────────

/** The fallback default when an agent has no model configured at all. Matches
 *  the `agents.llm_model` column default. */
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

export interface ModelProfile {
  /** effective primary model — primaryModel override, else llmModel, else default. */
  primary: string
  /** the cheaper tier model id, or null when unconfigured. */
  cheap: string | null
  /** cheap tier actually usable (enabled AND a cheap model is set). */
  cheapEnabled: boolean
  reasoningEffort: ReasoningEffort | null
}

/** The subset of an agent row this module reads. Accepts booleans or 0/1 for the
 *  enabled flag (Drizzle boolean-mode vs a raw libSQL row). */
export interface AgentModelRow {
  llmModel?: string | null
  llmProvider?: string | null
  primaryModel?: string | null
  cheapModel?: string | null
  cheapModelEnabled?: boolean | number | null
  reasoningEffort?: string | null
}

const trimOr = (v: string | null | undefined): string | null => {
  const s = String(v ?? '').trim()
  return s ? s : null
}

/** Build the resolved profile from an agent row. `primaryModel` overrides
 *  `llmModel`; when neither is set the module default is used. The cheap tier is
 *  only "enabled" when the flag is truthy AND a cheap model is actually set. */
export function resolveModelProfile(a: AgentModelRow, opts: { defaultModel?: string } = {}): ModelProfile {
  const def = opts.defaultModel ?? DEFAULT_MODEL
  const primary = trimOr(a.primaryModel) ?? trimOr(a.llmModel) ?? def
  const cheap = trimOr(a.cheapModel)
  const flag = a.cheapModelEnabled === true || a.cheapModelEnabled === 1
  return { primary, cheap, cheapEnabled: flag && !!cheap, reasoningEffort: parseReasoningEffort(a.reasoningEffort) }
}

// ─── Tier routing ─────────────────────────────────────────────────────────────

export const MODEL_TIERS = ['primary', 'cheap'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export type RouteStakes = 'low' | 'high'
export type TierOverride = ModelTier | 'auto'

/** Parse an explicit tier override (from deployConfig / a caller). `primary` |
 *  `cheap` force a tier; `auto` (or anything unknown) → let the router decide. */
export function parseTierOverride(raw: unknown): TierOverride | null {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'primary' || s === 'cheap' || s === 'auto') return s
  return null
}

/** Read an explicit tier override from an org's deployConfig. Prefers a per-agent
 *  key (`modelTierOverride:<agentId>`) over the org default (`modelTierOverride`). */
export function parseTierOverrideConfig(
  deployConfig: Record<string, unknown> | null | undefined,
  agentId?: string | null,
): TierOverride | null {
  const cfg = (deployConfig ?? {}) as Record<string, unknown>
  const raw = (agentId && cfg[`modelTierOverride:${agentId}`]) ?? cfg.modelTierOverride
  return parseTierOverride(raw)
}

export interface ModelRouteInput {
  profile: ModelProfile
  /** task work mode — 'ask' (lightweight single-turn) routes cheap. */
  workMode?: string | null
  /** orchestration / synthesis = heavier reasoning → primary. */
  isOrchestrator?: boolean
  /** explicit stakes hint from the caller: 'low' → cheap, 'high' → primary. */
  stakes?: RouteStakes | null
  /** explicit tier override — 'primary'|'cheap' win over auto routing. */
  override?: TierOverride | string | null
}

export interface ModelRouteDecision {
  tier: ModelTier
  model: string
  reason: string
}

const isAskMode = (workMode: string | null | undefined): boolean =>
  String(workMode ?? '').trim().toLowerCase() === 'ask'

/**
 * Decide which model tier to run this turn.
 * Order: cheap-availability gate → explicit override → stakes hint → ask-mode →
 * orchestrator → default. The DEFAULT for an ordinary execute turn is PRIMARY
 * (heavier reasoning); cheap is reserved for lightweight / ask / low-stakes work.
 */
export function decideModelTier(input: ModelRouteInput): ModelRouteDecision {
  const { profile } = input
  const primary = (reason: string): ModelRouteDecision => ({ tier: 'primary', model: profile.primary, reason })

  // Cheap tier not usable → always primary (existing behaviour for every agent
  // that hasn't opted in).
  if (!profile.cheapEnabled || !profile.cheap) {
    return primary(profile.cheap ? 'cheap profile disabled → primary' : 'no cheap model configured → primary')
  }
  const cheap = (reason: string): ModelRouteDecision => ({ tier: 'cheap', model: profile.cheap as string, reason })

  const ov = parseTierOverride(input.override)
  if (ov === 'primary') return primary('explicit override → primary')
  if (ov === 'cheap') return cheap('explicit override → cheap')

  if (input.stakes === 'high') return primary('high-stakes turn → primary')
  if (input.stakes === 'low') return cheap('low-stakes turn → cheap')
  if (isAskMode(input.workMode)) return cheap('ask-mode (lightweight Q&A) → cheap')
  if (input.isOrchestrator) return primary('orchestration/synthesis (heavier reasoning) → primary')
  return primary('execute turn → primary')
}

// ─── Provider resolution ──────────────────────────────────────────────────────

// Reverse index: model id → provider slug, built lazily from the catalogue.
// Lazy (not an init-time IIFE) to avoid a circular-import init race: llm-router
// imports mapReasoningEffort from here, and MODEL_CATALOGUE is defined lower in
// llm-router, so it must only be read at call time — never at module init.
let _modelToProvider: Record<string, string> | null = null
function modelToProvider(): Record<string, string> {
  if (_modelToProvider) return _modelToProvider
  const idx: Record<string, string> = {}
  for (const [provider, models] of Object.entries(MODEL_CATALOGUE)) {
    for (const m of models) idx[m.id] = provider
  }
  _modelToProvider = idx
  return idx
}

/** Infer the provider slug for a model id from its prefix (used for custom /
 *  uncatalogued models). Mirrors llm-fallback's parseChainLink inference. */
function inferProviderFromModel(model: string): string | null {
  const t = String(model ?? '').trim().toLowerCase()
  if (!t) return null
  if (t.startsWith('claude')) return 'anthropic'
  if (t.startsWith('gpt') || t.startsWith('o1') || t.startsWith('o3') || t.startsWith('o4')) return 'openai'
  if (t.startsWith('gemini')) return 'google'
  if (t.startsWith('deepseek')) return 'deepseek'
  if (t.startsWith('kimi') || t.startsWith('moonshot')) return 'moonshot'
  if (t.startsWith('qwen')) return 'qwen'
  if (t.startsWith('minimax')) return 'minimax'
  return null
}

/**
 * Resolve the provider slug that should serve a chosen model id.
 * Prefers the catalogue mapping (exact), then a prefix inference, then the
 * agent's configured provider — so a same-provider cheap model (Opus→Haiku)
 * routes correctly, a cross-provider cheap model (Opus→gpt-4o-mini) is inferred,
 * and a fully-custom local model falls back to the agent's own provider.
 */
export function providerForModel(model: string, fallbackProvider: string): string {
  const id = String(model ?? '').trim()
  if (!id) return fallbackProvider
  return modelToProvider()[id] ?? inferProviderFromModel(id) ?? fallbackProvider
}

// ─── The executor's one call ──────────────────────────────────────────────────

// ─── Config surface (routes) ───────────────────────────────────────────────────

const MAX_MODEL_ID_LEN = 200
/** Trim a submitted model id → string, or null when empty. Bounds the length so
 *  a garbage payload can't bloat the row. */
function normModelId(v: unknown): string | null {
  const s = String(v ?? '').trim().slice(0, MAX_MODEL_ID_LEN)
  return s ? s : null
}

export interface ModelProfilePatchInput {
  primaryModel?: unknown
  cheapModel?: unknown
  cheapModelEnabled?: unknown
  reasoningEffort?: unknown
}
export type ModelProfilePatchResult =
  | { ok: true; set: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Validate + normalize a model-profile PUT body into a DB patch. Only keys
 * PRESENT in the body are set (partial update). Empty model ids clear the
 * override (→ null → the agent's `llmModel` stays primary). reasoningEffort must
 * parse to low|medium|high or be empty (→ null = provider default). Pure — the
 * route persists the returned `set`. */
export function buildModelProfilePatch(input: ModelProfilePatchInput): ModelProfilePatchResult {
  const set: Record<string, unknown> = {}
  if ('primaryModel' in input) set.primaryModel = normModelId(input.primaryModel)
  if ('cheapModel' in input) set.cheapModel = normModelId(input.cheapModel)
  if ('cheapModelEnabled' in input) {
    set.cheapModelEnabled = input.cheapModelEnabled === true || input.cheapModelEnabled === 1 || input.cheapModelEnabled === '1' || input.cheapModelEnabled === 'true'
  }
  if ('reasoningEffort' in input) {
    const raw = input.reasoningEffort
    if (raw == null || String(raw).trim() === '') set.reasoningEffort = null
    else {
      const e = parseReasoningEffort(raw)
      if (!e) return { ok: false, error: `reasoningEffort must be one of ${REASONING_EFFORTS.join(' | ')} (or empty)` }
      set.reasoningEffort = e
    }
  }
  return { ok: true, set }
}

export interface ModelOption { id: string; label: string; provider: string; tier: string; custom?: boolean }

/** Flatten the built-in catalogue + any operator custom-model entries (from the
 *  S8 `arturita_llm_chain`) into a single selectable list for the config UI.
 *  Custom entries are de-duplicated against the catalogue by model id. Pure. */
export function flattenModelOptions(
  custom: Array<{ provider?: string | null; model?: string | null; label?: string | null }> = [],
): ModelOption[] {
  const out: ModelOption[] = []
  const seen = new Set<string>()
  for (const [provider, models] of Object.entries(MODEL_CATALOGUE)) {
    for (const m of models) { out.push({ id: m.id, label: m.label, provider, tier: m.tier }); seen.add(m.id) }
  }
  for (const c of custom) {
    const id = String(c?.model ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: (c.label && String(c.label).trim()) || `${c.provider ?? 'custom'} · ${id}`, provider: String(c.provider ?? 'custom'), tier: 'custom', custom: true })
  }
  return out
}

export interface WakeModelPlan {
  tier: ModelTier
  model: string
  provider: string
  reasoningEffort: ReasoningEffort | null
  reason: string
}

/**
 * Plan the concrete model for a wake: resolve the profile, route the tier, and
 * resolve the provider for the chosen model. This is what the executor + ask
 * path call to pick the model that then becomes the F1 chain head (when no
 * explicit chain is set) and is priced by the preflight cap.
 */
export function planWakeModel(
  agent: AgentModelRow,
  ctx: { workMode?: string | null; isOrchestrator?: boolean; stakes?: RouteStakes | null; override?: TierOverride | string | null } = {},
): WakeModelPlan {
  const profile = resolveModelProfile(agent)
  const decision = decideModelTier({ profile, ...ctx })
  const provider = providerForModel(decision.model, trimOr(agent.llmProvider) ?? 'anthropic')
  return { ...decision, provider, reasoningEffort: profile.reasoningEffort }
}
