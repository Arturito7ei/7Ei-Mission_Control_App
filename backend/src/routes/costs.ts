import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and, desc, gte } from 'drizzle-orm'

// ─── COSTS ───────────────────────────────────────────────────────────────────

export async function costRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/costs', async (req) => {
    const { orgId } = req.params as any
    const { groupBy = 'agent', period = '30d' } = req.query as any
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30
    const since = new Date(Date.now() - days * 86400000)
    const rawTasks = await db.select({ agentId: schema.tasks.agentId, projectId: schema.tasks.projectId, costUsd: schema.tasks.costUsd, tokensUsed: schema.tasks.tokensUsed, createdAt: schema.tasks.createdAt }).from(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), gte(schema.tasks.createdAt, since)))
    const totals = { totalCost: rawTasks.reduce((s, t) => s + (t.costUsd ?? 0), 0), totalTokens: rawTasks.reduce((s, t) => s + (t.tokensUsed ?? 0), 0), taskCount: rawTasks.length }
    if (groupBy === 'agent') {
      const map = new Map<string, any>()
      for (const t of rawTasks) {
        const e = map.get(t.agentId) ?? { agentId: t.agentId, totalCost: 0, totalTokens: 0, taskCount: 0 }
        e.totalCost += t.costUsd ?? 0; e.totalTokens += t.tokensUsed ?? 0; e.taskCount++
        map.set(t.agentId, e)
      }
      const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, avatarEmoji: schema.agents.avatarEmoji }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
      const agentMap = new Map(agents.map(a => [a.id, a]))
      return { costs: Array.from(map.values()).map(c => ({ ...c, agentName: agentMap.get(c.agentId)?.name ?? 'Unknown', avatarEmoji: agentMap.get(c.agentId)?.avatarEmoji ?? '🤖' })), period, groupBy, totals }
    }
    if (groupBy === 'day') {
      const dayMap = new Map<string, any>()
      for (const t of rawTasks) {
        const day = (t.createdAt as Date).toISOString().slice(0, 10)
        const e = dayMap.get(day) ?? { date: day, totalCost: 0, totalTokens: 0 }
        e.totalCost += t.costUsd ?? 0; e.totalTokens += t.tokensUsed ?? 0
        dayMap.set(day, e)
      }
      return { costs: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)), period, groupBy, totals }
    }
    return { costs: totals, period, groupBy }
  })
  app.get('/api/orgs/:orgId/costs/summary', async (req) => {
    const { orgId } = req.params as any
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfWeek = new Date(startOfToday.getTime() - startOfToday.getDay() * 86400000)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const allTasks = await db.select({
      costUsd: schema.tasks.costUsd,
      tokensUsed: schema.tasks.tokensUsed,
      createdAt: schema.tasks.createdAt,
    }).from(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), gte(schema.tasks.createdAt, startOfMonth)))

    const sumPeriod = (since: Date) => {
      const filtered = allTasks.filter(t => (t.createdAt as Date) >= since)
      return {
        cost: filtered.reduce((s, t) => s + (t.costUsd ?? 0), 0),
        tokens: filtered.reduce((s, t) => s + (t.tokensUsed ?? 0), 0),
        tasks: filtered.length,
      }
    }

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    const monthData = sumPeriod(startOfMonth)
    const budgetLimit = org?.budgetMonthlyUsd ?? null

    return {
      today: sumPeriod(startOfToday),
      week: sumPeriod(startOfWeek),
      month: monthData,
      budget: {
        monthlyLimitUsd: budgetLimit,
        usedThisMonth: monthData.cost,
        percentUsed: budgetLimit ? Math.round((monthData.cost / budgetLimit) * 100) : null,
      },
    }
  })

  // Cost CSV export
  app.get('/api/orgs/:orgId/costs/export', async (req, reply) => {
    const { orgId } = req.params as any
    const tasks = await db.select({
      createdAt: schema.tasks.createdAt, agentId: schema.tasks.agentId,
      llmModel: schema.tasks.llmModel, tokensUsed: schema.tasks.tokensUsed, costUsd: schema.tasks.costUsd,
    }).from(schema.tasks).where(eq(schema.tasks.orgId, orgId)).orderBy(desc(schema.tasks.createdAt))
    const agents = await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const agentMap = new Map(agents.map(a => [a.id, a.name]))

    const header = 'date,agentId,agentName,model,tokens,cost'
    const rows = tasks.filter(t => t.costUsd != null).map(t =>
      [t.createdAt instanceof Date ? t.createdAt.toISOString().slice(0, 10) : '',
       t.agentId, agentMap.get(t.agentId) ?? 'Unknown', t.llmModel ?? '',
       t.tokensUsed ?? 0, (t.costUsd ?? 0).toFixed(6)].join(',')
    )
    const csv = [header, ...rows].join('\n')
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', 'attachment; filename=costs-export.csv')
    return csv
  })
}
