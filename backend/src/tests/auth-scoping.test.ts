import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'

// ─── Auth-scoping lock-down (MCA-85 hardening) ───────────────────────────────
//
// D1's /api/openapi.json surfaced that several org/agent-scoped route groups
// (jira, gmail/comms, notifications, memory, webhooks, usage, skills) were
// registered in the PUBLIC scope — reachable with no Clerk session. This suite
// is the regression net so tenant data never silently becomes public again:
//
//  1. Boot every route group the way src/index.ts does (with the three
//     recordRoute onRoute hooks) and assert the collected route table tags every
//     tenant-scoped path (`:orgId` / `:agentId`) as authenticated — Clerk or the
//     agent token — except a small, explicit public allowlist (webhook receivers
//     + the Google OAuth handshake).
//  2. Prove the secured scope actually enforces: an unauthenticated request to a
//     moved route returns 401, while a public webhook receiver is not gated.

import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, authRoutes, credentialRoutes } from '../routes/all'
import { knowledgeRoutes } from '../routes/knowledge'
import { commsRoutes, commsWebhookRoutes } from '../routes/comms'
import { connectorRoutes } from '../routes/connectors'
import { notificationRoutes } from '../routes/notifications'
import { jiraRoutes } from '../routes/jira'
import { jiraWebhookRoutes, jiraEventRoutes } from '../routes/jira-webhook'
import { memoryRoutes } from '../routes/memory'
import { multiOrgRoutes } from '../routes/multi-org'
import { usageRoutes } from '../middleware/ratelimit'
import { scheduledRoutes, routineTriggerRoutes } from '../routes/scheduled'
import { webhookRoutes } from '../routes/webhooks'
import { telegramWebhookRoutes } from '../routes/telegram-webhook'
import { agentApiRoutes } from '../routes/agent-api'
import { recordRoute, collectedRoutes, resetOpenApi } from '../services/openapi'
import { createClerkAuth } from '../middleware/clerk-auth'

// Tenant-scoped routes that are intentionally reachable without a Clerk session.
// Keep this list SHORT and justified — every entry is an external caller that
// cannot present a user session: an inbound webhook receiver, or a step of the
// Google OAuth redirect handshake. `${METHOD} ${url}` (Fastify path syntax).
const PUBLIC_TENANT_ALLOWLIST = new Set([
  'POST /api/jira/webhook/:orgId',       // Jira posts issue events here
  'POST /api/telegram/webhook/:orgId',   // Telegram posts updates here
  'GET /api/orgs/:orgId/auth/google',    // returns the Google consent URL
  'GET /api/orgs/:orgId/auth/google/status', // connection status for the OAuth UI
])

// Mirror src/index.ts wiring: baseline 'none' hook for all routes, a Clerk-tagged
// secured scope, and an agentToken-tagged scope around the agent API.
async function bootLikeIndex() {
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
    await secured.register(jiraRoutes)
    await secured.register(jiraEventRoutes)
    await secured.register(commsRoutes)
    await secured.register(notificationRoutes)
    await secured.register(memoryRoutes)
    await secured.register(webhookRoutes)
    await secured.register(usageRoutes)
    await secured.register(skillRoutes)
  })

  await app.register(commsWebhookRoutes)
  await app.register(jiraWebhookRoutes)
  await app.register(async (agentScope) => {
    agentScope.addHook('onRoute', (r) => recordRoute('agentToken', r.method, r.url))
    await agentScope.register(agentApiRoutes)
  })
  await app.register(routineTriggerRoutes)
  await app.register(authRoutes)

  await app.ready()
  return app
}

test('[MCA-85] no tenant-scoped route is publicly reachable outside the allowlist', async () => {
  resetOpenApi()
  const app = await bootLikeIndex()
  await app.close()

  const tenantScoped = collectedRoutes().filter(r => /:orgId|:agentId/.test(r.url))
  assert.ok(tenantScoped.length > 20, `expected many tenant-scoped routes, got ${tenantScoped.length}`)

  const leaks = tenantScoped.filter(r =>
    r.auth === 'none' && !PUBLIC_TENANT_ALLOWLIST.has(`${r.method} ${r.url}`))

  assert.deepEqual(
    leaks.map(r => `${r.method} ${r.url}`),
    [],
    'these tenant-scoped routes are public but not in the allowlist — put them behind the secured scope or justify + allowlist them',
  )

  // Guard the guard: every allowlisted route must still exist (so a renamed or
  // deleted receiver can't leave a stale exemption that hides a real leak).
  const present = new Set(collectedRoutes().map(r => `${r.method} ${r.url}`))
  for (const entry of PUBLIC_TENANT_ALLOWLIST) {
    assert.ok(present.has(entry), `allowlist entry no longer exists — prune it: ${entry}`)
  }

  // Spot-check the specific groups this hardening moved.
  const secured = (method: string, url: string) => {
    const r = collectedRoutes().find(x => x.method === method && x.url === url)
    assert.ok(r, `route missing: ${method} ${url}`)
    assert.equal(r!.auth, 'clerk', `${method} ${url} must be Clerk-secured, got '${r!.auth}'`)
  }
  secured('GET', '/api/orgs/:orgId/jira/issues')
  secured('GET', '/api/orgs/:orgId/jira/events')
  secured('GET', '/api/orgs/:orgId/gmail/threads')
  secured('POST', '/api/orgs/:orgId/gmail/send')
  secured('GET', '/api/orgs/:orgId/comms/inbox')
  secured('POST', '/api/orgs/:orgId/meet/create')
  secured('GET', '/api/orgs/:orgId/notifications')
  secured('GET', '/api/agents/:agentId/memory')
  secured('DELETE', '/api/agents/:agentId/memory')
  secured('POST', '/api/orgs/:orgId/webhooks')
  secured('GET', '/api/orgs/:orgId/usage')
})

test('[MCA-85] secured scope enforces 401; public webhook receiver is not gated', async () => {
  const app = Fastify({ logger: false })
  // Real Clerk hook, but with a verifier that always rejects — stands in for an
  // invalid/absent session without reaching Clerk's network JWKS.
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async () => { throw new Error('no session') }))
    await secured.register(jiraRoutes)
    await secured.register(skillRoutes)
  })
  await app.register(commsWebhookRoutes)
  await app.ready()

  // Moved route, no Authorization header → 401 before the handler runs.
  const noAuth = await app.inject({ method: 'GET', url: '/api/orgs/o1/jira/status' })
  assert.equal(noAuth.statusCode, 401, 'jira status must reject unauthenticated callers')

  // Moved route, garbage token → verifier throws → 401.
  const badToken = await app.inject({
    method: 'GET', url: '/api/skills',
    headers: { authorization: 'Bearer not.a.jwt' },
  })
  assert.equal(badToken.statusCode, 401, 'skills must reject an invalid token')

  // Public receiver: an empty Telegram update short-circuits before any DB call,
  // so a 200 here proves it is reachable with no session (not auth-gated).
  const receiver = await app.inject({
    method: 'POST', url: '/api/telegram/webhook/o1',
    payload: {}, headers: { 'content-type': 'application/json' },
  })
  assert.equal(receiver.statusCode, 200, 'telegram webhook receiver must stay public')
  assert.deepEqual(receiver.json(), { ok: true })

  await app.close()
})
