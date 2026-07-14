// Epic ONB / ONB1 — invite management (owner-gated) + the public adapter registry.
//
// What this file deliberately does NOT do: there is no public join endpoint, no
// join request, no claim, and no token minting here. ONB1 ships the *object* and
// the *taxonomy*; the public surface lands in ONB3/ONB4 behind the board-approval
// gate + the per-IP rate limit. `GET /api/adapters` is the only public route, and
// it is a static, org-agnostic, secret-free description of the runtimes we support.
//
// Thin routes: every decision lives in the pure services
// (`services/agent-invites.ts`, `services/adapter-registry.ts`,
// `services/deployment-profile.ts`); this layer only does DB + HTTP.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { requireOrgRole } from '../middleware/rbac'
import { documentEndpoint } from '../services/openapi'
import { publicRegistry, invitableAdapterTypes, joinableAdapterTypes } from '../services/adapter-registry'
import { onboardingPosture, onboardingDocAccess } from '../services/deployment-profile'
import {
  createInvite, inviteView, inviteUrls, parseAllowedAdapterTypes, isInviteTokenShaped, hashToken, isInviteUsable,
  DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, DEFAULT_MAX_USES, MAX_MAX_USES, MAX_MESSAGE_CHARS,
  type InviteRecord,
} from '../services/agent-invites'
import { buildOnboardingDoc, buildOnboardingPrompt } from '../services/onboarding-doc'

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
