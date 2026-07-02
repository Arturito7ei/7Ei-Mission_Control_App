import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { buildAuthUrl, exchangeCode, SCOPES as GOOGLE_SCOPES } from '../services/google-auth'

// ─── AUTH ─────────────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/auth/google', async (req) => {
    const { orgId } = req.params as any
    return { url: buildAuthUrl(orgId) }
  })

  app.get('/api/auth/google/callback', async (req, reply) => {
    const { code, state: orgId } = req.query as any
    if (!code || !orgId) return reply.code(400).send({ error: 'Missing code or state' })
    const tokens = await exchangeCode(code)
    const existing = await db.query.oauthTokens.findFirst({
      where: and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google'))
    })
    if (existing) {
      await db.update(schema.oauthTokens).set({
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      }).where(eq(schema.oauthTokens.id, existing.id))
    } else {
      await db.insert(schema.oauthTokens).values({
        id: randomUUID(), orgId, provider: 'google',
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt, scopes: GOOGLE_SCOPES,
        createdAt: new Date(),
      })
    }
    reply.redirect(`${process.env.ALLOWED_ORIGINS?.split(',')[0] ?? '/'}/dashboard?connected=google`)
  })

  app.get('/api/orgs/:orgId/auth/google/status', async (req) => {
    const { orgId } = req.params as any
    const token = await db.query.oauthTokens.findFirst({
      where: and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google'))
    })
    return { connected: !!token, expiresAt: token?.expiresAt ?? null }
  })
}
