import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and, inArray, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { agentAuth } from '../middleware/agent-token'

// ─── AGENT-FACING API (MCA-EXT) ────────────────────────────────────────────
//
// Called by external / self-hosted runtimes (OpenClaw, Cursor, custom) using
// their agent token (Authorization: Bearer mca_...). Every route is scoped to
// the single agent resolved from the token (req.agent). NOT Clerk-protected —
// registered in the public scope with its own onRequest hook.

const HeartbeatSchema = z.object({
  status: z.enum(['green', 'amber', 'stale']).default('green'),
  note: z.string().max(500).optional(),
})

const ResultSchema = z.object({
  output: z.string(),
  status: z.enum(['done', 'failed']).default('done'),
})

export async function agentApiRoutes(app: FastifyInstance) {
  app.addHook('onRequest', agentAuth)

  // Identity of the authenticated agent — lets a runtime build its system prompt.
  app.get('/api/agent/me', async (req) => {
    const a = (req as any).agent
    return {
      agent: {
        id: a.id, orgId: a.orgId, name: a.name, role: a.role,
        runtime: a.runtime, llmProvider: a.llmProvider, llmModel: a.llmModel,
        termsOfReference: a.termsOfReference ?? null, persona: a.persona ?? null,
        skills: a.skills ?? [],
      },
    }
  })

  // Liveness/heartbeat — also returns who the runtime is authenticated as.
  app.post('/api/agent/heartbeat', async (req) => {
    const agent = (req as any).agent
    const { status } = HeartbeatSchema.parse(req.body ?? {})
    await db.update(schema.agents)
      .set({ lastHeartbeatAt: new Date(), heartbeatStatus: status, status: 'idle' })
      .where(eq(schema.agents.id, agent.id))
    return { ok: true, agentId: agent.id, name: agent.name, runtime: agent.runtime }
  })

  // The agent's claimable / active queue. ?state=assigned (default) | in_progress | all
  app.get('/api/agent/tasks', async (req) => {
    const agent = (req as any).agent
    const state = ((req.query as any)?.state ?? 'assigned') as string
    const statusFilter: Record<string, string[]> = {
      assigned: ['assigned'],
      in_progress: ['in_progress'],
      open: ['assigned', 'in_progress'],
      all: ['assigned', 'in_progress', 'pending', 'blocked', 'done', 'failed'],
    }
    const states = statusFilter[state] ?? statusFilter.assigned
    const tasks = await db.select().from(schema.tasks)
      .where(and(eq(schema.tasks.agentId, agent.id), inArray(schema.tasks.status, states)))
      .orderBy(desc(schema.tasks.createdAt)).limit(50)
    return { tasks }
  })

  // Claim a task: assigned → in_progress (only this agent's tasks).
  app.post('/api/agent/tasks/:taskId/claim', async (req, reply) => {
    const agent = (req as any).agent
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task || task.agentId !== agent.id) return reply.code(404).send({ error: 'Task not found' })
    if (task.status === 'done') return reply.code(409).send({ error: 'Task already completed' })
    await db.update(schema.tasks).set({ status: 'in_progress', kanbanColumn: 'in_progress' })
      .where(eq(schema.tasks.id, taskId))
    await db.update(schema.agents).set({ status: 'active' }).where(eq(schema.agents.id, agent.id))
    return { ok: true, task: { ...task, status: 'in_progress' } }
  })

  // Post the result of a task: done | failed.
  app.post('/api/agent/tasks/:taskId/result', async (req, reply) => {
    const agent = (req as any).agent
    const { taskId } = req.params as any
    const { output, status } = ResultSchema.parse(req.body ?? {})
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task || task.agentId !== agent.id) return reply.code(404).send({ error: 'Task not found' })
    await db.update(schema.tasks)
      .set({ output, status, kanbanColumn: status === 'done' ? 'done' : 'blocked', completedAt: new Date() })
      .where(eq(schema.tasks.id, taskId))
    await db.insert(schema.messages).values({
      id: randomUUID(), agentId: agent.id, taskId, role: 'assistant', content: output, createdAt: new Date(),
    })
    await db.update(schema.agents)
      .set({ status: 'idle', lastHeartbeatAt: new Date(), heartbeatStatus: 'green' })
      .where(eq(schema.agents.id, agent.id))
    return { ok: true }
  })

  // Free-form progress / chatter message from the runtime.
  app.post('/api/agent/messages', async (req) => {
    const agent = (req as any).agent
    const { taskId, content } = (req.body as any) ?? {}
    await db.insert(schema.messages).values({
      id: randomUUID(), agentId: agent.id, taskId: taskId ?? null, role: 'assistant',
      content: String(content ?? ''), createdAt: new Date(),
    })
    return { ok: true }
  })
}
