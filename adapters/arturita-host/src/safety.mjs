// Arturita Local Host — SAFETY module (zero-dep, mirrors backend host-planner.ts).
//
// The daemon touches the real filesystem, so the allowlist / denylist / system-
// integrity / blast-radius rules live here and are enforced on EVERY op. This is
// the daemon-side twin of backend/src/services/host-planner.ts — keep them in
// sync. S3 (2026-07-08): whole-machine root, minimal self-protection denylist,
// destructive ops behind an approval flag.

import path from 'node:path'
import fs from 'node:fs'

// Segment/filename denylist — catastrophic + self-protection targets.
export const DENYLIST = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud', 'library/keychains', 'keychains',
  '.env', '.env.local', 'id_rsa', 'id_ed25519', 'wallet.dat', 'keystore',
  'utc--', '.metamask', 'ethereum', '.arturita-host', '.arturita-keystore', '.arturita-secrets',
]

// OS system-integrity prefixes (SIP-ish) — hard-denied, with /usr/local carved out.
export const SYSTEM_INTEGRITY_PREFIXES = ['/system', '/usr', '/bin', '/sbin', '/private/var/db/systempolicy', '/library/apple']
const SYSTEM_INTEGRITY_EXCEPTIONS = ['/usr/local']

export function hitsSystemIntegrity(p) {
  const c = String(p || '').toLowerCase()
  if (!c) return false
  if (SYSTEM_INTEGRITY_EXCEPTIONS.some(ex => c === ex || c.startsWith(ex + '/'))) return false
  return SYSTEM_INTEGRITY_PREFIXES.some(pre => c === pre || c.startsWith(pre + '/'))
}

export function hitsDenylist(p) {
  const c = String(p || '').toLowerCase()
  if (!c) return true
  if (hitsSystemIntegrity(c)) return true
  const segments = c.split('/')
  const last = segments[segments.length - 1] || ''
  for (const d of DENYLIST) {
    const dl = d.toLowerCase()
    if (segments.includes(dl)) return true
    if (last === dl || last.startsWith(dl)) return true
    if (dl.includes('/') && c.includes(dl)) return true
  }
  return false
}

/** Resolve a path to its real absolute form, following symlinks. For a
 *  non-existent target (e.g. a write destination) resolve the nearest existing
 *  ancestor's realpath and re-append the tail — so a symlinked parent can't be
 *  used to escape. Returns { real, existed }. */
export function resolveReal(p) {
  const abs = path.resolve(String(p || ''))
  try {
    return { real: fs.realpathSync(abs), existed: true }
  } catch {
    // walk up to the nearest existing ancestor
    let dir = abs
    const tail = []
    while (dir !== path.dirname(dir)) {
      const parent = path.dirname(dir)
      tail.unshift(path.basename(dir))
      try {
        const realParent = fs.realpathSync(parent)
        return { real: path.join(realParent, ...tail), existed: false }
      } catch { dir = parent }
    }
    return { real: abs, existed: false }
  }
}

export function isWithinRoot(child, root) {
  const c = path.resolve(child)
  const r = path.resolve(root)
  if (c === r) return true
  return c.startsWith(r.endsWith('/') ? r : r + '/')
}

/** The single access gate: fail-closed. Resolves symlinks, checks the (whole-
 *  machine) root and the self-protection denylist. Returns { allowed, reason,
 *  real }. */
export function decideAccess({ op, target, root = '/' }) {
  const raw = String(target || '')
  if (!raw.trim()) return { allowed: false, reason: 'blank/invalid path', real: null }
  const { real } = resolveReal(raw)
  // Resolve the root's realpath too so a symlinked root prefix (e.g. macOS
  // /var → /private/var) still matches a realpath-resolved child.
  const realRoot = resolveReal(root).real
  if (!isWithinRoot(real, realRoot)) return { allowed: false, reason: 'resolves outside the allowed root (symlink escape?)', real }
  if (hitsDenylist(real)) return { allowed: false, reason: 'denylisted self-protection target — refused for read + write', real }
  return { allowed: true, reason: 'within root, not denylisted', real }
}

// ── Blast radius (mirror of host-planner) ────────────────────────────────────
export const BLAST_CAPS = { autoSafeMaxFiles: 10, autoSafeMaxBytes: 50 * 1024 * 1024, hardMaxFiles: 5000, hardMaxBytes: 20 * 1024 * 1024 * 1024 }

export function classifyBlast({ op, fileCount, totalBytes, recursive }) {
  if (fileCount > BLAST_CAPS.hardMaxFiles || totalBytes > BLAST_CAPS.hardMaxBytes) return { verdict: 'refuse', reason: 'over the hard ceiling — narrow the request' }
  const destructive = op === 'move' || op === 'delete' || op === 'overwrite'
  const over = fileCount > BLAST_CAPS.autoSafeMaxFiles || totalBytes > BLAST_CAPS.autoSafeMaxBytes || !!recursive
  if (destructive || over) return { verdict: 'needs_approval', reason: destructive ? 'destructive op — approval required' : 'over the auto-safe threshold — approval required' }
  return { verdict: 'auto_safe', reason: 'in-root, under threshold, non-destructive' }
}
