// Arturita routes (A1) — persona ensure, command sessions, single-operator
// binding, and the /panic kill switch. Thin routes: all logic lives in the pure
// `services/arturita-session.ts` helpers (routes → services only).
//
// Auth split:
//  - `arturitaRoutes`  → registered in the Clerk-secured scope (owner mints/
//    revokes sessions, starts/confirms/revokes the binding).
//  - `arturitaPublicRoutes` → registered public, but /panic is OWNER-AUTHED
//    inside via a valid command-session token (minting one requires Clerk, so
//    possessing a live token proves owner authorization). /panic only ever
//    REMOVES capability, so it's safe to make it reachable off-session (voice/
//    Telegram in D1); an unauthenticated caller still can't harm anything.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { documentEndpoint } from '../services/openapi'
import {
  mintSession, hashToken, isSessionValid, panicPlan, buildArturitaAgent,
  beginBinding, confirmBinding, generateBindCode, type SessionSource, SESSION_SOURCES,
} from '../services/arturita-session'

// ─── Persona ensure (idempotent) ─────────────────────────────────────────────

/** Ensure exactly one Arturita persona per org. Returns the agent id. */
async function ensureArturita(orgId: string): Promise<string> {
  const existing = await db.query.agents.findFirst({
    where: and(eq(schema.agents.orgId, orgId), eq(schema.agents.agentType, 'arturita')),
  })
  if (existing) return existing.id
  const agent = buildArturitaAgent(orgId, randomUUID(), new Date())
  await db.insert(schema.agents).values(agent as any)
  return agent.id
}

const SessionBody = z.object({ source: z.enum(SESSION_SOURCES).default('desk') })
const BindConfirmBody = z.object({ code: z.string().min(1), telegramChatId: z.string().min(1) })

// ─── Clerk-secured surface ───────────────────────────────────────────────────

export async function arturitaRoutes(app: FastifyInstance) {
  // Ensure persona + return it (owner-scoped).
  app.get('/api/orgs/:orgId/arturita', async (req) => {
    const { orgId } = req.params as any
    const agentId = await ensureArturita(orgId)
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    const binding = await db.query.arturitaBindings.findFirst({ where: eq(schema.arturitaBindings.orgId, orgId) })
    return {
      agent,
      bound: !!binding?.boundAt && !binding?.revokedAt,
      telegramChatId: binding?.revokedAt ? null : (binding?.telegramChatId ?? null),
    }
  })

  // Mint a short-lived command session. Token is returned ONCE (only its hash is
  // stored). The persona is ensured on first mint.
  app.post('/api/orgs/:orgId/arturita/session', async (req, reply) => {
    const { orgId } = req.params as any
    const { source } = SessionBody.parse(req.body ?? {})
    await ensureArturita(orgId)
    const { token, record } = mintSession({ source: source as SessionSource })
    const id = randomUUID()
    await db.insert(schema.arturitaSessions).values({ id, orgId, ...record } as any)
    reply.code(201)
    return {
      session: { id, source: record.source, expiresAt: record.expiresAt, createdAt: record.createdAt },
      token, // shown once — the caller stores it; we keep only the hash
    }
  })

  // List live (non-revoked) sessions — never exposes token hashes.
  app.get('/api/orgs/:orgId/arturita/sessions', async (req) => {
    const { orgId } = req.params as any
    const rows = await db.select({
      id: schema.arturitaSessions.id, source: schema.arturitaSessions.source,
      createdAt: schema.arturitaSessions.createdAt, expiresAt: schema.arturitaSessions.expiresAt,
      lastStepupAt: schema.arturitaSessions.lastStepupAt, revokedAt: schema.arturitaSessions.revokedAt,
    }).from(schema.arturitaSessions).where(eq(schema.arturitaSessions.orgId, orgId))
    return { sessions: rows }
  })

  // Revoke one session (individual revocation).
  app.delete('/api/orgs/:orgId/arturita/session/:sessionId', async (req, reply) => {
    const { orgId, sessionId } = req.params as any
    await db.update(schema.arturitaSessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.arturitaSessions.id, sessionId), eq(schema.arturitaSessions.orgId, orgId)))
    reply.code(204)
  })

  // Begin binding: mint a one-time code for the authenticated owner. The code is
  // shown in the Cockpit and entered from Telegram (confirm below / D1 receiver).
  app.post('/api/orgs/:orgId/arturita/bind', async (req, reply) => {
    const { orgId } = req.params as any
    const userId = (req as any).userId ?? 'unknown'
    const code = generateBindCode()
    const rec = beginBinding({ operatorUserId: userId, code })
    // One binding row per org: replace any prior in-progress/old row for the org.
    await db.delete(schema.arturitaBindings).where(eq(schema.arturitaBindings.orgId, orgId))
    const id = randomUUID()
    await db.insert(schema.arturitaBindings).values({ id, orgId, createdAt: new Date(), ...rec } as any)
    reply.code(201)
    return { bindCode: code, expiresAt: rec.bindCodeExpiresAt }
  })

  // Confirm binding (A1: owner may confirm from the Cockpit; D1 moves the primary
  // path to the HMAC Telegram receiver). Single-use: the code is cleared on success.
  app.post('/api/orgs/:orgId/arturita/bind/confirm', async (req, reply) => {
    const { orgId } = req.params as any
    const body = BindConfirmBody.parse(req.body ?? {})
    const binding = await db.query.arturitaBindings.findFirst({ where: eq(schema.arturitaBindings.orgId, orgId) })
    const result = confirmBinding(binding as any, { code: body.code, telegramChatId: body.telegramChatId })
    if (!result.ok) return reply.code(400).send({ error: result.error })
    await db.update(schema.arturitaBindings).set(result.patch!).where(eq(schema.arturitaBindings.orgId, orgId))
    return { bound: true, telegramChatId: result.patch!.telegramChatId }
  })

  // Revoke the binding (unbind remote control).
  app.delete('/api/orgs/:orgId/arturita/bind', async (req, reply) => {
    const { orgId } = req.params as any
    await db.update(schema.arturitaBindings).set({ revokedAt: new Date() })
      .where(eq(schema.arturitaBindings.orgId, orgId))
    reply.code(204)
  })

  documentEndpoint('GET', '/api/orgs/:orgId/arturita', { summary: 'Ensure + fetch the Arturita persona and binding state', tag: 'arturita' })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/session', { summary: 'Mint a short-lived command session (token returned once)', tag: 'arturita', body: SessionBody })
  documentEndpoint('GET', '/api/orgs/:orgId/arturita/sessions', { summary: 'List command sessions (no token material)', tag: 'arturita' })
  documentEndpoint('DELETE', '/api/orgs/:orgId/arturita/session/:sessionId', { summary: 'Revoke one command session', tag: 'arturita' })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/bind', { summary: 'Begin single-operator binding — mint a one-time code', tag: 'arturita' })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/bind/confirm', { summary: 'Confirm binding with the one-time code + Telegram chat id', tag: 'arturita', body: BindConfirmBody })
  documentEndpoint('DELETE', '/api/orgs/:orgId/arturita/bind', { summary: 'Revoke the operator binding', tag: 'arturita' })
}

// ─── Public surface — /panic (owner-authed inside) ───────────────────────────

/** Pull a command-session token from Authorization: Bearer, x-arturita-session,
 *  or a body field. */
function sessionTokenFrom(req: any): string | null {
  const auth = req.headers?.authorization
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m && m[1].trim()) return m[1].trim()
  }
  const hdr = req.headers?.['x-arturita-session']
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim()
  const bodyTok = (req.body as any)?.token
  if (typeof bodyTok === 'string' && bodyTok.trim()) return bodyTok.trim()
  return null
}

export async function arturitaPublicRoutes(app: FastifyInstance) {
  // /panic — pauses Arturita, cancels in-flight runs, revokes ALL sessions.
  // Owner-authed via a valid command-session token for the org. Never gated by
  // an approval; it only removes capability. Fail-closed: no valid token → 401.
  app.post('/api/orgs/:orgId/arturita/panic', async (req, reply) => {
    const { orgId } = req.params as any
    const token = sessionTokenFrom(req)
    if (!token) return reply.code(401).send({ error: 'command session token required' })

    const session = await db.query.arturitaSessions.findFirst({
      where: and(eq(schema.arturitaSessions.orgId, orgId), eq(schema.arturitaSessions.tokenHash, hashToken(token))),
    })
    if (!isSessionValid(session as any)) {
      req.log?.warn({ orgId }, 'arturita panic: invalid/absent session token — refused')
      return reply.code(401).send({ error: 'invalid or expired session' })
    }

    const sessions = await db.select({ tokenHash: schema.arturitaSessions.tokenHash, revokedAt: schema.arturitaSessions.revokedAt })
      .from(schema.arturitaSessions).where(eq(schema.arturitaSessions.orgId, orgId))
    const plan = panicPlan(sessions as any)

    // Pause the persona (canAgentRun → false).
    const agent = await db.query.agents.findFirst({
      where: and(eq(schema.agents.orgId, orgId), eq(schema.agents.agentType, 'arturita')),
    })
    if (agent) {
      await db.update(schema.agents).set(plan.agentPatch).where(eq(schema.agents.id, agent.id))
      // Cancel in-flight runs for the persona.
      const runs = await db.select({ id: schema.agentRuns.id, status: schema.agentRuns.status })
        .from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id))
      const cancel = runs.filter(r => plan.cancelRunStatuses.includes(String(r.status)))
      for (const r of cancel) {
        await db.update(schema.agentRuns).set({ status: 'cancelled', endedAt: plan.revokePatch.revokedAt }).where(eq(schema.agentRuns.id, r.id))
      }
    }

    // Revoke every session for the org (re-stamping an already-revoked row is a
    // harmless no-op, so a double-tap /panic stays idempotent).
    await db.update(schema.arturitaSessions).set({ revokedAt: plan.revokePatch.revokedAt })
      .where(eq(schema.arturitaSessions.orgId, orgId))

    return { ok: true, paused: !!agent, sessionsRevoked: plan.sessionsToRevoke.length }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/arturita/panic', { summary: 'Kill switch — pause Arturita, cancel runs, revoke sessions (owner-authed via session token)', tag: 'arturita' })
}
