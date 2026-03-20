import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { clerkPlugin } from '@clerk/fastify'
import { setupDatabase } from './db/setup'
import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes } from './routes/all'
import { knowledgeRoutes } from './routes/knowledge'
import { commsRoutes } from './routes/comms'
import { notificationRoutes } from './routes/notifications'
import { jiraRoutes } from './routes/jira'
import { jiraWebhookRoutes } from './routes/jira-webhook'
import { memoryRoutes } from './routes/memory'
import { multiOrgRoutes } from './routes/multi-org'
import { usageRoutes } from './middleware/ratelimit'
import { modelRoutes } from './routes/models'
import { ensureIndex } from './services/vector-search'

const app = Fastify({ logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' } })

async function start() {
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000', 'http://localhost:8081'],
    credentials: true,
  })
  await app.register(websocket)
  await app.register(clerkPlugin)
  await setupDatabase()
  await ensureIndex()  // Pinecone index (non-blocking if no key)

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

  app.get('/health', async () => ({
    status: 'ok', version: '0.5.0', ts: new Date().toISOString(),
    features: ['anthropic', 'openai', 'gemini', 'pinecone', 'jira-webhook', 'memory-compression', 'redis-ratelimit'],
  }))

  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error)
    reply.code(error.statusCode ?? 500).send({ error: error.message ?? 'Internal server error' })
  })

  const port = Number(process.env.PORT) || 3001
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`\ud83d\ude80 7Ei backend v0.5.0 \u2192 http://localhost:${port}`)
}

start().catch(err => { console.error(err); process.exit(1) })
