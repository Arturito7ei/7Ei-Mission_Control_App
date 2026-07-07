// OpenAPI 3.1 generation (MCA-85 D1) — a *self-describing* API.
//
// The route list is collected live from Fastify's `onRoute` hook (see index.ts),
// so it can never drift from the real server the way a hand-maintained doc
// (docs/API.md) does — every registered path is in the spec. Request bodies are
// enriched from the actual Zod validators via `documentEndpoint()`, which route
// files call at registration (routes → services is the allowed import direction;
// a service must NOT import route files, so routes push their schema in).
//
// Pure helpers below (`buildOpenApiSpec`, `zodToOpenApiSchema`, `tagForPath`, …)
// are IO-free and unit-tested; the module-level collector is the only state.

import { z } from 'zod'

// ─── Route collection ───────────────────────────────────────────────────────

export type RouteAuth = 'none' | 'agentToken' | 'clerk'

export interface CollectedRoute {
  method: string
  url: string
  auth: RouteAuth
}

// clerk / agentToken always win over the baseline 'none' regardless of the order
// the onRoute hooks fire (root baseline vs. scoped auth hook) — makes recording
// order-independent.
const AUTH_RANK: Record<RouteAuth, number> = { none: 0, agentToken: 1, clerk: 1 }
const SKIP_METHODS = new Set(['HEAD', 'OPTIONS'])

const routes = new Map<string, CollectedRoute>()

/** Record a route seen by an onRoute hook. Auto HEAD/OPTIONS are skipped; the
 *  highest-ranked auth wins so the baseline hook and scoped auth hooks compose. */
export function recordRoute(auth: RouteAuth, method: string | string[], url: string): void {
  const methods = Array.isArray(method) ? method : [method]
  for (const raw of methods) {
    const m = raw.toUpperCase()
    if (SKIP_METHODS.has(m)) continue
    const key = `${m} ${url}`
    const existing = routes.get(key)
    if (!existing || AUTH_RANK[auth] > AUTH_RANK[existing.auth]) {
      routes.set(key, { method: m, url, auth })
    }
  }
}

export function collectedRoutes(): CollectedRoute[] {
  return [...routes.values()]
}

/** Test-only: clear collected routes + docs so a suite starts from a clean slate. */
export function resetOpenApi(): void {
  routes.clear()
  docs.clear()
}

// ─── Endpoint enrichment (summaries + request bodies) ───────────────────────

export interface EndpointDoc {
  summary?: string
  body?: z.ZodTypeAny
  tag?: string
}

const docs = new Map<string, EndpointDoc>()

/** Attach a human summary and/or a Zod request-body schema to a route so the
 *  spec documents its shape. Called from route modules (allowed import way). */
export function documentEndpoint(method: string, url: string, doc: EndpointDoc): void {
  docs.set(`${method.toUpperCase()} ${url}`, doc)
}

export function endpointDocs(): Map<string, EndpointDoc> {
  return docs
}

// ─── Zod → JSON Schema (the subset our validators use) ──────────────────────

export type JsonSchema = Record<string, any>

/** Minimal Zod→JSON-Schema converter covering the constructs our route
 *  validators use. Unknown types degrade to `{}` (accept-anything) rather than
 *  throwing — a spec that omits a constraint beats a 500 on /api/openapi.json. */
export function zodToOpenApiSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional) return zodToOpenApiSchema(schema.unwrap())
  if (schema instanceof z.ZodNullable) {
    const inner = zodToOpenApiSchema(schema.unwrap())
    return { ...inner, nullable: true }
  }
  if (schema instanceof z.ZodDefault) {
    const inner = zodToOpenApiSchema(schema._def.innerType)
    return { ...inner, default: schema._def.defaultValue() }
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const properties: JsonSchema = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToOpenApiSchema(value)
      if (!value.isOptional()) required.push(key)
    }
    const out: JsonSchema = { type: 'object', properties }
    if (required.length) out.required = required
    return out
  }

  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: 'string' }
    for (const check of schema._def.checks ?? []) {
      if (check.kind === 'min') out.minLength = check.value
      else if (check.kind === 'max') out.maxLength = check.value
      else if (check.kind === 'email') out.format = 'email'
      else if (check.kind === 'url') out.format = 'uri'
      else if (check.kind === 'uuid') out.format = 'uuid'
    }
    return out
  }

  if (schema instanceof z.ZodNumber) {
    const out: JsonSchema = { type: schema._def.checks?.some(c => c.kind === 'int') ? 'integer' : 'number' }
    for (const check of schema._def.checks ?? []) {
      if (check.kind === 'min') out.minimum = check.value
      else if (check.kind === 'max') out.maximum = check.value
    }
    return out
  }

  if (schema instanceof z.ZodBoolean) return { type: 'boolean' }
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...schema._def.values] }
  if (schema instanceof z.ZodNativeEnum) return { enum: Object.values(schema._def.values) }
  if (schema instanceof z.ZodLiteral) {
    return { type: typeof schema._def.value === 'number' ? 'number' : typeof schema._def.value === 'boolean' ? 'boolean' : 'string', enum: [schema._def.value] }
  }
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToOpenApiSchema(schema._def.type) }
  if (schema instanceof z.ZodRecord) return { type: 'object', additionalProperties: zodToOpenApiSchema(schema._def.valueType) }
  if (schema instanceof z.ZodUnion) {
    const options = (schema._def.options as z.ZodTypeAny[]).map(zodToOpenApiSchema)
    // A union of literals collapses to a single enum — cleaner in the spec.
    if (options.every(o => Array.isArray(o.enum) && o.enum.length === 1)) {
      return { type: options[0].type, enum: options.map(o => o.enum[0]) }
    }
    return { anyOf: options }
  }

  return {} // unknown / effects / lazy → accept anything
}

// ─── Path + tag helpers ─────────────────────────────────────────────────────

/** Fastify `/api/tasks/:taskId` → OpenAPI `/api/tasks/{taskId}`. */
export function openApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

/** Path parameters extracted from a Fastify URL pattern, in order. */
export function pathParameters(url: string): JsonSchema[] {
  return [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))
}

/** Group tag = first non-versioned, non-parameter path segment after /api. */
export function tagForPath(url: string): string {
  const segments = url.split('/').filter(Boolean)
  const start = segments[0] === 'api' ? 1 : 0
  for (let i = start; i < segments.length; i++) {
    if (!segments[i].startsWith(':')) return segments[i]
  }
  return 'misc'
}

const METHOD_VERBS: Record<string, string> = { GET: 'Get', POST: 'Create', PATCH: 'Update', PUT: 'Replace', DELETE: 'Delete' }

/** Fallback summary when a route didn't register an explicit one. */
export function defaultSummary(method: string, url: string): string {
  const verb = METHOD_VERBS[method.toUpperCase()] ?? method.toUpperCase()
  const tail = url.split('/').filter(Boolean).slice(-1)[0] ?? url
  const noun = tail.startsWith(':') ? tail.slice(1) : tail
  return `${verb} ${noun}`
}

function operationId(method: string, url: string): string {
  const slug = url.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `${method.toLowerCase()}_${slug}`
}

function securityFor(auth: RouteAuth): JsonSchema[] {
  if (auth === 'clerk') return [{ clerkAuth: [] }]
  if (auth === 'agentToken') return [{ agentToken: [] }]
  return []
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete']

// ─── Spec assembly ──────────────────────────────────────────────────────────

export interface BuildSpecOptions {
  version: string
  serverUrl?: string
  routes: CollectedRoute[]
  docs?: Map<string, EndpointDoc>
}

/** Assemble a complete OpenAPI 3.1 document from the collected route table and
 *  per-endpoint enrichment. Pure: same inputs → identical (sorted) output. */
export function buildOpenApiSpec(opts: BuildSpecOptions): JsonSchema {
  const { version, serverUrl, routes, docs = new Map<string, EndpointDoc>() } = opts

  const paths: JsonSchema = {}
  const tagSet = new Set<string>()

  const sorted = [...routes].sort((a, b) =>
    a.url === b.url
      ? METHOD_ORDER.indexOf(a.method.toLowerCase()) - METHOD_ORDER.indexOf(b.method.toLowerCase())
      : a.url.localeCompare(b.url))

  for (const route of sorted) {
    const doc = docs.get(`${route.method} ${route.url}`)
    const tag = doc?.tag ?? tagForPath(route.url)
    tagSet.add(tag)

    const oaPath = openApiPath(route.url)
    paths[oaPath] ??= {}

    const operation: JsonSchema = {
      tags: [tag],
      summary: doc?.summary ?? defaultSummary(route.method, route.url),
      operationId: operationId(route.method, route.url),
      security: securityFor(route.auth),
      responses: { '200': { description: 'Success' } },
    }
    const params = pathParameters(route.url)
    if (params.length) operation.parameters = params
    if (doc?.body && route.method !== 'GET' && route.method !== 'DELETE') {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: zodToOpenApiSchema(doc.body) } },
      }
    }
    paths[oaPath][route.method.toLowerCase()] = operation
  }

  const spec: JsonSchema = {
    openapi: '3.1.0',
    info: {
      title: '7Ei Mission Control API',
      version,
      description:
        'Self-describing API for the 7Ei Mission Control agent virtual-office control plane. ' +
        'Generated live from the route table + Zod validators — see GET /api/openapi.json.',
    },
    servers: [{ url: serverUrl ?? 'https://7ei-backend.fly.dev' }],
    tags: [...tagSet].sort().map(name => ({ name })),
    components: {
      securitySchemes: {
        clerkAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Clerk session JWT — web → backend. Sent as Authorization: Bearer <jwt>.',
        },
        agentToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Long-lived agent token (mca_…) for external runtimes. Authorization: Bearer <token>.',
        },
      },
    },
    paths,
  }
  return spec
}
