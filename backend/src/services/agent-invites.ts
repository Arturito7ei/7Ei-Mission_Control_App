// Epic ONB / ONB1 — the INVITE OBJECT (pure half).
//
// An invite is a short-lived, revocable, org-scoped DOOR that an external agent
// walks through to describe itself. It is NOT a credential: walking through it
// buys you a row in a human's approval queue (ONB3), never a token. The token
// itself is minted only after a human approves, and is claimed exactly once by
// the joining agent (ONB4).
//
// The storage pattern is lifted verbatim from `arturita_bindings` (A1), which is
// the shipped precedent for a hashed, short-TTL, single-use secret:
//   * only the sha256 HASH of the invite token is stored — a DB read yields no
//     working links, and the raw token is shown to the operator exactly once;
//   * a TTL, enforced server-side;
//   * single-use by default (`maxUses: 1`), consumed on accept.
//
// Everything here is PURE (crypto + arithmetic, injectable `now`/`token`), so the
// state machine is deterministically testable and the route layer does the DB work.
//
// Fail-closed rule that the routes must honour: an unknown, expired, revoked or
// exhausted invite must be INDISTINGUISHABLE from the outside (identical 404) —
// otherwise the lookup becomes an oracle for enumerating valid invite tokens.

import { randomBytes } from 'crypto'
// Generic sha256 + constant-time compare, first written for the A1 session/bind
// codes. Reused rather than re-implemented so the two can never drift.
import { hashToken, hashesEqual } from './arturita-session'
import { getAdapter, invitableAdapterTypes } from './adapter-registry'

export { hashToken, hashesEqual }

/** Public invite token prefix — mirrors `mca_` (agent token) / `art_` (session). */
export const INVITE_TOKEN_PREFIX = 'mci_inv_'

/** 128 bits of entropy. The design sketched 12 chars; on a backend that will
 *  eventually expose a public join endpoint, the invite token is a bearer
 *  credential and gets full-strength entropy. */
export const INVITE_TOKEN_BYTES = 16

/** 3 days — the same order as Paperclip's, short enough that a leaked link rots. */
export const DEFAULT_INVITE_TTL_HOURS = 72
/** 7 days. A door that stands open for a month is not an invite, it's a policy. */
export const MAX_INVITE_TTL_HOURS = 168
/** Invariant (operator decision): SINGLE-USE by default. */
export const DEFAULT_MAX_USES = 1
/** Multi-use is an explicit opt-in, and still bounded. */
export const MAX_MAX_USES = 50
export const MAX_MESSAGE_CHARS = 2000

export const INVITE_STATUSES = ['active', 'revoked', 'expired', 'accepted'] as const
export type InviteStatus = (typeof INVITE_STATUSES)[number]

/** Generate a raw invite token. Returned to the operator ONCE; only the hash is stored. */
export function generateInviteToken(): string {
  return INVITE_TOKEN_PREFIX + randomBytes(INVITE_TOKEN_BYTES).toString('hex')
}

/** Shape check before we spend a DB round-trip (and before we hash attacker input). */
export function isInviteTokenShaped(token: unknown): boolean {
  const t = String(token ?? '')
  return t.startsWith(INVITE_TOKEN_PREFIX) && new RegExp(`^${INVITE_TOKEN_PREFIX}[0-9a-f]{${INVITE_TOKEN_BYTES * 2}}$`).test(t)
}

/**
 * Parse the stored `allowed_adapter_types` JSON column into the record's field.
 *
 * FAIL-CLOSED, and the distinction matters: `null` means "any joinable adapter"
 * (the operator never restricted this invite), so a *corrupt* value must NOT
 * decay to null — that would silently WIDEN an invite the operator deliberately
 * narrowed. Unparseable / non-array / empty content therefore yields `[]`, an
 * allow-list that admits nothing, and the invite is inert until re-created.
 */
export function parseAllowedAdapterTypes(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const types = parsed.map(String).filter((t) => t.length > 0)
    return types.length > 0 ? Array.from(new Set(types)) : []
  } catch {
    return []
  }
}

/** The persisted row (mirrors the `agent_invites` table). */
export interface InviteRecord {
  id: string
  orgId: string
  tokenHash: string
  /** JSON array of adapterTypes this invite may onboard; null = any joinable one. */
  allowedAdapterTypes: string[] | null
  maxUses: number
  usedCount: number
  message: string | null
  createdBy: string
  expiresAt: Date
  revokedAt: Date | null
  lastAcceptedAt: Date | null
  createdAt: Date
}

export interface MintedInvite {
  /** Plaintext — shown to the operator exactly once, never stored. */
  token: string
  record: InviteRecord
}

export interface CreateInviteInput {
  id: string
  orgId: string
  createdBy: string
  allowedAdapterTypes?: string[] | null
  maxUses?: number
  expiresInHours?: number
  message?: string | null
  now?: Date
  /** Injectable for deterministic tests. */
  token?: string
}

export type CreateInviteResult =
  | { ok: true; invite: MintedInvite }
  | { ok: false; errors: string[] }

/**
 * Build an invite. Validates the operator's inputs (the one place a *trusted*
 * caller can still get it wrong) and clamps nothing silently — an out-of-range
 * TTL or use-count is an error, not a quietly-adjusted value, because "I asked
 * for 30 days and got 7" is exactly the kind of surprise a security control
 * must not spring.
 */
export function createInvite(input: CreateInviteInput): CreateInviteResult {
  const errors: string[] = []
  const now = input.now ?? new Date()

  const hours = input.expiresInHours ?? DEFAULT_INVITE_TTL_HOURS
  if (!Number.isFinite(hours) || hours <= 0) errors.push('expiresInHours must be a positive number')
  else if (hours > MAX_INVITE_TTL_HOURS) errors.push(`expiresInHours must be <= ${MAX_INVITE_TTL_HOURS}`)

  const maxUses = input.maxUses ?? DEFAULT_MAX_USES
  if (!Number.isInteger(maxUses) || maxUses < 1) errors.push('maxUses must be an integer >= 1')
  else if (maxUses > MAX_MAX_USES) errors.push(`maxUses must be <= ${MAX_MAX_USES}`)

  const message = input.message ? String(input.message) : null
  if (message && message.length > MAX_MESSAGE_CHARS) errors.push(`message must be <= ${MAX_MESSAGE_CHARS} chars`)

  let allowed: string[] | null = null
  if (input.allowedAdapterTypes != null) {
    if (!Array.isArray(input.allowedAdapterTypes) || input.allowedAdapterTypes.length === 0) {
      errors.push('allowedAdapterTypes must be a non-empty array, or omitted for "any"')
    } else {
      const invitable = new Set(invitableAdapterTypes())
      const bad = input.allowedAdapterTypes.filter((t) => !invitable.has(String(t)))
      if (bad.length > 0) errors.push(`not invitable adapterType(s): ${bad.join(', ')}`)
      allowed = Array.from(new Set(input.allowedAdapterTypes.map(String)))
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const token = input.token ?? generateInviteToken()
  return {
    ok: true,
    invite: {
      token,
      record: {
        id: input.id,
        orgId: input.orgId,
        tokenHash: hashToken(token),
        allowedAdapterTypes: allowed,
        maxUses,
        usedCount: 0,
        message,
        createdBy: input.createdBy,
        expiresAt: new Date(now.getTime() + hours * 3600_000),
        revokedAt: null,
        lastAcceptedAt: null,
        createdAt: now,
      },
    },
  }
}

/** The invite's state, computed — never a stored string that can go stale.
 *  Precedence: revoked > expired > accepted(=exhausted) > active. Revocation is
 *  the operator's explicit act and must always be what the UI reports. */
export function inviteStatus(record: Pick<InviteRecord, 'revokedAt' | 'expiresAt' | 'maxUses' | 'usedCount'>, now: Date = new Date()): InviteStatus {
  if (record.revokedAt) return 'revoked'
  if (record.expiresAt.getTime() <= now.getTime()) return 'expired'
  if (record.usedCount >= record.maxUses) return 'accepted'
  return 'active'
}

/** Can this invite still be walked through? */
export function isInviteUsable(record: Pick<InviteRecord, 'revokedAt' | 'expiresAt' | 'maxUses' | 'usedCount'>, now: Date = new Date()): boolean {
  return inviteStatus(record, now) === 'active'
}

export type InviteRejection =
  | { ok: true }
  | { ok: false; reason: string; /** What the caller may safely be TOLD (always a flat 404). */ publicReason: 'not_found' | 'adapter_not_allowed' }

/**
 * May `adapterType` walk through this invite, right now?
 *
 * Note the two-tier reason: the *internal* reason is specific (for the audit
 * log), the *public* one collapses unknown/expired/revoked/exhausted into a
 * single `not_found` so the endpoint cannot be used to probe which invite tokens
 * exist. An adapter that is simply not on the invite's allow-list is a different
 * class — the caller holds a valid invite, so telling them is not a leak.
 */
export function checkInviteAccepts(
  record: Pick<InviteRecord, 'revokedAt' | 'expiresAt' | 'maxUses' | 'usedCount' | 'allowedAdapterTypes'>,
  adapterType: string,
  now: Date = new Date(),
): InviteRejection {
  const status = inviteStatus(record, now)
  if (status !== 'active') return { ok: false, reason: `invite is ${status}`, publicReason: 'not_found' }

  const adapter = getAdapter(adapterType)
  if (!adapter || !adapter.invitable) return { ok: false, reason: `adapterType ${adapterType} is not invitable`, publicReason: 'adapter_not_allowed' }
  if (!adapter.available) return { ok: false, reason: `adapterType ${adapterType} is declared but not available`, publicReason: 'adapter_not_allowed' }
  if (record.allowedAdapterTypes && !record.allowedAdapterTypes.includes(adapter.type)) {
    return { ok: false, reason: `adapterType ${adapterType} is not on this invite's allow-list`, publicReason: 'adapter_not_allowed' }
  }
  return { ok: true }
}

/** Consume one use. Returns the patch the route applies — the route MUST make
 *  the update conditional on `used_count = <the value it read>` (compare-and-set)
 *  so two concurrent joins cannot both consume the last use of a single-use invite. */
export function consumeUsePatch(record: Pick<InviteRecord, 'usedCount'>, now: Date = new Date()): { usedCount: number; lastAcceptedAt: Date } {
  return { usedCount: record.usedCount + 1, lastAcceptedAt: now }
}

/** The operator-facing view of an invite. The token HASH never leaves the DB —
 *  and neither does the raw token, which exists only in the create response. */
export interface InviteView {
  id: string
  orgId: string
  status: InviteStatus
  allowedAdapterTypes: string[] | null
  maxUses: number
  usedCount: number
  usesRemaining: number
  message: string | null
  createdBy: string
  expiresAt: string
  revokedAt: string | null
  lastAcceptedAt: string | null
  createdAt: string
}

export function inviteView(record: InviteRecord, now: Date = new Date()): InviteView {
  return {
    id: record.id,
    orgId: record.orgId,
    status: inviteStatus(record, now),
    allowedAdapterTypes: record.allowedAdapterTypes,
    maxUses: record.maxUses,
    usedCount: record.usedCount,
    usesRemaining: Math.max(0, record.maxUses - record.usedCount),
    message: record.message,
    createdBy: record.createdBy,
    expiresAt: record.expiresAt.toISOString(),
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    lastAcceptedAt: record.lastAcceptedAt ? record.lastAcceptedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  }
}

/** The URLs baked into the onboarding document (ONB2 renders from these). Pure —
 *  the base URL is passed in, never read from the environment here. */
export function inviteUrls(baseUrl: string, token: string): {
  invitePath: string; inviteUrl: string
  onboardingPath: string; onboardingUrl: string
  onboardingTextPath: string; onboardingTextUrl: string
} {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  const invitePath = `/api/agent-invites/${token}`
  return {
    invitePath,
    inviteUrl: `${base}${invitePath}`,
    onboardingPath: `${invitePath}/onboarding`,
    onboardingUrl: `${base}${invitePath}/onboarding`,
    onboardingTextPath: `${invitePath}/onboarding.txt`,
    onboardingTextUrl: `${base}${invitePath}/onboarding.txt`,
  }
}
