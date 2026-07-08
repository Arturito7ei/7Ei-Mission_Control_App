// Epic P / P1 — low-trust review mode (pure UI logic, mirrors backend
// services/review.ts). Kept framework-free + unit-tested (web zero-dep runner):
// trust-mode parsing, boundary field <-> list marshalling, and colorblind-safe
// badge descriptors (icon + label + shape/tone — never color alone).

export const TRUST_MODES = ['standard', 'low_trust_review'] as const
export type TrustMode = (typeof TRUST_MODES)[number]

export interface TrustBoundary { projects: string[]; tasks: string[]; agents: string[] }

/** Default (and any unknown value) → standard, matching the backend: a garbled
 *  value never silently lowers containment. */
export function parseTrustMode(m: string | null | undefined): TrustMode {
  return String(m ?? '').trim().toLowerCase() === 'low_trust_review' ? 'low_trust_review' : 'standard'
}
export function isLowTrust(m: string | null | undefined): boolean {
  return parseTrustMode(m) === 'low_trust_review'
}

const cleanList = (s: string): string[] =>
  Array.from(new Set(String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean)))

/** Marshal three comma-separated editor fields → a normalized boundary. */
export function parseBoundaryFields(f: { projects?: string; tasks?: string; agents?: string }): TrustBoundary {
  return { projects: cleanList(f.projects ?? ''), tasks: cleanList(f.tasks ?? ''), agents: cleanList(f.agents ?? '') }
}

/** Un-marshal a boundary back into editor fields (comma-joined). */
export function boundaryToFields(b?: Partial<TrustBoundary> | null): { projects: string; tasks: string; agents: string } {
  return {
    projects: (b?.projects ?? []).join(', '),
    tasks: (b?.tasks ?? []).join(', '),
    agents: (b?.agents ?? []).join(', '),
  }
}

export function boundaryCount(b?: Partial<TrustBoundary> | null): number {
  return (b?.projects?.length ?? 0) + (b?.tasks?.length ?? 0) + (b?.agents?.length ?? 0)
}

/** Colorblind-safe badge: icon + label + tone (shape/word carry meaning, not
 *  color alone). Low-trust = 🛡 shield / amber; standard = ● / muted. */
export function trustBadge(mode: string | null | undefined): { icon: string; label: string; tone: 'muted' | 'warn' } {
  return isLowTrust(mode)
    ? { icon: '🛡', label: 'Low-trust review', tone: 'warn' }
    : { icon: '●', label: 'Standard', tone: 'muted' }
}

/** A low-trust agent with an EMPTY boundary can touch nothing — surface it so
 *  the operator doesn't accidentally strand an agent. */
export function isContainedToNothing(mode: string | null | undefined, b?: Partial<TrustBoundary> | null): boolean {
  return isLowTrust(mode) && boundaryCount(b) === 0
}

/** The approval_requests.type the quarantine queue reuses. */
export const REVIEW_CASE_TYPE = 'low_trust_review'
export function isReviewCase(type: string | null | undefined): boolean {
  return String(type ?? '') === REVIEW_CASE_TYPE
}
