// MOB-6f — Governance's pure half. No React, no react-native, so
// `governance.test.ts` can load it AND the web's `lib/trust.ts` under
// `node --test` and assert the two agree.
//
// WHAT CARRIES OVER, AND WHAT DOESN'T
//
// The web's Governance panel (web/app/dashboard/GovernancePanel.tsx) is four
// sections, and every one of them is an EDITOR wrapped around a reading:
//
//   * Execution policies    — a list, plus add/remove
//   * Per-agent permissions — a capability list, plus a text field + Save
//   * Trust & containment   — a mode + boundary set, plus a select + Save (owner)
//   * Config revisions      — a history, plus one-click rollback
//
// The phone keeps all four READINGS and none of the four editors. That is not
// timidity about screen size: this is the surface that decides what an agent is
// allowed to do, and a mis-tap on a phone — approving a capability, lowering a
// trust boundary, rolling back a config — is not a gesture you can take back.
// The readings are what an operator away from their desk actually needs ("is
// this agent still contained?"), and they carry no such risk. Writes are
// DEFERRED, not dropped — parity doc §6.7 names the story.
//
// THE TRUST VOCABULARY IS THE WEB'S, MIRRORED. `parseTrustMode`, `trustBadge`
// and `isContainedToNothing` are re-implemented here (Metro cannot import from
// web/) and pinned to the web's originals by the tripwire. Whether an agent
// reads as "contained" must not depend on which device you picked up — that
// sentence IS the screen.

/** An execution policy row, as `GET …/policies` returns it. */
export interface PolicyLite {
  id: string
  action: string
  /** SQLite integer boolean — 1/0, not true/false (schema.ts: `integer`). */
  requiresApproval: number | boolean | null
}

/**
 * The governance columns the agents list returns inline. A SUPERSET-tolerant
 * subset of `GET …/agents` — the same endpoint the roster uses, because it is
 * the same endpoint the web's Governance panel uses. `permissions` and
 * `trustBoundary` are JSON-encoded TEXT columns, hence the string type.
 */
export interface GovAgentLite {
  id: string
  name: string
  avatarEmoji?: string | null
  permissions?: string | null
  trustMode?: string | null
  trustBoundary?: string | null
  llmModel?: string | null
  primaryModel?: string | null
  cheapModel?: string | null
  cheapModelEnabled?: boolean | number | null
}

/** A config revision, as `GET …/revisions` returns it. */
export interface RevisionLite {
  id: string
  entity: string
  entityId: string
  actor?: string | null
  createdAt: number
}

/** Said on the screen, not just here: why there are no Save buttons. */
export const GOVERNANCE_READONLY_NOTE =
  'Read-only on the phone. Adding a policy, editing permissions, changing a trust tier, and rolling back a revision are done on the desktop — a mis-tap here would change what an agent is allowed to do.'

// ─── Trust — MIRRORED from web/lib/trust.ts (pinned by governance.test.ts) ────

export const TRUST_MODES = ['standard', 'low_trust_review'] as const
export type TrustModeLite = (typeof TRUST_MODES)[number]

export interface TrustBoundaryLite {
  projects: string[]
  tasks: string[]
  agents: string[]
}

/**
 * Default (and any unknown value) → standard, matching the web AND the backend:
 * a garbled value never silently lowers containment.
 */
export function parseTrustMode(m: string | null | undefined): TrustModeLite {
  return String(m ?? '').trim().toLowerCase() === 'low_trust_review' ? 'low_trust_review' : 'standard'
}

export function isLowTrust(m: string | null | undefined): boolean {
  return parseTrustMode(m) === 'low_trust_review'
}

/** Parse the `trustBoundary` TEXT column. A garbled value reads as empty. */
export function parseBoundary(json: string | null | undefined): TrustBoundaryLite {
  try {
    const b = json ? JSON.parse(json) : {}
    return {
      projects: Array.isArray(b?.projects) ? b.projects : [],
      tasks: Array.isArray(b?.tasks) ? b.tasks : [],
      agents: Array.isArray(b?.agents) ? b.agents : [],
    }
  } catch {
    return { projects: [], tasks: [], agents: [] }
  }
}

export function boundaryCount(b?: Partial<TrustBoundaryLite> | null): number {
  return (b?.projects?.length ?? 0) + (b?.tasks?.length ?? 0) + (b?.agents?.length ?? 0)
}

/**
 * Colorblind-safe badge — icon + label + tone, never hue alone (theme.ts). A
 * MIRROR of the web's `trustBadge`, tone vocabulary included.
 */
export function trustBadge(mode: string | null | undefined): {
  icon: string
  label: string
  tone: 'muted' | 'warn'
} {
  return isLowTrust(mode)
    ? { icon: '🛡', label: 'Low-trust review', tone: 'warn' }
    : { icon: '●', label: 'Standard', tone: 'muted' }
}

/**
 * A low-trust agent with an EMPTY boundary can touch nothing. The web surfaces
 * it so the operator doesn't accidentally strand an agent; the phone surfaces it
 * so the operator can SEE they already did.
 */
export function isContainedToNothing(
  mode: string | null | undefined,
  b?: Partial<TrustBoundaryLite> | null,
): boolean {
  return isLowTrust(mode) && boundaryCount(b) === 0
}

/** The boundary set as one line — the web's three editor fields, read-only. */
export function boundaryLine(b: TrustBoundaryLite): string {
  const parts = [
    b.projects.length ? `${b.projects.length} project${b.projects.length === 1 ? '' : 's'}` : '',
    b.tasks.length ? `${b.tasks.length} task${b.tasks.length === 1 ? '' : 's'}` : '',
    b.agents.length ? `${b.agents.length} agent${b.agents.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No boundary set'
}

// ─── Permissions ─────────────────────────────────────────────────────────────

/**
 * The capability wildcards the web hints at. COPIED from GovernancePanel.tsx's
 * `CAP_HINTS` — a constant that lives inside a JSX component module, so it
 * cannot be import-tripwired the way `trust.ts` can. Named here as a copy so the
 * next reader knows to check both. (Cosmetic if it drifts: it's a hint string,
 * not a rule the backend enforces.)
 */
export const CAP_HINTS = ['memory:write', 'attachment:write', 'connector:*', '*']

/** Parse the `permissions` TEXT column. A garbled value reads as empty. */
export function parseCaps(p: string | null | undefined): string[] {
  try {
    const v = p ? JSON.parse(p) : []
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/**
 * THE TRAP THIS EXISTS FOR: an EMPTY capability list means **allow all**, not
 * "allowed nothing". The web says so in its hint ("Empty = allow all") and its
 * placeholder ("allow all (empty)"); the backend agrees (`permissions == null/[]`
 * → legacy allow-all, services/code-executor.ts). A read-only list that rendered
 * an empty array as "none" would tell the operator an agent is locked down when
 * it is in fact unrestricted — the single most dangerous thing this screen could
 * get backwards. So the empty case is a LABEL, not a blank.
 */
export function capsLabel(p: string | null | undefined): {
  label: string
  caps: string[]
  allowAll: boolean
} {
  const caps = parseCaps(p)
  return caps.length === 0
    ? { label: 'Allow all', caps: [], allowAll: true }
    : { label: caps.join(' · '), caps, allowAll: false }
}

// ─── Policies ────────────────────────────────────────────────────────────────

/**
 * The web renders `requiresApproval` as a two-tone pill: "requires approval"
 * (warn) or "allowed" (muted). Mirrored, plus a glyph — the phone never leans on
 * hue.
 */
export function policyBadge(p: PolicyLite): { icon: string; label: string; tone: 'muted' | 'warn' } {
  return p.requiresApproval
    ? { icon: '⏸', label: 'requires approval', tone: 'warn' }
    : { icon: '▸', label: 'allowed', tone: 'muted' }
}

// ─── Revisions ───────────────────────────────────────────────────────────────

/** `entity` + a short id — what the web's revision row leads with. */
export function revisionTitle(r: RevisionLite): string {
  return `${r.entity} · ${shortId(r.entityId)}`
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** "who, when" — actor falls back honestly rather than inventing a system user. */
export function revisionSubtitle(r: RevisionLite, now: number): string {
  return `${r.actor?.trim() || 'unknown actor'} · ${relTime(r.createdAt, now)}`
}

/**
 * `now` is a parameter, not `Date.now()`, so the tests are deterministic and the
 * screen keeps one clock per render rather than one per row.
 */
export function relTime(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

/**
 * The web's revision list is unbounded; the phone renders the newest 50. The
 * backend already orders newest-first, so this is a slice, not a sort — and it
 * is a DISPLAY cap on a history feed, not a limit on what the operator can act
 * on (they can't act on it here at all).
 */
export const REVISION_DISPLAY_LIMIT = 50

export function revisionRows(revisions: RevisionLite[]): RevisionLite[] {
  return revisions.slice(0, REVISION_DISPLAY_LIMIT)
}
