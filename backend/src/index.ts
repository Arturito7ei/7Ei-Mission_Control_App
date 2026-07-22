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
import { agentConnectorRoutes } from './routes/agent-connectors'
import { agentAuthGoogleRoutes } from './routes/agent-auth-google'
import { notificationRoutes } from './routes/notifications'
import { jiraRoutes } from './routes/jira'
import { jiraWebhookRoutes, jiraEventRoutes } from './routes/jira-webhook'
import { memoryRoutes } from './routes/memory'
import { multiOrgRoutes } from './routes/multi-org'
import { usageRoutes } from './middleware/ratelimit'
import { modelRoutes } from './routes/models'
import { scheduledRoutes, routineTriggerRoutes } from './routes/scheduled'
import { agentDetailRoutes } from './routes/agent-detail'
import { agentChatRoutes } from './routes/agent-chat'
import { webhookRoutes } from './routes/webhooks'
import { telegramWebhookRoutes } from './routes/telegram-webhook'
import { arturitaRoutes, arturitaPublicRoutes } from './routes/arturita'
import { arturitaWalletRoutes } from './routes/arturita-wallet'
import { arturitaVoiceRoutes } from './routes/arturita-voice'
import { arturitaSttRoutes } from './routes/arturita-stt'
import { arturitaConverseRoutes } from './routes/arturita-converse'
import { arturitaPipelineRoutes } from './routes/arturita-pipeline'
import { arturitaCustomModelRoutes } from './routes/arturita-custom-model'
import { customModelRoutes } from './routes/custom-models'
import { agentInviteRoutes, adapterRegistryRoutes, agentInviteDocRoutes, agentJoinRoutes } from './routes/agent-invites'
import { agentApiRoutes } from './routes/agent-api'
import { ensureIndex } from './services/vector-search'
import { auditLogPlugin, auditLogQueryRoutes } from './middleware/audit-log'
import { activityRoutes } from './routes/activity'
import { clerkAuth } from './middleware/clerk-auth'
import { loopbackAuth } from './middleware/loopback-auth'
import { requireOrgMembership } from './middleware/rbac'
import { resolveDeploymentProfile } from './services/deployment-profile'
import { assertSecretKeysSafe } from './services/secret-keys'
import { bootstrapLocalOperator } from './services/loopback-identity'
import { telemetryPlugin, telemetryQueryRoutes } from './services/telemetry'
import { startScheduler } from './services/scheduler'
import { recordRoute, collectedRoutes, endpointDocs, buildOpenApiSpec } from './services/openapi'
import { buildLlmsTxt } from './services/llms-txt'
import { llmProviderHealth } from './services/llm-fallback-runtime'
import { redactPath } from './services/log-redaction'

// Keep in sync with package.json "version" — surfaced in /api/openapi.json + /api/health.
const API_VERSION = '0.6.0'

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    // ONB2 / audit H2 — the SECOND sink. Invite tokens are bearer credentials
    // carried in the URL path (`/api/agent-invites/mci_inv_…/onboarding.txt`), and
    // Fastify logs `req.url` verbatim. Redact it here exactly as `audit-log.ts`
    // redacts the persisted path: one helper, both sinks, no drift.
    serializers: {
      req(req: any) {
        return {
          method: req.method,
          url: redactPath(req.url),
          hostname: req.hostname,
          remoteAddress: req.ip,
        }
      },
    },
  },
  trustProxy: true,  // needed behind Fly.io / Railway proxy
})

async function start() {
  // ─── H6 FAIL-CLOSED secret-key guard (AUDIT-H1 LOW-3 #1/#2/#4) ─────────────
  // In the `packaged` profile, REFUSE TO BOOT if SECRETS_ENC_KEY / RUN_TOKEN_SECRET /
  // MC_LOOPBACK_SESSION_SECRET are missing or a known dev/throwaway default — no real
  // secret may ever be encrypted under a world-readable default key, and the loopback
  // identity cannot authenticate without a real per-install session secret. In
  // `hosted` (the default) this is a NO-OP (real Fly secrets), so the boot is
  // byte-identical. A throw here → start().catch → process.exit(1) = fail-closed.
  const deploymentProfile = resolveDeploymentProfile(process.env)
  assertSecretKeysSafe(process.env)

  // Self-describing API (MCA-85 D1): collect every registered route into the
  // OpenAPI route table. This baseline hook fires for all routes (it is added
  // before any registration and propagates to descendant scopes) and tags them
  // 'none'; scoped hooks below upgrade the auth of secured/agent routes. Auth
  // rank is order-independent, so it doesn't matter which hook fires first.
  app.addHook('onRoute', (r) => recordRoute('none', r.method, r.url))

  // ─── Audit trail — HOISTED + ENABLED (Epic ONB, audit finding H-1) ────────
  // The audit hook is installed on the ROOT instance, before any register(), so its
  // onResponse fires for every descendant route (a request-lifecycle hook on the
  // root propagates to all child scopes, exactly like the onRoute hook above). This
  // is what closes H-1: registering it via `app.register(auditLogPlugin)` would
  // encapsulate the hook into a child whose onResponse never runs for its siblings —
  // the original no-op. It records the SENSITIVE half only (see `shouldAudit`): every
  // mutating method + the onboarding/invite/join/approval surfaces, skipping the
  // read-only GET flood; every row is path-redacted + body-sanitized by construction;
  // and rows are pruned older than N days (default 90) by the scheduler. Turso cost is
  // one fire-and-forget INSERT per SENSITIVE request. See GO-LIVE.md §7.
  await auditLogPlugin(app)

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
  // ─── Clerk plugin — registered only when a publishable key is configured ──
  // @clerk/fastify's clerkPlugin installs a GLOBAL onRequest hook (withClerkMiddleware)
  // that authenticates EVERY request — and it *throws* (→ 500 on every route,
  // including the public /api/health) when no CLERK_PUBLISHABLE_KEY is present.
  // The `packaged`/loopback profile (Epic H) ships NO Clerk keys: it is single-
  // tenant on 127.0.0.1, and H6 replaces Clerk with a local single-operator
  // identity. So register the plugin only when a key exists — the same graceful
  // degradation the web already does (`if (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)` in
  // web/app/layout.tsx + middleware.ts). Hosted (Fly) sets CLERK_PUBLISHABLE_KEY,
  // so this is a NO-OP there; a keyless packaged boot no longer 500s.
  //   NOTE (H0 spike): skipping the plugin is NOT auth for packaged — it is an
  //   auth *bypass*. The per-route `clerkAuth` hook on the `secured` scope below
  //   still 401s tenant data without a bearer token; real loopback auth is H6 and
  //   is deliberately NOT built here (the packaged profile is not security-complete).
  if (process.env.CLERK_PUBLISHABLE_KEY) {
    await app.register(clerkPlugin)
  }
  await setupDatabase()
  await ensureIndex()  // Pinecone (non-blocking)

  // ─── H6 packaged single-operator bootstrap ────────────────────────────────
  // On the `packaged` profile, seed the one local org OWNED by the local operator
  // (idempotent) so the loopback identity is a real owner/member the membership +
  // owner gates can resolve against — and the packaged dashboard has a workspace on
  // first boot. Hosted never runs this (multi-tenant, Clerk users own their orgs).
  if (deploymentProfile === 'packaged') {
    const localOrgId = await bootstrapLocalOperator(db)
    console.log(`🔐 packaged profile: local operator owns org ${localOrgId} (loopback auth)`)
  }

  // ─── Protected routes (MCA-14) ──────────────────────────────────────────
  // Every route in this encapsulated scope requires a valid session — a Clerk JWT
  // on hosted, the single-operator loopback bearer on packaged (H6, branched below).
  // The onRequest hook attaches req.userId / req.clerkSession (and req.auth for
  // rbac/audit/telemetry compat) or replies 401. OPTIONS preflight is skipped.
  // The identity source for the secured scope is PROFILE-BRANCHED (H6): hosted
  // authenticates with Clerk exactly as before; packaged authenticates with the
  // single-operator loopback identity (the per-install session secret the Electron
  // shell injects). The hook CONTRACT is identical — both attach req.auth.userId /
  // req.userId — so the membership gate, owner checks, audit + telemetry hooks all
  // run unchanged whichever fills it. Hosted resolves to `clerkAuth` (the default
  // profile), so the hosted secured scope is byte-identical to before.
  const securedAuthHook = deploymentProfile === 'packaged' ? loopbackAuth : clerkAuth
  await app.register(async (secured) => {
    secured.addHook('onRequest', securedAuthHook)
    secured.addHook('onRoute', (r) => recordRoute('clerk', r.method, r.url))
    // ─── Multi-tenant membership gate (R-4 fix) ────────────────────────────
    // ONE preHandler on the whole secured scope: every authenticated route now
    // enforces org membership (baseline `member`) for the org it targets —
    // derived from `:orgId`, or from the `:agentId`/`:taskId` record where the
    // path carries no org id. Before this, only ~35 of ~159 org-scoped routes
    // checked membership, so any logged-in user could act on any org by swapping
    // `:orgId` (the cross-tenant gap the ONB2/ONB3 audits kept surfacing). Because
    // it lives at the scope level, a NEW org route can't be added ungated — it is
    // covered the moment it registers here. Stricter per-route gates
    // (`requireOrgRole('owner')`) still layer on top. See middleware/rbac.ts.
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(orgRoutes)
    await secured.register(agentRoutes)
    await secured.register(agentDetailRoutes)   // Epic AG — per-agent detail page (org-scoped)
    await secured.register(agentChatRoutes)     // MCC-1 — org-scoped agent chat threads
    await secured.register(taskRoutes)
    await secured.register(projectRoutes)
    await secured.register(costRoutes)
    await secured.register(knowledgeRoutes)
    await secured.register(multiOrgRoutes)
    await secured.register(scheduledRoutes)
    await secured.register(credentialRoutes)
    await secured.register(connectorRoutes)
    await secured.register(agentConnectorRoutes)  // Epic CONN — per-agent connectors (owner-gated)
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
    await secured.register(arturitaSttRoutes)     // MOB-5a — hosted speech-to-text: audio blob → { transcript }
    await secured.register(arturitaConverseRoutes) // Arturita conversational front door — answer vs delegate (J1)
    await secured.register(arturitaPipelineRoutes) // Arturita free-first pipeline chains (LLM/STT/TTS) config (J2)
    await secured.register(arturitaCustomModelRoutes) // Arturita custom operator-defined LLM insertion (J2+)
    await secured.register(customModelRoutes)         // Epic AG — custom adapters/models for agents
    await secured.register(agentInviteRoutes)         // Epic ONB — owner-gated invite create/list/revoke + posture
    // ONB2 audit H-2 — these two READ endpoints used to be registered inside the
    // hook plugins below, i.e. in the PUBLIC block: `GET /api/orgs/:orgId/audit-log`
    // was an unauthenticated cross-tenant audit read, and the traces route served
    // real spans to anyone. Both are now Clerk- AND owner-gated on an `:orgId`, and
    // `auth-scoping.test.ts` boots both plugins so the MCA-85 leak guard covers them
    // from now on. (The re-audit of #248 moved traces from a bare `/api/traces` —
    // authenticated but tenant-blind, one process-wide span buffer readable by any
    // Clerk user — to the org-scoped, org-filtered path. See docs/AUDIT-ONB2-hardening.md.)
    await secured.register(auditLogQueryRoutes)       // GET /api/orgs/:orgId/audit-log (owner)
    await secured.register(telemetryQueryRoutes)      // GET /api/orgs/:orgId/traces  (owner)
    // ACT-1 — GET /api/orgs/:orgId/activity: the unified feed (approvals filed/decided,
    // connector executions, agent runs, tasks, audit events). Member-readable via the
    // scope gate above; the OWNER-ONLY sources (connector executions, audit) are dropped
    // per-caller inside the handler, so this composes the existing gates rather than
    // becoming a side door around them.
    await secured.register(activityRoutes)
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
  // Epic ONB / ONB2 — the per-invite onboarding document. Public and token-addressed:
  // the invite token in the path IS the bearer, its exposure follows the deployment
  // profile (`onboardingDocAccess`), and it mints nothing. The token is redacted out
  // of every log sink before persistence (services/log-redaction.ts).
  await app.register(agentInviteDocRoutes)
  // Epic ONB / ONB3 — the public JOIN REQUEST. Unauthenticated by design (the invite
  // token is the bearer) and the first unauthenticated WRITE in the app, so it ships
  // with the controls that make that safe: it mints NO credential (it creates a row in
  // the owner's approval queue), its exposure follows the deployment profile
  // (`publicJoinEnabled` — a hosted deployment without MC_ENABLE_REMOTE_ONBOARDING
  // answers a flat 404, which is production today), the single use is spent by an
  // atomic conditional UPDATE, and it is per-IP rate limited. There is still NO claim
  // endpoint: `TOKEN_CLAIM_IMPLEMENTED` is false and `auth-scoping.test.ts` fails if
  // one appears before ONB4.
  await app.register(agentJoinRoutes)
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
  // Epic CONN / CONN-5 — the per-agent Google OAuth callback. Public like authRoutes
  // (Google redirects here with no app JWT); its single-use, expiring state row is the
  // authorization. The owner-gated START route lives in the secured scope above
  // (agentConnectorRoutes).
  await app.register(agentAuthGoogleRoutes)
  // The TELEMETRY hook. Still a no-op by encapsulation (ONB2 audit H-1): a hook
  // added inside a register()'d child never fires for its siblings. Left that way
  // ON PURPOSE — telemetry is a SEPARATE concern from the audit trail (an in-memory
  // span ring buffer, no Turso writes, and its /traces query under-reports until
  // llm.call spans carry an org id), and the operator's H-1 decision was scoped to
  // the audit trail. Enabling telemetry is its own call. The AUDIT hook is hoisted
  // + enabled at the top of start(); its query route lives in the secured scope.
  await app.register(telemetryPlugin)

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
  // Bind host is env-overridable so the packaged/loopback profile (Epic H) can
  // bind 127.0.0.1 — the trust boundary of the `packaged` profile (nothing on a
  // routable interface). Hosted (Fly) sets no HOST → keeps 0.0.0.0 as today.
  const host = process.env.HOST || '0.0.0.0'
  await app.listen({ port, host })
  console.log(`\ud83d\ude80 7Ei backend v0.6.0 \u2192 http://localhost:${port}`)

  // Start cron scheduler after server is up
  startScheduler()
}

start().catch(err => { console.error(err); process.exit(1) })
