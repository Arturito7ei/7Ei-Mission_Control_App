import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { clerkPlugin } from '@clerk/fastify'
import { setupDatabase } from './db/setup'
import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, knowledgeRoutes } from './routes/all'

const app = Fastify({ logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' } })

async function start() {
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000', 'http://localhost:8081'],
    credentials: true,
  })
  await app.register(websocket)
  await app.register(clerkPlugin)
  await setupDatabase()
  await app.register(orgRoutes)
  await app.register(agentRoutes)
  await app.register(taskRoutes)
  await app.register(projectRoutes)
  await app.register(costRoutes)
  await app.register(skillRoutes)
  await app.register(knowledgeRoutes)
  app.get('/health', async () => ({ status: 'ok', version: '0.2.0', ts: new Date().toISOString() }))
  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error)
    reply.code(error.statusCode ?? 500).send({ error: error.message ?? 'Internal server error' })
  })
  const port = Number(process.env.PORT) || 3001
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`🚀 7Ei backend → http://localhost:${port}`)
}

start().catch(err => { console.error(err); process.exit(1) })
