// Epic AG — routes behind the per-agent detail page. Everything here is
// org-scoped (`/api/orgs/:orgId/agents/:agentId/...`) so `requireOrgRole` can
// actually gate it — the RBAC helper reads `:orgId` from the path and silently
// no-ops without it, which is why these do NOT live under `/api/agents/:id/...`.
//
// Aggregation is pure (`services/agent-overview.ts`); these handlers only fetch
// rows and hand them over.
import type { FastifyInstance } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { buildAgentOverview, OVERVIEW_DAYS } from '../services/agent-overview'

/** The agent, but only if it belongs to this org. Null otherwise (→ 404). */
export async function agentInOrg(orgId: string, agentId: string) {
  const agent = await db.query.agents.findFirst({
    where: and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)),
  })
  return agent ?? null
}

export async function agentDetailRoutes(app: FastifyInstance) {
  // AG2 — Dashboard tab: latest run, 14-day charts, recent tasks, costs.
  app.get('/api/orgs/:orgId/agents/:agentId/overview', async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const windowStart = new Date(Date.now() - OVERVIEW_DAYS * 86_400_000)

    const [runs, tasks] = await Promise.all([
      db.select().from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agentId)))
        .orderBy(desc(schema.agentRuns.startedAt)).limit(200),
      db.select().from(schema.tasks)
        .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.agentId, agentId)))
        .orderBy(desc(schema.tasks.createdAt)).limit(200),
    ])

    // Charts cover the window; the Costs strip covers the same window's tasks so
    // the numbers on screen belong to the period the charts claim to show.
    const windowTasks = tasks.filter(t => (t.createdAt?.getTime() ?? 0) >= windowStart.getTime())

    return {
      overview: buildAgentOverview({ agentId, runs, tasks: windowTasks, now: Date.now() }),
      // Recent tasks are the agent's newest overall, not window-clipped — an idle
      // agent should still show what it last worked on.
      recentTasks: buildAgentOverview({ agentId, runs: [], tasks, now: Date.now() }).recentTasks,
    }
  })

  // AG2/AG6 — the agent's run history (there was only a per-task runs route).
  app.get('/api/orgs/:orgId/agents/:agentId/runs', async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const { limit } = req.query as { limit?: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
    const runs = await db.select().from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agentId)))
      .orderBy(desc(schema.agentRuns.startedAt)).limit(n)
    return { runs }
  })
}
