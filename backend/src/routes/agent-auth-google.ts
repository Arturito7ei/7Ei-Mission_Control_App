import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import {
  consumeOauthState, exchangeCodePkce, fetchGoogleUserEmail,
  storeAgentGoogleToken, servicesFromScopes,
} from '../services/agent-google-auth'
import { allowedRedirectOrigin, dashboardRedirect } from '../services/oauth-redirect'

// ─── Per-agent Google OAuth CALLBACK (Epic CONN / CONN-5) ─────────────────────
//
// PUBLIC by design (registered outside the Clerk-secured scope): Google redirects the
// operator's browser here with ?code&state and NO app session JWT — exactly like the
// org callback (routes/auth-google.ts). The authorization is carried ENTIRELY by the
// `state`: a single-use, expiring, server-side row (services/agent-google-auth.ts)
// that binds the flow to one (org, agent). An attacker cannot forge or replay it, so
// they cannot attach their Google account to someone else's connector or CSRF this
// endpoint. On success we store the tokens ENCRYPTED at agent scope, record the
// connector row, and bounce back to the dashboard — never returning a token.

/** Upsert the agent_connectors row for a freshly-connected Google account. */
async function markGoogleConnected(args: {
  orgId: string; agentId: string; accountEmail: string | null; grantedScopes: string | null
}): Promise<void> {
  const { orgId, agentId, accountEmail, grantedScopes } = args
  const config = {
    services: servicesFromScopes(grantedScopes),
    scopes: (grantedScopes ?? '').split(/\s+/).filter(Boolean),
  }
  const now = new Date()
  const existing = await db.query.agentConnectors.findFirst({
    where: and(
      eq(schema.agentConnectors.orgId, orgId),
      eq(schema.agentConnectors.agentId, agentId),
      eq(schema.agentConnectors.connectorId, 'google'),
    ),
  })
  const patch = {
    status: 'connected',
    config,
    accountLabel: accountEmail,
    useOrgConnection: false,
    secretRef: null,          // tokens live in agent_oauth_tokens, never in `secrets`
    lastError: null,
    updatedAt: now,
  }
  if (existing) {
    await db.update(schema.agentConnectors).set(patch).where(eq(schema.agentConnectors.id, existing.id))
  } else {
    await db.insert(schema.agentConnectors).values({
      id: randomUUID(), orgId, agentId, connectorId: 'google', lastTestedAt: null, createdAt: now, ...patch,
    })
  }
}

export async function agentAuthGoogleRoutes(app: FastifyInstance) {
  app.get('/api/agent-connectors/google/callback', async (req, reply) => {
    const { code, state, error: oauthError } = (req.query ?? {}) as Record<string, string>

    // The user denied consent (Google appends ?error=access_denied) — spend nothing,
    // just bounce back with a clean error. We still try to consume the state so it
    // can't be reused, but a denied flow has no code to exchange.
    if (oauthError || !code || !state) {
      const consumed = state ? await consumeOauthState(state) : null
      const st = consumed?.ok ? consumed.state : undefined
      const origin = allowedRedirectOrigin(st?.redirectOrigin ?? null)
      const to = dashboardRedirect(origin, { google: 'error', agentId: st?.agentId, reason: oauthError || 'missing_params' })
      return to ? reply.redirect(to) : reply.code(400).send({ error: 'Google authorization failed' })
    }

    // SPEND the state exactly once. Unknown/expired/used → reject with a clean bounce.
    const consumed = await consumeOauthState(state)
    if (!consumed.ok || !consumed.state) {
      const origin = allowedRedirectOrigin(null)
      const to = dashboardRedirect(origin, { google: 'error', reason: consumed.reason })
      return to ? reply.redirect(to) : reply.code(400).send({ error: `Invalid state: ${consumed.reason}` })
    }
    const { orgId, agentId, codeVerifier } = consumed.state
    const origin = allowedRedirectOrigin(consumed.state.redirectOrigin)

    try {
      // Confirm the agent still exists in the org the state was minted for (defence in
      // depth — the agent could have been deleted between start and callback).
      const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
      if (!agent || agent.orgId !== orgId) {
        const to = dashboardRedirect(origin, { google: 'error', reason: 'agent_gone' })
        return to ? reply.redirect(to) : reply.code(404).send({ error: 'Agent not found' })
      }

      const tokens = await exchangeCodePkce(code, codeVerifier)
      const email = await fetchGoogleUserEmail(tokens.accessToken)
      await storeAgentGoogleToken({ orgId, agentId, provider: 'google', tokens, accountEmail: email })
      await markGoogleConnected({ orgId, agentId, accountEmail: email, grantedScopes: tokens.scopes })

      const to = dashboardRedirect(origin, { google: 'connected', agentId })
      return to ? reply.redirect(to) : reply.send({ ok: true })
    } catch (err) {
      // Never log the code/token — only a generic failure.
      console.warn('Per-agent Google callback failed:', (err as Error)?.message)
      const to = dashboardRedirect(origin, { google: 'error', agentId, reason: 'exchange_failed' })
      return to ? reply.redirect(to) : reply.code(502).send({ error: 'Google token exchange failed' })
    }
  })
}
