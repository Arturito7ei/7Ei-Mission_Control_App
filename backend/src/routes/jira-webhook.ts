import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// ─── Jira Webhook — inbound real-time updates ───────────────────────────────
// Setup: in Jira, go to Settings → System → Webhooks
// URL: https://api.7ei.ai/api/jira/webhook/:orgId
// Events: issue:created, issue:updated, issue:deleted

// In-memory event store per org (last 100 events)
const eventStore = new Map<string, any[]>()

// WebSocket clients per org for live push
const wsClients = new Map<string, Set<any>>()

export async function jiraWebhookRoutes(app: FastifyInstance) {

  // ─ Jira webhook receiver ────────────────────────────────────────────
  app.post('/api/jira/webhook/:orgId', async (req, reply) => {
    const { orgId } = req.params as any
    const payload = req.body as any

    const event = {
      id: randomUUID(),
      orgId,
      type: payload.webhookEvent ?? 'unknown',
      issueKey: payload.issue?.key,
      issueSummary: payload.issue?.fields?.summary,
      issueStatus: payload.issue?.fields?.status?.name,
      issuePriority: payload.issue?.fields?.priority?.name,
      assignee: payload.issue?.fields?.assignee?.displayName ?? null,
      changedFields: payload.changelog?.items?.map((i: any) => i.field) ?? [],
      timestamp: new Date().toISOString(),
    }

    // Store event
    const existing = eventStore.get(orgId) ?? []
    existing.unshift(event)
    eventStore.set(orgId, existing.slice(0, 100)) // keep last 100

    // Push to WebSocket subscribers
    const clients = wsClients.get(orgId)
    if (clients) {
      const msg = JSON.stringify({ type: 'jira_event', data: event })
      for (const socket of clients) {
        try { socket.send(msg) } catch {}
      }
    }

    // Sync task status if issue was updated
    if (payload.webhookEvent === 'jira:issue_updated' && event.issueKey && event.issueStatus) {
      await syncJiraStatusToTask(orgId, event.issueKey, event.issueStatus)
    }

    // Delete local task if issue was deleted in Jira
    if (payload.webhookEvent === 'jira:issue_deleted' && event.issueKey) {
      await markTaskDeleted(orgId, event.issueKey)
    }

    reply.code(200).send({ ok: true })
  })

  // ─ Get recent events ─────────────────────────────────────────────────
  app.get('/api/orgs/:orgId/jira/events', async (req) => {
    const { orgId } = req.params as any
    const events = eventStore.get(orgId) ?? []
    return { events, count: events.length }
  })

  // ─ WebSocket live events stream ─────────────────────────────────────
  app.get('/api/orgs/:orgId/jira/live', { websocket: true }, async (socket: any, req: any) => {
    const { orgId } = req.params
    if (!wsClients.has(orgId)) wsClients.set(orgId, new Set())
    wsClients.get(orgId)!.add(socket)

    // Send last 10 events on connect
    const recent = (eventStore.get(orgId) ?? []).slice(0, 10)
    socket.send(JSON.stringify({ type: 'history', data: recent }))

    socket.on('close', () => {
      wsClients.get(orgId)?.delete(socket)
    })
  })

  // ─ Generate webhook URL for this org ────────────────────────────────
  app.get('/api/orgs/:orgId/jira/webhook-url', async (req) => {
    const { orgId } = req.params as any
    const baseUrl = process.env.PUBLIC_URL ?? 'https://api.7ei.ai'
    return {
      url: `${baseUrl}/api/jira/webhook/${orgId}`,
      instructions: [
        '1. In Jira: Settings \u2192 System \u2192 Webhooks \u2192 Create',
        '2. Set URL to the value above',
        '3. Select events: Issue Created, Updated, Deleted',
        '4. Save. Events will appear in real-time in the Jira tab.',
      ],
    }
  })
}

async function syncJiraStatusToTask(orgId: string, issueKey: string, jiraStatus: string): Promise<void> {
  const statusMap: Record<string, string> = {
    'To Do': 'pending', 'In Progress': 'in_progress', 'In Review': 'in_progress',
    'Done': 'done', 'Blocked': 'blocked', 'Closed': 'done', 'Resolved': 'done',
  }
  const newStatus = statusMap[jiraStatus]
  if (!newStatus) return

  const tasks = await db.select().from(schema.tasks)
    .where(and(eq(schema.tasks.orgId, orgId)))
  const matching = tasks.filter(t => t.title.includes(`[${issueKey}]`))
  for (const task of matching) {
    await db.update(schema.tasks).set({ status: newStatus }).where(eq(schema.tasks.id, task.id))
  }
}

async function markTaskDeleted(orgId: string, issueKey: string): Promise<void> {
  const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.orgId, orgId))
  const matching = tasks.filter(t => t.title.includes(`[${issueKey}]`))
  for (const task of matching) {
    await db.update(schema.tasks).set({ status: 'blocked' } as any).where(eq(schema.tasks.id, task.id))
  }
}
