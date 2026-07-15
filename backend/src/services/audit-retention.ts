// Epic ONB / audit H-1 — RETENTION for the now-live audit trail.
//
// Enabling the audit hook (docs/AUDIT-ONB2.md H-1) turns on one Turso INSERT per
// SENSITIVE request, forever. Without a bound, `audit_logs` grows without limit —
// a storage cost line and a slow query path. This is that bound: rows older than
// N days (default 90) are pruned on a daily scheduler tick.
//
// The date math and the day/hour gate are PURE and tested; the DELETE is the only
// I/O and is injectable so a test can drive the prune without standing up Turso.
// No `process.env` read lives inside the executor — the caller (the scheduler)
// resolves the retention window from env at the orchestration boundary and passes
// it in, per backend/CLAUDE.md ("pass values as parameters").

import { db as defaultDb, schema } from '../db/client'
import { lt } from 'drizzle-orm'

/** Default retention window. Tunable via `MC_AUDIT_RETENTION_DAYS`. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90

/** The daily tick hour (UTC) at which the prune runs — once per day, at or after. */
export const AUDIT_RETENTION_HOUR_UTC = 3

/**
 * Resolve the retention window from the environment. A missing, non-numeric, zero,
 * negative, OR sub-one-day value falls back to the 90-day default — an operator
 * cannot accidentally collapse retention to 0 (which would delete everything on the
 * next tick) with a typo. Pure: env in, number out.
 *
 * The floor is `>= 1`, NOT `> 0`: a fractional value in (0, 1) — `0.5`, `.5`,
 * `1e-9` — passes a `> 0` gate but `Math.floor`s to 0, so the cutoff becomes `now`
 * and the daily prune wipes the whole table. Requiring at least one whole day means
 * `Math.floor(n) >= 1` always holds for an accepted value, so the cutoff is always
 * at least a day in the past and the table can never be emptied by this env.
 */
export function auditRetentionDays(env: { MC_AUDIT_RETENTION_DAYS?: string } = process.env): number {
  const n = env.MC_AUDIT_RETENTION_DAYS ? Number(env.MC_AUDIT_RETENTION_DAYS) : NaN
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_AUDIT_RETENTION_DAYS
}

/** The cutoff instant: a row is prunable iff `createdAt < cutoff`. Pure. */
export function auditRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000)
}

/**
 * Has the daily retention window opened for a day we have not pruned yet? Pure gate,
 * mirroring the nightly-KV-export / weekly-consolidation predicates in the scheduler:
 * fire at or after `AUDIT_RETENTION_HOUR_UTC`, at most once per UTC day.
 */
export function auditRetentionDue(now: Date, lastRunDay: string | null): boolean {
  const day = now.toISOString().slice(0, 10)
  return now.getUTCHours() >= AUDIT_RETENTION_HOUR_UTC && lastRunDay !== day
}

type PrunableDb = { delete: typeof defaultDb.delete }

/**
 * Delete audit rows older than the retention window. Returns the number pruned.
 * `database` is injectable for tests; production uses the module DB singleton.
 */
export async function pruneAuditLogs(opts: {
  now?: Date
  retentionDays?: number
  database?: PrunableDb
} = {}): Promise<number> {
  const now = opts.now ?? new Date()
  const days = opts.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS
  const cutoff = auditRetentionCutoff(now, days)
  const database = opts.database ?? defaultDb
  const res: any = await database.delete(schema.auditLogs).where(lt(schema.auditLogs.createdAt, cutoff))
  return Number(res?.rowsAffected ?? 0)
}
