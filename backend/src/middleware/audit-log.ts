import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { redactPath, redactTokensInText } from '../services/log-redaction'
import { requireOrgRole } from './rbac'
import { allSecretFieldKeys } from '../services/adapter-registry'

// Fields that should never appear in audit metadata — substring-matched, so this
// covers `apiKey`, `x-openclaw-token`, `refresh_token`, … by shape.
const SENSITIVE_KEYS = ['key', 'token', 'secret', 'password', 'apiKey', 'api_key', 'refreshToken', 'accessToken']

/**
 * …but shape-matching is not enough, and the re-audit of #248 found where it fails.
 *
 * The adapter registry declares which of an adapter's fields are secrets, and the
 * onboarding document instructs a joining agent to send exactly those keys inside
 * `agentDefaultsPayload`. `http_webhook` declares `webhookAuthHeader` (`secret: true`
 * — it is a bearer `Authorization` header value), and that name contains none of
 * `key|token|secret|password|…`. It sailed through `sanitizeBody` verbatim: the day
 * ONB3 lands the join body and the hook is enabled, a live bearer credential is
 * persisted to `audit_logs.metadata` in plaintext.
 *
 * So the registry — not a hand-written list that has to be remembered — decides. A
 * new adapter's secret field is redacted the moment it is declared, and the guard in
 * `audit-onb2-reaudit.test.ts` fails if that ever stops being true.
 */
const REGISTRY_SECRET_KEYS = new Set(allSecretFieldKeys().map(k => k.toLowerCase()))

/** How deep sanitizeBody walks before it gives up and drops the subtree. Bodies
 *  are Zod-validated request payloads, not arbitrary graphs — 8 is far past any
 *  real one, and the cap is what stops a hostile/cyclic body from spinning here. */
const MAX_DEPTH = 8

const isSensitiveKey = (k: string) => {
  const lower = k.toLowerCase()
  return SENSITIVE_KEYS.some(s => lower.includes(s.toLowerCase())) || REGISTRY_SECRET_KEYS.has(lower)
}

/**
 * ONB2 audit finding H-3 — sanitizeBody must RECURSE.
 *
 * It used to redact only TOP-LEVEL secret-shaped keys and copy any object value
 * in whole, un-walked. ONB2's onboarding document explicitly instructs a joining
 * agent to put its adapter secrets INSIDE `agentDefaultsPayload` (`apiKey`,
 * `x-openclaw-token`, …) — a key that matches none of SENSITIVE_KEYS. So the day
 * ONB3 wires the join body and the hook is alive, the whole payload would land in
 * `audit_logs.metadata` in plaintext. It now walks objects and arrays and applies
 * the same key test at EVERY depth, and every surviving string goes through
 * `redactTokensInText` so a token echoed inside free text is scrubbed too.
 */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    const scrubbed = redactTokensInText(value)
    return scrubbed.length > 200 ? scrubbed.slice(0, 200) + '...' : scrubbed
  }
  if (!value || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'

  if (Array.isArray(value)) return value.map(v => sanitizeValue(v, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : sanitizeValue(v, depth + 1)
  }
  return out
}

export function sanitizeBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return sanitizeValue(body, 0) as Record<string, unknown>
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

/**
 * The audit HOOK.
 *
 * ⚠️ ONB2 audit finding H-1: this hook is a NO-OP in production. `app.register()`
 * creates an encapsulated child context, so an `onResponse` hook added in here
 * fires for this plugin's own routes and descendants only — never for its
 * siblings, which is every route in the app. Nothing is persisted today.
 *
 * That is left DELIBERATELY unfixed: hoisting the hook (fastify-plugin, or adding
 * it at the root instance before any register()) switches on one Turso INSERT per
 * request, forever, with no retention policy. That is an OPERATOR cost decision —
 * see docs/AUDIT-ONB2.md H-1 and HANDOFF.md. This PR makes the trail
 * SAFE-TO-ENABLE-BY-CONSTRUCTION (query route gated, body recursively sanitized,
 * path + telemetry URL redacted); it does not enable it.
 */
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
}

/**
 * The audit QUERY route — split out of the hook plugin (ONB2 audit finding H-2).
 *
 * It used to live inside `auditLogPlugin`, which `src/index.ts` registers in the
 * PUBLIC block: the route therefore inherited no Clerk hook and no RBAC, so any
 * caller who knew an `orgId` could read that org's audit log. Only the H-1 bug
 * (empty table) kept it from being a live cross-tenant leak — luck, not design,
 * and it would have gone live the moment someone "just fixed the hook".
 *
 * Register this in the SECURED scope. An audit log is an owner artefact, so it is
 * Clerk + `requireOrgRole('owner')`. `auth-scoping.test.ts` now boots both plugins
 * in `bootLikeIndex()`, so the MCA-85 leak guard covers this route permanently.
 */
export async function auditLogQueryRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/audit-log', { preHandler: requireOrgRole('owner') }, async (req) => {
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
