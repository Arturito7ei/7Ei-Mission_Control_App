import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// Fields that should never appear in audit metadata
const SENSITIVE_KEYS = ['key', 'token', 'secret', 'password', 'apiKey', 'api_key', 'refreshToken', 'accessToken']

export function sanitizeBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null
  const sanitized: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s.toLowerCase()))) {
      sanitized[k] = '[REDACTED]'
    } else if (typeof v === 'string' && v.length > 200) {
      sanitized[k] = v.slice(0, 200) + '...'
    } else {
      sanitized[k] = v
    }
  }
  return sanitized
}

function classifyAction(method: string, path: string): string {
  const m = method.toUpperCase()
  if (path.includes('/api/orgs') && m === 'POST' && !path.includes('/')) return 'org.create'
  if (path.includes('/api/orgs') && m === 'DELETE') return 'org.delete'
  if (path.includes('/agents') && m === 'POST') return 'agent.create'
  if (path.includes('/agents') && m === 'DELETE') return 'agent.delete'
  if (path.includes('/credentials') && m === 'POST') return 'credential.add'
  if (path.includes('/credentials') && m === 'DELETE') return 'credential.remove'
  if (path.includes('/chat') && m === 'POST') return 'agent.chat'
  if (path.includes('/scheduled') && m === 'POST') return 'scheduled.create'
  if (path.includes('/budget') || (path.includes('/orgs') && m === 'PATCH')) return 'org.update'
  return `${m.toLowerCase()}.${path.split('/api/')[1]?.split('/')[0] ?? 'unknown'}`
}

const SENSITIVE_METHODS = ['POST', 'DELETE', 'PATCH', 'PUT']

export async function auditLogPlugin(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    // Skip health/ready checks
    if (req.url === '/health' || req.url === '/ready' || req.url === '/api/health') return

    const userId = (req as any).auth?.userId ?? null
    const orgId = (req.params as any)?.orgId ?? null
    const action = classifyAction(req.method, req.url)
    const durationMs = Math.round(reply.elapsedTime)

    let metadata: Record<string, unknown> | null = null
    if (SENSITIVE_METHODS.includes(req.method) && req.body) {
      metadata = sanitizeBody(req.body)
    }

    db.insert(schema.auditLogs).values({
      id: randomUUID(),
      orgId,
      userId,
      action,
      method: req.method,
      path: req.url.split('?')[0],
      statusCode: reply.statusCode,
      durationMs,
      metadata,
      createdAt: new Date(),
    }).catch(err => console.warn('Audit log insert failed:', err))
  })

  // Query endpoint
  app.get('/api/orgs/:orgId/audit-log', async (req) => {
    const { orgId } = req.params as any
    const { limit = '100', action } = req.query as any
    const conditions = [eq(schema.auditLogs.orgId, orgId)]
    if (action) conditions.push(eq(schema.auditLogs.action, action))
    const { and } = await import('drizzle-orm')
    const logs = await db.select().from(schema.auditLogs)
      .where(and(...conditions))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(Number(limit))
    return { logs }
  })
}
