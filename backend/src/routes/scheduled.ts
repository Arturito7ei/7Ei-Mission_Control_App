import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { calcNextRun, fireRoutine } from '../services/scheduler'
import { makeWebhookToken, normalizeTriggerType, cronSentinel } from '../services/routines'
import { assertAgentInOrg } from '../services/tenant-guard'

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
    const b = req.body as any
    const { agentId, title, input } = b
    const triggerType = normalizeTriggerType(b.triggerType)
    if (!agentId || !title) return reply.code(400).send({ error: 'agentId, title required' })
    // GC-0b (audit) — the same CREATE-side hole as `POST /api/orgs/:orgId/tasks`, and
    // strictly worse here for two reasons. `fireRoutine` (services/scheduler.ts) inserts
    // a task with `orgId: routine.orgId` (the attacker's org) and `agentId:
    // routine.agentId` (the victim's agent) and then calls `executeAgentTask` — so a
    // cron routine re-executes another tenant's agent on a schedule, indefinitely. And
    // for any non-`cron` triggerType this route MINTS A WEBHOOK TOKEN and returns the
    // trigger URL to the caller; `POST /api/routines/:token/trigger` is registered
    // OUTSIDE the authenticated scope, so that URL fires the victim's agent with no
    // session at all, and keeps working after the attacker leaves their own org.
    // The agent must belong to the org the routine is created in.
    {
      const err = await assertAgentInOrg(agentId, orgId)
      if (err) return reply.code(400).send({ error: err })
    }
    if (triggerType === 'cron' && !b.cronExpression) return reply.code(400).send({ error: 'cronExpression required for cron routines' })

    const cronExpression = triggerType === 'cron' ? b.cronExpression : cronSentinel(triggerType)
    const nextRunAt = triggerType === 'cron' ? calcNextRun(cronExpression) : null
    const webhookToken = triggerType === 'cron' ? null : makeWebhookToken()
    const task = {
      id: randomUUID(), orgId, agentId, title, input: input ?? title, cronExpression,
      enabled: true, lastRunAt: null, nextRunAt, triggerType, webhookToken,
      lastTriggeredAt: null, createdAt: new Date(),
    }
    await db.insert(schema.scheduledTasks).values(task as any)
    reply.code(201)
    return { task: { ...task, nextRunAt: nextRunAt?.toISOString() ?? null }, triggerUrl: webhookToken ? `/api/routines/${webhookToken}/trigger` : undefined }
  })

  // Update (enable/disable, change cron)
  app.patch('/api/scheduled/:id', async (req) => {
    const { id } = req.params as any
    const body = req.body as any
    const update: any = {}
    if (body.enabled !== undefined) update.enabled = !!body.enabled
    if (body.cronExpression) {
      update.cronExpression = body.cronExpression
      update.nextRunAt = calcNextRun(body.cronExpression)
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
    const { cronExpression } = req.query as any
    if (!cronExpression) return { error: 'cronExpression required' }
    try {
      const next = calcNextRun(cronExpression)
      return { next: next.toISOString(), cronExpression }
    } catch { return { error: 'Invalid cron expression' } }
  })
}

// Public webhook/API trigger (MCA-PC C3) — fires a routine by its token, no Clerk
// session. External systems POST here to run a routine on demand.
export async function routineTriggerRoutes(app: FastifyInstance) {
  app.post('/api/routines/:token/trigger', async (req, reply) => {
    const { token } = req.params as any
    const routine = await db.query.scheduledTasks.findFirst({ where: eq(schema.scheduledTasks.webhookToken, token) })
    if (!routine || !routine.enabled) return reply.code(404).send({ error: 'Routine not found' })
    const taskId = await fireRoutine(routine, new Date())
    return { ok: true, taskId }
  })
}
