// Epic ONB / ONB1+ONB3 — invite management (owner-gated), the public adapter
// registry, the public onboarding document (ONB2), and — since ONB3 — the public
// JOIN REQUEST + the owner-gated BOARD-APPROVAL GATE.
//
// What this file still deliberately does NOT do: mint or return a credential.
// There is no claim endpoint and no token anywhere in it. A join creates a row in a
// human's approval queue; an approval creates a CONTAINED agent with a null
// `api_token_hash`. The one-time claim is ONB4, and `TOKEN_CLAIM_IMPLEMENTED` is
// false until it lands.
//
// Thin routes: every decision lives in the pure services
// (`services/agent-invites.ts`, `services/adapter-registry.ts`,
// `services/deployment-profile.ts`, `services/join-requests.ts`); this layer only
// does DB + HTTP. The two DB-touching exceptions are deliberate and named:
// `services/invite-consume.ts` (the atomic single-use CAS) and
// `services/join-approvals.ts` (the one decision path) — both own a statement whose
// correctness IS the security property, so neither may be re-implemented at a route.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { requireOrgRole } from '../middleware/rbac'
import { perIpRateLimit } from '../middleware/ratelimit'
import { documentEndpoint } from '../services/openapi'
import { publicRegistry, invitableAdapterTypes, joinableAdapterTypes } from '../services/adapter-registry'
import { onboardingPosture, onboardingDocAccess, JOIN_RATE_LIMIT_PER_MINUTE, TOKEN_CLAIM_IMPLEMENTED } from '../services/deployment-profile'
import {
  createInvite, inviteView, inviteUrls, parseAllowedAdapterTypes, isInviteTokenShaped, hashToken, isInviteUsable,
  DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, DEFAULT_MAX_USES, MAX_MAX_USES, MAX_MESSAGE_CHARS,
  type InviteRecord,
} from '../services/agent-invites'
import { buildOnboardingDoc, buildOnboardingPrompt } from '../services/onboarding-doc'
import { consumeInviteUse } from '../services/invite-consume'
import { claimApiKey, generateClaimSecret, claimSecretExpiry } from '../services/claim'
import { applyJoinDecision, toJoinRecord } from '../services/join-approvals'
import {
  buildJoinRequest, buildJoinApprovalCard, joinRequestView, joinAcceptedResponse, parseJoinDecision,
  JOIN_APPROVAL_TYPE, JOIN_SECRET_SCOPE, MAX_AGENT_NAME_CHARS, MAX_CAPABILITIES, JOINABLE_CAPABILITIES,
} from '../services/join-requests'
import { encrypt } from '../services/secrets'

const CreateInviteBody = z.object({
  allowedAdapterTypes: z.array(z.string()).min(1).optional(),
  maxUses: z.number().int().min(1).max(MAX_MAX_USES).optional(),
  expiresInHours: z.number().int().min(1).max(MAX_INVITE_TTL_HOURS).optional(),
  message: z.string().max(MAX_MESSAGE_CHARS).optional(),
})

/** The public base URL the onboarding doc's links are built from. */
function baseUrl(): string {
  return String(process.env.PUBLIC_URL ?? 'https://7ei-backend.fly.dev').replace(/\/+$/, '')
}

/**
 * The base URLs a joining agent should probe, in order (ONB2's connectivity block).
 *
 * Ours is the easy direction: we are a hosted backend on one stable public URL, so
 * the list is usually one entry — but the doc ships the *mechanism* (probe each,
 * take the first that answers `/api/health`) because a packaged/self-hosted Mission
 * Control (Epic H) will have several, and because the agent, not the server, is the
 * only party that knows what it can actually reach.
 *
 * `MC_BASE_URL_CANDIDATES` (comma-separated) lets a self-hosted operator add
 * addresses without a code change. Never a candidate we invent: an unreachable URL
 * in this list costs the agent a timeout and teaches it nothing.
 *
 * The server never fetches these — they are PRINTED into the document, and the
 * joining agent is the one told to probe them. So there is no SSRF here. But the
 * document instructs an agent to make a request to each, so we only ever print
 * `http://`/`https://` origins: a `file:`/`javascript:`-shaped entry (a typo, or a
 * bad value in an operator's env) must not become an instruction to a runtime that
 * might honour it. Audit ONB2, LOW-2.
 */
const HTTP_URL = /^https?:\/\/[^\s/$.?#].[^\s]*$/i

export function baseUrlCandidates(): string[] {
  const extra = String(process.env.MC_BASE_URL_CANDIDATES ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => HTTP_URL.test(s))
  return Array.from(new Set([baseUrl(), ...extra]))
}

/** DB row → the pure service's record shape (JSON columns parsed, dates hydrated).
 *  The allow-list parse is fail-CLOSED (`parseAllowedAdapterTypes`): a corrupt
 *  column yields an empty allow-list, never `null` — `null` means "any adapter",
 *  and a parse failure must not widen an invite the operator narrowed. */
function toRecord(row: typeof schema.agentInvites.$inferSelect): InviteRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    tokenHash: row.tokenHash,
    allowedAdapterTypes: parseAllowedAdapterTypes(row.allowedAdapterTypes),
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    message: row.message ?? null,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt as Date,
    revokedAt: (row.revokedAt as Date | null) ?? null,
    lastAcceptedAt: (row.lastAcceptedAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
  }
}

// ─── Owner-gated invite management (Clerk-secured scope) ────────────────────

export async function agentInviteRoutes(app: FastifyInstance) {
  documentEndpoint('POST', '/api/orgs/:orgId/agent-invites', {
    summary: 'Create an agent invite (owner). Returns the raw invite token EXACTLY ONCE — only its hash is stored.',
    body: CreateInviteBody,
    tag: 'onboarding',
  })
  app.post('/api/orgs/:orgId/agent-invites', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId } = req.params as any
    const body = CreateInviteBody.parse(req.body ?? {})
    const createdBy = (req as any).auth?.userId ?? 'unknown'

    const result = createInvite({
      id: randomUUID(),
      orgId,
      createdBy,
      allowedAdapterTypes: body.allowedAdapterTypes ?? null,
      maxUses: body.maxUses,
      expiresInHours: body.expiresInHours,
      message: body.message ?? null,
    })
    if (result.ok === false) return reply.code(400).send({ error: 'Invalid invite', details: result.errors })

    const { token, record } = result.invite
    await db.insert(schema.agentInvites).values({
      ...record,
      allowedAdapterTypes: record.allowedAdapterTypes ? JSON.stringify(record.allowedAdapterTypes) : null,
    } as any)

    reply.code(201)
    const urls = inviteUrls(baseUrl(), token)
    const posture = onboardingPosture(process.env)
    // The raw token crosses the wire exactly once, here. It is never stored, never
    // logged, and cannot be re-read — a lost invite is re-created, not recovered.
    // The pastable prompt is generated in the SAME response for the same reason:
    // it embeds the token, so this is the only moment it can exist (ONB6 surfaces
    // it with a copy button; the operator never fetches it again).
    return {
      invite: inviteView(record),
      inviteToken: token,
      ...urls,
      onboardingPrompt: buildOnboardingPrompt({
        token,
        onboardingTextUrl: urls.onboardingTextUrl,
        onboardingJsonUrl: urls.onboardingUrl,
        allowedAdapterTypes: record.allowedAdapterTypes,
        message: record.message,
        joinOpen: posture.publicJoinEnabled,
        claimOpen: posture.tokenClaimEnabled,
      }),
      // ONB3/ONB4 open the join + claim endpoints. Until then the invite is an
      // object and a document, not yet a flow — and the doc says so, in the doc.
      joinEnabled: posture.publicJoinEnabled,
      onboardingDocPublic: posture.onboardingDocPublic,
    }
  })

  documentEndpoint('GET', '/api/orgs/:orgId/agent-invites', { summary: 'List agent invites (owner). Never returns the token or its hash.', tag: 'onboarding' })
  app.get('/api/orgs/:orgId/agent-invites', { preHandler: requireOrgRole('owner') }, async (req) => {
    const { orgId } = req.params as any
    const { status } = req.query as { status?: string }
    const rows = await db.select().from(schema.agentInvites)
      .where(eq(schema.agentInvites.orgId, orgId))
      .orderBy(desc(schema.agentInvites.createdAt))
    const now = new Date()
    const invites = rows.map((r) => inviteView(toRecord(r), now))
    return { invites: status ? invites.filter((i) => i.status === status) : invites }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/agent-invites/:inviteId/revoke', { summary: 'Revoke an agent invite (owner). Idempotent.', tag: 'onboarding' })
  app.post('/api/orgs/:orgId/agent-invites/:inviteId/revoke', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, inviteId } = req.params as any
    const row = await db.query.agentInvites.findFirst({
      where: and(eq(schema.agentInvites.id, inviteId), eq(schema.agentInvites.orgId, orgId)),
    })
    if (!row) return reply.code(404).send({ error: 'Invite not found' })
    const record = toRecord(row)
    // Revoking an already-revoked invite is a no-op, not an error: the operator's
    // intent (this door is shut) is satisfied either way.
    if (!record.revokedAt) {
      const now = new Date()
      await db.update(schema.agentInvites).set({ revokedAt: now }).where(eq(schema.agentInvites.id, inviteId))
      record.revokedAt = now
    }
    return { invite: inviteView(record) }
  })

  documentEndpoint('GET', '/api/orgs/:orgId/onboarding-posture', {
    summary: 'The deployment profile + derived onboarding posture (owner). Reports WHY the public join surface is closed.',
    tag: 'onboarding',
  })
  app.get('/api/orgs/:orgId/onboarding-posture', { preHandler: requireOrgRole('owner') }, async () => {
    const posture = onboardingPosture(process.env)
    return {
      posture,
      invitableAdapterTypes: invitableAdapterTypes(),
      joinableAdapterTypes: joinableAdapterTypes(),
      defaults: { expiresInHours: DEFAULT_INVITE_TTL_HOURS, maxUses: DEFAULT_MAX_USES },
    }
  })

  // ─── ONB3 — the BOARD-APPROVAL GATE (owner-gated) ─────────────────────────
  //
  // The pending join request is ALSO a card in the shipped tri-state approvals
  // queue (`approval_requests`, type `agent_join_request`) — that is what the
  // Inbox/Governance panel renders, and deciding it there runs the SAME
  // `applyJoinDecision` path (wired in `routes/tasks.ts`). These routes are the
  // API twin of that card, not a second decision mechanism.

  documentEndpoint('GET', '/api/orgs/:orgId/agent-join-requests', {
    summary: 'List agent join requests (owner). Self-declared, unverified data. Never contains a secret value or a token.',
    tag: 'onboarding',
  })
  app.get('/api/orgs/:orgId/agent-join-requests', { preHandler: requireOrgRole('owner') }, async (req) => {
    const { orgId } = req.params as any
    const { status } = req.query as { status?: string }
    const conds = [eq(schema.agentJoinRequests.orgId, orgId)]
    if (status) conds.push(eq(schema.agentJoinRequests.status, status))
    const rows = await db.select().from(schema.agentJoinRequests)
      .where(and(...conds))
      .orderBy(desc(schema.agentJoinRequests.createdAt))
      .limit(100)
    return { joinRequests: rows.map((r) => joinRequestView(toJoinRecord(r))) }
  })

  for (const decision of ['approve', 'reject'] as const) {
    const path = `/api/orgs/:orgId/agent-join-requests/:requestId/${decision}`
    documentEndpoint('POST', path, {
      summary: decision === 'approve'
        ? 'Approve a join request (owner): creates the agent CONTAINED (low_trust_review, explicit capabilities) — and mints NO token (the one-time claim is ONB4).'
        : 'Reject a join request (owner): nothing is minted, and the secrets the agent supplied are deleted.',
      tag: 'onboarding',
    })
    app.post(path, { preHandler: requireOrgRole('owner') }, async (req, reply) => {
      const { orgId, requestId } = req.params as any
      const result = await applyJoinDecision({
        joinRequestId: requestId,
        orgId,
        decision: decision === 'approve' ? 'approved' : 'rejected',
        actor: (req as any).auth?.userId ?? 'unknown',
      })
      if (result.ok === false) return reply.code(result.code).send({ error: result.error })
      return {
        joinRequest: joinRequestView(result.record),
        // Invariant #4, restated where an operator would look for a key: there is
        // none, and there is nothing here that could ever be one.
        agentToken: null,
        note: 'The agent was created contained (low_trust_review) with NO API key. The one-time key claim lands in ONB4; until then this agent can authenticate to nothing.',
      }
    })
  }
}

// ─── ONB3 — the PUBLIC JOIN REQUEST ─────────────────────────────────────────
//
// The first UNAUTHENTICATED WRITE in the system, and the reason every control in
// this epic exists. What holds it safe, in order:
//
//  * **It cannot produce a credential.** Not a token, not a claim secret, not a
//    parked hash. It produces a row in a human's queue. A leaked invite is worth an
//    inbox item, not an agent.
//  * **Its exposure follows the deployment profile** (`publicJoinEnabled`): packaged
//    = loopback-trusted, open; hosted = closed unless the operator explicitly set
//    `MC_ENABLE_REMOTE_ONBOARDING` — which is FALSE on our live backend today, so
//    this route answers the same flat 404 as an unknown invite in production.
//  * **The single use is spent atomically** (`consumeInviteUse` — ONB1 audit H1), and
//    the join row is written only after that CAS is won.
//  * **It is per-IP rate limited** (the ONB2 re-audit's M-3: rate limiting must exist
//    before remote onboarding is ever enabled in prod). `perIpRateLimit` had zero
//    call-sites since it was written; this is its caller.
//  * **The body is strictly typed and registry-validated, with NO free-text field**
//    (`.strict()` — an unknown key is refused, not ignored). A secret in free text
//    under an innocuous key would reach `audit_logs.metadata` unredacted; the defence
//    is that no such field exists (AUDIT-ONB2-hardening, ruling 3).
//  * **Declared secrets go to the ENCRYPTED store**, scoped to the not-yet-approved
//    request (an inert scope), never to a plaintext column and never to a log.
//
// Every closed state — bad shape, unknown/expired/revoked/exhausted invite, lost
// consume race, posture closed — collapses to ONE identical flat 404.

const JoinBody = z.object({
  agentName: z.string().min(1).max(MAX_AGENT_NAME_CHARS),
  adapterType: z.string().min(1).max(64),
  capabilities: z.array(z.string().max(64)).min(1).max(MAX_CAPABILITIES),
  agentDefaultsPayload: z.record(z.unknown()).optional(),
}).strict() // ← the carried audit caveat: an undeclared (free-text) field is REFUSED.

export async function agentJoinRoutes(app: FastifyInstance) {
  documentEndpoint('POST', '/api/agent-invites/:token/join', {
    summary: 'Submit a join request (public, invite-token-bearer, profile-gated, rate-limited). Creates NO agent and NO credential — it creates a pending board-approval item. Returns a requestId and the ONB4 claim path; NEVER a token.',
    body: JoinBody,
    tag: 'onboarding',
  })
  app.post('/api/agent-invites/:token/join', { preHandler: perIpRateLimit(JOIN_RATE_LIMIT_PER_MINUTE) }, async (req, reply) => {
    const notFound = () => reply.code(404).send({ error: 'Not found' })
    const posture = onboardingPosture(process.env)
    // Closed by posture → indistinguishable from an unknown invite. A "this exists
    // but the door is shut" would tell an attacker their token is real.
    if (!posture.publicJoinEnabled) return notFound()

    const { token } = req.params as { token: string }
    // Shape-check BEFORE we hash attacker input or spend a DB round-trip.
    if (!isInviteTokenShaped(token)) return notFound()

    const parsed = JoinBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      // Field-level errors only — never an echo of the submitted values, which may
      // carry a credential the sender put in the wrong field.
      return reply.code(400).send({
        error: 'Invalid join request',
        details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
        allowedCapabilities: JOINABLE_CAPABILITIES,
      })
    }

    const row = await db.query.agentInvites.findFirst({
      where: eq(schema.agentInvites.tokenHash, hashToken(token)),
    })
    if (!row) return notFound()
    const invite = toRecord(row)
    if (!isInviteUsable(invite)) return notFound()

    const built = buildJoinRequest({
      invite,
      agentName: parsed.data.agentName,
      adapterType: parsed.data.adapterType,
      capabilities: parsed.data.capabilities,
      agentDefaultsPayload: parsed.data.agentDefaultsPayload,
    })
    if (built.ok === false) {
      // `not_found` (a closed invite) is the flat 404. `adapter_not_allowed` and
      // `invalid` are safe to explain: the caller already holds a valid invite, and
      // a silent 404 would send a legitimate agent chasing a ghost.
      if (built.publicReason === 'not_found') return notFound()
      return reply.code(400).send({ error: 'Join request refused', details: built.errors })
    }

    // ── ONB1 audit H1: the atomic single-use consume. Nothing is written until
    //    this CAS is won, and a lost race is the same flat 404 as everything else. ──
    const now = new Date()
    const won = await consumeInviteUse(invite.id, now)
    if (!won) return notFound()

    const record = built.record

    // ── ONB4: mint the one-time CLAIM SECRET here, store it HASH-ONLY (+ a TTL never
    //    exceeding the invite's own expiry), and return the raw `mcc_` secret to the
    //    agent EXACTLY ONCE below. The agent spends it once at the claim step, AFTER
    //    approval. Only minted when the claim surface is actually open. ──
    const claim = TOKEN_CLAIM_IMPLEMENTED ? generateClaimSecret() : null
    const claimExpiresAt = claim ? claimSecretExpiry(now, invite.expiresAt) : null

    // The declared secrets, encrypted at rest, parked against the REQUEST (an inert
    // scope: `resolveSecretsForAgent` resolves only `company` and `agent`, so no agent
    // can read these). Approval re-scopes them to the agent that then exists; rejection
    // deletes them. They are never written to a config column and never logged.
    for (const [key, value] of Object.entries(built.secrets)) {
      await db.insert(schema.secrets).values({
        id: randomUUID(), orgId: record.orgId, scope: JOIN_SECRET_SCOPE, scopeId: record.id,
        key, valueEncrypted: encrypt(value), createdAt: now,
      } as any)
    }

    // The board's queue item — a row in the SHIPPED tri-state approvals store, with a
    // MACHINE-GENERATED summary and every agent-authored value under `selfDeclared`
    // and labelled unverified (audit R8).
    const card = buildJoinApprovalCard(record)
    const approvalId = randomUUID()
    await db.insert(schema.approvalRequests).values({
      id: approvalId, orgId: record.orgId, type: JOIN_APPROVAL_TYPE, summary: card.summary,
      payload: card.payload, status: 'pending', requestedByAgentId: null,
      decidedBy: null, decidedAt: null, createdAt: now,
    } as any)
    record.approvalRequestId = approvalId

    await db.insert(schema.agentJoinRequests).values({
      id: record.id, orgId: record.orgId, inviteId: record.inviteId, agentName: record.agentName,
      adapterType: record.adapterType, runtime: record.runtime,
      capabilities: JSON.stringify(record.capabilities),
      config: JSON.stringify(record.config),
      secretKeys: JSON.stringify(record.secretKeys),
      status: record.status, approvalRequestId: approvalId, agentId: null,
      decidedBy: null, decidedAt: null,
      // ONB4: only the HASH of the claim secret is stored, with a TTL. The raw secret
      // lives only in the response below and is never persisted or logged.
      claimSecretHash: claim ? claim.hash : null,
      claimSecretExpiresAt: claimExpiresAt,
      claimedAt: null,
      createdAt: now,
    } as any)

    reply.code(201)
    // Since ONB4 this response body carries the raw one-time `mcc_` claim secret, so
    // it is a credential-bearing response like the claim itself and the onboarding doc
    // — keep it out of every intermediary cache (AUDIT-ONB4, LOW-1). (A POST is not
    // cached by default, but every other credential path here says `no-store` out loud.)
    reply.header('cache-control', 'no-store')
    // A requestId, a path, and — since ONB4 — the one-time claim secret (raw, once).
    // Still no agent token and no agent id: the `mca_` credential is minted at claim.
    return joinAcceptedResponse(
      record,
      `/api/agent-join-requests/${record.id}/claim-api-key`,
      TOKEN_CLAIM_IMPLEMENTED,
      claim && claimExpiresAt ? { secret: claim.secret, expiresAt: claimExpiresAt } : undefined,
    )
  })

  // ─── ONB4 — the ONE-TIME CLAIM ────────────────────────────────────────────
  //
  // The second UNAUTHENTICATED WRITE in the system, and the most security-critical:
  // it mints and hands over the real `mca_` agent credential. What holds it safe:
  //
  //  * **Its exposure follows the deployment profile**, exactly like the join route
  //    (`publicJoinEnabled`): hosted answers a flat 404 unless the operator explicitly
  //    set `MC_ENABLE_REMOTE_ONBOARDING`. It is FALSE on our live backend today.
  //  * **It is per-IP rate limited** (the same fixed limiter as join, keyed on the real
  //    socket / `Fly-Client-IP`, never the spoofable `X-Forwarded-For` — AUDIT-ONB3 M-2).
  //  * **Every failure is one identical flat 404** — unknown request, not approved,
  //    missing agent row, wrong/expired/already-spent secret, lost race. No oracle: a
  //    caller cannot learn a request's status from the claim endpoint.
  //  * **The claim consume and the token mint are atomic CAS statements** owned by
  //    `services/claim.ts` (`claimed_at IS NULL`, then `api_token_hash IS NULL`). Two
  //    simultaneous claims yield exactly one token.
  //  * **The raw token appears only in this response** — never persisted (hash-only on
  //    the agent), never logged (`mcc_`/`mca_` are redacted), never in an operator UI.
  const ClaimBody = z.object({ claimSecret: z.string().min(1).max(256) }).strict()

  documentEndpoint('POST', '/api/agent-join-requests/:id/claim-api-key', {
    summary: 'Claim the one-time API key for an APPROVED join request (public, claim-secret-bearer, profile-gated, rate-limited). Returns the raw agent token EXACTLY ONCE. Every failure is one flat 404.',
    body: ClaimBody,
    tag: 'onboarding',
  })
  app.post('/api/agent-join-requests/:id/claim-api-key', { preHandler: perIpRateLimit(JOIN_RATE_LIMIT_PER_MINUTE) }, async (req, reply) => {
    const notFound = () => reply.code(404).send({ error: 'Not found' })
    const posture = onboardingPosture(process.env)
    // Closed by posture (or claim not built) → indistinguishable from an unknown request.
    if (!posture.publicJoinEnabled || !posture.tokenClaimEnabled) return notFound()

    const { id } = req.params as { id: string }
    const parsed = ClaimBody.safeParse(req.body ?? {})
    // A malformed body is the same flat 404 as a wrong secret — no field-level echo
    // (the body carries a credential) and no oracle.
    if (!parsed.success) return notFound()

    const result = await claimApiKey({ joinRequestId: id, claimSecret: parsed.data.claimSecret })
    if (result.ok === false) return notFound()

    // The raw `mca_` token, EXACTLY ONCE, to the claimer. Never persisted (hash-only
    // on the agent row), never logged, never shown to an operator (Invariant #4).
    reply.header('cache-control', 'no-store')
    return {
      token: result.token,
      tokenType: 'agent' as const,
      agentId: result.agentId,
      baseUrl: baseUrl(),
    }
  })
}

// ─── Public: the per-invite onboarding document (ONB2) ──────────────────────
//
// The FIRST token-addressed route in the system. Three properties hold it safe:
//
//  * **It is not a credential and mints none.** It restates the invite the caller
//    already holds and describes the join/claim endpoints — which ONB3/ONB4 build
//    and which the doc honestly labels "not open yet". Nothing here can be spent.
//  * **Its exposure follows the deployment profile** (`onboardingDocAccess`):
//    packaged/loopback-trusted → served; hosted → served only when the operator
//    explicitly enabled remote onboarding. Closed answers the same flat 404 as an
//    unknown invite, so it is not an oracle either way.
//  * **The token in the path is redacted before any log** — `services/log-redaction.ts`,
//    applied in `middleware/audit-log.ts` and in Fastify's request serializer.
//    Without that, this route would write working invite links into `audit_logs`.
//
// Every closed state — bad shape, unknown, expired, revoked, exhausted, doc closed
// by posture — collapses to ONE identical 404. Distinguishing them would turn this
// endpoint into an enumeration oracle for valid invite tokens.

export async function agentInviteDocRoutes(app: FastifyInstance) {
  const notFound = (reply: any) => reply.code(404).send({ error: 'Not found' })

  /** Load the invite behind a raw token, or null for every closed state. */
  async function loadInvite(rawToken: string): Promise<InviteRecord | null> {
    if (!onboardingDocAccess(process.env).allowed) return null
    // Shape-check BEFORE we hash attacker input or spend a DB round-trip.
    if (!isInviteTokenShaped(rawToken)) return null
    const row = await db.query.agentInvites.findFirst({
      where: eq(schema.agentInvites.tokenHash, hashToken(rawToken)),
    })
    if (!row) return null
    const record = toRecord(row)
    // An expired/revoked/exhausted invite is as good as unknown: its door is shut,
    // and the doc is the thing behind the door.
    return isInviteUsable(record) ? record : null
  }

  function render(record: InviteRecord, token: string) {
    return buildOnboardingDoc({
      token,
      invite: record,
      posture: onboardingPosture(process.env),
      baseUrlCandidates: baseUrlCandidates(),
      // The registry is the single source of truth for every adapter shape printed.
      adapters: publicRegistry() as any,
    })
  }

  documentEndpoint('GET', '/api/agent-invites/:token/onboarding.txt', {
    summary: 'The per-invite onboarding document (text/markdown). Public, invite-token-bearer, profile-gated. Unknown/expired/revoked/closed → the same flat 404.',
    tag: 'onboarding',
  })
  app.get('/api/agent-invites/:token/onboarding.txt', async (req, reply) => {
    const { token } = req.params as { token: string }
    const record = await loadInvite(token)
    if (!record) return notFound(reply)
    reply.header('content-type', 'text/markdown; charset=utf-8')
    // Not a credential, but it is addressed by one — keep it out of every cache.
    reply.header('cache-control', 'no-store')
    return render(record, token).text
  })

  documentEndpoint('GET', '/api/agent-invites/:token/onboarding', {
    summary: 'The per-invite onboarding document (JSON twin of onboarding.txt). Same content, structured.',
    tag: 'onboarding',
  })
  app.get('/api/agent-invites/:token/onboarding', async (req, reply) => {
    const { token } = req.params as { token: string }
    const record = await loadInvite(token)
    if (!record) return notFound(reply)
    reply.header('cache-control', 'no-store')
    return render(record, token)
  })
}

// ─── Public: the adapter registry ───────────────────────────────────────────
//
// Public by design and safe to be: it is a static, org-agnostic description of
// the runtimes Mission Control speaks, with no tenant data and no secrets in it
// (secret FIELDS are named — `apiKey`, `x-openclaw-token` — never valued). A
// joining agent needs to discover the taxonomy before it holds any credential.

export async function adapterRegistryRoutes(app: FastifyInstance) {
  documentEndpoint('GET', '/api/adapters', { summary: 'The adapter registry: every runtime, its agentDefaultsPayload contract, and whether it is available.', tag: 'onboarding' })
  app.get('/api/adapters', async () => ({
    adapters: publicRegistry(),
    invitable: invitableAdapterTypes(),
    joinable: joinableAdapterTypes(),
  }))
}
