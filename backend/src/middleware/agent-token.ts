import { FastifyReply, FastifyRequest } from 'fastify'
import { createHash, randomBytes } from 'crypto'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'

// ─── AGENT TOKEN AUTH (MCA-EXT) ────────────────────────────────────────────
//
// External / bring-your-own runtimes (OpenClaw, Cursor, custom) authenticate to
// the agent-facing API with a long-lived agent token instead of a Clerk JWT.
// The token is shown once at onboarding; only its sha256 hash is stored on the
// agent row (agents.api_token_hash). This hook resolves the agent from the
// Bearer token and attaches it to the request, or replies 401.

const TOKEN_PREFIX = 'mca_'

/** Generate a new agent token + its storable hash. Token is returned ONCE. */
export function generateAgentToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('hex')
  return { token, hash: hashToken(token) }
}

/** Deterministic sha256 of a token, hex-encoded. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Pull the bearer token out of the Authorization header, or null if absent. */
export function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (!header || typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1].trim()
  return token.length > 0 ? token : null
}

export type AgentResolver = (hash: string) => Promise<typeof schema.agents.$inferSelect | null>

const defaultResolver: AgentResolver = async (hash) =>
  (await db.query.agents.findFirst({ where: eq(schema.agents.apiTokenHash, hash) })) ?? null

/**
 * Build the agent-token onRequest hook. The resolver is injectable so tests can
 * exercise the hook without a live DB.
 */
export function createAgentAuth(resolve: AgentResolver = defaultResolver) {
  return async function agentAuth(req: FastifyRequest, reply: FastifyReply) {
    if (req.method === 'OPTIONS') return
    const token = extractBearerToken(req)
    if (!token) return reply.code(401).send({ error: 'Unauthorized' })
    try {
      const agent = await resolve(hashToken(token))
      if (!agent) return reply.code(401).send({ error: 'Unauthorized' })
      ;(req as any).agent = agent
      ;(req as any).orgId = agent.orgId
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  }
}

/** The production hook, using the real DB resolver. */
export const agentAuth = createAgentAuth()
