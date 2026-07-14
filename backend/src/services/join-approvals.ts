// Epic ONB / ONB3 — applying the BOARD's decision to a join request.
//
// One decision path, reached from two doors:
//   * the dedicated owner routes (`POST /api/orgs/:orgId/agent-join-requests/:id/approve|reject`), and
//   * the generic tri-state approvals decide route (`POST /api/approvals/:id/decide`),
//     which is what the SHIPPED Inbox/Governance card calls.
//
// Both funnel here, so an owner who clicks Approve on the card in the inbox gets
// exactly the same effect as one who calls the API — there is no way to mark a join
// request approved without actually creating the (contained) agent, and no second
// implementation to drift.
//
// What approval does and does not do:
//   ✅ creates the agent row, CONTAINED — `low_trust_review` regardless of runtime
//      (invariant #3), with an explicit, allow-listed capability list;
//   ✅ re-scopes the joining agent's declared secrets from the inert `join_request`
//      scope to the agent that now exists (they were never readable before);
//   ❌ mints NO token. `api_token_hash` is null. The one-time claim is ONB4, and
//      until it lands an approved agent can authenticate to nothing.
//
// Rejection mints nothing and DELETES the parked secrets.

import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db as defaultDb, schema } from '../db/client'
import {
  buildApprovedAgent, JOIN_SECRET_SCOPE, type JoinDecision, type JoinRequestRecord,
} from './join-requests'

export type JoinDb = typeof defaultDb

/** DB row → the pure service's record shape. Fail-closed on corrupt JSON: an
 *  unparseable capability list becomes `[]`, which `buildApprovedAgent` would turn
 *  into an allow-all `permissions` — so the caller refuses to approve it instead
 *  (see `applyJoinDecision`). Never widen on a parse failure. */
export function toJoinRecord(row: any): JoinRequestRecord {
  const arr = (raw: unknown): string[] => {
    try {
      const p = JSON.parse(String(raw ?? '[]'))
      return Array.isArray(p) ? p.map(String).filter(Boolean) : []
    } catch { return [] }
  }
  const obj = (raw: unknown): Record<string, unknown> => {
    try {
      const p = JSON.parse(String(raw ?? '{}'))
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
    } catch { return {} }
  }
  return {
    id: row.id,
    orgId: row.orgId,
    inviteId: row.inviteId,
    agentName: row.agentName,
    adapterType: row.adapterType,
    runtime: row.runtime,
    capabilities: arr(row.capabilities),
    config: obj(row.config),
    secretKeys: arr(row.secretKeys),
    status: row.status,
    approvalRequestId: row.approvalRequestId ?? null,
    agentId: row.agentId ?? null,
    decidedBy: row.decidedBy ?? null,
    decidedAt: (row.decidedAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
  }
}

export type JoinDecisionResult =
  | { ok: true; status: 'approved' | 'rejected'; agentId: string | null; record: JoinRequestRecord }
  | { ok: false; code: 404 | 409 | 422; error: string }

/**
 * Apply an owner's decision to a pending join request.
 *
 * The status transition is a **compare-and-set** (`WHERE status = 'pending_approval'`)
 * for the same reason the invite consume is: two owners clicking Approve at once must
 * not create two agents. A lost CAS is a 409, not a second agent.
 */
export async function applyJoinDecision(input: {
  joinRequestId: string
  orgId?: string
  decision: JoinDecision
  actor: string
  now?: Date
  database?: JoinDb
}): Promise<JoinDecisionResult> {
  const database = input.database ?? defaultDb
  const now = input.now ?? new Date()

  const row = await database.query.agentJoinRequests.findFirst({
    where: input.orgId
      ? and(eq(schema.agentJoinRequests.id, input.joinRequestId), eq(schema.agentJoinRequests.orgId, input.orgId))
      : eq(schema.agentJoinRequests.id, input.joinRequestId),
  })
  if (!row) return { ok: false, code: 404, error: 'Join request not found' }

  const record = toJoinRecord(row)
  if (record.status !== 'pending_approval') {
    return { ok: false, code: 409, error: `Join request is already ${record.status}` }
  }

  // A capability list that failed to parse would become `permissions: []`, which is
  // ALLOW-ALL in governance2. Refuse to approve rather than silently widen (the same
  // fail-closed rule as the invite allow-list parse, ONB1 audit M2).
  if (input.decision === 'approved' && record.capabilities.length === 0) {
    return { ok: false, code: 422, error: 'Join request has no capabilities — refusing to approve (an empty capability list is allow-all)' }
  }

  const agentId = input.decision === 'approved' ? randomUUID() : null

  // ── the CAS: only a PENDING request can be decided, and only once ──
  const res: any = await database
    .update(schema.agentJoinRequests)
    .set({ status: input.decision, decidedBy: input.actor, decidedAt: now, agentId } as any)
    .where(and(
      eq(schema.agentJoinRequests.id, record.id),
      eq(schema.agentJoinRequests.status, 'pending_approval'),
    ))
  if (Number(res?.rowsAffected ?? 0) !== 1) {
    return { ok: false, code: 409, error: 'Join request was decided concurrently' }
  }

  if (input.decision === 'approved' && agentId) {
    // Created CONTAINED, and with NO api_token_hash — there is no credential to
    // claim until ONB4, which is the whole point of the gate.
    //
    // AUDIT-ONB3 M-1: this is NOT one transaction (libSQL/Turso gives us `db.transaction`,
    // but it opens a second connection — which the `:memory:` test DB cannot follow — so
    // wrapping this is a change to the test harness, not a one-liner: see the audit doc).
    // The ordering is deliberately fail-CLOSED — the status CAS first, the agent second —
    // so a crash here can never leave an agent nobody approved. What it CAN leave is the
    // mirror image: a request marked `approved` pointing at an agent that was never
    // inserted, unrecoverable because a second approve is a 409. So an insert failure
    // COMPENSATES: the CAS is rolled back to `pending_approval` (guarded on the agent id
    // we just claimed, so a concurrent decision cannot be clobbered) and the error is
    // re-thrown. The operator retries; nothing is half-approved.
    const agent = buildApprovedAgent({ id: agentId, record, now })
    try {
      await database.insert(schema.agents).values(agent as any)
    } catch (err) {
      await database.update(schema.agentJoinRequests)
        .set({ status: 'pending_approval', decidedBy: null, decidedAt: null, agentId: null } as any)
        .where(and(
          eq(schema.agentJoinRequests.id, record.id),
          eq(schema.agentJoinRequests.status, 'approved'),
          eq(schema.agentJoinRequests.agentId, agentId),
        ))
        .catch(() => { /* the compensation is best-effort; the throw below is the truth */ })
      throw err
    }

    // The parked secrets become the agent's. They were inert until this moment:
    // `resolveSecretsForAgent` only resolves `company` + `agent` scopes, so nothing
    // could read a `join_request`-scoped row.
    if (record.secretKeys.length > 0) {
      await database.update(schema.secrets)
        .set({ scope: 'agent', scopeId: agentId } as any)
        .where(and(
          eq(schema.secrets.orgId, record.orgId),
          eq(schema.secrets.scope, JOIN_SECRET_SCOPE),
          eq(schema.secrets.scopeId, record.id),
        ))
    }
  } else {
    // Rejected: nothing is minted, and the credentials the agent sent are destroyed.
    await database.delete(schema.secrets).where(and(
      eq(schema.secrets.orgId, record.orgId),
      eq(schema.secrets.scope, JOIN_SECRET_SCOPE),
      eq(schema.secrets.scopeId, record.id),
    ))
  }

  // Close the board's queue item, if it is still open. Idempotent: when the decision
  // arrived THROUGH that card (the generic decide route), it is already closed and
  // this is a no-op.
  if (record.approvalRequestId) {
    await database.update(schema.approvalRequests)
      .set({ status: input.decision, decidedBy: input.actor, decidedAt: now } as any)
      .where(and(
        eq(schema.approvalRequests.id, record.approvalRequestId),
        eq(schema.approvalRequests.status, 'pending'),
      ))
  }

  return {
    ok: true,
    status: input.decision,
    agentId,
    record: { ...record, status: input.decision, decidedBy: input.actor, decidedAt: now, agentId },
  }
}
