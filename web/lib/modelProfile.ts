// Epic P / P2 — model profiles (pure UI logic, mirrors backend
// services/model-profile.ts). Framework-free + unit-tested (web zero-dep runner):
// reasoning-effort parsing, cheap-tier usability, a colorblind-safe tier/effort
// badge (icon + word carry meaning — never color alone), and a plain-language
// routing summary for the config surface.

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
/** '' = provider default (no explicit effort). */
export type ReasoningEffortField = ReasoningEffort | ''

export type ModelTier = 'primary' | 'cheap'

export interface ModelProfileFields {
  /** explicit primary override; '' → the agent's llmModel stays primary. */
  primaryModel: string
  cheapModel: string
  cheapModelEnabled: boolean
  reasoningEffort: ReasoningEffortField
}

/** Parse a stored/inbound effort → 'low'|'medium'|'high' or '' (default). */
export function parseReasoningEffort(raw: string | null | undefined): ReasoningEffortField {
  const s = String(raw ?? '').trim().toLowerCase()
  return (REASONING_EFFORTS as readonly string[]).includes(s) ? (s as ReasoningEffort) : ''
}

/** The cheap tier only does anything when it's enabled AND a cheap model is set. */
export function cheapUsable(f: Pick<ModelProfileFields, 'cheapModel' | 'cheapModelEnabled'>): boolean {
  return !!f.cheapModelEnabled && String(f.cheapModel ?? '').trim().length > 0
}

/** Colorblind-safe tier badge: a shape + a WORD carry the meaning; the tone is a
 *  redundant cue, never the sole signal. Cheap = 🪙 (positive/ok), primary = ◆
 *  (neutral/muted). */
export function tierBadge(tier: ModelTier): { icon: string; label: string; tone: 'ok' | 'muted' } {
  return tier === 'cheap'
    ? { icon: '🪙', label: 'Cheap', tone: 'ok' }
    : { icon: '◆', label: 'Primary', tone: 'muted' }
}

/** Colorblind-safe effort badge (icon + word). Default (no effort) → provider
 *  default, shown muted. */
export function effortBadge(effort: ReasoningEffortField): { icon: string; label: string; tone: 'muted' | 'warn' } {
  switch (parseReasoningEffort(effort)) {
    case 'high':   return { icon: '🧠', label: 'High effort', tone: 'warn' }
    case 'medium': return { icon: '≋', label: 'Medium effort', tone: 'muted' }
    case 'low':    return { icon: '·', label: 'Low effort', tone: 'muted' }
    default:       return { icon: '—', label: 'Default effort', tone: 'muted' }
  }
}

/** Plain-language description of how turns route for this profile. Matches the
 *  backend decideModelTier: cheap for ask/low-stakes, primary for execute. */
export function routingSummary(f: Pick<ModelProfileFields, 'cheapModel' | 'cheapModelEnabled'>): string {
  return cheapUsable(f)
    ? 'Ask-mode & low-stakes turns → cheap model · execute & heavier reasoning → primary'
    : 'Single model (primary) for every turn — enable a cheap model to route light turns cheaper'
}

/** The effective primary a user sees: the explicit override, else the fallback
 *  (agent llmModel), else a dash. Pure display helper. */
export function effectivePrimary(f: Pick<ModelProfileFields, 'primaryModel'>, fallbackModel: string | null | undefined): string {
  return String(f.primaryModel ?? '').trim() || String(fallbackModel ?? '').trim() || '—'
}
