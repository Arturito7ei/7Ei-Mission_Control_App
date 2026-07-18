// APPR-1 — the desk's copy of the backend's DANGEROUS approval-type set.
//
// Approving a dangerous type requires STEP-UP: a fresh Arturita command session
// presented in the `x-arturita-session` header on /api/approvals/:id/decide, else
// the backend 403s (backend/src/routes/tasks.ts). Before APPR-1 the web sent no
// header at all AND cleared the card optimistically, so a 403 rendered as success —
// the operator believed a dangerous action was approved when the server had
// rejected it. This module is the desk half of the gate the phone already
// implements (apps/mobile/src/constants.ts + stepup.ts).
//
// ⚠ HAND-COPIED from backend/src/services/dangerous-approvals.ts. It is duplicated
// rather than imported because that module pulls `./cc-denylist` + `./connector-authz`
// (and transitively drizzle), which must not enter the browser bundle. The copy is
// pinned by a tripwire — `dangerousApprovals.test.ts` text-reads the backend source
// and asserts SET EQUALITY, so drift in either direction fails the build rather than
// silently downgrading a dangerous approval to a one-click approve.
//
// Keep this file IMPORT-FREE: apps/mobile's parity test imports it directly, and
// Mobile CI installs only apps/mobile's dependencies (see the root CLAUDE.md
// parity rule + the cross-workspace test-import constraint).

export const DANGEROUS_APPROVAL_TYPES = [
  'file_destructive',
  'wallet_tx',
  'email_send',
  'machine_exec',
  // CONN-7 — a per-agent connector WRITE/SEND/DESTRUCTIVE action. CONN-9 wired
  // connector actions into the agent run loop, so these are now an EVERYDAY card.
  'connector_action',
] as const

export type DangerousApprovalType = (typeof DANGEROUS_APPROVAL_TYPES)[number]

const DANGEROUS_SET = new Set<string>(DANGEROUS_APPROVAL_TYPES)

/** Is this a dangerous approval type? Normalized exactly like the backend
 *  (dangerous-approvals.ts `isDangerousType`) — the direct approval-creation route
 *  stores `type` verbatim, so "machine exec" / "Machine_Exec" / " wallet_tx" must
 *  still be caught here, otherwise the desk renders a plain Approve that dead-ends
 *  on the server's 403. */
export function isDangerousApprovalType(type: string | null | undefined): boolean {
  const norm = String(type ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  return DANGEROUS_SET.has(norm)
}

/** Does approving this item require step-up? Mirrors the backend decide gate
 *  (tasks.ts: `isDangerousType(approval.type) || payload.requiresStepUp === true`).
 *
 *  The second clause is DEFENCE IN DEPTH, not the primary path: an approval whose
 *  OUTER type is not itself dangerous (e.g. a `low_trust_review` WRAPPING a
 *  dangerous action) still carries `requiresStepUp:true` in its payload, and the
 *  backend gates on it. Keeping it means a backend type we have not copied yet
 *  still routes through step-up instead of failing as a mystery 403 — but the
 *  tripwire exists so we never *rely* on it. */
export function approvalNeedsStepUp(a: {
  type?: string | null
  payload?: { requiresStepUp?: unknown } | null
}): boolean {
  return isDangerousApprovalType(a?.type) || a?.payload?.requiresStepUp === true
}

/** The word the operator must type to confirm a dangerous approve on the desk.
 *  The web equivalent of the phone's biometric gate: there is no Face ID in the
 *  browser, so the deliberate act is typing. Exact (trimmed), case-sensitive match
 *  so a stray "approve" / " ok " never passes. Mirrors apps/mobile/src/stepup.ts. */
export const TYPED_CONFIRM_WORD = 'APPROVE'

/** Does the typed input satisfy the desk's step-up gate? */
export function typedConfirmationOk(input: string | null | undefined): boolean {
  return String(input ?? '').trim() === TYPED_CONFIRM_WORD
}

/** What the step-up card must show: the type, the backend's MACHINE-RENDERED
 *  summary (never model prose — the backend renders it deterministically from the
 *  structured action), and the danger warnings it surfaced. Pure + defensive: an
 *  odd payload yields an empty warnings list, never throws. Mirrors the phone's
 *  `dangerDetails`. */
export function dangerDetails(a: { type?: string | null; summary?: string | null; payload?: any }): {
  typeLabel: string
  summary: string
  warnings: string[]
} {
  const warnings = Array.isArray(a?.payload?.warnings)
    ? a.payload.warnings.map((w: unknown) => String(w)).filter(Boolean)
    : []
  return {
    typeLabel: String(a?.type ?? '').replace(/_/g, ' '),
    summary: a?.summary || '(no summary provided)',
    warnings,
  }
}
