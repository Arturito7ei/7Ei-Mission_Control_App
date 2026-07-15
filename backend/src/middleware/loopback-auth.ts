import { FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'crypto'
import { LOCAL_OPERATOR_USER_ID } from '../services/loopback-identity'
import { extractBearerToken } from './clerk-auth'

// ─── LOOPBACK LOCAL-OPERATOR ENFORCEMENT (Epic H / H6) ──────────────────────
//
// The packaged-profile replacement for `clerkAuth`. It fills the SAME secured-scope
// onRequest hook Clerk fills on hosted, with the SAME request contract — so every
// downstream gate (requireOrgMembership, requireOrgRole, the audit/telemetry hooks
// that read `req.auth.userId`) keeps working with the local operator as the identity.
// The ONLY thing that changes between profiles is WHERE the identity comes from.
//
// The bearer is the per-install `MC_LOOPBACK_SESSION_SECRET` the Electron shell
// generated into the OS Keychain and injects (a) into this backend's env and (b) as
// the `Authorization` header on every BrowserWindow→backend request. A request that
// presents the matching secret authenticates AS the single local operator; anything
// else — a browser tab that never got the injected header, a second OS account, a
// stray localhost caller without the secret — gets 401. This is a single-operator
// local identity, NOT an open-on-loopback free-for-all.
//
// Fail-closed by construction: if no session secret is configured (a mis-provisioned
// boot that slipped the H6 boot guard), NOTHING can authenticate — every secured
// route 401s rather than defaulting open.

export type LoopbackAuthConfig = {
  /** The expected per-install session secret (from `MC_LOOPBACK_SESSION_SECRET`). */
  sessionSecret: string | undefined
  /** The identity a valid request authenticates as. Defaults to the local operator. */
  operatorUserId?: string
}

/** Constant-time equality that never short-circuits on length (returns false instead
 *  of throwing on a length mismatch, so a wrong-length token can't be distinguished
 *  by timing from a same-length miss). */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Build the loopback auth onRequest hook. Config is injected so tests can exercise
 * the hook without the env, exactly like `createClerkAuth`'s injectable verifier.
 */
export function createLoopbackAuth(config: LoopbackAuthConfig) {
  const operatorUserId = config.operatorUserId ?? LOCAL_OPERATOR_USER_ID
  const sessionSecret = config.sessionSecret

  return async function loopbackAuth(req: FastifyRequest, reply: FastifyReply) {
    // CORS preflight passes untouched — same as clerkAuth (the browser sends it
    // without a bearer). Loopback has no cross-origin story, but keep the contract
    // identical so the two hooks are drop-in interchangeable.
    if (req.method === 'OPTIONS') return

    // No configured secret → nothing can authenticate. Fail closed.
    if (!sessionSecret || sessionSecret.length === 0) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const token = extractBearerToken(req)
    if (!token || !secretsMatch(token, sessionSecret)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    // Attach the SAME identity shape clerkAuth attaches, so every downstream reader
    // (rbac, audit-log, telemetry, the route handlers that read req.userId) is
    // profile-agnostic. `sub`/`sid` mimic a Clerk claim set for the compat readers.
    const claims = { sub: operatorUserId, sid: 'loopback', loopback: true }
    ;(req as any).userId = operatorUserId
    ;(req as any).clerkSession = claims
    ;(req as any).auth = { userId: operatorUserId, sessionId: 'loopback', claims }
  }
}

/** The production hook, reading the injected per-install session secret from env.
 *  Constructed lazily-per-boot via `process.env` at module load, exactly like
 *  `clerkAuth`'s default verifier reads `CLERK_SECRET_KEY`. */
export const loopbackAuth = createLoopbackAuth({
  sessionSecret: process.env.MC_LOOPBACK_SESSION_SECRET,
})
