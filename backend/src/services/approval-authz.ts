// Epic ONB / ONB3 (AUDIT-ONB3 H-1) — WHO may DECIDE an approval, by its TYPE.
//
// The board-approval gate is the load-bearing control of the epic, and it is only a
// gate if the door the Inbox card actually uses — `POST /api/approvals/:id/decide` —
// is role-gated. That route looks an approval up by id and has NO `:orgId` path
// param, so `requireOrgRole` NO-OPS on it (AUDIT-ONB2-hardening R-4). The decision of
// which role a given approval needs must therefore be DATA-DRIVEN from the approval
// TYPE, computed here, and enforced in the route against the org DERIVED FROM THE ROW.
//
// The rule, and why:
//   * AGENT-MINTING types (`agent_join_request`, `agent_create`) → OWNER. Deciding one
//     brings an agent into existence. A member — or, before this fix, any authenticated
//     non-member — approving a join would turn "a leaked invite buys a queue item" back
//     into "a leaked invite buys an agent". A `low_trust_review` case whose WRAPPED
//     action is itself agent-minting counts too: a contained agent trying to create
//     another agent is still minting.
//   * EVERY OTHER well-formed type → MEMBER. Approval types are open-ended: an agent's
//     plan emits `[APPROVAL: <type> | …]` with an arbitrary type (`spend`, `hire`,
//     `summarize`, `deploy`, …). Defaulting those to owner would over-restrict every
//     everyday card. Membership is the new FLOOR (it was previously unchecked here),
//     but non-minting cards keep their member-level reach.
//   * A MALFORMED / ABSENT type (null, empty, non-string) → OWNER (fail closed). The
//     column is NOT NULL and the create routes reject an empty type, so this branch is
//     defence-in-depth: a decision whose type we cannot read is not a member's to make.
//
// This is a PURE module (no IO). The route does the membership lookup + reply; this
// only classifies. Kept small and data-driven so a future minting card type is one
// entry away from being gated, and can't silently drift open.

export type OrgRole = 'owner' | 'member'

/** Approval types whose approval MINTS AN AGENT — owner-only, always. A positive
 *  allowlist: add a new minting card type here the moment it exists, and until then
 *  an unrecognized/malformed type also fails closed to owner (see below). */
export const AGENT_MINTING_APPROVAL_TYPES = ['agent_join_request', 'agent_create'] as const

/** The review-case wrapper type (`review.ts` REVIEW_CASE_TYPE). A quarantined
 *  low-trust action carries its real action type in `payload.actionType`; when that
 *  wrapped action is agent-minting, deciding the review case is agent-minting too. */
const REVIEW_CASE_TYPE = 'low_trust_review'

/** Normalize a type the way `parseApprovalDirectives` / the review renderer emit it:
 *  trimmed, lower-cased, whitespace → underscore. Matches `isDangerousType`/`isGatedAction`. */
function normType(t: unknown): string {
  return String(t ?? '').trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Does deciding this approval bring an agent into existence?
 *
 * True for the minting types directly, and for a `low_trust_review` case whose
 * wrapped `actionType` is itself a minting action. `actionType` is optional: callers
 * that only have the top-level `type` (e.g. a plain `agent_join_request` card) pass
 * just that.
 */
export function isAgentMintingApproval(type: unknown, actionType?: unknown): boolean {
  const minting = AGENT_MINTING_APPROVAL_TYPES as readonly string[]
  const t = normType(type)
  if (minting.includes(t)) return true
  if (t === REVIEW_CASE_TYPE && minting.includes(normType(actionType))) return true
  return false
}

/**
 * The MINIMUM org role a caller must hold to DECIDE (approve / reject /
 * revision_requested) an approval of this type.
 *
 *   - agent-minting            → 'owner'   (the ONB3 board-approval gate)
 *   - any other well-formed    → 'member'  (membership is the floor; don't over-restrict)
 *   - absent / empty / garbage → 'owner'   (fail closed — an unreadable type is not a
 *                                            member's call)
 *
 * `actionType` is the wrapped action type for a `low_trust_review` card (from
 * `payload.actionType`); pass it so a review case quarantining an agent-minting
 * action is gated to owner as well.
 */
export function requiredRoleForApproval(input: { type: unknown; actionType?: unknown }): OrgRole {
  if (isAgentMintingApproval(input.type, input.actionType)) return 'owner'
  // Anything that is not a well-formed, non-empty STRING type (null, '', a number,
  // an object) is a decision we cannot classify → owner, fail closed. The column is
  // `text NOT NULL`, so in practice this only fires on defence-in-depth inputs.
  if (typeof input.type !== 'string' || input.type.trim() === '') return 'owner'
  return 'member'
}
