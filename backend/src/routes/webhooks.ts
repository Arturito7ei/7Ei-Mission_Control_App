import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

const WEBHOOK_EVENTS = [
  'task.done', 'task.failed',
  'agent.active', 'agent.idle',
  'message.created', 'org.created', '*',
]

export async function webhookRoutes(app: FastifyInstance) {
  // Available events
  app.get('/api/webhooks/events', async () => ({ events: WEBHOOK_EVENTS }))

  // List webhooks for org
  app.get('/api/orgs/:orgId/webhooks', async (req) => {
    const { orgId } = req.params as any
    const hooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.orgId, orgId))
    // Never return secrets in list
    return { webhooks: hooks.map(h => ({ ...h, secret: h.secret ? '***' : null })) }
  })

  // Create webhook
  app.post('/api/orgs/:orgId/webhooks', async (req, reply) => {
    const { orgId } = req.params as any
    const { name, url, secret, events = ['*'] } = req.body as any
    if (!name || !url) return reply.code(400).send({ error: 'name and url required' })
    // Validate URL
    try { new URL(url) } catch { return reply.code(400).send({ error: 'Invalid URL' }) }

    const hook = {
      id: randomUUID(), orgId, name, url,
      secret: secret ?? null,
      events: events as string[],
      enabled: 1, lastTriggeredAt: null, createdAt: new Date(),
    }
    await db.insert(schema.webhooks).values(hook)
    reply.code(201)
    return { webhook: { ...hook, secret: hook.secret ? '***' : null } }
  })

  // Update
  app.patch('/api/webhooks/:id', async (req) => {
    const { id } = req.params as any
    const body = req.body as any
    const update: any = {}
    if (body.name)    update.name = body.name
    if (body.url)     update.url = body.url
    if (body.secret)  update.secret = body.secret
    if (body.events)  update.events = body.events
    if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0
    await db.update(schema.webhooks).set(update).where(eq(schema.webhooks.id, id))
    return { ok: true }
  })

  // Delete
  app.delete('/api/webhooks/:id', async (req, reply) => {
    const { id } = req.params as any
    await db.delete(schema.webhooks).where(eq(schema.webhooks.id, id))
    reply.code(204)
  })

  // Test: send a test ping to the webhook
  app.post('/api/webhooks/:id/test', async (req, reply) => {
    const { id } = req.params as any
    const hook = await db.query.webhooks.findFirst({ where: eq(schema.webhooks.id, id) })
    if (!hook) return reply.code(404).send({ error: 'Not found' })

    const testPayload = JSON.stringify({
      event: 'test.ping',
      orgId: hook.orgId,
      data: { message: '7Ei webhook test — if you see this, the connection works.' },
      timestamp: new Date().toISOString(),
      version: '1',
    })

    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': '7Ei-Mission-Control/1.0' },
        body: testPayload,
        signal: AbortSignal.timeout(10_000),
      })
      return { ok: res.ok, status: res.status }
    } catch (err: any) {
      return reply.code(502).send({ error: `Webhook unreachable: ${err.message}` })
    }
  })
}
