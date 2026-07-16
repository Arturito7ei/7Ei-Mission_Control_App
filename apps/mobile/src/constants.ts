// Cross-screen constants. Single source of truth so lists don't drift between
// screens (L2 nit from the MOB-1 audit).

// Approval types the backend classifies as *dangerous*: approving one requires a
// fresh Arturita step-up session token (x-arturita-session), which this client
// does not yet mint — so one-tap approve of these always 403s until MOB-4 lands.
// Reject / request-changes never need step-up. This mirrors the backend's
// dangerous-type set (backend approvals service); it is duplicated here because
// apps/mobile is a standalone npm project that must not import backend source.
// Keep in sync with the backend if that list ever changes.
export const DANGEROUS_APPROVAL_TYPES = [
  'file_destructive',
  'wallet_tx',
  'email_send',
  'machine_exec',
] as const

export type DangerousApprovalType = (typeof DANGEROUS_APPROVAL_TYPES)[number]

const DANGEROUS_SET = new Set<string>(DANGEROUS_APPROVAL_TYPES)

export function isDangerousApprovalType(type: string | null | undefined): boolean {
  // Normalize exactly like the backend (dangerous-approvals.ts:30-33) before
  // matching: the direct approval-creation route stores `type` verbatim, so a
  // stored "machine exec" / "Machine_Exec" / " wallet_tx" must still be caught
  // client-side — otherwise L1 would render an ENABLED one-tap Approve that then
  // dead-ends on the server's 403.
  const norm = String(type ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  return DANGEROUS_SET.has(norm)
}

/** Does approving this item require an on-device step-up? Mirrors the backend
 *  decide gate (tasks.ts:478), which requires step-up for a direct dangerous
 *  type OR any approval carrying `payload.requiresStepUp === true` — e.g. a
 *  `low_trust_review` WRAPPING a dangerous action, whose OUTER type is not itself
 *  dangerous. Without the second clause such an item would read as safe, route to
 *  the one-tap approve, and 403 at the server. */
export function approvalNeedsStepUp(a: {
  type?: string | null
  payload?: { requiresStepUp?: unknown } | null
}): boolean {
  return isDangerousApprovalType(a?.type) || a?.payload?.requiresStepUp === true
}
