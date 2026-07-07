import 'dotenv/config'
import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import { clerkPlugin } from '@clerk/fastify'
import { setupDatabase } from './db/setup'
import { dbClient, db, schema } from './db/client'
import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, authRoutes, credentialRoutes } from './routes/all'
import { knowledgeRoutes } from './routes/knowledge'
import { commsRoutes } from './routes/comms'
import { connectorRoutes } from './routes/connectors'
import { notificationRoutes } from './routes/notifications'
import { jiraRoutes } from './routes/jira'
import { jiraWebhookRoutes } from './routes/jira-webhook'
import { memoryRoutes } from './routes/memory'
import { multiOrgRoutes } from './routes/multi-org'
import { usageRoutes } from './middleware/ratelimit'
import { modelRoutes } from './routes/models'
import { scheduledRoutes, routineTriggerRoutes } from './routes/scheduled'
import { webhookRoutes } from './routes/webhooks'
import { telegramWebhookRoutes } from './routes/telegram-webhook'
import { agentApiRoutes } from './routes/agent-api'
import { ensureIndex } from './services/vector-search'
import { auditLogPlugin } from './middleware/audit-log'
import { clerkAuth } from './middleware/clerk-auth'
import { telemetryPlugin } from './services/telemetry'
import { startScheduler } from './services/scheduler'
import { recordRoute, collectedRoutes, endpointDocs, buildOpenApiSpec } from './services/openapi'

// Keep in sync with package.json "version" — surfaced in /api/openapi.json + /api/health.
const API_VERSION = '0.6.0'

const app = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' },
  trustProxy: true,  // needed behind Fly.io / Railway proxy
})

async function start() {
  // Self-describing API (MCA-85 D1): collect every registered route into the
  // OpenAPI route table. This baseline hook fires for all routes (it is added
  // before any registration and propagates to descendant scopes) and tags them
  // 'none'; scoped hooks below upgrade the auth of secured/agent routes. Auth
  // rank is order-independent, so it doesn't matter which hook fires first.
  app.addHook('onRoute', (r) => recordRoute('none', r.method, r.url))

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
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } })  // 25 MB document uploads
  await app.register(clerkPlugin)
  await setupDatabase()
  await ensureIndex()  // Pinecone (non-blocking)

  // ─── Protected routes (MCA-14) ──────────────────────────────────────────
  // Every route in this encapsulated scope requires a valid Clerk JWT. The
  // onRequest hook attaches req.userId / req.clerkSession (and req.auth for
  // rbac/audit/telemetry compat) or replies 401. OPTIONS preflight is skipped.
  await app.register(async (secured) => {
    secured.addHook('onRequest', clerkAuth)
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

  // ─── Public / externally-called routes ──────────────────────────────────
  // Webhooks (Jira/Telegram), the Google OAuth redirect callback, and the
  // skill library are invoked without a Clerk session JWT, so they stay open.
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
  // Agent-facing API (MCA-EXT): external runtimes authenticate with an agent
  // token via this plugin's own onRequest hook, not Clerk. Wrapped in a scope
  // so an onRoute hook can tag these routes with the agentToken security scheme.
  await app.register(async (agentScope) => {
    agentScope.addHook('onRoute', (r) => recordRoute('agentToken', r.method, r.url))
    await agentScope.register(agentApiRoutes)
  })
  // Public routine webhook/API trigger (MCA-PC C3) — token-authenticated by URL.
  await app.register(routineTriggerRoutes)
  await app.register(authRoutes)
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

  // Self-describing API (MCA-85 D1) — the live route table + Zod request bodies
  // as an OpenAPI 3.1 doc. Public: agents/tools fetch it to self-configure.
  app.get('/api/openapi.json', async () => buildOpenApiSpec({
    version: API_VERSION,
    serverUrl: process.env.PUBLIC_URL || 'https://7ei-backend.fly.dev',
    routes: collectedRoutes(),
    docs: endpointDocs(),
  }))

  app.get('/ready', async (_req, reply) => {
    // Could check DB connectivity here
    reply.code(200).send({ ready: true })
  })

  app.setErrorHandler((error: FastifyError, _req, reply) => {
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
