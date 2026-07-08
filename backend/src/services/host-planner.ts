// Arturita C1 — Local Host SAFETY PLANNER (pure). The decision logic for the
// Arturita Local Host daemon (`adapters/arturita-host/`); it performs NO
// filesystem I/O itself. The daemon (which DOES touch the FS) mirrors these RULES
// so the denylist / blast-radius / canonicalization / undo-journal logic is
// owned + tested here.
//
// S3 CONFIRMED (2026-07-08): the operator grants FULL machine access — the
// allowlist root is effectively the whole machine. What protects the host is now
// a MINIMAL SELF-PROTECTION denylist (Arturita's own secret store + burner
// keystore + daemon config, plus OS system-integrity paths) AND the A2 approval
// gate on every destructive/irreversible op. Reads/previews are safe; destructive
// execution (move/delete/overwrite over the cap, machine_exec) stays behind the
// approval gate + two-phase confirm.
//
// `HOST_EXECUTION_ENABLED = false` remains the backend→daemon PROXY gate: the
// backend does not drive real destructive host actions until the operator has
// installed + wired the daemon. `assertExecutionEnabled()` throws so a plan is
// never mistaken for permission. The daemon does real reads/previews under its
// own enforcement (see `adapters/arturita-host/`).

// ─── Fail-closed master switch ───────────────────────────────────────────────

/** Master switch for REAL host execution. Stays false until S3 is CONFIRMED and
 *  the daemon ships. Pure planners run regardless (they only decide); nothing may
 *  actually touch the filesystem while this is false. */
export const HOST_EXECUTION_ENABLED = false as boolean

/** Throw unless real host execution has been enabled. The daemon/route calls this
 *  at the top of any would-be execution path so a plan can never be mistaken for
 *  permission. */
export function assertExecutionEnabled(): void {
  if (!HOST_EXECUTION_ENABLED) {
    throw new Error(
      'Arturita host execution is DISABLED (fail-closed): S3 (mac-control adapter + allowlist root/denylist) ' +
      'is not CONFIRMED and the host daemon is not shipped. Planning only — no real filesystem action.',
    )
  }
}

// ─── Path canonicalization + allowlist root ──────────────────────────────────

/** Canonicalize a POSIX-ish path lexically (no filesystem access): resolve `.`
 *  and `..`, collapse duplicate slashes, strip a trailing slash. This is the
 *  pure prefix-check basis; the daemon additionally resolves symlinks on the
 *  real FS before applying the same prefix check (defense in depth). */
export function canonicalizePath(input: string): string {
  let p = String(input ?? '').trim()
  if (!p) return ''
  // Expand a leading ~ to a placeholder the caller substitutes with the real
  // home; we keep it symbolic so this stays pure.
  const parts = p.split('/')
  const out: string[] = []
  const absolute = p.startsWith('/')
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      // at root, `..` is a no-op (can't escape above /)
    } else {
      out.push(seg)
    }
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** Is `child` at or under `root` after canonicalization? The core no-escape
 *  check. Both are canonicalized; a child equal to root is allowed. */
export function isWithinRoot(child: string, root: string): boolean {
  const c = canonicalizePath(child)
  const r = canonicalizePath(root)
  if (!c || !r) return false
  if (c === r) return true
  return c.startsWith(r.endsWith('/') ? r : r + '/')
}

// ─── Denylist ────────────────────────────────────────────────────────────────

// Catastrophic targets — hard-denied for read AND write regardless of the
// allowlist root (PRD §7.3). Matched against any path segment / suffix so a
// nested `.ssh` or `.env` is caught too.
export const DEFAULT_DENYLIST = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  'Library/Keychains',
  'Keychains',
  '.env',
  '.env.local',
  'id_rsa',
  'id_ed25519',
  'wallet.dat',
  'keystore',
  'UTC--',                // geth keystore file prefix
  '.metamask',
  'Ethereum',             // wallet vaults
  '.arturita-host',       // the host's own config
  '.arturita-keystore',   // the burner wallet keystore (S4) — never readable/writable
  '.arturita-secrets',    // the host's copy of the secret store, if any
] as const

// OS system-integrity path prefixes — hard-denied so Arturita can't brick the OS
// (S3 self-protection). Matched as canonical absolute prefixes; `/usr/local` is
// the documented exception (Homebrew etc. live there and are operator space).
export const SYSTEM_INTEGRITY_PREFIXES = [
  '/system',
  '/usr',                 // except /usr/local (carved out below)
  '/bin',
  '/sbin',
  '/private/var/db/systempolicy',
  '/library/apple',
] as const

const SYSTEM_INTEGRITY_EXCEPTIONS = ['/usr/local']

/** Is this a protected OS system-integrity path (SIP-ish)? Canonical + lowercase
 *  prefix match, with the `/usr/local` operator carve-out. Pure. */
export function hitsSystemIntegrity(path: string): boolean {
  const c = canonicalizePath(path).toLowerCase()
  if (!c) return false
  if (SYSTEM_INTEGRITY_EXCEPTIONS.some(ex => c === ex || c.startsWith(ex + '/'))) return false
  return SYSTEM_INTEGRITY_PREFIXES.some(p => c === p || c.startsWith(p + '/'))
}

/** Does a path hit the denylist (catastrophic target)? Case-insensitive; matches
 *  a full segment, a dotfile, or a known filename prefix anywhere in the path.
 *  Fail-closed: a blank path is denied. */
export function hitsDenylist(path: string, denylist: readonly string[] = DEFAULT_DENYLIST): boolean {
  const c = canonicalizePath(path).toLowerCase()
  if (!c) return true
  // S3 self-protection: OS system-integrity paths are always denied.
  if (hitsSystemIntegrity(c)) return true
  const segments = c.split('/')
  for (const d of denylist) {
    const dl = d.toLowerCase()
    if (segments.includes(dl)) return true
    // filename prefix (e.g. UTC-- keystore files) or dotfile match on the last seg
    const last = segments[segments.length - 1] ?? ''
    if (last === dl || last.startsWith(dl)) return true
    // nested path fragment (e.g. "library/keychains")
    if (dl.includes('/') && c.includes(dl)) return true
  }
  return false
}

// ─── Access decision (read/write) ────────────────────────────────────────────

export type HostOp = 'list' | 'read' | 'write' | 'move' | 'delete'

export interface AccessDecision {
  allowed: boolean
  reason: string
}

/** Decide whether an op on a path is permitted by the root + denylist rules
 *  ALONE (blast-radius is a separate gate). Fail-closed: outside root, in the
 *  denylist, blank, or on a symlink-escape flag → denied. */
export function decideAccess(input: {
  op: HostOp
  path: string
  root: string
  denylist?: readonly string[]
  symlinkEscapes?: boolean   // the daemon sets this after real symlink resolution
}): AccessDecision {
  const path = String(input.path ?? '')
  if (!canonicalizePath(path)) return { allowed: false, reason: 'blank/invalid path' }
  if (input.symlinkEscapes) return { allowed: false, reason: 'symlink resolves outside the allowlist root' }
  if (!isWithinRoot(path, input.root)) return { allowed: false, reason: 'outside the allowlist root' }
  if (hitsDenylist(path, input.denylist)) return { allowed: false, reason: 'denylisted (catastrophic target) — refused for read + write' }
  return { allowed: true, reason: 'within root, not denylisted' }
}

// ─── Blast-radius caps ───────────────────────────────────────────────────────

export interface BlastRadius {
  fileCount: number
  totalBytes: number
  recursive?: boolean
}

export interface BlastCaps {
  /** at/below this, an in-root op is auto-safe (no approval). */
  autoSafeMaxFiles: number
  autoSafeMaxBytes: number
  /** above the hard ceiling, refuse outright and ask the operator to narrow. */
  hardMaxFiles: number
  hardMaxBytes: number
}

export const DEFAULT_BLAST_CAPS: BlastCaps = {
  autoSafeMaxFiles: 10,
  autoSafeMaxBytes: 50 * 1024 * 1024,       // 50 MB
  hardMaxFiles: 5000,
  hardMaxBytes: 20 * 1024 * 1024 * 1024,    // 20 GB
}

export type BlastVerdict = 'auto_safe' | 'needs_approval' | 'refuse'

export interface BlastDecision {
  verdict: BlastVerdict
  reason: string
}

/** Classify an op by blast radius: auto-safe (small, in-root), needs-approval
 *  (over the auto-safe threshold or recursive), or refuse (over the hard
 *  ceiling). Destructive ops (move/delete) are NEVER auto-safe — they always need
 *  at least approval. Pure. */
export function classifyBlastRadius(input: {
  op: HostOp
  radius: BlastRadius
  caps?: BlastCaps
}): BlastDecision {
  const caps = input.caps ?? DEFAULT_BLAST_CAPS
  const { fileCount, totalBytes, recursive } = input.radius
  if (fileCount > caps.hardMaxFiles || totalBytes > caps.hardMaxBytes) {
    return { verdict: 'refuse', reason: `over the hard ceiling (${caps.hardMaxFiles} files / ${caps.hardMaxBytes} bytes) — narrow the request` }
  }
  const destructive = input.op === 'move' || input.op === 'delete'
  const overAutoSafe = fileCount > caps.autoSafeMaxFiles || totalBytes > caps.autoSafeMaxBytes || !!recursive
  if (destructive || overAutoSafe) {
    return { verdict: 'needs_approval', reason: destructive ? 'destructive op — approval required' : 'over the auto-safe threshold — approval required' }
  }
  return { verdict: 'auto_safe', reason: 'in-root, under threshold, non-destructive' }
}

// ─── Combined plan ───────────────────────────────────────────────────────────

export interface HostPlan {
  op: HostOp
  path: string
  access: AccessDecision
  blast: BlastDecision | null
  /** overall: 'refused' | 'auto_safe' | 'needs_approval'. */
  outcome: 'refused' | 'auto_safe' | 'needs_approval'
  /** the A2 approval type to raise when outcome === 'needs_approval'. */
  approvalType: 'file_destructive' | null
  /** always false in this build — real execution is gated on S3 + the daemon. */
  executable: boolean
  reason: string
}

/** Produce a full host-op plan combining access + blast-radius. NEVER executable
 *  in this build (fail-closed): `executable` is `HOST_EXECUTION_ENABLED`, which
 *  stays false until S3 is confirmed and the daemon ships. */
export function planHostOp(input: {
  op: HostOp
  path: string
  root: string
  radius?: BlastRadius
  caps?: BlastCaps
  denylist?: readonly string[]
  symlinkEscapes?: boolean
}): HostPlan {
  const access = decideAccess({ op: input.op, path: input.path, root: input.root, denylist: input.denylist, symlinkEscapes: input.symlinkEscapes })
  if (!access.allowed) {
    return { op: input.op, path: input.path, access, blast: null, outcome: 'refused', approvalType: null, executable: false, reason: access.reason }
  }
  const radius = input.radius ?? { fileCount: 1, totalBytes: 0 }
  const blast = classifyBlastRadius({ op: input.op, radius, caps: input.caps })
  if (blast.verdict === 'refuse') {
    return { op: input.op, path: input.path, access, blast, outcome: 'refused', approvalType: null, executable: false, reason: blast.reason }
  }
  const outcome = blast.verdict === 'auto_safe' ? 'auto_safe' : 'needs_approval'
  return {
    op: input.op, path: input.path, access, blast, outcome,
    approvalType: outcome === 'needs_approval' ? 'file_destructive' : null,
    executable: HOST_EXECUTION_ENABLED, // false until S3 confirmed + daemon ships
    reason: blast.reason,
  }
}

// ─── Undo journal ────────────────────────────────────────────────────────────

export interface UndoEntry {
  op: HostOp
  original: string          // canonical original path
  staged: string | null     // where the original was staged (move/delete), null for read
  performedAt: number       // ms epoch
  expiresAt: number         // ms epoch — reversible window end
}

/** Default reversible window: 10 minutes. */
export const DEFAULT_UNDO_WINDOW_MS = 10 * 60 * 1000

/** Build an undo-journal entry for a reversible destructive op. The daemon stages
 *  the original (not purged) and records this; `isReversible` gates "undo that". */
export function buildUndoEntry(input: {
  op: HostOp
  original: string
  staged: string | null
  now: number
  windowMs?: number
}): UndoEntry {
  const windowMs = input.windowMs ?? DEFAULT_UNDO_WINDOW_MS
  return {
    op: input.op,
    original: canonicalizePath(input.original),
    staged: input.staged,
    performedAt: input.now,
    expiresAt: input.now + windowMs,
  }
}

/** Is an op still reversible (within its window and with staged originals)? */
export function isReversible(entry: UndoEntry | null | undefined, now: number): boolean {
  if (!entry || !entry.staged) return false
  return now < entry.expiresAt
}

// ─── Preview manifest ────────────────────────────────────────────────────────

export interface PreviewFile { path: string; bytes: number }

export interface PreviewManifest {
  op: HostOp
  fileCount: number
  totalBytes: number
  destination: string | null
  files: PreviewFile[]     // capped sample for display
  truncated: boolean       // true when more files than the sample cap
}

/** Build the human-facing preview manifest a destructive op shows BEFORE it runs
 *  ("move 42 files → ~/Archive"): counts, total size, destination, and a capped
 *  sample of paths. Pure — the daemon supplies the resolved file list. This is
 *  what the A2 `file_destructive` card renders verbatim. */
export function buildPreviewManifest(input: {
  op: HostOp
  files: PreviewFile[]
  destination?: string | null
  sampleCap?: number
}): PreviewManifest {
  const cap = input.sampleCap ?? 20
  const files = input.files ?? []
  const totalBytes = files.reduce((s, f) => s + (Number(f.bytes) || 0), 0)
  return {
    op: input.op,
    fileCount: files.length,
    totalBytes,
    destination: input.destination ?? null,
    files: files.slice(0, cap).map(f => ({ path: canonicalizePath(f.path), bytes: Number(f.bytes) || 0 })),
    truncated: files.length > cap,
  }
}
