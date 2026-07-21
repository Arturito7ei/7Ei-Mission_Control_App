// AAD-2 (mobile) — the phone's copy of the desk's create-invite decisions
// (`web/lib/invites.logic.ts`). Pure and React-free so `node --test` can load it,
// and PINNED against the web module by `invites.test.ts` — Metro cannot import
// out of apps/mobile into web/, so the copy needs a tripwire or it drifts.
//
// THE ONE INVARIANT THAT MATTERS HERE. The runtime picker RENDERS FROM the
// server adapter registry (`GET /api/adapters`), never from a hardcoded list on
// the device. `pickableAdapters` = `invitable && available && kind !== 'internal'`
// — exactly `joinableAdapterTypes()` on the server. A runtime that is declared
// but not BUILT (openclaw_gateway, http_webhook, hermes_gateway, hermes_local,
// grok_local — all `available: false`, backend/src/services/adapter-registry.ts)
// must therefore be shown as NOT YET AVAILABLE and must not be selectable. It is
// not "greyed out for tidiness": an invite naming a runtime Mission Control
// cannot hand work to is an invite that can never be spent.

/** One row of GET /api/adapters (the fields the picker needs). */
export interface AdapterRegistryEntry {
  type: string
  label: string
  kind: string
  available: boolean
  invitable: boolean
  /** Why an unavailable adapter is unavailable. The registry carries a note for
   *  every `available: false` row (pinned by the backend's [ADD-1] tripwire), and
   *  the picker shows it rather than a bare disabled chip. */
  note?: string | null
}

/** The adapters an operator may put on an invite's allow-list. */
export function pickableAdapters(adapters: AdapterRegistryEntry[] | null | undefined): AdapterRegistryEntry[] {
  return (adapters ?? []).filter((a) => a.invitable && a.available && a.kind !== 'internal')
}

/**
 * The declared-but-not-yet-available runtimes, shown UNDER the picker as inert
 * rows. `internal` is excluded — Mission Control runs those itself, so there is
 * no external runtime to onboard and it is not "coming soon", it is not a thing
 * you invite. Showing the rest is the honest half of the registry: the operator
 * asked for Cursor/Claude Code/Grok/Hermes/OpenClaw and deserves to see which of
 * those can actually be onboarded today, not an empty space where the others were.
 */
export function unavailableAdapters(adapters: AdapterRegistryEntry[] | null | undefined): AdapterRegistryEntry[] {
  return (adapters ?? []).filter((a) => a.invitable && !a.available && a.kind !== 'internal')
}

export type ChipTone = 'ok' | 'warn' | 'fail' | 'muted'
export interface StatusChip { icon: string; label: string; tone: ChipTone }

/** Colorblind-safe descriptor for an invite's status — icon + label + tone. */
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
  adapterTypes: string[]
  multiUse: boolean
  uses: number
  ttlHours: number
  message: string
}

export const CREATE_INVITE_DEFAULTS: CreateInviteForm = {
  adapterTypes: [], multiUse: false, uses: 5, ttlHours: 72, message: '',
}

/** Bounds mirror the backend constants (routes/agent-invites.ts). Out-of-range
 *  values are REFUSED by the server, not clamped — so the phone refuses too
 *  rather than quietly sending something that 400s. */
export const INVITE_MAX_USES = 50
export const INVITE_MAX_TTL_HOURS = 168

/** Build the POST body, omitting anything left at its default so the SERVER owns
 *  the defaults (single-use, 72h). Single-use never sends `maxUses`. */
export function buildCreateInviteBody(form: CreateInviteForm): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (form.adapterTypes.length > 0) body.allowedAdapterTypes = form.adapterTypes
  if (form.multiUse && form.uses > 1) body.maxUses = form.uses
  if (form.ttlHours && form.ttlHours !== 72) body.expiresInHours = form.ttlHours
  const msg = form.message.trim()
  if (msg) body.message = msg
  return body
}

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

/** Toggle one runtime in the allow-list (the picker's only mutation). */
export function toggleAdapterType(selected: string[], type: string): string[] {
  return selected.includes(type) ? selected.filter((t) => t !== type) : [...selected, type]
}

// ─── Copy shown on the sheet ────────────────────────────────────────────────

/** What an approved join actually produces. Both clauses are backend invariants
 *  (`secureRegistration()`; `allowShell` defaults false in the registry), stated
 *  here so the operator knows what they are creating BEFORE they create it. */
export const INVITE_POSTURE_NOTE =
  'A human still approves every join before a credential exists. An approved agent starts under low-trust review with shell access OFF.'

/** The deployment-posture warning. `MC_ENABLE_REMOTE_ONBOARDING` is unset on
 *  hosted prod, so join/claim answer a flat 404 — the invite is real but cannot
 *  be spent yet. Never soften this to make the entry point feel finished. */
export const JOIN_CLOSED_NOTE =
  'Public join is closed on this deployment. The invite and prompt are created, but an agent cannot join until remote onboarding is enabled by the operator.'

export const ONE_TIME_REVEAL_NOTE =
  'Shown once and not recoverable — copy the prompt now. There is no agent key here: the key is minted only when the joining agent claims the invite, and only the claimer ever sees it.'
