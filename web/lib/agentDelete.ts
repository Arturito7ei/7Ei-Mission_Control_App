// AAD-2 — pure decisions for the "Delete Agent" control (Agent Settings →
// Configuration). Framework-free and unit-tested under the web zero-dep runner,
// so the dialog and the tab stay thin — and so the phone can pin its hand-copy
// against this module (apps/mobile/src/agentDelete.test.ts).
//
// THE GATE. The backend route is
//   DELETE /api/orgs/:orgId/agents/:agentId   { preHandler: requireOrgRole('owner') }
// (AAD-1). The client NEVER decides whether a delete is allowed — the server
// does. What lives here is what the client decides to OFFER: a Delete button a
// member can press only to collect a 403 is a lie about what they can do.
//
// FAIL CLOSED. `canDeleteAgent` is exact-match on `'owner'`. Anything else —
// `'member'`, an unknown string, `'admin'` (which is NOT a role in this model),
// null, undefined — is not an owner. Mirrors `isOwnerRole` in
// `apps/mobile/src/agentEdit.ts:36`, which is locked by its own test for the
// same reason: a role vocabulary that grows must not silently grant delete.

/** The org membership roles, mirroring the backend `OrgRole` union (rbac.ts). */
export const ORG_ROLES = ['owner', 'member'] as const
export type OrgRole = (typeof ORG_ROLES)[number]

/**
 * May this caller be OFFERED the delete control? Owner only, fail-closed on
 * anything unrecognised. The backend is still the enforcer.
 */
export function canDeleteAgent(role: string | null | undefined): boolean {
  return role === 'owner'
}

/** The org-scoped delete route. Owner-gated + audit-logged with the right orgId
 *  precisely BECAUSE it carries `:orgId` — `requireOrgRole` no-ops on a path
 *  without one (the R-4 trap), which is why the legacy top-level
 *  `DELETE /api/agents/:agentId` was retired to a 410 rather than decorated. */
export function agentDeletePath(orgId: string, agentId: string): string {
  return `/api/orgs/${orgId}/agents/${agentId}`
}

/**
 * The typed-name confirmation. Trimmed and case-insensitive — the operator is
 * proving intent, not their typing accuracy — but never empty, and never a
 * partial match: an agent called "Ops" must not be deletable by typing "O".
 */
export function isDeleteConfirmed(typed: string, agentName: string): boolean {
  const want = (agentName ?? '').trim().toLowerCase()
  const got = (typed ?? '').trim().toLowerCase()
  return want.length > 0 && got === want
}

/** What deleting actually does, in the operator's words. Every clause is a real
 *  backend behaviour (services/agent-deletion.ts), not reassurance: if one of
 *  these stops being true, this copy is a bug. */
export const DELETE_CONSEQUENCES = [
  'Its API token stops working immediately — a running adapter loses access on its next call.',
  'Its connected credentials are revoked: Google/OAuth tokens are dropped (and revoked upstream where possible), agent-scoped secrets are deleted, and its connectors are disabled.',
  'It disappears from the roster, the staff grid and the org chart, and it can no longer be assigned or run work.',
  'Its history is retained for the audit trail — this is a soft delete, but there is no restore in the app.',
] as const

export const DELETE_TITLE = 'Delete this agent?'

/** Shown instead of the control to a caller we know is not an owner. */
export const NON_OWNER_DELETE_NOTE =
  'Only an organisation owner can delete an agent. Ask an owner if this agent should go.'

/** Shown when the caller's role could not be resolved at all. We hide the
 *  control (fail closed) and say so, rather than offering a button whose outcome
 *  we cannot predict. */
export const UNKNOWN_ROLE_DELETE_NOTE =
  'Your role in this organisation could not be confirmed, so deleting is not offered here. Reload, or ask an owner.'
