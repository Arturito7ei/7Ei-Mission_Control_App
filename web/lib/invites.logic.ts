// Epic ONB / ONB6 — pure logic for the create-invite surface. Framework-free and
// unit-tested (web zero-dep runner), so the dialog component stays thin.
//
// Two ONB6 acceptance points live here:
//  * the adapter picker RENDERS FROM the server-side registry (GET /api/adapters),
//    never from the client-side `adapterProfile.ts` — `pickableAdapters` is the
//    filter that closes the ONB1 audit's "second source of truth" item for the
//    invite flow: only `invitable && available` (and never `internal`) may be named.
//  * status is colorblind-safe: `inviteStatusChip` returns an icon + a label + a
//    tone, never a colour alone (DESIGN_SYSTEM v2 rule).

/** One row of GET /api/adapters (the fields the picker needs). */
export interface AdapterRegistryEntry {
  type: string
  label: string
  kind: string
  available: boolean
  invitable: boolean
  /** Why an `available: false` adapter is unavailable. The registry carries a
   *  note on every one of them (pinned by the backend's [ADD-1] tripwire), and
   *  AAD-2 shows it rather than hiding the runtime entirely. */
  note?: string | null
}

/**
 * The adapters an operator may put on an invite's allow-list: invitable AND
 * available, and never `internal` (Mission Control runs those — there is no
 * external runtime to onboard). This is exactly `joinableAdapterTypes()` on the
 * server, computed here from the registry payload so the two cannot drift.
 */
export function pickableAdapters(adapters: AdapterRegistryEntry[] | null | undefined): AdapterRegistryEntry[] {
  return (adapters ?? []).filter((a) => a.invitable && a.available && a.kind !== 'internal')
}

/**
 * AAD-2 — the declared-but-NOT-YET-BUILT runtimes, for an inert "not yet
 * available" list under the picker.
 *
 * The picker used to render only `pickableAdapters`, so a runtime that Mission
 * Control cannot hand work to (openclaw_gateway, http_webhook, hermes_gateway,
 * hermes_local, grok_local — all `available: false`) was simply ABSENT. An
 * operator who came looking for Grok or Hermes read that absence as "not
 * supported at all", or worse, went hunting for a setting to turn it on. Showing
 * them as inert, with the registry's own reason, is the honest answer: declared,
 * not yet dispatchable, and therefore not selectable.
 *
 * `internal` is excluded — MC runs those itself, so it is not "coming soon", it
 * is simply not something you invite.
 */
export function unavailableAdapters(adapters: AdapterRegistryEntry[] | null | undefined): AdapterRegistryEntry[] {
  return (adapters ?? []).filter((a) => a.invitable && !a.available && a.kind !== 'internal')
}

export type ChipTone = 'ok' | 'warn' | 'fail' | 'muted'
export interface StatusChip { icon: string; label: string; tone: ChipTone }

/** Colorblind-safe descriptor for an invite's computed status. Icon + label +
 *  tone — the icon and word carry the meaning; the tone is only reinforcement. */
export function inviteStatusChip(status: string): StatusChip {
  switch (status) {
    case 'active': return { icon: '●', label: 'Active', tone: 'ok' }
    case 'accepted': return { icon: '✓', label: 'Used up', tone: 'muted' }
    case 'expired': return { icon: '○', label: 'Expired', tone: 'muted' }
    case 'revoked': return { icon: '✕', label: 'Revoked', tone: 'fail' }
    default: return { icon: '•', label: status || 'Unknown', tone: 'muted' }
  }
}

export interface CreateInviteForm {
  /** Selected adapter types; empty → "any invitable adapter". */
  adapterTypes: string[]
  /** true → multi-use (uses honoured); false → single-use (default). */
  multiUse: boolean
  uses: number
  ttlHours: number
  message: string
}

export const CREATE_INVITE_DEFAULTS: CreateInviteForm = {
  adapterTypes: [], multiUse: false, uses: 5, ttlHours: 72, message: '',
}

/** Bounds mirror the backend constants (agent-invites.ts). Kept here so the form
 *  can validate before the round-trip, not so it becomes a second source of truth. */
export const INVITE_MAX_USES = 50
export const INVITE_MAX_TTL_HOURS = 168

/** Build the POST body from form state — omitting anything left at "default" so the
 *  backend applies its own defaults (single-use, 72h). Single-use never sends `maxUses`. */
export function buildCreateInviteBody(form: CreateInviteForm): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (form.adapterTypes.length > 0) body.allowedAdapterTypes = form.adapterTypes
  if (form.multiUse && form.uses > 1) body.maxUses = form.uses
  if (form.ttlHours && form.ttlHours !== 72) body.expiresInHours = form.ttlHours
  const msg = form.message.trim()
  if (msg) body.message = msg
  return body
}

/** Client-side guard rails matching the backend's `createInvite` validation, so a
 *  bad value is caught before the request (the backend is still the authority). */
export function validateCreateInvite(form: CreateInviteForm): string[] {
  const errors: string[] = []
  if (form.multiUse && (!Number.isInteger(form.uses) || form.uses < 1 || form.uses > INVITE_MAX_USES)) {
    errors.push(`Uses must be between 1 and ${INVITE_MAX_USES}.`)
  }
  if (!Number.isFinite(form.ttlHours) || form.ttlHours <= 0 || form.ttlHours > INVITE_MAX_TTL_HOURS) {
    errors.push(`Time to live must be between 1 and ${INVITE_MAX_TTL_HOURS} hours.`)
  }
  return errors
}

// ─── Join-request approval visibility (ONB3 cards in the shipped inbox) ───────

/** The approval type a join request is filed under (mirrors JOIN_APPROVAL_TYPE). */
export const JOIN_APPROVAL_TYPE = 'agent_join_request'

export function isJoinRequestApproval(type: string | null | undefined): boolean {
  return type === JOIN_APPROVAL_TYPE
}

/** The inbox chip for a join request — an agent asking to join is neither a routine
 *  approval nor a low-trust quarantine, so it reads distinctly (icon + words). */
export function joinRequestChip(): StatusChip {
  return { icon: '🤝', label: 'Agent wants to join', tone: 'warn' }
}
