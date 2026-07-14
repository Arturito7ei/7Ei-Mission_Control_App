import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'

// Regression guard for FST_ERR_DUPLICATED_ROUTE and any other boot-time route
// registration error. Unit tests exercise individual plugins in isolation, so a
// path collision BETWEEN two route groups (e.g. taskRoutes vs commsRoutes both
// declaring GET /api/orgs/:orgId/inbox) only surfaces when the whole app boots —
// which previously only happened in prod. This registers every route group the
// way src/index.ts does and asserts the app becomes ready. No DB needed: route
// declaration does not touch the database.

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
import { modelRoutes } from '../routes/models'
import { scheduledRoutes, routineTriggerRoutes } from '../routes/scheduled'
import { webhookRoutes } from '../routes/webhooks'
import { telegramWebhookRoutes } from '../routes/telegram-webhook'
import { arturitaRoutes, arturitaPublicRoutes } from '../routes/arturita'
import { arturitaWalletRoutes } from '../routes/arturita-wallet'
import { customModelRoutes } from '../routes/custom-models'
import { agentInviteRoutes, adapterRegistryRoutes, agentInviteDocRoutes } from '../routes/agent-invites'
import { arturitaVoiceRoutes } from '../routes/arturita-voice'
import { agentApiRoutes } from '../routes/agent-api'

test('app boots: all route groups register without collision', async () => {
  const app = Fastify({ logger: false })
  await app.register(websocket)
  await app.register(multipart)

  // Secured scope (Clerk hook swapped for a no-op — we only test route wiring).
  await app.register(async (secured) => {
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
    await secured.register(arturitaRoutes)
    await secured.register(arturitaWalletRoutes)
    await secured.register(customModelRoutes)
    await secured.register(arturitaVoiceRoutes)
    await secured.register(agentInviteRoutes)
  })

  // Public / externally-called route groups.
  await app.register(commsWebhookRoutes)
  await app.register(jiraWebhookRoutes)
  await app.register(arturitaPublicRoutes)
  await app.register(modelRoutes)
  await app.register(adapterRegistryRoutes)
  await app.register(agentInviteDocRoutes)   // Epic ONB / ONB2 — token-addressed onboarding doc
  await app.register(telegramWebhookRoutes)
  await app.register(agentApiRoutes)
  await app.register(routineTriggerRoutes)
  await app.register(authRoutes)

  await assert.doesNotReject(app.ready(), 'app.ready() must not throw (duplicate route or bad plugin)')
  await app.close()
})
