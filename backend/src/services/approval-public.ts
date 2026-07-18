// The approval row's public projection. ONE place, because a per-route allow-list
// drifts and this row carries an AGENT-CONTROLLED blob.
//
// WHY THIS EXISTS (GC-0). Every approval read route was `db.select().from(
// approvalRequests)` — the WHOLE row — and the whole row includes `payload`, a
// `z.any()` JSON blob written by the requesting AGENT. For the dangerous approval
// types that is precisely the sensitive part of the action awaiting a decision:
//
//   • `machine_exec`  — the argv about to be run on the operator's machine
//   • `wallet_tx`     — destination address and amount
//   • `email_send`    — recipients, subject, body
//   • `connector_action` — the connector's request parameters
//
// The clients read exactly TWO keys out of it (`requiresStepUp`, `warnings`), so
// the rest was crossing the wire, sitting in client JS memory, and landing in
// whatever logs a client feeds — for no consumer at all. This is structurally the
// same failure `toPublicOrg` fixed on the `organisations` row: `select *` shipping
// whatever the row happened to carry.
//
// THE RULE, mirroring org-public.ts: routes never return an approval row. They
// return `toPublicApproval(row)`.
//
// ⚠️ APPR-1 — DO NOT NARROW `type` OR `payload.requiresStepUp` OUT OF THIS.
// Both are load-bearing for the step-up flow that makes dangerous approvals
// approvable at all. `approvalNeedsStepUp` (web/lib/dangerousApprovals.ts:55,
// apps/mobile/src/constants.ts:55) is `isDangerousApprovalType(a.type) ||
// a.payload?.requiresStepUp === true`. Drop either and a dangerous approval renders
// as a one-click Approve that dead-ends on the server's own 403 — the exact
// "the desk cannot approve dangerous actions" bug APPR-1 and #325 just fixed.
// Both clients type `payload?: any`, so TypeScript will NOT catch it; the guards
// fail silently. `gc0-approval-projection.test.ts` is the tripwire.

import { schema } from '../db/client'

type ApprovalRow = typeof schema.approvalRequests.$inferSelect

/**
 * The COMPLETE set of `approval_requests` columns a client may see. All of it is
 * card-render data or decision provenance — none of it is agent-authored except
 * `summary`, which for dangerous types is MACHINE-regenerated from the structured
 * action (`prepareApprovalRecord`) and never model prose.
 */
export const PUBLIC_APPROVAL_FIELDS = [
  'id',
  'orgId',
  'type',                 // APPR-1: step-up routing reads this. Load-bearing.
  'summary',
  'status',
  'requestedByAgentId',
  'decidedBy',
  'decidedAt',
  'decisionNote',
  'createdAt',
] as const

/**
 * The COMPLETE set of `payload` keys a client may see.
 *
 * Everything else in the blob — argv, destinations, recipients, tokens, connector
 * parameters — stays server-side. The decide route reads what it needs
 * (`actionType`, `requiresStepUp`, `joinRequestId`) straight from the DB row, not
 * from the client, so nothing server-side depends on shipping them.
 */
export const PUBLIC_PAYLOAD_KEYS = ['requiresStepUp', 'warnings'] as const

/** Bound the one client-visible free-text field an agent controls. */
const MAX_WARNINGS = 20
const MAX_WARNING_LEN = 300

export type PublicApproval = Pick<ApprovalRow, (typeof PUBLIC_APPROVAL_FIELDS)[number]> & {
  payload?: { requiresStepUp?: boolean; warnings?: string[] } | null
}

/**
 * Project a payload blob down to the two keys the clients read.
 *
 * The coercion is not cosmetic, it is the second half of the containment. An
 * allow-listed KEY whose VALUE is an arbitrary object would carry the leak straight
 * through it — `warnings: [{ token: 'sk-live-…' }]` is allow-listed by name. So:
 *
 *   • `requiresStepUp` is narrowed to a real boolean (`=== true`), matching the
 *     strict check both clients already perform.
 *   • `warnings` accepts STRING elements only — a non-string is DROPPED, not
 *     stringified. Stringifying is not enough: `String(['a','sk-live-…'])` joins
 *     to `"a,sk-live-…"`, so a secret planted in a nested array would survive the
 *     coercion intact. Dropping is the only rule with no such escape, and the
 *     clients already type this `string[]`.
 *
 * Returns `null` for an absent/!object payload so the response shape stays stable.
 */
function toPublicPayload(payload: unknown): PublicApproval['payload'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const src = payload as Record<string, unknown>
  const out: { requiresStepUp?: boolean; warnings?: string[] } = {}

  if ('requiresStepUp' in src) out.requiresStepUp = src.requiresStepUp === true
  if (Array.isArray(src.warnings)) {
    out.warnings = src.warnings
      .filter((w): w is string => typeof w === 'string')
      .slice(0, MAX_WARNINGS)
      .map(w => w.slice(0, MAX_WARNING_LEN))
  }
  return out
}

/**
 * Project an approval row down to its public shape.
 *
 * Allow-list, not deny-list, on BOTH axes: a column added to `approval_requests`
 * and a key added to `payload` are alike invisible to clients until someone lists
 * them here on purpose. A new secret therefore cannot leak by default — which is
 * exactly how this got in.
 *
 * Top-level keys are copied only when PRESENT (not when merely non-null), so a
 * row's `null` columns still serialise as `null` and the response is shape-identical
 * to the old one minus the blob.
 */
export function toPublicApproval<T extends Partial<ApprovalRow>>(approval: T): PublicApproval {
  const out: Record<string, unknown> = {}
  for (const key of PUBLIC_APPROVAL_FIELDS) {
    if (key in approval) out[key] = (approval as Record<string, unknown>)[key]
  }
  if ('payload' in approval) out.payload = toPublicPayload((approval as Record<string, unknown>).payload)
  return out as PublicApproval
}
