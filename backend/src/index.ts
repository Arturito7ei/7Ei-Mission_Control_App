import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import websocket from '@fastify/websocket'
import { clerkPlugin } from '@clerk/fastify'
import { setupDatabase } from './db/setup'
import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, credentialRoutes, authRoutes } from './routes/all'
import { knowledgeRoutes } from './routes/knowledge'
import { commsRoutes } from './routes/comms'
import { notificationRoutes } from './routes/notifications'
import { jiraRoutes } from './routes/jira'
import { jiraWebhookRoutes } from './routes/jira-webhook'
import { memoryRoutes } from './routes/memory'
import { multiOrgRoutes } from './routes/multi-org'
import { usageRoutes } from './middleware/ratelimit'
import { modelRoutes } from './routes/models'
import { scheduledRoutes } from './routes/scheduled'
import { webhookRoutes } from './routes/webhooks'
import { ensureIndex } from './services/vector-search'
import { startScheduler } from './services/scheduler'

const app = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' },
  trustProxy: true,  // needed behind Fly.io / Railway proxy
})

async function start() {
  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: false,  // API — no CSP needed
    crossOriginEmbedderPolicy: false,
  })

  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [
      'http://localhost:3000',
      'http://localhost:8081',
      'https://7ei.ai',
      'https://app.7ei.ai',
    ],
    credentials: true,
  })

  await app.register(websocket)
  await app.register(clerkPlugin)
  await setupDatabase()
  await ensureIndex()  // Pinecone (non-blocking)

  // Routes
  await app.register(orgRoutes)
  await app.register(agentRoutes)
  await app.register(taskRoutes)
  await app.register(projectRoutes)
  await app.register(costRoutes)
  await app.register(skillRoutes)
  await app.register(knowledgeRoutes)
  await app.register(commsRoutes)
  await app.register(notificationRoutes)
  await app.register(jiraRoutes)
  await app.register(jiraWebhookRoutes)
  await app.register(memoryRoutes)
  await app.register(multiOrgRoutes)
  await app.register(usageRoutes)
  await app.register(modelRoutes)
  await app.register(scheduledRoutes)
  await app.register(webhookRoutes)
  await app.register(credentialRoutes)
  await app.register(authRoutes)

  // Health + readiness
  app.get('/health', async () => ({
    status: 'ok',
    version: '0.6.0',
    ts: new Date().toISOString(),
    features: [
      'anthropic', 'openai', 'gemini',
      'pinecone', 'jira-webhook',
      'memory-compression', 'redis-ratelimit',
      'scheduler', 'orchestration', 'outbound-webhooks',
    ],
  }))

  app.get('/ready', async (_req, reply) => {
    // Could check DB connectivity here
    reply.code(200).send({ ready: true })
  })

  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error)
    reply.code(error.statusCode ?? 500).send({ error: error.message ?? 'Internal server error' })
  })

  const port = Number(process.env.PORT) || 3001
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`\ud83d\ude80 7Ei backend v0.6.0 \u2192 http://localhost:${port}`)

  // Start cron scheduler after server is up
  startScheduler()
}

start().catch(err => { console.error(err); process.exit(1) })
