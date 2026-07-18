// ACT-1 — the unified activity feed route.
//
// ONE read endpoint that answers "what has my office been doing", composed from the
// five places the office already writes its history. See ../services/activity for the
// vocabulary, the allow-list projectors and the merge.
//
// AUTHZ, in two layers:
//
//  - The path carries `:orgId`, so the surface-wide `requireOrgMembership` preHandler
//    (installed once on the secured scope in index.ts) already resolves the org and
//    403s a non-member. That is deliberate rather than incidental: mounting this at a
//    tailless path like `/api/activity` would put us straight into the R-4 trap, where
//    `requireOrgRole` returns early on a missing `:orgId` and enforces NOTHING.
//
//  - Owner-only SOURCES stay owner-only. `connector_executions` and `audit_logs` are
//    reachable today only behind `requireOrgRole('owner')`. So rather than gating the
//    whole feed at owner (which would take the Activity tab away from members, who can
//    see runs and tasks today), the route resolves the caller's REAL role via the same
//    `enforceOrgRole` core the preHandlers use, and `visibleKinds` drops the owner-only
//    kinds for a member BEFORE any query runs. A member's request never reads those
//    tables at all. This composes existing RBAC; it weakens nothing.
//
// BOUNDED: every source is over-fetched by exactly one page (`limit + 1`) and merged;
// `limit` is clamped to FEED_MAX_LIMIT. There is no unbounded path.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and, desc, lte, isNotNull, inArray } from 'drizzle-orm'
import { enforceOrgRole } from '../middleware/rbac'
import {
  ACTIVITY_KINDS, ACTIVITY_OUTCOMES, OWNER_ONLY_KINDS,
  FEED_TIE_SLACK,
  clampLimit, parseActivityCursor, parseKindFilter, visibleKinds, mergeActivityPage,
  projectApprovalFiled, projectApprovalDecided, projectConnectorEvent,
  projectRunEvent, projectTaskEvent, projectAuditEvent,
  type ActivityEvent, type ActivityKind,
} from '../services/activity'

export async function activityRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/activity', async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    const userId = (req as any).auth?.userId ?? (req as any).userId ?? null
    const q = req.query as { limit?: string; cursor?: string; kind?: string; agentId?: string }

    // DEFENCE IN DEPTH. The scope-wide `requireOrgMembership` preHandler already 403s a
    // non-member before we get here, so in the deployed app this check is redundant —
    // which is exactly why it is worth having. This route reads five tables at once; if
    // it were ever re-registered outside the secured scope, or the scope gate were
    // refactored, the failure would be a silent five-table cross-tenant read rather than
    // a 403. `enforceOrgRole` NEVER skips (unlike the path-based preHandler), so this
    // fails closed on a missing org too. Caught by activity-route.test.ts driving the
    // route in isolation, without the scope gate mounted.
    const member = await enforceOrgRole({ userId, orgId, minRole: 'member' })
    if (!member.ok) return reply.code(member.code).send({ error: member.error })

    // The caller's REAL role decides which SOURCES are legible — never the client.
    const isOwner = (await enforceOrgRole({ userId, orgId, minRole: 'owner' })).ok

    const kinds = visibleKinds({ isOwner, requested: parseKindFilter(q.kind) })
    const limit = clampLimit(q.limit)
    const cursor = parseActivityCursor(q.cursor)
    const agentFilter = typeof q.agentId === 'string' && q.agentId.length > 0 ? q.agentId : null
    const want = (k: ActivityKind) => kinds.includes(k)

    // Over-fetch per source: one page beyond `limit` to determine the global top-`limit`
    // of the k-way merge AND whether a further page exists, PLUS the tie slack so that
    // same-millisecond rows dropped by the cursor filter cannot eat the budget.
    // See FEED_TIE_SLACK for why the drop is always a contiguous prefix.
    const n = limit + 1 + FEED_TIE_SLACK
    const at = cursor?.at ?? null

    const agentRows = await db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.orgId, orgId))
    const agentName = (id: string | null | undefined): string | null =>
      (id ? agentRows.find((a) => a.id === id)?.name ?? null : null)

    // ── Approvals: filed ──────────────────────────────────────────────────────
    const filedRows = want('approval_filed')
      ? await db.select({
          id: schema.approvalRequests.id, type: schema.approvalRequests.type,
          summary: schema.approvalRequests.summary, status: schema.approvalRequests.status,
          requestedByAgentId: schema.approvalRequests.requestedByAgentId,
          createdAt: schema.approvalRequests.createdAt,
        }).from(schema.approvalRequests)
          .where(and(
            eq(schema.approvalRequests.orgId, orgId),
            ...(at !== null ? [lte(schema.approvalRequests.createdAt, new Date(at))] : []),
            ...(agentFilter ? [eq(schema.approvalRequests.requestedByAgentId, agentFilter)] : []),
          ))
          .orderBy(desc(schema.approvalRequests.createdAt), desc(schema.approvalRequests.id)).limit(n)
      : []

    // ── Approvals: decided (ordered by the DECISION, not the filing) ──────────
    const decidedRows = want('approval_decided')
      ? await db.select({
          id: schema.approvalRequests.id, type: schema.approvalRequests.type,
          summary: schema.approvalRequests.summary, status: schema.approvalRequests.status,
          requestedByAgentId: schema.approvalRequests.requestedByAgentId,
          decidedAt: schema.approvalRequests.decidedAt,
        }).from(schema.approvalRequests)
          .where(and(
            eq(schema.approvalRequests.orgId, orgId),
            isNotNull(schema.approvalRequests.decidedAt),
            ...(at !== null ? [lte(schema.approvalRequests.decidedAt, new Date(at))] : []),
            ...(agentFilter ? [eq(schema.approvalRequests.requestedByAgentId, agentFilter)] : []),
          ))
          .orderBy(desc(schema.approvalRequests.decidedAt), desc(schema.approvalRequests.id)).limit(n)
      : []

    // ── Connector executions (OWNER-ONLY — `want` is false for a member) ──────
    const cxRows = want('connector_execution')
      ? await db.select({
          id: schema.connectorExecutions.id, agentId: schema.connectorExecutions.agentId,
          connectorId: schema.connectorExecutions.connectorId, action: schema.connectorExecutions.action,
          classification: schema.connectorExecutions.classification,
          approvalId: schema.connectorExecutions.approvalId, status: schema.connectorExecutions.status,
          error: schema.connectorExecutions.error, createdAt: schema.connectorExecutions.createdAt,
        }).from(schema.connectorExecutions)
          .where(and(
            eq(schema.connectorExecutions.orgId, orgId),
            ...(at !== null ? [lte(schema.connectorExecutions.createdAt, new Date(at))] : []),
            ...(agentFilter ? [eq(schema.connectorExecutions.agentId, agentFilter)] : []),
          ))
          .orderBy(desc(schema.connectorExecutions.createdAt), desc(schema.connectorExecutions.id)).limit(n)
      : []

    // ── Agent runs ────────────────────────────────────────────────────────────
    const runRows = want('agent_run')
      ? await db.select({
          id: schema.agentRuns.id, agentId: schema.agentRuns.agentId, taskId: schema.agentRuns.taskId,
          status: schema.agentRuns.status, startedAt: schema.agentRuns.startedAt,
          endedAt: schema.agentRuns.endedAt,
        }).from(schema.agentRuns)
          .where(and(
            eq(schema.agentRuns.orgId, orgId),
            ...(at !== null ? [lte(schema.agentRuns.startedAt, new Date(at))] : []),
            ...(agentFilter ? [eq(schema.agentRuns.agentId, agentFilter)] : []),
          ))
          .orderBy(desc(schema.agentRuns.startedAt), desc(schema.agentRuns.id)).limit(n)
      : []

    // A run has no title of its own; borrow its task's. One bounded lookup for the
    // page's runs only — never a scan.
    const runTaskIds = [...new Set(runRows.map((r) => r.taskId).filter((t): t is string => !!t))]
    const runTasks = runTaskIds.length > 0
      ? await db.select({ id: schema.tasks.id, title: schema.tasks.title }).from(schema.tasks)
          .where(and(eq(schema.tasks.orgId, orgId), inArray(schema.tasks.id, runTaskIds)))
      : []

    // ── Tasks ─────────────────────────────────────────────────────────────────
    const taskRows = want('task')
      ? await db.select({
          id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status,
          agentId: schema.tasks.agentId, createdAt: schema.tasks.createdAt,
        }).from(schema.tasks)
          .where(and(
            eq(schema.tasks.orgId, orgId),
            ...(at !== null ? [lte(schema.tasks.createdAt, new Date(at))] : []),
            ...(agentFilter ? [eq(schema.tasks.agentId, agentFilter)] : []),
          ))
          .orderBy(desc(schema.tasks.createdAt), desc(schema.tasks.id)).limit(n)
      : []

    // ── Audit trail (OWNER-ONLY). Never agent-filtered: an audit row records a USER
    //    action and carries no agent, so an agent filter must EXCLUDE it, not match
    //    every row. ──────────────────────────────────────────────────────────────
    const auditRows = want('audit_event') && !agentFilter
      ? await db.select({
          id: schema.auditLogs.id, action: schema.auditLogs.action, method: schema.auditLogs.method,
          path: schema.auditLogs.path, statusCode: schema.auditLogs.statusCode,
          createdAt: schema.auditLogs.createdAt,
        }).from(schema.auditLogs)
          .where(and(
            eq(schema.auditLogs.orgId, orgId),
            ...(at !== null ? [lte(schema.auditLogs.createdAt, new Date(at))] : []),
          ))
          .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id)).limit(n)
      : []

    const sources: ActivityEvent[][] = [
      filedRows.map((r) => projectApprovalFiled(r as any, agentName(r.requestedByAgentId))),
      decidedRows.map((r) => projectApprovalDecided(r as any, agentName(r.requestedByAgentId))),
      cxRows.map((r) => projectConnectorEvent(r as any, agentName(r.agentId))),
      runRows.map((r) => projectRunEvent(
        r as any,
        agentName(r.agentId),
        runTasks.find((t) => t.id === r.taskId)?.title ?? null,
      )),
      taskRows.map((r) => projectTaskEvent(r as any, agentName(r.agentId))),
      auditRows.map((r) => projectAuditEvent(r as any)),
    ]

    const { events, nextCursor } = mergeActivityPage(sources, { limit, cursor })

    return {
      events,
      nextCursor,
      limit,
      // What THIS caller may filter by, so the client renders only chips that work
      // rather than offering an owner-only filter that silently returns nothing.
      availableKinds: visibleKinds({ isOwner, requested: null }),
      // The full vocabulary, for a client that wants to label an unknown kind.
      kinds: ACTIVITY_KINDS,
      outcomes: ACTIVITY_OUTCOMES,
      ownerOnlyKinds: OWNER_ONLY_KINDS,
      isOwner,
    }
  })
}
