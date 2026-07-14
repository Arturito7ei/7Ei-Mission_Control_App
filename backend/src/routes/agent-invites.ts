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
import { onboardingPosture } from '../services/deployment-profile'
import {
  createInvite, inviteView, inviteUrls, inviteStatus,
  DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, DEFAULT_MAX_USES, MAX_MAX_USES, MAX_MESSAGE_CHARS,
  type InviteRecord,
} from '../services/agent-invites'

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

/** DB row → the pure service's record shape (JSON columns parsed, dates hydrated). */
function toRecord(row: typeof schema.agentInvites.$inferSelect): InviteRecord {
  let allowed: string[] | null = null
  if (row.allowedAdapterTypes) {
    try {
      const parsed = JSON.parse(row.allowedAdapterTypes)
      if (Array.isArray(parsed)) allowed = parsed.map(String)
    } catch { allowed = null }
  }
  return {
    id: row.id,
    orgId: row.orgId,
    tokenHash: row.tokenHash,
    allowedAdapterTypes: allowed,
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
    // The raw token crosses the wire exactly once, here. It is never stored, never
    // logged, and cannot be re-read — a lost invite is re-created, not recovered.
    return {
      invite: inviteView(record),
      inviteToken: token,
      ...inviteUrls(baseUrl(), token),
      // ONB2 renders the pastable onboarding prompt; ONB3/ONB4 open the join +
      // claim endpoints. Until then the invite is an object, not yet a flow.
      joinEnabled: onboardingPosture(process.env).publicJoinEnabled,
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
