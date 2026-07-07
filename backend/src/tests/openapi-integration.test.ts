import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'

// End-to-end guard for the self-describing API (MCA-85 D1): boot every route
// group the way src/index.ts does — including the three onRoute collector hooks —
// then fetch /api/openapi.json and assert it is a rich, correctly-authed spec.
// This is the regression net if someone drops a hook or the route wiring.

import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, authRoutes, credentialRoutes } from '../routes/all'
import { knowledgeRoutes } from '../routes/knowledge'
import { commsRoutes } from '../routes/comms'
import { connectorRoutes } from '../routes/connectors'
import { notificationRoutes } from '../routes/notifications'
import { jiraRoutes } from '../routes/jira'
import { jiraWebhookRoutes } from '../routes/jira-webhook'
import { memoryRoutes } from '../routes/memory'
import { multiOrgRoutes } from '../routes/multi-org'
import { usageRoutes } from '../middleware/ratelimit'
import { modelRoutes } from '../routes/models'
import { scheduledRoutes, routineTriggerRoutes } from '../routes/scheduled'
import { webhookRoutes } from '../routes/webhooks'
import { telegramWebhookRoutes } from '../routes/telegram-webhook'
import { agentApiRoutes } from '../routes/agent-api'
import { recordRoute, collectedRoutes, endpointDocs, buildOpenApiSpec } from '../services/openapi'

test('[MCA-85 D1] /api/openapi.json is a rich, correctly-authed spec', async () => {
  const app = Fastify({ logger: false })
  app.addHook('onRoute', (r) => recordRoute('none', r.method, r.url))
  await app.register(websocket)
  await app.register(multipart)

  await app.register(async (secured) => {
    secured.addHook('onRoute', (r) => recordRoute('clerk', r.method, r.url))
    await secured.register(orgRoutes)
    await secured.register(agentRoutes)
    await secured.register(taskRoutes)
    await secured.register(projectRoutes)
    await secured.register(costRoutes)
    await secured.register(knowledgeRoutes)
    await secured.register(multiOrgRoutes)
    await secured.register(scheduledRoutes)
    await secured.register(credentialRoutes)
    await secured.register(connectorRoutes)
  })

  await app.register(skillRoutes)
  await app.register(commsRoutes)
  await app.register(notificationRoutes)
  await app.register(jiraRoutes)
  await app.register(jiraWebhookRoutes)
  await app.register(memoryRoutes)
  await app.register(usageRoutes)
  await app.register(modelRoutes)
  await app.register(webhookRoutes)
  await app.register(telegramWebhookRoutes)
  await app.register(async (agentScope) => {
    agentScope.addHook('onRoute', (r) => recordRoute('agentToken', r.method, r.url))
    await agentScope.register(agentApiRoutes)
  })
  await app.register(routineTriggerRoutes)
  await app.register(authRoutes)

  app.get('/api/openapi.json', async () => buildOpenApiSpec({
    version: '0.6.0', serverUrl: 'https://7ei-backend.fly.dev',
    routes: collectedRoutes(), docs: endpointDocs(),
  }))

  const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
  await app.close()

  assert.equal(res.statusCode, 200)
  const spec = res.json()

  // A real, versioned OpenAPI 3.1 document with many paths and groups.
  assert.equal(spec.openapi, '3.1.0')
  assert.ok(Object.keys(spec.paths).length > 120, `expected >120 paths, got ${Object.keys(spec.paths).length}`)
  assert.ok(spec.tags.length > 15, `expected >15 tag groups, got ${spec.tags.length}`)

  // Agent-facing route: agentToken security + a Zod-derived request body + summary.
  const heartbeat = spec.paths['/api/agent/heartbeat']?.post
  assert.deepEqual(heartbeat.security, [{ agentToken: [] }])
  assert.ok(heartbeat.requestBody.content['application/json'].schema.properties.status)
  assert.match(heartbeat.summary, /heartbeat/i)

  // The claim route documents its purpose (no body, path param extracted).
  const claim = spec.paths['/api/agent/tasks/{taskId}/claim']?.post
  assert.deepEqual(claim.security, [{ agentToken: [] }])
  assert.ok(claim.parameters.some((p: any) => p.name === 'taskId' && p.in === 'path'))

  // Clerk-protected core route.
  const tasks = spec.paths['/api/orgs/{orgId}/tasks']?.get
  assert.deepEqual(tasks.security, [{ clerkAuth: [] }])

  // Public route: no security.
  assert.deepEqual(spec.paths['/api/openapi.json'].get.security, [])

  // No accidental HEAD/OPTIONS operations leaked in.
  for (const [p, ops] of Object.entries<any>(spec.paths)) {
    for (const method of Object.keys(ops)) {
      assert.ok(!['head', 'options'].includes(method), `${method.toUpperCase()} ${p} should not be in the spec`)
    }
  }
})
