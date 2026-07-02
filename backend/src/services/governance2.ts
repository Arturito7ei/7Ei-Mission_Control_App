// MCA-GOV2 Phase 4 — pure helpers for execution policies, per-agent permissions,
// and short-lived run tokens. IO (DB, routes) lives in the route files.
import { createHmac } from 'crypto'

// ─── Execution policies (S4.1) ──────────────────────────────────────────────
export interface ExecPolicy { action: string; requiresApproval?: boolean | number | null }

/** Does any policy require human approval for this action? */
export function requiresApproval(policies: ExecPolicy[] | null | undefined, action: string): boolean {
  return (policies ?? []).some(p => p.action === action && (p.requiresApproval === true || p.requiresApproval === 1))
}

// ─── Per-agent permissions (S4.2) ───────────────────────────────────────────
export function parseCapabilities(json: string | null | undefined): string[] {
  if (!json) return []
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [] }
  catch { return [] }
}

/** Allow-all when unset/empty (backwards compatible). Supports exact + "ns:*" + "*". */
export function isCapabilityAllowed(permissions: string[] | null | undefined, cap: string): boolean {
  if (!permissions || permissions.length === 0) return true
  if (permissions.includes('*') || permissions.includes(cap)) return true
  const ns = String(cap).split(':')[0]
  return permissions.includes(`${ns}:*`)
}

// ─── Short-lived run tokens (S4.3) ──────────────────────────────────────────
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function signRunToken(payload: Record<string, any>, secret: string, now: number = Date.now(), ttlMs: number = 15 * 60 * 1000): string {
  const body = { ...payload, iat: Math.floor(now / 1000), exp: Math.floor((now + ttlMs) / 1000) }
  const p = b64url(Buffer.from(JSON.stringify(body)))
  const sig = b64url(createHmac('sha256', secret).update(p).digest())
  return `${p}.${sig}`
}

export function verifyRunToken(token: string, secret: string, now: number = Date.now()): { valid: boolean; payload?: any; reason?: string } {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 2) return { valid: false, reason: 'malformed' }
  const [p, sig] = parts
  const expected = b64url(createHmac('sha256', secret).update(p).digest())
  if (sig !== expected) return { valid: false, reason: 'bad signature' }
  let payload: any
  try { payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) }
  catch { return { valid: false, reason: 'bad payload' } }
  if (payload.exp && Math.floor(now / 1000) > payload.exp) return { valid: false, reason: 'expired' }
  return { valid: true, payload }
}
