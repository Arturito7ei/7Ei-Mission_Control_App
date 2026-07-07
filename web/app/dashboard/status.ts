// MCA-86 — colorblind-safe status helpers, ported from the DESIGN_SYSTEM.md v2
// status table (v1 canonical). The user is red-green colorblind:
//   1. never red vs green as the only differentiator,
//   2. ACTIVE = PURPLE, not green,
//   3. color is always paired with an icon or a text label — every
//      statusColor() call site must render statusIcon() (or a label) adjacent.
// Returns CSS var() strings so values follow the light/dark theme map.

export type CanonicalStatus = 'active' | 'idle' | 'pending' | 'done' | 'paused' | 'blocked' | 'failed' | 'info'

// Domain synonyms → canonical table rows (task/agent/run/Jira vocabularies).
const ALIAS: Record<string, CanonicalStatus> = {
  in_progress: 'active', running: 'active',
  todo: 'pending', assigned: 'pending', 'to do': 'pending',
  stopped: 'failed', terminated: 'failed', error: 'failed', stale: 'failed', orphaned: 'failed',
  review: 'info', 'in review': 'info', attention: 'info',
}

const COLOR: Record<CanonicalStatus, string> = {
  active: 'var(--accent)',        // ⬡ purple — Zeus on light, Aztec on dark
  idle: 'var(--muted)',
  pending: 'var(--muted)',
  done: 'var(--ok)',
  paused: 'var(--warn)',
  blocked: 'var(--danger-text)',
  failed: 'var(--danger-text)',
  info: 'var(--info)',
}

const ICON: Record<CanonicalStatus, string> = {
  active: '⬡', idle: '○', pending: '○', done: '✓', paused: '⏸', blocked: '⛔', failed: '✕', info: 'ℹ',
}

export function canonicalStatus(status: string | undefined | null): CanonicalStatus {
  const k = (status ?? '').toLowerCase()
  if (k in COLOR) return k as CanonicalStatus
  return ALIAS[k] ?? 'idle'
}

/** CSS var() color for a status (theme-aware). Pair with statusIcon() or a label. */
export function statusColor(status: string | undefined | null): string {
  return COLOR[canonicalStatus(status)]
}

/** Shape/icon carrying the same signal as the color — never rely on color alone. */
export function statusIcon(status: string | undefined | null): string {
  return ICON[canonicalStatus(status)]
}

// Heartbeats map onto the table (spec): green = running → active (purple),
// amber → paused (yellow), stale → failed (red ✕), unknown → idle.
export const HEARTBEAT_STATUS: Record<string, CanonicalStatus> = {
  green: 'active', amber: 'paused', stale: 'failed', unknown: 'idle',
}
