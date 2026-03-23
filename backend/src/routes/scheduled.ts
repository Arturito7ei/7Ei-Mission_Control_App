import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { calcNextRun } from '../services/scheduler'

const COMMON_CRONS = [
  { label: 'Every hour',     cron: '0 * * * *' },
  { label: 'Daily at 8am',   cron: '0 8 * * *' },
  { label: 'Weekdays 9am',   cron: '0 9 * * 1-5' },
  { label: 'Every Monday',   cron: '0 8 * * 1' },
  { label: 'Every 30 min',   cron: '*/30 * * * *' },
  { label: 'Daily midnight', cron: '0 0 * * *' },
]

export async function scheduledRoutes(app: FastifyInstance) {
  // Cron presets
  app.get('/api/scheduled/presets', async () => ({ presets: COMMON_CRONS }))

  // List scheduled tasks for org
  app.get('/api/orgs/:orgId/scheduled', async (req) => {
    const { orgId } = req.params as any
    const tasks = await db.select().from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.orgId, orgId))
    return { tasks }
  })

  // Create scheduled task
  app.post('/api/orgs/:orgId/scheduled', async (req, reply) => {
    const { orgId } = req.params as any
    const { agentId, title, input, cron, timezone = 'UTC' } = req.body as any
    if (!agentId || !title || !cron) return reply.code(400).send({ error: 'agentId, title, cron required' })

    const nextRunAt = calcNextRun(cron, timezone)
    const task = {
      id: randomUUID(), orgId, agentId, title,
      input: input ?? null, cron, timezone,
      enabled: 1, lastRunAt: null, nextRunAt,
      runCount: 0, createdAt: new Date(),
    }
    await db.insert(schema.scheduledTasks).values(task)
    reply.code(201)
    return { task: { ...task, nextRunAt: nextRunAt.toISOString() } }
  })

  // Update (enable/disable, change cron)
  app.patch('/api/scheduled/:id', async (req) => {
    const { id } = req.params as any
    const body = req.body as any
    const update: any = {}
    if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0
    if (body.cron) {
      update.cron = body.cron
      update.nextRunAt = calcNextRun(body.cron, body.timezone ?? 'UTC')
    }
    if (body.title) update.title = body.title
    if (body.input !== undefined) update.input = body.input
    await db.update(schema.scheduledTasks).set(update).where(eq(schema.scheduledTasks.id, id))
    return { ok: true }
  })

  // Delete
  app.delete('/api/scheduled/:id', async (req, reply) => {
    const { id } = req.params as any
    await db.delete(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, id))
    reply.code(204)
  })

  // Preview: when would this cron next fire?
  app.get('/api/scheduled/preview', async (req) => {
    const { cron, timezone = 'UTC' } = req.query as any
    if (!cron) return { error: 'cron required' }
    try {
      const next = calcNextRun(cron, timezone)
      return { next: next.toISOString(), cron, timezone }
    } catch { return { error: 'Invalid cron expression' } }
  })
}
