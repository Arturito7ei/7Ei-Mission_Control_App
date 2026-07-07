import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { z } from 'zod'
import {
  recordRoute, collectedRoutes, resetOpenApi, documentEndpoint, endpointDocs,
  zodToOpenApiSchema, openApiPath, pathParameters, tagForPath, defaultSummary,
  buildOpenApiSpec,
} from '../services/openapi.ts'

describe('[MCA-85 D1] zodToOpenApiSchema', () => {
  it('converts an object with strings, numbers, enums, optionals, defaults', () => {
    const schema = z.object({
      focus: z.string().min(1).max(2000),
      count: z.number().int().min(0),
      status: z.enum(['green', 'amber', 'stale']).default('green'),
      note: z.string().optional(),
      flag: z.boolean(),
    })
    const out = zodToOpenApiSchema(schema)
    assert.equal(out.type, 'object')
    assert.deepEqual(out.properties.focus, { type: 'string', minLength: 1, maxLength: 2000 })
    assert.deepEqual(out.properties.count, { type: 'integer', minimum: 0 })
    assert.deepEqual(out.properties.status, { type: 'string', enum: ['green', 'amber', 'stale'], default: 'green' })
    assert.deepEqual(out.properties.note, { type: 'string' })
    assert.deepEqual(out.properties.flag, { type: 'boolean' })
    // optional + default fields are not required; the rest are
    assert.deepEqual(out.required, ['focus', 'count', 'flag'])
  })

  it('handles arrays, nullable, email format, and records', () => {
    assert.deepEqual(zodToOpenApiSchema(z.array(z.string())), { type: 'array', items: { type: 'string' } })
    assert.deepEqual(zodToOpenApiSchema(z.string().nullable()), { type: 'string', nullable: true })
    assert.deepEqual(zodToOpenApiSchema(z.string().email()), { type: 'string', format: 'email' })
    assert.deepEqual(zodToOpenApiSchema(z.record(z.number())), { type: 'object', additionalProperties: { type: 'number' } })
  })

  it('collapses a union of literals into an enum', () => {
    assert.deepEqual(zodToOpenApiSchema(z.union([z.literal('a'), z.literal('b')])), { type: 'string', enum: ['a', 'b'] })
  })

  it('degrades unknown constructs to accept-anything instead of throwing', () => {
    assert.deepEqual(zodToOpenApiSchema(z.string().transform(s => s.length) as any), {})
  })
})

describe('[MCA-85 D1] path + tag helpers', () => {
  it('rewrites :params to {params}', () => {
    assert.equal(openApiPath('/api/tasks/:taskId/comments'), '/api/tasks/{taskId}/comments')
    assert.equal(openApiPath('/api/orgs/:orgId/agents/:agentId'), '/api/orgs/{orgId}/agents/{agentId}')
  })
  it('extracts path parameters in order', () => {
    assert.deepEqual(pathParameters('/api/orgs/:orgId/tasks/:taskId'), [
      { name: 'orgId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
    ])
    assert.deepEqual(pathParameters('/api/skills'), [])
  })
  it('tags by the first non-parameter segment after /api', () => {
    assert.equal(tagForPath('/api/orgs/:orgId/tasks'), 'orgs')
    assert.equal(tagForPath('/api/agent/me'), 'agent')
    assert.equal(tagForPath('/api/tasks/:taskId'), 'tasks')
  })
  it('builds a human default summary', () => {
    assert.equal(defaultSummary('GET', '/api/tasks/:taskId'), 'Get taskId')
    assert.equal(defaultSummary('POST', '/api/orgs/:orgId/agents'), 'Create agents')
    assert.equal(defaultSummary('DELETE', '/api/skills/:skillId'), 'Delete skillId')
  })
})

describe('[MCA-85 D1] recordRoute collector', () => {
  beforeEach(() => resetOpenApi())

  it('skips auto HEAD/OPTIONS routes', () => {
    recordRoute('none', 'GET', '/api/health')
    recordRoute('none', 'HEAD', '/api/health')
    recordRoute('none', 'OPTIONS', '/api/health')
    assert.deepEqual(collectedRoutes(), [{ method: 'GET', url: '/api/health', auth: 'none' }])
  })

  it('upgrades auth regardless of hook order (clerk/agentToken beat none)', () => {
    // baseline hook fires first
    recordRoute('none', 'GET', '/api/orgs/:orgId')
    recordRoute('clerk', 'GET', '/api/orgs/:orgId')
    // scoped hook fires first
    recordRoute('agentToken', 'GET', '/api/agent/me')
    recordRoute('none', 'GET', '/api/agent/me')
    const byUrl = Object.fromEntries(collectedRoutes().map(r => [r.url, r.auth]))
    assert.equal(byUrl['/api/orgs/:orgId'], 'clerk')
    assert.equal(byUrl['/api/agent/me'], 'agentToken')
  })

  it('normalises method case and dedupes', () => {
    recordRoute('none', 'post', '/api/x')
    recordRoute('none', 'POST', '/api/x')
    assert.equal(collectedRoutes().length, 1)
    assert.equal(collectedRoutes()[0].method, 'POST')
  })
})

describe('[MCA-85 D1] buildOpenApiSpec', () => {
  beforeEach(() => resetOpenApi())

  it('assembles a valid, deterministic OpenAPI 3.1 document', () => {
    const routes = [
      { method: 'POST', url: '/api/agent/heartbeat', auth: 'agentToken' as const },
      { method: 'GET', url: '/api/orgs/:orgId/tasks', auth: 'clerk' as const },
      { method: 'GET', url: '/api/health', auth: 'none' as const },
    ]
    documentEndpoint('POST', '/api/agent/heartbeat', {
      summary: 'Heartbeat',
      body: z.object({ status: z.enum(['green', 'amber', 'stale']).default('green') }),
    })
    const spec = buildOpenApiSpec({ version: '9.9.9', serverUrl: 'https://x.test', routes, docs: endpointDocs() })

    assert.equal(spec.openapi, '3.1.0')
    assert.equal(spec.info.version, '9.9.9')
    assert.deepEqual(spec.servers, [{ url: 'https://x.test' }])

    // security schemes declared
    assert.equal(spec.components.securitySchemes.clerkAuth.scheme, 'bearer')
    assert.equal(spec.components.securitySchemes.agentToken.type, 'http')

    // agent route: converted path, security, request body from Zod
    const hb = spec.paths['/api/agent/heartbeat'].post
    assert.deepEqual(hb.security, [{ agentToken: [] }])
    assert.equal(hb.summary, 'Heartbeat')
    assert.deepEqual(hb.requestBody.content['application/json'].schema.properties.status,
      { type: 'string', enum: ['green', 'amber', 'stale'], default: 'green' })

    // clerk route: path param extracted, clerk security, default summary
    const tasks = spec.paths['/api/orgs/{orgId}/tasks'].get
    assert.deepEqual(tasks.security, [{ clerkAuth: [] }])
    assert.deepEqual(tasks.parameters, [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }])

    // public route: empty security
    assert.deepEqual(spec.paths['/api/health'].get.security, [])

    // tags sorted + unique
    assert.deepEqual(spec.tags.map((t: any) => t.name), ['agent', 'health', 'orgs'])

    // deterministic
    const again = buildOpenApiSpec({ version: '9.9.9', serverUrl: 'https://x.test', routes, docs: endpointDocs() })
    assert.deepEqual(again, spec)
  })

  it('never emits a request body for GET/DELETE even if one is documented', () => {
    documentEndpoint('GET', '/api/agent/tasks', { summary: 'queue', body: z.object({ x: z.string() }) })
    const spec = buildOpenApiSpec({
      version: '1', routes: [{ method: 'GET', url: '/api/agent/tasks', auth: 'agentToken' }], docs: endpointDocs(),
    })
    assert.equal(spec.paths['/api/agent/tasks'].get.requestBody, undefined)
  })
})

describe('[MCA-85 D1] onRoute wiring (mirrors index.ts)', () => {
  beforeEach(() => resetOpenApi())

  it('the baseline root hook + scoped hooks collect routes with correct auth', async () => {
    const app = Fastify({ logger: false })
    // Baseline: fires for every route (root + descendant scopes).
    app.addHook('onRoute', (r) => recordRoute('none', r.method, r.url))

    // Secured scope → clerk.
    await app.register(async (secured) => {
      secured.addHook('onRoute', (r) => recordRoute('clerk', r.method, r.url))
      secured.get('/api/orgs/:orgId/tasks', async () => ({}))
    })
    // Agent scope → agentToken.
    await app.register(async (agentScope) => {
      agentScope.addHook('onRoute', (r) => recordRoute('agentToken', r.method, r.url))
      agentScope.post('/api/agent/heartbeat', async () => ({}))
    })
    // Public route registered on root → stays none.
    app.get('/api/openapi.json', async () => ({}))

    await app.ready()
    await app.close()

    const byUrl = Object.fromEntries(collectedRoutes().map(r => [`${r.method} ${r.url}`, r.auth]))
    assert.equal(byUrl['GET /api/orgs/:orgId/tasks'], 'clerk')
    assert.equal(byUrl['POST /api/agent/heartbeat'], 'agentToken')
    assert.equal(byUrl['GET /api/openapi.json'], 'none')
    // No HEAD leakage into the collected table.
    assert.ok(!collectedRoutes().some(r => r.method === 'HEAD'))
  })
})
