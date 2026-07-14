// ─── Lightweight Telemetry Service ──────────────────────────────────────────
// Follows OpenTelemetry semantic conventions for spans.
// Outputs structured JSON to console in dev.
// Ready to connect to Jaeger/OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set.
// No external dependencies — uses built-in Node.js APIs only.

import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { redactPath } from './log-redaction'

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
 * The trace QUERY route — split out of the hook plugin (ONB2 audit finding H-2).
 *
 * `GET /api/traces` served real spans (path, provider, model, duration, org id,
 * user id) to ANY unauthenticated caller, because `telemetryPlugin` is registered
 * in the public block of `src/index.ts`. Register this in the SECURED scope so it
 * requires a Clerk session. It is not org-scoped (spans are process-wide), so
 * there is no `:orgId` to hang `requireOrgRole` on — Clerk is the gate.
 */
export async function telemetryQueryRoutes(app: FastifyInstance) {
  app.get('/api/traces', async (req) => {
    const { limit = '50' } = req.query as any
    return { spans: getRecentSpans(Number(limit)) }
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
