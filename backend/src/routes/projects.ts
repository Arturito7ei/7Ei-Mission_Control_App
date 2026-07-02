import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// ─── PROJECTS ────────────────────────────────────────────────────────────────

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/projects', async (req) => {
    const { orgId } = req.params as any
    return { projects: await db.select().from(schema.projects).where(eq(schema.projects.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/projects', async (req, reply) => {
    const { orgId } = req.params as any
    const body = req.body as any
    const project = { id: randomUUID(), orgId, departmentId: body.departmentId ?? null, name: body.name, description: body.description ?? null, createdAt: new Date() }
    await db.insert(schema.projects).values(project)
    reply.code(201); return { project }
  })
  app.patch('/api/projects/:projectId', async (req) => {
    await db.update(schema.projects).set(req.body as any).where(eq(schema.projects.id, (req.params as any).projectId))
    return { ok: true }
  })
  app.delete('/api/projects/:projectId', async (req, reply) => {
    await db.delete(schema.projects).where(eq(schema.projects.id, (req.params as any).projectId))
    reply.code(204)
  })
  app.get('/api/projects/:projectId/board', async (req) => {
    const { projectId } = req.params as any
    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId))
    return { board: { todo: tasks.filter(t => t.kanbanColumn === 'todo'), in_progress: tasks.filter(t => t.kanbanColumn === 'in_progress'), blocked: tasks.filter(t => t.kanbanColumn === 'blocked'), done: tasks.filter(t => t.kanbanColumn === 'done') } }
  })
}
