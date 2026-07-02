import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { requireOrgRole } from '../middleware/rbac'

// ─── CREDENTIALS ─────────────────────────────────────────────────────────────

export function maskKey(key: string): string {
  if (key.length <= 11) return '****'
  return key.slice(0, 7) + '...' + key.slice(-4)
}

export async function credentialRoutes(app: FastifyInstance) {
  app.post('/api/orgs/:orgId/credentials', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId } = req.params as any
    const { provider, apiKey } = req.body as any
    if (!provider || !apiKey) return reply.code(400).send({ error: 'provider and apiKey required' })
    const validProviders = ['anthropic', 'openai', 'gemini']
    if (!validProviders.includes(provider)) return reply.code(400).send({ error: `provider must be one of: ${validProviders.join(', ')}` })

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })
    const config = (org.deployConfig ?? {}) as Record<string, string>
    config[`${provider}_api_key`] = apiKey
    await db.update(schema.organisations).set({ deployConfig: config }).where(eq(schema.organisations.id, orgId))
    reply.code(201)
    return { ok: true, provider, maskedKey: maskKey(apiKey) }
  })

  app.get('/api/orgs/:orgId/credentials', async (req) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return { credentials: [] }
    const config = (org.deployConfig ?? {}) as Record<string, string>
    const credentials = ['anthropic', 'openai', 'gemini']
      .filter(p => config[`${p}_api_key`])
      .map(p => ({ provider: p, maskedKey: maskKey(config[`${p}_api_key`]) }))
    return { credentials }
  })

  app.delete('/api/orgs/:orgId/credentials/:provider', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, provider } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })
    const config = (org.deployConfig ?? {}) as Record<string, string>
    delete config[`${provider}_api_key`]
    await db.update(schema.organisations).set({ deployConfig: config }).where(eq(schema.organisations.id, orgId))
    reply.code(204)
  })
}
