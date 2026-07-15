// Epic ONB / ONB3 — the JOIN REQUEST + the BOARD-APPROVAL GATE (pure half).
//
// This is the story that inverts the token lifecycle. Today an operator mints an
// `mca_` token at agent-create and hand-carries it. Here:
//
//   join request  ──► the agent DESCRIBES ITSELF. No agent row. No token. Ever.
//        ↓
//   BOARD APPROVAL ─► a human decision, in the EXISTING tri-state approvals queue
//        ↓             (a leaked invite buys a row in an inbox, not a credential)
//   agent row ──────► created CONTAINED: low_trust_review regardless of runtime
//        ↓             (invariant #3), with an EXPLICIT capability list
//   (ONB4) claim ───► the credential. NOT BUILT. `tokenClaimEnabled` is false, and
//                     an approved ONB3 agent has `api_token_hash = NULL` — there is
//                     nothing to claim and nothing to leak.
//
// Everything here is PURE (validation + row-building, injectable `now`/`id`); the
// route does the DB work, and the atomic single-use consume lives in
// `services/invite-consume.ts` — the ONE consume path, and it is the safe one.
//
// ─── Two carried audit caveats that shape this file ─────────────────────────
//
// 1. **No free-text field in the join body.** (`docs/AUDIT-ONB2-hardening.md`,
//    ruling 3.) `redactTokensInText` only catches OUR four token prefixes, so a
//    third-party secret arriving in free text under an innocuous key would reach
//    `audit_logs.metadata` in plaintext. The body is therefore strictly typed and
//    registry-validated: `agentName` is charset-restricted, `capabilities` is an
//    ALLOW-LISTED ENUM ARRAY (not prose), `adapterType` is a registry key, and
//    `agentDefaultsPayload` is validated field-by-field against the registry. There
//    is no `notes`, no `role`, no `message`, and no `description`. Adding one is a
//    security change, not a feature.
// 2. **Declared secrets never touch a plaintext column.** `validateDefaultsPayload`
//    (the registry) splits `secret: true` fields out of the config; the route writes
//    them to the encrypted store (`services/secrets.ts`) and persists only their KEY
//    NAMES here. The values are never logged, never echoed, and never rendered on
//    the approval card.

import { randomUUID } from 'crypto'
import { getAdapter, validateDefaultsPayload, runtimeForAdapter } from './adapter-registry'
import { checkInviteAccepts, type InviteRecord } from './agent-invites'
import { secureRegistration } from './code-executor'
import { INVITE_AGENTS_ALWAYS_LOW_TRUST } from './deployment-profile'

/** Status machine. Terminal on both sides — a decided request is never re-decided. */
export const JOIN_REQUEST_STATUSES = ['pending_approval', 'approved', 'rejected'] as const
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number]

/** The `approval_requests.type` the board-approval card is filed under. It is a
 *  row in the SHIPPED tri-state queue — not a parallel store (the P1 rule). */
export const JOIN_APPROVAL_TYPE = 'agent_join_request'

/** The secret store scope a not-yet-approved join request's secrets are parked in.
 *  Deliberately NOT `agent`/`company`: `resolveSecretsForAgent` only resolves those
 *  two, so a parked secret is INERT — unreadable by every agent — until approval
 *  re-scopes it to the agent that was actually created. A rejected request's secrets
 *  are deleted and were never reachable. */
export const JOIN_SECRET_SCOPE = 'join_request'

export const MAX_AGENT_NAME_CHARS = 100
export const MAX_CAPABILITIES = 8

/**
 * `agentName` is the one field a joining agent freely chooses, and it is rendered
 * on a human's approval card — so it is charset-restricted, not merely length-capped.
 * Letters, numbers, spaces and a few punctuation marks: enough for any real agent
 * name, and not enough to smuggle a credential, a URL, or an instruction to the
 * approver (audit R8: the card must not be an injection surface).
 */
export const AGENT_NAME_RE = /^[\p{L}\p{N} ._\-()]+$/u

/**
 * The capability ALLOW-LIST a joining agent may request — an enum, not prose.
 *
 * These are exactly the capabilities the API actually enforces today
 * (`isCapabilityAllowed` call-sites in `routes/agent-api.ts`, plus CC3's
 * `machine_exec`). Wildcards (`*`, `ns:*`) are refused: a self-declaring, not-yet-
 * approved party does not get to ask for allow-all. An EMPTY list is also refused —
 * `permissions: []` means ALLOW-ALL in `governance2.isCapabilityAllowed`, so an
 * empty capability list is the footgun, not the safe default (CC3 says so).
 */
export const JOINABLE_CAPABILITIES = ['memory:write', 'attachment:write', 'machine_exec'] as const
export type JoinableCapability = (typeof JOINABLE_CAPABILITIES)[number]

/** Capabilities that deserve a warning on the approval card. */
const HIGH_RISK_CAPABILITIES = new Set<string>(['machine_exec'])

/** The persisted row (mirrors the `agent_join_requests` table). */
export interface JoinRequestRecord {
  id: string
  orgId: string
  inviteId: string
  agentName: string
  adapterType: string
  /** The legacy `agents.runtime` value this adapter maps to. */
  runtime: string
  /** Self-declared, allow-listed capability enum values. */
  capabilities: string[]
  /** Non-secret, registry-validated `agentDefaultsPayload` fields (defaults applied). */
  config: Record<string, unknown>
  /** The KEY NAMES of the declared secrets that went to the encrypted store. Never values. */
  secretKeys: string[]
  status: JoinRequestStatus
  /** The `approval_requests` row this is gated by (the board's queue item). */
  approvalRequestId: string | null
  /** The agent created on approve. Null while pending, and null forever on reject. */
  agentId: string | null
  decidedBy: string | null
  decidedAt: Date | null
  createdAt: Date
}

export interface BuildJoinRequestInput {
  id?: string
  invite: InviteRecord
  agentName: unknown
  adapterType: unknown
  capabilities: unknown
  agentDefaultsPayload?: unknown
  now?: Date
}

export type BuildJoinRequestResult =
  | { ok: true; record: JoinRequestRecord; secrets: Record<string, string> }
  | { ok: false; publicReason: 'not_found' | 'adapter_not_allowed' | 'invalid'; errors: string[] }

/**
 * Validate a join request against the invite + the adapter registry, and build the
 * row. Pure: no DB, no crypto beyond an id, injectable `now`.
 *
 * Fail-closed, and the reason-tiering is load-bearing (it is ONB1's rule):
 *  - an invite that is unknown/expired/revoked/exhausted → `not_found`. The route
 *    collapses it to the SAME flat 404 as an unknown token, so the endpoint cannot
 *    be used to enumerate valid invites.
 *  - an adapter the invite does not allow / that is not available → `adapter_not_allowed`.
 *    The caller holds a VALID invite, so telling them is not a leak — and a silent
 *    404 here would send a legitimate agent chasing a ghost.
 *  - a malformed body → `invalid` with field-level errors, because the caller can
 *    fix it and there is nothing to leak.
 *
 * NOTE: the invite check here is advisory. The AUTHORITATIVE check is the atomic
 * conditional UPDATE in `consumeInviteUse` (ONB1 audit H1) — this one only avoids
 * doing work for an obviously-closed door.
 */
export function buildJoinRequest(input: BuildJoinRequestInput): BuildJoinRequestResult {
  const now = input.now ?? new Date()
  const errors: string[] = []

  // ── adapterType: registry + the invite's allow-list ──
  const adapterType = String(input.adapterType ?? '').trim()
  if (!adapterType) return { ok: false, publicReason: 'invalid', errors: ['adapterType is required'] }

  const accepts = checkInviteAccepts(input.invite, adapterType, now)
  if (accepts.ok === false) {
    return {
      ok: false,
      publicReason: accepts.publicReason,
      errors: [accepts.publicReason === 'not_found' ? 'not found' : accepts.reason],
    }
  }
  const adapter = getAdapter(adapterType)!

  // ── agentName ──
  const agentName = String(input.agentName ?? '').trim()
  if (!agentName) errors.push('agentName is required')
  else if (agentName.length > MAX_AGENT_NAME_CHARS) errors.push(`agentName must be <= ${MAX_AGENT_NAME_CHARS} chars`)
  else if (!AGENT_NAME_RE.test(agentName)) errors.push('agentName may contain only letters, numbers, spaces and . _ - ( )')

  // ── capabilities: an allow-listed enum array, never free text, never empty ──
  const caps = input.capabilities
  if (!Array.isArray(caps) || caps.length === 0) {
    errors.push(`capabilities must be a non-empty array of: ${JOINABLE_CAPABILITIES.join(', ')}`)
  } else if (caps.length > MAX_CAPABILITIES) {
    errors.push(`capabilities must be <= ${MAX_CAPABILITIES} entries`)
  } else {
    const bad = caps.map(String).filter((c) => !(JOINABLE_CAPABILITIES as readonly string[]).includes(c))
    if (bad.length > 0) errors.push(`unknown capability: ${bad.join(', ')} (allowed: ${JOINABLE_CAPABILITIES.join(', ')})`)
  }

  // ── agentDefaultsPayload: the registry decides, and it splits the secrets out ──
  const payload = validateDefaultsPayload(adapterType, input.agentDefaultsPayload ?? {})
  if (!payload.ok) errors.push(...payload.errors)

  if (errors.length > 0) return { ok: false, publicReason: 'invalid', errors }

  const capabilities = Array.from(new Set((caps as unknown[]).map(String)))
  return {
    ok: true,
    secrets: payload.secrets,
    record: {
      id: input.id ?? randomUUID(),
      orgId: input.invite.orgId,
      inviteId: input.invite.id,
      agentName,
      adapterType: adapter.type,
      runtime: runtimeForAdapter(adapter.type) ?? 'custom',
      capabilities,
      config: payload.config,
      // Only the NAMES. The values are in the encrypted store and nowhere else.
      secretKeys: Object.keys(payload.secrets),
      status: 'pending_approval',
      approvalRequestId: null,
      agentId: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: now,
    },
  }
}

// ─── The board-approval card (machine-generated; never agent prose) ──────────

export interface JoinApprovalCard {
  summary: string
  payload: Record<string, unknown>
}

/**
 * Render the approval card for a pending join request.
 *
 * Same rule as A2/CC2 and P1's `renderReviewSummary`: the human sees a
 * MACHINE-GENERATED summary built from the structured record — never a string the
 * joining agent wrote, presented as if Mission Control said it. The agent's own
 * `agentName` appears (it must — the approver is deciding about it), quoted, charset-
 * restricted at validation, and explicitly labelled **self-declared and unverified**
 * (audit R8: the card is an injection surface if you let it be).
 *
 * Secret VALUES never appear. Only the key names, and only to tell the approver that
 * a credential was supplied and is already encrypted.
 */
export function buildJoinApprovalCard(record: JoinRequestRecord): JoinApprovalCard {
  const adapter = getAdapter(record.adapterType)
  const summary = `Agent join request: "${record.agentName}" wants to join as ${record.adapterType} (${record.capabilities.length} capability/ies) — self-declared, unverified`

  const warnings: string[] = [
    'Every field on this card was SELF-DECLARED by the joining agent and is NOT verified by Mission Control.',
    'On approve the agent is created CONTAINED: low_trust_review, an explicit capability list, and a boundary set. It has NO API key — the one-time claim lands in ONB4.',
  ]
  const risky = record.capabilities.filter((c) => HIGH_RISK_CAPABILITIES.has(c))
  if (risky.length > 0) {
    warnings.push(`The agent asked for ${risky.join(', ')}. Low-trust containment quarantines every such action for your review before it runs — approving this request does NOT approve any command.`)
  }
  if (adapter?.capabilities.executesHostCommands) {
    warnings.push(`\`${record.adapterType}\` is a runtime that executes commands on a host machine.`)
  }
  if (record.secretKeys.length > 0) {
    warnings.push(`The agent supplied ${record.secretKeys.length} declared secret field(s) (${record.secretKeys.join(', ')}). They are already ENCRYPTED at rest and are never shown here or anywhere else.`)
  }

  return {
    summary,
    payload: {
      agentJoinRequest: true,
      joinRequestId: record.id,
      inviteId: record.inviteId,
      // Every agent-authored value is under this key, and the key says what it is.
      selfDeclared: {
        agentName: record.agentName,
        adapterType: record.adapterType,
        capabilities: record.capabilities,
        // Machine-generated summary of the payload — the registry-validated config,
        // which by construction contains no secret field.
        config: record.config,
        secretFieldsSupplied: record.secretKeys,
      },
      verified: false,
      landsInTrustMode: 'low_trust_review',
      mintsCredential: false,
      warnings,
    },
  }
}

// ─── The decision ───────────────────────────────────────────────────────────

export type JoinDecision = 'approved' | 'rejected'

export function parseJoinDecision(decision: unknown): JoinDecision | null {
  const d = String(decision ?? '').trim().toLowerCase()
  return d === 'approved' || d === 'rejected' ? d : null
}

/**
 * The agent row an APPROVED join request produces.
 *
 * Invariant #3 (`INVITE_AGENTS_ALWAYS_LOW_TRUST`, operator-approved, not env-tunable):
 * **every invite-created agent lands in `low_trust_review` regardless of runtime** —
 * extending CC3 beyond `claude_code`. Invite-onboarded means self-declared and
 * remotely-attached: contain it. We do not re-decide this per runtime; we read the
 * constant, so a future runtime cannot quietly opt out (ONB1 audit's instruction).
 *
 * Invariant #1/#4: `apiTokenHash` is **null**. No credential is minted here, nothing
 * is parked, and there is nothing an operator could be shown. The claim is ONB4.
 */
export function buildApprovedAgent(input: {
  id?: string
  record: JoinRequestRecord
  now?: Date
}): Record<string, unknown> {
  const { record } = input
  const now = input.now ?? new Date()

  const sec = secureRegistration({
    runtime: record.runtime,
    // The EXPLICIT capability list — the agent's own, allow-list-validated. Never
    // empty (validation refuses that), so this can never decay to allow-all.
    permissions: record.capabilities,
    // Read the invariant; do not re-derive it from the runtime.
    trustMode: INVITE_AGENTS_ALWAYS_LOW_TRUST ? 'low_trust_review' : undefined,
    // An EXPLICIT empty boundary, persisted. `secureRegistration` would leave it
    // null for a non-code runtime, and `parseBoundary(null)` is already fail-closed
    // (empty = touches nothing) — but a persisted empty boundary says "contained on
    // purpose" instead of "nobody set this", which is what the next reader needs.
    trustBoundary: { projects: [], tasks: [], agents: [] },
  })

  return {
    id: input.id ?? randomUUID(),
    orgId: record.orgId,
    departmentId: null,
    name: record.agentName,
    // Machine-generated. NOT a field the joining agent supplied — there is no
    // free-text `role` in the join body, and this is why.
    role: `External ${record.adapterType} agent (invite-onboarded)`,
    personality: null,
    cv: null,
    termsOfReference: null,
    llmProvider: 'minimax',
    llmModel: 'minimax',
    skills: [] as string[],
    status: 'idle',
    avatarEmoji: '🤖',
    agentType: 'external',
    advisorPersona: null,
    memoryLongTerm: null,
    runtime: record.runtime,
    externalEndpoint: typeof record.config.externalEndpoint === 'string' ? record.config.externalEndpoint : null,
    // ONB4. There is no token, so there is no hash. An agent with a null hash can
    // authenticate to nothing (`agentAuth` matches on the hash).
    apiTokenHash: null,
    heartbeatStatus: 'unknown',
    contactChannel: null,
    permissions: sec.permissions,
    trustMode: sec.trustMode,
    trustBoundary: sec.trustBoundary,
    createdAt: now,
  }
}

// ─── Views ──────────────────────────────────────────────────────────────────

export interface JoinRequestView {
  id: string
  orgId: string
  inviteId: string
  agentName: string
  adapterType: string
  runtime: string
  capabilities: string[]
  config: Record<string, unknown>
  secretFieldsSupplied: string[]
  status: JoinRequestStatus
  approvalRequestId: string | null
  agentId: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  /** Restated on every view so no caller can mistake this for a credential path. */
  selfDeclaredUnverified: true
}

/** The operator-facing view. Contains no secret value — there is none to contain. */
export function joinRequestView(record: JoinRequestRecord): JoinRequestView {
  return {
    id: record.id,
    orgId: record.orgId,
    inviteId: record.inviteId,
    agentName: record.agentName,
    adapterType: record.adapterType,
    runtime: record.runtime,
    capabilities: record.capabilities,
    config: record.config,
    secretFieldsSupplied: record.secretKeys,
    status: record.status,
    approvalRequestId: record.approvalRequestId,
    agentId: record.agentId,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    selfDeclaredUnverified: true,
  }
}

/**
 * The JOIN response — what the joining agent is told, and the whole of it.
 *
 * ONB4 changes this: the response now carries the one-time `claimSecret` (a `mcc_`
 * bearer), minted here and stored HASH-ONLY, plus its expiry. This is the ONLY time
 * the raw claim secret exists — the agent stores it and spends it ONCE at the claim
 * step, but only AFTER a human approves (a leaked secret is useless before approval,
 * and single-use after). There is still NO agent token here: the `mca_` credential is
 * minted at claim, not now.
 *
 * When the claim surface is not open (`claimOpen` false — a build without ONB4, or a
 * posture that keeps the whole onboarding flow shut), no secret is minted and none is
 * returned; the agent is told the claim is not yet open.
 */
export function joinAcceptedResponse(
  record: JoinRequestRecord,
  claimPath: string,
  claimOpen: boolean,
  claim?: { secret: string; expiresAt: Date },
) {
  const base = {
    requestId: record.id,
    status: record.status,
    claimPath,
    claimStatus: claimOpen ? ('open' as const) : ('not_yet_open' as const),
  }
  if (claimOpen && claim) {
    return {
      ...base,
      // The raw `mcc_` claim secret — returned EXACTLY ONCE, stored hash-only. Store
      // it from this raw JSON, never from a chat/transcript preview, and spend it once
      // at the claim step after approval.
      claimSecret: claim.secret,
      claimSecretExpiresAt: claim.expiresAt.toISOString(),
      message: 'Join request submitted. Store the one-time claimSecret from THIS response (never from a transcript). A human must approve the request before you can spend it at the claim step; the raw API key is returned only there, exactly once.',
    }
  }
  return {
    ...base,
    // Said out loud, in the response, because an agent that expects a secret here
    // and gets none should know WHY rather than retry.
    message: 'Join request submitted. A human must approve it before any API key can exist. The claim step is not open on this deployment, so no claim secret was issued.',
  }
}
