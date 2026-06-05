import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyToken } from '@clerk/backend'

// ─── CLERK JWT ENFORCEMENT ─────────────────────────────────────────────────
//
// Strict auth for org-scoped routes. A valid Clerk session JWT must be present
// in the `Authorization: Bearer <token>` header (the web app sends this via
// @clerk/nextjs). On success we attach the verified identity to the request;
// on any failure we reply 401. CORS preflight (OPTIONS) is always allowed
// through so the browser can complete its preflight before sending the token.

export interface ClerkClaims {
  /** Clerk user id (the JWT `sub` claim). */
  sub: string
  /** Clerk session id (the JWT `sid` claim), when present. */
  sid?: string
  [key: string]: unknown
}

export type TokenVerifier = (token: string) => Promise<ClerkClaims>

// Default verifier — validates the JWT against CLERK_SECRET_KEY using Clerk's
// backend SDK (fetches + caches the JWKS internally).
const defaultVerifier: TokenVerifier = async (token) => {
  const secretKey = process.env.CLERK_SECRET_KEY
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not configured')
  return (await verifyToken(token, { secretKey })) as unknown as ClerkClaims
}

/** Pull the bearer token out of the Authorization header, or null if absent/malformed. */
export function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (!header || typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1].trim()
  return token.length > 0 ? token : null
}

/**
 * Build the Clerk auth onRequest hook. The verifier is injectable so tests can
 * exercise the hook without reaching Clerk's network JWKS endpoint.
 */
export function createClerkAuth(verify: TokenVerifier = defaultVerifier) {
  return async function clerkAuth(req: FastifyRequest, reply: FastifyReply) {
    // CORS preflight must pass untouched — the browser sends it without a token.
    if (req.method === 'OPTIONS') return

    const token = extractBearerToken(req)
    if (!token) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    try {
      const claims = await verify(token)
      const userId = claims?.sub
      if (!userId) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
      // Per MCA-14: expose the verified identity to handlers.
      ;(req as any).userId = userId
      ;(req as any).clerkSession = claims
      // Backwards-compat: rbac, audit-log, telemetry and multi-org read req.auth.userId.
      ;(req as any).auth = { userId, sessionId: claims.sid ?? null, claims }
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  }
}

/** The production hook, using the real Clerk verifier. */
export const clerkAuth = createClerkAuth()

/**
 * Fastify plugin that enforces Clerk auth on every route registered within its
 * encapsulation scope. Register protected route groups inside this scope.
 */
export async function clerkAuthPlugin(app: FastifyInstance) {
  app.addHook('onRequest', clerkAuth)
}
