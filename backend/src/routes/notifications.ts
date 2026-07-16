import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, desc, and, gte } from 'drizzle-orm'
import { registerPushToken, unregisterPushToken } from '../services/push'

// Re-exported for backwards compatibility — the implementation lives in services/push.
export { sendPushNotification } from '../services/push'

/** The authenticated identity the secured onRequest hook (clerkAuth on hosted /
 *  loopbackAuth on packaged) attaches. Both set the SAME `req.auth.userId` /
 *  `req.userId` contract, so this is profile-agnostic. */
function authedUserId(req: any): string | null {
  return req?.auth?.userId ?? req?.userId ?? null
}

export async function notificationRoutes(app: FastifyInstance) {
  // Register Expo push token. MOB-3B (audit L1): the device is keyed on the
  // AUTHENTICATED identity, never a body-supplied `userId` — otherwise any
  // authenticated user could register a device under another user's id and
  // receive their pushes. A `userId` in the body is accepted only for
  // client compatibility, and only if it MATCHES the session; a mismatch is 403.
  app.post('/api/notifications/register', async (req, reply) => {
    const sub = authedUserId(req)
    if (!sub) return reply.code(401).send({ error: 'Unauthorized' })
    const { userId: bodyUserId, token, platform } = (req.body ?? {}) as any
    if (!token || typeof token !== 'string') return reply.code(400).send({ error: 'token is required' })
    if (bodyUserId != null && String(bodyUserId) !== sub) {
      return reply.code(403).send({ error: 'userId does not match the authenticated session' })
    }
    await registerPushToken({ userId: sub, token, platform: typeof platform === 'string' ? platform : null })
    return { ok: true }
  })

  // Unregister — same identity rule, and the delete is scoped to the caller's own
  // identity in the service (a user can only unregister their own device).
  app.delete('/api/notifications/register', async (req, reply) => {
    const sub = authedUserId(req)
    if (!sub) return reply.code(401).send({ error: 'Unauthorized' })
    const { userId: bodyUserId, token } = (req.body ?? {}) as any
    if (!token || typeof token !== 'string') return reply.code(400).send({ error: 'token is required' })
    if (bodyUserId != null && String(bodyUserId) !== sub) {
      return reply.code(403).send({ error: 'userId does not match the authenticated session' })
    }
    await unregisterPushToken({ userId: sub, token })
    return { ok: true }
  })

  // Get recent notifications for a user (derived from tasks)
  app.get('/api/orgs/:orgId/notifications', async (req) => {
    const { orgId } = req.params as any
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // last 24h

    const recentTasks = await db.select({
      id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status,
      costUsd: schema.tasks.costUsd, completedAt: schema.tasks.completedAt,
      agentId: schema.tasks.agentId,
    }).from(schema.tasks).where(and(
      eq(schema.tasks.orgId, orgId),
      gte(schema.tasks.createdAt, since),
    )).orderBy(desc(schema.tasks.createdAt)).limit(50)

    const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, avatarEmoji: schema.agents.avatarEmoji })
      .from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const agentMap = new Map(agents.map(a => [a.id, a]))

    const notifications = recentTasks.map(t => ({
      id: t.id,
      type: t.status === 'done' ? 'task_done' : t.status === 'failed' ? 'task_failed' : 'task_update',
      title: t.status === 'done' ? `✅ ${agentMap.get(t.agentId)?.name ?? 'Agent'} finished a task` : `Task update`,
      body: t.title,
      agentEmoji: agentMap.get(t.agentId)?.avatarEmoji ?? '🤖',
      agentName: agentMap.get(t.agentId)?.name ?? 'Unknown',
      cost: t.costUsd,
      timestamp: t.completedAt ?? t.id,
    }))

    return { notifications }
  })
}
