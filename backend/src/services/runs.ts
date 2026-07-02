// MCA-EXEC Phase 1 — pure helpers for atomic task checkout, blocker
// dependencies, run leases, and structured run logs. IO lives in the routes.

export const LEASE_MS = Number(process.env.RUN_LEASE_MS ?? 15 * 60 * 1000)  // 15 min default

export function parseBlockedBy(json: string | null | undefined): string[] {
  if (!json) return []
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [] }
  catch { return [] }
}

/** All blocker tasks must be 'done' before a dependent task can be claimed. */
export function blockersSatisfied(blockerStatuses: string[]): boolean {
  return blockerStatuses.every((s) => s === 'done')
}

/** A lock is stale if older than the lease window — used to reclaim orphaned runs. */
export function isLeaseExpired(lockedAt: Date | number | null | undefined, now: number = Date.now(), leaseMs: number = LEASE_MS): boolean {
  if (lockedAt === null || lockedAt === undefined) return true
  const t = lockedAt instanceof Date ? lockedAt.getTime() : Number(lockedAt)
  if (!Number.isFinite(t)) return true
  return now - t > leaseMs
}

/** Claimable when assigned, or in_progress whose lease has expired (recover orphaned). */
export function isClaimable(task: { status: string; lockedAt?: Date | number | null }, now: number = Date.now(), leaseMs: number = LEASE_MS): boolean {
  if (task.status === 'assigned') return true
  if (task.status === 'in_progress') return isLeaseExpired(task.lockedAt ?? null, now, leaseMs)
  return false
}

/** Append a capped structured log line to a run's JSON log array. */
export function appendLog(existing: string | null | undefined, msg: string, now: number = Date.now()): string {
  let arr: any[] = []
  try { arr = existing ? JSON.parse(existing) : [] } catch { arr = [] }
  if (!Array.isArray(arr)) arr = []
  arr.push({ t: now, msg: String(msg ?? '').slice(0, 2000) })
  return JSON.stringify(arr.slice(-200))
}
