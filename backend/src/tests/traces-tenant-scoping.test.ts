// Epic ONB — RE-AUDIT of the #248 hardening (docs/AUDIT-ONB2-hardening.md, R-1).
//
// #248 closed ONB2-audit H-2 by moving `GET /api/traces` out of the public block
// and into the secured scope. That narrowed the route from *public* to *any
// authenticated Clerk user* — but `spans` in services/telemetry.ts is ONE
// process-wide buffer shared by every tenant on the machine, and the span carries
// `org.id`, `user.id` and the request path. So a user of org A could still read
// org B's span metadata. Narrowing is not isolation.
//
// These tests lock the isolation:
//   R-1a  the tenant-blind `GET /api/traces` no longer exists at all
//   R-1b  the route is `:orgId`-scoped, owner-gated, and 401s without a session
//   R-1c  a span is returned ONLY to the org it is attributed to; an UNATTRIBUTED
//         span (no `org.id`) is returned to nobody
//
// Why the path had to change rather than just gaining a preHandler: `requireOrgRole`
// skips every check when the request has no `:orgId` param (middleware/rbac.ts) —
// so `requireOrgRole('owner')` on a bare `/api/traces` would have been a NO-OP gate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { telemetryQueryRoutes, getSpansForOrg, createSpan, endSpan } from '../services/telemetry'
import { createClerkAuth } from '../middleware/clerk-auth'

/** Push a finished SERVER span into the module-level buffer, as the hook does. */
function recordSpan(orgId: string | undefined, userId: string, path: string) {
  const span = createSpan(`GET ${path}`, 'SERVER')
  span.attributes['http.url'] = path
  span.attributes['user.id'] = userId
  if (orgId !== undefined) span.attributes['org.id'] = orgId
  endSpan(span, 'OK')
}

test('[ONB2-R1] a span is only visible to the org it is attributed to', () => {
  const orgA = `org-a-${randomTag()}`
  const orgB = `org-b-${randomTag()}`

  recordSpan(orgA, 'user-a', '/api/orgs/a/agents')
  recordSpan(orgB, 'user-b', '/api/orgs/b/agents')

  const seenByA = getSpansForOrg(orgA, 50)
  const serialized = JSON.stringify(seenByA)

  assert.ok(seenByA.length >= 1, 'org A must see its own span')
  assert.ok(
    seenByA.every(s => s.attributes['org.id'] === orgA),
    'a span belonging to another org was served to org A',
  )
  assert.ok(!serialized.includes(orgB), "org B's org id leaked into org A's traces")
  assert.ok(!serialized.includes('user-b'), "org B's user id leaked into org A's traces")
  assert.ok(!serialized.includes('/api/orgs/b/agents'), "org B's request path leaked into org A's traces")
})

test('[ONB2-R1] an UNATTRIBUTED span is served to nobody', () => {
  // `llm.call` spans (services/llm-router.ts) carry no org id — LLMStreamOpts has
  // none to give. An unattributed span cannot be shown to one tenant without
  // risking showing them another's, so it is shown to none. Under-reporting is the
  // correct direction to fail; attributing those spans is the noted follow-up.
  const orgA = `org-a-${randomTag()}`
  recordSpan(orgA, 'user-a', '/api/orgs/a/agents')

  const unattributed = createSpan('llm.call', 'CLIENT')
  unattributed.attributes['llm.provider'] = 'anthropic'
  unattributed.attributes['llm.model'] = 'secret-model-name'
  endSpan(unattributed, 'OK')

  const seen = getSpansForOrg(orgA, 50)
  assert.ok(
    !JSON.stringify(seen).includes('secret-model-name'),
    'an unattributed span was served to a tenant',
  )
  // …and an empty/absent org id must not act as a wildcard that matches everything.
  assert.deepEqual(getSpansForOrg('', 50), [], 'an empty orgId must return nothing, not the whole buffer')
})

test('[ONB2-R1] GET /api/orgs/:orgId/traces is not reachable without a session', async () => {
  const app = Fastify({ logger: false })
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async () => { throw new Error('no session') }))
    await secured.register(telemetryQueryRoutes)
  })
  await app.ready()

  const res = await app.inject({ method: 'GET', url: '/api/orgs/other-tenant/traces' })
  assert.equal(res.statusCode, 401, "an unauthenticated caller must not read another org's spans")
  await app.close()
})

test('[ONB2-R1] the tenant-blind GET /api/traces is gone, not merely re-registered', async () => {
  const app = Fastify({ logger: false })
  await app.register(telemetryQueryRoutes)
  await app.ready()
  const routes = app.printRoutes({ commonPrefix: false })
  await app.close()

  assert.ok(routes.includes('/api/orgs/:orgId/traces'), 'the org-scoped traces route must exist')
  assert.ok(
    !/\/api\/traces\b/.test(routes),
    'GET /api/traces is back — with no :orgId, requireOrgRole silently skips and the gate is a no-op',
  )
})

let tag = 0
function randomTag() {
  return `${Date.now()}-${tag++}`
}
