import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { clerkPlugin } from '@clerk/fastify'
import 'dotenv/config'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
await app.register(websocket)
await app.register(clerkPlugin)

// Health check
app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }))

// Route stubs — Sprint 1+
app.get('/api/orgs', async () => ({ orgs: [] }))
app.get('/api/agents', async () => ({ agents: [] }))
app.get('/api/tasks', async () => ({ tasks: [] }))

const port = Number(process.env.PORT) || 3001
app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
