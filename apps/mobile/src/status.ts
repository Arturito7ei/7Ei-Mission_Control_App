// MOB-6b — the status vocabulary, ported from `web/app/dashboard/status.ts`.
//
// The web's table is the source of truth for what a status MEANS: which
// synonyms collapse onto which canonical row, and which glyph carries that row.
// This file ports the canonicalisation + glyph verbatim and swaps only the one
// thing that cannot cross the boundary: the web returns CSS `var()` strings,
// which mean nothing to react-native, so the colour is resolved to a `Chip`
// tone against our own palette instead.
//
// Colorblind rule (unchanged from the web, and the reason the glyph is ported
// rather than re-invented): the operator is red-green colorblind, so a status is
// ALWAYS label + glyph. The tone is decoration on top of a signal that already
// reads without it — never the signal itself.
//
// `status.test.ts` imports the web module and asserts the canonicalisation and
// the glyphs still agree. Copy without a tripwire = silent drift.

/** The canonical rows — identical to the web's `CanonicalStatus`. */
export type CanonicalStatus =
  | 'active' | 'idle' | 'pending' | 'done' | 'paused' | 'blocked' | 'failed' | 'info'

/**
 * Chip tones this module resolves to. Declared here rather than imported from
 * `ui.tsx` on purpose: that module imports react-native, and importing it —
 * even as a type — would stop this file loading under `node --test`, which is
 * exactly what the tripwire needs it to do. `Chip`'s prop type is structurally
 * the same union; a drift between them is a typecheck error at the call site.
 */
export type StatusTone = 'info' | 'ok' | 'warn' | 'danger' | 'delegate' | 'neutral'

// Domain synonyms → canonical rows. A verbatim port of the web's ALIAS map;
// the tripwire pins it.
const ALIAS: Record<string, CanonicalStatus> = {
  in_progress: 'active', running: 'active',
  todo: 'pending', assigned: 'pending', 'to do': 'pending',
  stopped: 'failed', terminated: 'failed', error: 'failed', stale: 'failed', orphaned: 'failed',
  review: 'info', 'in review': 'info', attention: 'info',
}

const ICON: Record<CanonicalStatus, string> = {
  active: '⬡', idle: '○', pending: '○', done: '✓', paused: '⏸', blocked: '⛔', failed: '✕', info: 'ℹ',
}

// The web maps `active` to the accent (purple), NOT green — a deliberate
// DESIGN_SYSTEM v2 rule, since green/red is the pair the operator cannot see.
// 'delegate' is our purple chip, so active lands there and `done` takes the ✓+ok
// pairing. Same intent, our palette.
const TONE: Record<CanonicalStatus, StatusTone> = {
  active: 'delegate',
  idle: 'neutral',
  pending: 'neutral',
  done: 'ok',
  paused: 'warn',
  blocked: 'danger',
  failed: 'danger',
  info: 'info',
}

/** Collapse any domain synonym onto its canonical row (unknown → 'idle'). */
export function canonicalStatus(status: string | undefined | null): CanonicalStatus {
  const k = (status ?? '').toLowerCase()
  if (k in ICON) return k as CanonicalStatus
  return ALIAS[k] ?? 'idle'
}

/** The glyph carrying the status — always rendered beside the label. */
export function statusIcon(status: string | undefined | null): string {
  return ICON[canonicalStatus(status)]
}

/** The chip tone for a status. Decoration only — never the sole signal. */
export function statusTone(status: string | undefined | null): StatusTone {
  return TONE[canonicalStatus(status)]
}

// Heartbeats map onto the same table, exactly as the web's HEARTBEAT_STATUS
// does: green = running → active, amber → paused, stale → failed, else idle.
export const HEARTBEAT_STATUS: Record<string, CanonicalStatus> = {
  green: 'active', amber: 'paused', stale: 'failed', unknown: 'idle',
}

/** A heartbeat's canonical row (via the web's heartbeat mapping). */
export function heartbeatStatus(h: string | undefined | null): CanonicalStatus {
  return HEARTBEAT_STATUS[(h ?? '').toLowerCase()] ?? 'idle'
}
