import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, desc, and, gte } from 'drizzle-orm'

// Push notifications — Expo push tokens stored, used for task completion alerts
const pushTokens = new Map<string, Set<string>>() // userId → Set<expoToken>

export async function notificationRoutes(app: FastifyInstance) {
  // Register Expo push token
  app.post('/api/notifications/register', async (req) => {
    const { userId, token } = req.body as any
    if (!userId || !token) return { ok: false }
    if (!pushTokens.has(userId)) pushTokens.set(userId, new Set())
    pushTokens.get(userId)!.add(token)
    return { ok: true }
  })

  // Unregister
  app.delete('/api/notifications/register', async (req) => {
    const { userId, token } = req.body as any
    pushTokens.get(userId)?.delete(token)
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

// Called internally when a task completes — sends Expo push notification
export async function sendPushNotification(userId: string, title: string, body: string, data?: Record<string, unknown>) {
  const tokens = pushTokens.get(userId)
  if (!tokens || tokens.size === 0) return

  const messages = Array.from(tokens).map(to => ({ to, title, body, data: data ?? {}, sound: 'default' }))

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
  } catch (e) {
    console.warn('Push notification failed:', e)
  }
}
