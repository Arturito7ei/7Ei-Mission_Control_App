// Epic ONB / ONB4 — the ONE-TIME API-KEY CLAIM. The most security-critical step in
// the epic: it mints and hands over the actual `mca_` agent credential.
//
// The lifecycle this closes (DESIGN-agent-onboarding §3.6):
//
//   join (ONB3) ──► a `mcc_` CLAIM SECRET is minted, stored HASH-ONLY (+ a TTL), and
//        ↓           returned to the joining agent EXACTLY ONCE in the join response.
//   board approval ► a human decides. The agent row is created CONTAINED, with a NULL
//        ↓           `api_token_hash` — approved, but with no credential yet.
//   claim (HERE) ──► the agent spends its claim secret ONCE. We mint the `mca_` token,
//                    store its HASH on the agent row, and return the RAW token in the
//                    HTTP response body — the only place it ever exists in plaintext.
//
// This module OWNS two statements whose correctness IS the security property, so —
// like `invite-consume.ts` and `join-approvals.ts` — neither may be re-implemented at
// a route:
//
//   1. the atomic single-use CLAIM CAS (`claimed_at IS NULL` in the WHERE), and
//   2. the token-mint CAS on the agent (`api_token_hash IS NULL` in the WHERE).
//
// FAIL-CLOSED, NO ORACLE. Every failure — unknown request, not approved, missing
// agent row, wrong secret, expired, already claimed, lost race — returns the SAME
// flat `{ ok: false }`, which the route collapses to one identical 404. A claimer who
// holds a valid secret still cannot use this endpoint to learn a request's status: a
// wrong or absent secret is indistinguishable from every other closed state.

import { and, eq, gt, isNull } from 'drizzle-orm'
import { randomBytes } from 'crypto'
import { db as defaultDb, schema } from '../db/client'
// sha256 + constant-time compare — the SAME helpers `arturita_bindings` uses for its
// single-use bind code. Reused, never re-implemented, so the two cannot drift.
import { hashToken, hashesEqual } from './arturita-session'
import { generateAgentToken } from '../middleware/agent-token'

/** The one-time claim secret prefix. `log-redaction.ts` already reserves `mcc_`, so
 *  the claim path + any log line carrying one is redacted without a change there. */
export const CLAIM_SECRET_PREFIX = 'mcc_'
/** 256 bits — matches the `mca_` agent token, well above the design's ≥128-bit floor. */
export const CLAIM_SECRET_BYTES = 32
/** The claim's TTL, clamped never to exceed the invite's own expiry (§3.4). */
export const DEFAULT_CLAIM_TTL_HOURS = 24

/** Mint a raw claim secret + its storable hash. The raw value is returned to the
 *  joining agent ONCE (in the join response); only the hash is persisted. */
export function generateClaimSecret(): { secret: string; hash: string } {
  const secret = CLAIM_SECRET_PREFIX + randomBytes(CLAIM_SECRET_BYTES).toString('hex')
  return { secret, hash: hashToken(secret) }
}

/** Shape-check a claim secret BEFORE hashing attacker input or touching the DB. */
export function isClaimSecretShaped(secret: unknown): boolean {
  const s = String(secret ?? '')
  return s.startsWith(CLAIM_SECRET_PREFIX) && new RegExp(`^${CLAIM_SECRET_PREFIX}[0-9a-f]{${CLAIM_SECRET_BYTES * 2}}$`).test(s)
}

/** The claim secret's expiry: `now + DEFAULT_CLAIM_TTL_HOURS`, but never later than
 *  the invite itself expires. A claim is a strictly-shorter-lived credential than the
 *  door it came through. */
export function claimSecretExpiry(now: Date, inviteExpiresAt: Date): Date {
  const ttl = new Date(now.getTime() + DEFAULT_CLAIM_TTL_HOURS * 3600_000)
  return ttl.getTime() < inviteExpiresAt.getTime() ? ttl : inviteExpiresAt
}

/** Just enough of Drizzle for this module — injectable so the concurrency test can
 *  drive a real (in-memory) database rather than a mock that cannot race. */
export type ClaimDb = Pick<typeof defaultDb, 'query' | 'update'>

export type ClaimResult =
  | { ok: true; token: string; agentId: string }
  | { ok: false }

/** One flat failure, so a caller can never build an oracle out of the difference. */
const FAIL: ClaimResult = { ok: false }

/**
 * Claim the one-time API key for an APPROVED join request.
 *
 * Preconditions, all fail-closed to the identical `{ ok: false }`:
 *   - the request exists, is `approved`, and has an unexpired, unclaimed claim secret;
 *   - **its agent row actually exists** and still has a NULL `api_token_hash` (the
 *     ONB3 auditor's carried caveat #3: never trust `status = 'approved'` alone —
 *     re-read the agent, fail closed if it is absent or already credentialed);
 *   - the supplied secret matches the stored hash under a CONSTANT-TIME compare.
 *
 * Then, atomically:
 *   - the CLAIM is consumed by one conditional UPDATE (`claimed_at IS NULL` is the
 *     compare-and-set; `claimed_at` is stamped and the secret hash is CLEARED in the
 *     same statement), and only if it wins;
 *   - the `mca_` token is minted and its HASH written to the agent under a second CAS
 *     (`api_token_hash IS NULL`), so the credential is single-use by construction too.
 *
 * The RAW token is returned only here; it is never persisted, never logged, never
 * shown to an operator.
 */
export async function claimApiKey(input: {
  joinRequestId: string
  claimSecret: string
  now?: Date
  database?: ClaimDb
  /** Injectable for deterministic tests; defaults to a real random `mca_` token. */
  mint?: () => { token: string; hash: string }
}): Promise<ClaimResult> {
  const database = input.database ?? defaultDb
  const now = input.now ?? new Date()
  const mint = input.mint ?? generateAgentToken

  // Shape-check before we hash attacker input or spend a DB round-trip.
  if (!isClaimSecretShaped(input.claimSecret)) return FAIL

  const row: any = await database.query.agentJoinRequests.findFirst({
    where: eq(schema.agentJoinRequests.id, String(input.joinRequestId)),
  })
  if (!row) return FAIL

  // ── fail-closed preconditions (each returns the identical flat failure) ──
  if (row.status !== 'approved') return FAIL
  if (!row.agentId) return FAIL
  if (!row.claimSecretHash) return FAIL          // pre-ONB4 row, or already claimed (hash NULLed)
  if (row.claimedAt) return FAIL                 // already claimed
  const exp = row.claimSecretExpiresAt as Date | number | null
  const expMs = exp instanceof Date ? exp.getTime() : Number(exp ?? 0)
  if (!expMs || expMs <= now.getTime()) return FAIL   // expired (or never set)

  // Carried caveat #3: re-read the agent. `status = 'approved'` is NOT enough — the
  // row must actually exist, and still be un-credentialed. M-1's compensation can
  // leave an "approved" request whose agent insert failed; a claim must not mint
  // against a ghost.
  const agent: any = await database.query.agents.findFirst({
    where: eq(schema.agents.id, String(row.agentId)),
  })
  if (!agent) return FAIL                         // approved, but the agent is gone
  if (agent.apiTokenHash) return FAIL             // already credentialed → not claimable

  // CONSTANT-TIME compare. Never a SQL `=` on the hash (it would leak timing and put
  // the secret in a query), never a Node `===`. `arturita_bindings` pattern.
  if (!hashesEqual(hashToken(input.claimSecret), String(row.claimSecretHash))) return FAIL

  // ── (1) the atomic single-use CLAIM CAS ──────────────────────────────────────
  // `claimed_at IS NULL` is the compare-and-set. `claimed_at` + a CLEARED hash are
  // set in the SAME statement, and every precondition is re-asserted in the WHERE so
  // a state change between our read and this write consumes nothing. Two simultaneous
  // claims cannot both match: one commits, the other affects 0 rows → flat failure.
  const claimRes: any = await database.update(schema.agentJoinRequests)
    .set({ claimedAt: now, claimSecretHash: null } as any)
    .where(and(
      eq(schema.agentJoinRequests.id, row.id),
      isNull(schema.agentJoinRequests.claimedAt),
      eq(schema.agentJoinRequests.status, 'approved'),
      gt(schema.agentJoinRequests.claimSecretExpiresAt, now),
    ))
  if (Number(claimRes?.rowsAffected ?? 0) !== 1) return FAIL   // lost the race / already spent

  // ── (2) the token MINT, hash-only, under its own CAS ─────────────────────────
  const { token, hash } = mint()
  const mintRes: any = await database.update(schema.agents)
    .set({ apiTokenHash: hash } as any)
    .where(and(
      eq(schema.agents.id, String(row.agentId)),
      isNull(schema.agents.apiTokenHash),
    ))
  if (Number(mintRes?.rowsAffected ?? 0) !== 1) {
    // Extreme edge (the agent was deleted / credentialed between our read and here):
    // the claim CAS already won, so DON'T silently burn it. Compensate back to
    // claimable — `claimed_at` NULL and the hash re-derived from the secret that just
    // matched — guarded on the `claimed_at` we stamped so a concurrent claim cannot be
    // clobbered. Then fail closed; a retry is possible, nothing half-minted persists.
    await database.update(schema.agentJoinRequests)
      .set({ claimedAt: null, claimSecretHash: hashToken(input.claimSecret) } as any)
      .where(and(
        eq(schema.agentJoinRequests.id, row.id),
        eq(schema.agentJoinRequests.claimedAt, now),
      ))
      .catch(() => { /* best-effort; we fail closed regardless */ })
    return FAIL
  }

  // The raw token crosses the wire EXACTLY ONCE, to the claimer, from here.
  return { ok: true, token, agentId: String(row.agentId) }
}
