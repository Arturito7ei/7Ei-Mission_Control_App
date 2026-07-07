// MCA-84 V2 — tri-state approvals. Pure helper that validates an approval
// decision and computes the record patch. Our approvals used to be binary
// (approved | rejected); Paperclip's revision loop is the good part, so we add
// a third state, `revision_requested`, that carries a reviewer note back to the
// requester (the comment loop) instead of a flat reject.
//
// No new store: the note lives on the approval row (decision_note), so the
// requesting agent/operator sees *why* changes were asked for.

export type ApprovalDecision = 'approved' | 'rejected' | 'revision_requested'

export const APPROVAL_DECISIONS: ApprovalDecision[] = ['approved', 'rejected', 'revision_requested']

export interface DecisionPatch {
  status: ApprovalDecision
  decidedBy: string
  decidedAt: Date
  decisionNote: string | null
}

export interface DecisionResult {
  ok: boolean
  error?: string
  patch?: DecisionPatch
}

/**
 * Validate a tri-state decision and produce the update patch.
 * - `revision_requested` REQUIRES a non-empty note — the loop is pointless
 *   without telling the requester what to change.
 * - `approved`/`rejected` may carry an optional note (trimmed, or null).
 * Returns `{ ok:false, error }` for an invalid decision or a missing note so
 * the route can 400 without duplicating the rules.
 */
export function decideApproval(input: {
  decision: unknown
  note?: unknown
  actor: string
  now?: Date
}): DecisionResult {
  const { decision, actor } = input
  if (typeof decision !== 'string' || !APPROVAL_DECISIONS.includes(decision as ApprovalDecision)) {
    return { ok: false, error: 'decision must be approved | rejected | revision_requested' }
  }
  const d = decision as ApprovalDecision
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (d === 'revision_requested' && !note) {
    return { ok: false, error: 'revision_requested requires a note describing the changes' }
  }
  return {
    ok: true,
    patch: {
      status: d,
      decidedBy: actor,
      decidedAt: input.now ?? new Date(),
      decisionNote: note || null,
    },
  }
}
