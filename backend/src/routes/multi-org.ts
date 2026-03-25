import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

export async function multiOrgRoutes(app: FastifyInstance) {
  // List orgs for a user via membership table
  app.get('/api/users/:userId/orgs', async (req) => {
    const { userId } = req.params as any
    const memberships = await db.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, userId))
    const orgs = await Promise.all(memberships.map(async (m) => {
      const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, m.orgId) })
      return org ? { ...org, memberRole: m.role } : null
    }))
    return { orgs: orgs.filter(Boolean) }
  })

  app.get('/api/orgs/switch/list', async (req) => {
    const userId = (req as any).auth?.userId ?? ''
    const orgs = await db.select().from(schema.organisations).where(eq(schema.organisations.ownerId, userId))
    const enriched = await Promise.all(orgs.map(async (org) => {
      const [agents, tasks] = await Promise.all([
        db.select({ id: schema.agents.id, status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, org.id)),
        db.select({ id: schema.tasks.id, status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.orgId, org.id)),
      ])
      return {
        ...org,
        agentCount: agents.length,
        activeAgents: agents.filter(a => a.status === 'active').length,
        taskCount: tasks.length,
        pendingTasks: tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length,
      }
    }))
    return { orgs: enriched }
  })

  app.post('/api/agents/:agentId/transfer', async (req, reply) => {
    const { agentId } = req.params as any
    const { targetOrgId } = req.body as any
    if (!targetOrgId) return reply.code(400).send({ error: 'targetOrgId required' })
    const targetOrg = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, targetOrgId) })
    if (!targetOrg) return reply.code(404).send({ error: 'Target org not found' })
    await db.update(schema.agents).set({ orgId: targetOrgId, departmentId: null }).where(eq(schema.agents.id, agentId))
    return { ok: true, agentId, newOrgId: targetOrgId }
  })

  app.post('/api/agents/:agentId/clone', async (req, reply) => {
    const { agentId } = req.params as any
    const { targetOrgId } = req.body as any
    if (!targetOrgId) return reply.code(400).send({ error: 'targetOrgId required' })
    const source = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!source) return reply.code(404).send({ error: 'Agent not found' })
    const cloned = { ...source, id: randomUUID(), orgId: targetOrgId, departmentId: null, status: 'idle', createdAt: new Date() }
    await db.insert(schema.agents).values(cloned)
    reply.code(201)
    return { agent: cloned }
  })

  app.post('/api/orgs/:orgId/duplicate', async (req, reply) => {
    const { orgId } = req.params as any
    const { name } = req.body as any
    const userId = (req as any).auth?.userId ?? 'anon'
    const [sourceOrg, departments, agents] = await Promise.all([
      db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) }),
      db.select().from(schema.departments).where(eq(schema.departments.orgId, orgId)),
      db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId)),
    ])
    if (!sourceOrg) return reply.code(404).send({ error: 'Source org not found' })
    const newOrgId = randomUUID()
    await db.insert(schema.organisations).values({
      id: newOrgId, name: name ?? `${sourceOrg.name} (copy)`,
      description: sourceOrg.description, logoUrl: sourceOrg.logoUrl,
      ownerId: userId, createdAt: new Date(),
    })
    const deptIdMap = new Map<string, string>()
    for (const dept of departments) {
      const newId = randomUUID(); deptIdMap.set(dept.id, newId)
      await db.insert(schema.departments).values({ ...dept, id: newId, orgId: newOrgId })
    }
    for (const agent of agents) {
      await db.insert(schema.agents).values({
        ...agent, id: randomUUID(), orgId: newOrgId,
        departmentId: agent.departmentId ? (deptIdMap.get(agent.departmentId) ?? null) : null,
        status: 'idle', createdAt: new Date(),
      })
    }
    reply.code(201)
    return { orgId: newOrgId, name: name ?? `${sourceOrg.name} (copy)`, agentsCopied: agents.length }
  })
}
