import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { redactPath } from '../services/log-redaction'

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
  // `/api/orgs` collection POST = org.create. The old guard was
  // `path.includes('/api/orgs') && !path.includes('/')` — unsatisfiable (a path
  // holding `/api/orgs` always holds `/`), so org.create was never classified and
  // a create fell through to the generic `post.orgs`. Match the collection path.
  if (m === 'POST' && (path === '/api/orgs' || path === '/api/orgs/')) return 'org.create'
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

/** The row the hook persists. Built by a pure function so the redaction is
 *  testable without a DB, and so there is exactly ONE place a path is written. */
export interface AuditRow {
  id: string
  orgId: string | null
  userId: string | null
  action: string
  method: string
  path: string
  statusCode: number
  durationMs: number
  metadata: Record<string, unknown> | null
  createdAt: Date
}

/**
 * Build the audit row for one response.
 *
 * ONB2 / audit finding H2: the path is REDACTED here (`redactPath`) — invite
 * tokens are bearer credentials carried in the URL (`/api/agent-invites/mci_inv_…`),
 * and this row is persisted into a queryable table. A raw token must never reach
 * `audit_logs.path`. The redaction happens before the value is used at all — not
 * even the derived `action` sees the raw URL.
 */
export function buildAuditRow(input: {
  method: string
  url: string
  statusCode: number
  durationMs: number
  userId?: string | null
  orgId?: string | null
  body?: unknown
  now?: Date
}): AuditRow {
  const path = redactPath(input.url)
  return {
    id: randomUUID(),
    orgId: input.orgId ?? null,
    userId: input.userId ?? null,
    action: classifyAction(input.method, path),
    method: input.method,
    path,
    statusCode: input.statusCode,
    durationMs: input.durationMs,
    metadata: SENSITIVE_METHODS.includes(input.method) && input.body ? sanitizeBody(input.body) : null,
    createdAt: input.now ?? new Date(),
  }
}

/** Where an audit row goes. Injectable so a test can prove what would be
 *  persisted without standing up Turso; production always uses the DB sink. */
export type AuditSink = (row: AuditRow) => void

const dbSink: AuditSink = (row) => {
  db.insert(schema.auditLogs).values(row).catch(err => console.warn('Audit log insert failed:', err))
}

export async function auditLogPlugin(app: FastifyInstance, opts: { sink?: AuditSink } = {}) {
  const sink = opts.sink ?? dbSink

  app.addHook('onResponse', async (req, reply) => {
    // Skip health/ready checks
    if (req.url === '/health' || req.url === '/ready' || req.url === '/api/health') return

    sink(buildAuditRow({
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      userId: (req as any).auth?.userId ?? null,
      orgId: (req.params as any)?.orgId ?? null,
      body: req.body,
    }))
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
