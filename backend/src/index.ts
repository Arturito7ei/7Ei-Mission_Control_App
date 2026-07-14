import 'dotenv/config'
import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import { corsOptions } from './middleware/cors'
import { registerJsonBodyParser } from './middleware/body-parser'
import helmet from '@fastify/helmet'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import { clerkPlugin } from '@clerk/fastify'
import { setupDatabase } from './db/setup'
import { dbClient, db, schema } from './db/client'
import { orgRoutes, agentRoutes, taskRoutes, projectRoutes, costRoutes, skillRoutes, authRoutes, credentialRoutes } from './routes/all'
import { knowledgeRoutes } from './routes/knowledge'
import { commsRoutes, commsWebhookRoutes } from './routes/comms'
import { connectorRoutes } from './routes/connectors'
import { notificationRoutes } from './routes/notifications'
import { jiraRoutes } from './routes/jira'
import { jiraWebhookRoutes, jiraEventRoutes } from './routes/jira-webhook'
import { memoryRoutes } from './routes/memory'
import { multiOrgRoutes } from './routes/multi-org'
import { usageRoutes } from './middleware/ratelimit'
import { modelRoutes } from './routes/models'
import { scheduledRoutes, routineTriggerRoutes } from './routes/scheduled'
import { agentDetailRoutes } from './routes/agent-detail'
import { webhookRoutes } from './routes/webhooks'
import { telegramWebhookRoutes } from './routes/telegram-webhook'
import { arturitaRoutes, arturitaPublicRoutes } from './routes/arturita'
import { arturitaWalletRoutes } from './routes/arturita-wallet'
import { arturitaVoiceRoutes } from './routes/arturita-voice'
import { arturitaConverseRoutes } from './routes/arturita-converse'
import { arturitaPipelineRoutes } from './routes/arturita-pipeline'
import { arturitaCustomModelRoutes } from './routes/arturita-custom-model'
import { customModelRoutes } from './routes/custom-models'
import { agentInviteRoutes, adapterRegistryRoutes } from './routes/agent-invites'
import { agentApiRoutes } from './routes/agent-api'
import { ensureIndex } from './services/vector-search'
import { auditLogPlugin } from './middleware/audit-log'
import { clerkAuth } from './middleware/clerk-auth'
import { telemetryPlugin } from './services/telemetry'
import { startScheduler } from './services/scheduler'
import { recordRoute, collectedRoutes, endpointDocs, buildOpenApiSpec } from './services/openapi'
import { buildLlmsTxt } from './services/llms-txt'
import { llmProviderHealth } from './services/llm-fallback-runtime'

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

  // Method list is explicit — the @fastify/cors default is GET,HEAD,POST, which
  // silently breaks every PUT/PATCH/DELETE from the dashboard. See middleware/cors.ts.
  await app.register(cors, corsOptions())

  // A bodiless DELETE that still declares `Content-Type: application/json` (what
  // the dashboard's shared client sends) must reach its handler, not 400 in the
  // parser. See middleware/body-parser.ts — this is the avatar-Remove bug.
  registerJsonBodyParser(app)

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
    await secured.register(agentDetailRoutes)   // Epic AG — per-agent detail page (org-scoped)
    await secured.register(taskRoutes)
    await secured.register(projectRoutes)
    await secured.register(costRoutes)
    await secured.register(knowledgeRoutes)
    await secured.register(multiOrgRoutes)
    await secured.register(scheduledRoutes)
    await secured.register(credentialRoutes)
    await secured.register(connectorRoutes)
    // MCA-85 auth hardening — these route groups are org/agent-scoped (they read
    // or mutate tenant data, or act on the org's behalf) and were previously
    // registered public. They now require a Clerk JWT like the rest of the app.
    await secured.register(jiraRoutes)            // /orgs/:orgId/jira/*
    await secured.register(jiraEventRoutes)       // /orgs/:orgId/jira/{events,live,webhook-url}
    await secured.register(commsRoutes)           // inbox, gmail, telegram send, meet
    await secured.register(notificationRoutes)    // /orgs/:orgId/notifications + push register
    await secured.register(memoryRoutes)          // /agents/:agentId/memory
    await secured.register(webhookRoutes)         // outbound webhook config (SSRF-sensitive)
    await secured.register(usageRoutes)           // /orgs/:orgId/usage, /limits
    await secured.register(skillRoutes)           // skill library read + write/sync
    await secured.register(arturitaRoutes)        // Arturita persona/session/binding (A1)
    await secured.register(arturitaWalletRoutes)  // Arturita wallet read/prepare/simulate + policy (E1/E2)
    await secured.register(arturitaVoiceRoutes)   // Arturita voice command → task + spoken reply (B1/S1)
    await secured.register(arturitaConverseRoutes) // Arturita conversational front door — answer vs delegate (J1)
    await secured.register(arturitaPipelineRoutes) // Arturita free-first pipeline chains (LLM/STT/TTS) config (J2)
    await secured.register(arturitaCustomModelRoutes) // Arturita custom operator-defined LLM insertion (J2+)
    await secured.register(customModelRoutes)         // Epic AG — custom adapters/models for agents
    await secured.register(agentInviteRoutes)         // Epic ONB — owner-gated invite create/list/revoke + posture
  })

  // ─── Public / externally-called routes ──────────────────────────────────
  // These are called WITHOUT a Clerk session JWT by design: inbound webhooks
  // (Jira/Telegram receivers — the caller is the external service, not a user),
  // the Google OAuth redirect callback, the static model catalogue, the agent
  // API (its own token auth), and the routine URL-token trigger. Everything that
  // reads or writes tenant data lives in the secured scope above.
  await app.register(commsWebhookRoutes)   // POST /telegram/webhook/:orgId (receiver)
  await app.register(jiraWebhookRoutes)    // POST /jira/webhook/:orgId (receiver)
  await app.register(arturitaPublicRoutes) // POST /orgs/:orgId/arturita/panic (owner-authed via session token)
  await app.register(modelRoutes)
  // Epic ONB / ONB1 — the adapter registry. Public and safe to be: a static,
  // org-agnostic, secret-free description of the runtimes we speak, which a
  // joining agent must be able to read BEFORE it holds any credential. No invite,
  // join or claim endpoint is public — those land in ONB3/ONB4 behind the gate.
  await app.register(adapterRegistryRoutes)
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

    // F1: LLM provider circuit-breaker health — which providers are in cooldown
    // after repeated failures (empty until a fallback chain trips a breaker).
    const llmProviders = llmProviderHealth()
    const llmUnhealthy = llmProviders.filter(p => !p.healthy).map(p => p.key)

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
      llm: {
        providers: llmProviders,
        unhealthy: llmUnhealthy,
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

  // Agent-facing install/context doc (MCA-85 D2) — https://llmstxt.org. Public,
  // served as markdown; a static mirror lives at web/public/llms.txt for 7ei.ai.
  app.get('/llms.txt', async (_req, reply) => {
    reply.header('Content-Type', 'text/markdown; charset=utf-8')
    return buildLlmsTxt({ apiUrl: process.env.PUBLIC_URL || 'https://7ei-backend.fly.dev' })
  })

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
