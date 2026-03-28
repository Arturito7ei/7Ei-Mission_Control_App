import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import websocket from '@fastify/websocket'
import { clerkPlugin } from '@clerk/fastify'
import { setupDatabase } from './db/setup'
import { dbClient, db, schema } from './db/client'
import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, authRoutes, credentialRoutes } from './routes/all'
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
import { auditLogPlugin } from './middleware/audit-log'
import { telemetryPlugin } from './services/telemetry'
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
  await app.register(authRoutes)
  await app.register(credentialRoutes)
  await app.register(telemetryPlugin)
  await app.register(auditLogPlugin)

  // Health + readiness
  const startTime = Date.now()
  const healthResponse = async () => {
    let dbStatus = 'error'
    try { await dbClient.execute('SELECT 1'); dbStatus = 'connected' } catch {}

    const oauthCount = await db.select({ id: schema.oauthTokens.id }).from(schema.oauthTokens).then(r => r.length).catch(() => 0)

    return {
      status: 'ok',
      version: '1.3.0',
      timestamp: new Date().toISOString(),
      uptime: Math.round((Date.now() - startTime) / 1000),
      db: dbStatus,
      scheduler: 'running',
      services: {
        pinecone: !!process.env.PINECONE_API_KEY,
        redis: !!process.env.REDIS_URL,
        googleOAuth: oauthCount,
      },
      features: [
        'anthropic', 'openai', 'gemini',
        'pinecone', 'jira-webhook',
        'memory-compression', 'redis-ratelimit',
        'scheduler', 'orchestration', 'outbound-webhooks',
        'audit-log', 'rbac', 'push-notifications',
      ],
    }
  }
  app.get('/health', async () => healthResponse())
  app.get('/api/health', async () => healthResponse())

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
