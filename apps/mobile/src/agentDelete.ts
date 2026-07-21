// AAD-2 (mobile) — the phone's copy of the desk's delete decisions.
//
// PARITY. Metro cannot import out of `apps/mobile` into `web/`, so this is a
// hand-copy of `web/lib/agentDelete.ts` — and, per the standing rule, the copy is
// PINNED: `agentDelete.test.ts` imports the web module directly and asserts the
// two agree. A copy without a tripwire is silent drift.
//
// The gate is the same one the desk states: the backend route is
//   DELETE /api/orgs/:orgId/agents/:agentId   { preHandler: requireOrgRole('owner') }
// and the client only decides what to OFFER. Fail closed on anything that is not
// exactly `'owner'` — same rule, and same reason, as `isOwnerRole` in agentEdit.ts.

export const ORG_ROLES = ['owner', 'member'] as const
export type OrgRole = (typeof ORG_ROLES)[number]

/** Owner-only, fail-closed. The backend is still the enforcer. */
export function canDeleteAgent(role: string | null | undefined): boolean {
  return role === 'owner'
}

/** The ORG-SCOPED path. `requireOrgRole` no-ops on a path without `:orgId`, so
 *  the shape of this string is a security property, not a formatting choice. */
export function agentDeletePath(orgId: string, agentId: string): string {
  return `/api/orgs/${orgId}/agents/${agentId}`
}

/** Typed-name confirmation — trimmed, case-insensitive, never empty, never partial. */
export function isDeleteConfirmed(typed: string, agentName: string): boolean {
  const want = (agentName ?? '').trim().toLowerCase()
  const got = (typed ?? '').trim().toLowerCase()
  return want.length > 0 && got === want
}

/** What deleting actually does — every clause a real backend behaviour. */
export const DELETE_CONSEQUENCES = [
  'Its API token stops working immediately — a running adapter loses access on its next call.',
  'Its connected credentials are revoked: Google/OAuth tokens are dropped (and revoked upstream where possible), agent-scoped secrets are deleted, and its connectors are disabled.',
  'It disappears from the roster, the staff grid and the org chart, and it can no longer be assigned or run work.',
  'Its history is retained for the audit trail — this is a soft delete, but there is no restore in the app.',
] as const

export const DELETE_TITLE = 'Delete this agent?'

export const NON_OWNER_DELETE_NOTE =
  'Only an organisation owner can delete an agent. Ask an owner if this agent should go.'

/** The phone's role can be genuinely UNKNOWN (a pasted token whose orgs were
 *  never listed with a role) — a state the desk does not have. The phone's
 *  established rule for that case (agentEdit.ts) is to offer the action with a
 *  caution and let the backend 403 be the real enforcer. Deleting keeps that
 *  rule rather than inventing a stricter one, because a stricter one would lock
 *  a legitimate owner out of the only destructive control on the device. The
 *  typed-name confirmation still stands in front of it. */
export const UNKNOWN_ROLE_DELETE_NOTE =
  'Your role in this org isn’t known on this device (you’re signed in with a pasted token). Deleting is offered, but the backend still enforces owner-only — a non-owner delete is refused there.'
