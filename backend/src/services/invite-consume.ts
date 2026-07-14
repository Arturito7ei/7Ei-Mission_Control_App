// Epic ONB / ONB3 — the ATOMIC single-use consume. ONB1 audit finding **H1**.
//
// This module exists to make the racy consume UNWRITABLE. ONB1 shipped a
// `consumeUsePatch(record)` helper that returned `{ usedCount: record.usedCount + 1 }`
// and *asked* the route, in a comment, to make the UPDATE conditional. The audit's
// verdict was blunt and correct: an advisory compare-and-set is not a compare-and-set.
// Two concurrent joins against a single-use invite both read `used_count = 0`, both
// see `active`, both write `1`, and a single-use door admits two agents. On a public
// endpoint that is a remotely-reachable bypass of invariant (2).
//
// `consumeUsePatch` is DELETED. This is now the only consume path, and it cannot be
// used incorrectly:
//
//   * `used_count = used_count + 1` is computed **in SQL**, never in Node. A
//     client-computed value IS the race.
//   * `used_count < max_uses` sits in the **WHERE clause** — that is the CAS, and it
//     is what makes a double-spend impossible rather than merely unlikely.
//   * The WHERE clause re-asserts EVERY precondition (not revoked, not expired, not
//     exhausted) atomically with the write, so an invite revoked between the lookup
//     and the write consumes nothing.
//   * `rowsAffected !== 1` → the caller returns the identical flat 404 it returns for
//     an unknown invite. No oracle, and no partial state.
//   * The caller creates the join-request row **only after** this returns `true`.
//     Creating it first and consuming after re-opens the same hole.
//
// Turso/libSQL gives us no serializable isolation to lean on, and the check and the
// write are separated by a network round-trip. The WHERE clause is the state machine.

import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { db as defaultDb, schema } from '../db/client'

/** Just enough of Drizzle for this one statement — injectable so the concurrency
 *  test can drive a real (in-memory) database rather than a mock that cannot race. */
export type ConsumeDb = Pick<typeof defaultDb, 'update'>

/**
 * Consume ONE use of an invite, atomically. Returns `true` iff this caller won.
 *
 * A `false` means: lost the race, exhausted, revoked, or expired — the caller must
 * NOT distinguish them, and must NOT create a join request.
 */
export async function consumeInviteUse(
  inviteId: string,
  now: Date = new Date(),
  database: ConsumeDb = defaultDb,
): Promise<boolean> {
  const res: any = await database
    .update(schema.agentInvites)
    .set({
      // In SQL. Not `record.usedCount + 1`.
      usedCount: sql`${schema.agentInvites.usedCount} + 1`,
      lastAcceptedAt: now,
    } as any)
    .where(
      and(
        eq(schema.agentInvites.id, inviteId),
        isNull(schema.agentInvites.revokedAt),
        gt(schema.agentInvites.expiresAt, now),
        // ── the compare-and-set ──
        lt(schema.agentInvites.usedCount, schema.agentInvites.maxUses),
      ),
    )

  return Number(res?.rowsAffected ?? 0) === 1
}
