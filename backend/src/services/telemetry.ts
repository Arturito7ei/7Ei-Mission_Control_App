// ─── Lightweight Telemetry Service ──────────────────────────────────────────
// Follows OpenTelemetry semantic conventions for spans.
// Outputs structured JSON to console in dev.
// Ready to connect to Jaeger/OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set.
// No external dependencies — uses built-in Node.js APIs only.

import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { redactPath } from './log-redaction'
import { requireOrgRole } from '../middleware/rbac'

export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'SERVER' | 'CLIENT' | 'INTERNAL'
  startTime: number
  endTime?: number
  durationMs?: number
  attributes: Record<string, string | number | boolean>
  status: 'OK' | 'ERROR' | 'UNSET'
}

const spans: Span[] = []
const MAX_SPANS = 1000

export function createSpan(name: string, kind: Span['kind'] = 'INTERNAL', parentSpanId?: string): Span {
  const span: Span = {
    traceId: randomUUID().replace(/-/g, '').slice(0, 32),
    spanId: randomUUID().replace(/-/g, '').slice(0, 16),
    parentSpanId,
    name,
    kind,
    startTime: Date.now(),
    attributes: {},
    status: 'UNSET',
  }
  return span
}

export function endSpan(span: Span, status: Span['status'] = 'OK') {
  span.endTime = Date.now()
  span.durationMs = span.endTime - span.startTime
  span.status = status

  spans.push(span)
  if (spans.length > MAX_SPANS) spans.shift()

  // Structured log output (compatible with OTEL JSON format)
  if (process.env.NODE_ENV !== 'test') {
    console.log(JSON.stringify({
      _otel: true,
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      kind: span.kind,
      durationMs: span.durationMs,
      status: span.status,
      attributes: span.attributes,
    }))
  }
}

export function getRecentSpans(limit = 50): Span[] {
  return spans.slice(-limit).reverse()
}

/**
 * The spans ATTRIBUTABLE TO ONE ORG.
 *
 * `spans` is a single process-wide buffer shared by every tenant on the machine,
 * so `getRecentSpans` is not a safe thing to serve to a tenant — see
 * `telemetryQueryRoutes`. A span belongs to an org only if the org id was written
 * onto it (`org.id`, set from the route's `:orgId` param by the `onResponse` hook).
 *
 * A span with no `org.id` is UNATTRIBUTED and is returned to nobody. That is the
 * whole point: an unattributed span cannot be shown to one tenant without risking
 * showing them another's. Today `llm.call` spans (`services/llm-router.ts`) are
 * unattributed — `LLMStreamOpts` carries no org id — so they are excluded. Giving
 * them one is the follow-up that restores this endpoint's usefulness; until then
 * it under-reports, which is the correct direction to fail.
 */
export function getSpansForOrg(orgId: string, limit = 50): Span[] {
  if (!orgId) return []
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_SPANS)
  return spans.filter(s => s.attributes['org.id'] === orgId).slice(-n).reverse()
}

/**
 * Fastify plugin — creates a span per HTTP request.
 *
 * ⚠️ Like `auditLogPlugin`, this hook is a NO-OP in production (ONB2 audit H-1):
 * it is added inside an encapsulated `register()` child, so it never fires for the
 * plugin's siblings — i.e. for any route in the app. Hoisting it is an operator
 * decision (see docs/AUDIT-ONB2.md); this PR only makes it safe to hoist.
 *
 * ONB2 audit M-1: the span used to carry the RAW `req.url`. Invite tokens are
 * bearer credentials in the path, and these spans were served by a public
 * `GET /api/traces` — so the same `redactPath` helper the audit row and the
 * request logger use is applied here. One helper, every sink, no drift.
 */
export async function telemetryPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    const path = redactPath(req.url)
    const span = createSpan(`${req.method} ${path}`, 'SERVER')
    span.attributes['http.method'] = req.method
    span.attributes['http.url'] = path
    span.attributes['http.route'] = path
    ;(req as any)._telemetrySpan = span
  })

  app.addHook('onResponse', async (req, reply) => {
    const span = (req as any)._telemetrySpan as Span | undefined
    if (!span) return
    span.attributes['http.status_code'] = reply.statusCode
    span.attributes['http.duration_ms'] = Math.round(reply.elapsedTime)
    span.attributes['org.id'] = (req.params as any)?.orgId ?? ''
    span.attributes['user.id'] = (req as any).auth?.userId ?? ''
    endSpan(span, reply.statusCode >= 400 ? 'ERROR' : 'OK')
  })
}

/**
 * The trace QUERY route — `GET /api/orgs/:orgId/traces`.
 *
 * History, because the shape of this route is the fix:
 *
 * 1. It was `GET /api/traces`, registered INSIDE `telemetryPlugin`, which lives in
 *    the PUBLIC block of `src/index.ts` — so it served real spans to any
 *    unauthenticated caller (ONB2 audit H-2).
 * 2. PR #248 moved it into the SECURED scope. That narrowed it from *public* to
 *    *any authenticated Clerk user* — but `spans` is one process-wide buffer shared
 *    by every tenant, so an authenticated user of org A could still read org B's
 *    span metadata (paths, org ids, user ids, providers, models, timings). A
 *    narrowing, not an isolation.
 * 3. This route is now ORG-SCOPED and owner-gated, and returns only the spans
 *    attributable to that org (`getSpansForOrg`).
 *
 * Why the path had to change, rather than just adding a preHandler: `requireOrgRole`
 * reads the org from `req.params.orgId` and **returns without checking anything** if
 * there is none (`middleware/rbac.ts` — "No org context — skip RBAC"). Hanging
 * `requireOrgRole('owner')` on a path with no `:orgId` is a NO-OP — a gate that
 * looks like one and is not. An `:orgId` in the path is what makes the gate real.
 *
 * It also puts the route inside the MCA-85 leak guard's net for good: that guard
 * only inspects routes matching `:orgId|:agentId`, so a bare `/api/traces` serving
 * cross-tenant data was invisible to it by construction and could only ever be
 * caught by a hand-written spot-check.
 */
export async function telemetryQueryRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/traces', { preHandler: requireOrgRole('owner') }, async (req) => {
    const { orgId } = req.params as any
    const { limit = '50' } = req.query as any
    return { spans: getSpansForOrg(orgId, Number(limit)) }
  })
}

// Wrap an async function with a span
export async function withSpan<T>(name: string, attributes: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
  const span = createSpan(name, 'CLIENT')
  Object.assign(span.attributes, attributes)
  try {
    const result = await fn()
    endSpan(span, 'OK')
    return result
  } catch (err) {
    span.attributes['error.message'] = (err as Error).message
    endSpan(span, 'ERROR')
    throw err
  }
}
