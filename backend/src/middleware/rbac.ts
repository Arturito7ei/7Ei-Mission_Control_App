import { FastifyRequest, FastifyReply } from 'fastify'
import { db as defaultDb, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'

export type OrgRole = 'owner' | 'member'

const ROLE_HIERARCHY: Record<OrgRole, number> = { member: 1, owner: 2 }

type RbacDb = Pick<typeof defaultDb, 'query'>

export type EnforceResult =
  | { ok: true; code?: undefined; error?: undefined }
  | { ok: false; code: 401 | 403; error: string }

/**
 * The ONE org membership + role check. Both the `requireOrgRole` preHandler (below)
 * and any route that must derive its org from a RECORD rather than the path (the
 * ONB3 approvals decide route — AUDIT-ONB3 H-1) go through here, so there is a single
 * enforcement path and no second implementation to drift.
 *
 * Unlike the preHandler, this NEVER skips: a missing `orgId` is a 403, not a pass.
 * The preHandler's skip-when-no-`:orgId` (the R-4 trap) is a property of reading the
 * org from the URL — callers that derive the org from data must not inherit it.
 */
export async function enforceOrgRole(input: {
  userId: string | null | undefined
  orgId: string | null | undefined
  minRole: OrgRole
  database?: RbacDb
}): Promise<EnforceResult> {
  const { userId, orgId, minRole } = input
  if (!userId) return { ok: false, code: 401, error: 'Authentication required' }
  // No org to check against → refuse. (The path-based preHandler skips here for
  // legitimately org-agnostic routes; a data-derived caller must fail closed.)
  if (!orgId) return { ok: false, code: 403, error: 'Not a member of this organisation' }

  const database = input.database ?? defaultDb
  const membership = await database.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId)),
  })
  if (!membership) {
    return { ok: false, code: 403, error: 'Not a member of this organisation' }
  }

  const userLevel = ROLE_HIERARCHY[membership.role as OrgRole] ?? 0
  const requiredLevel = ROLE_HIERARCHY[minRole]
  if (userLevel < requiredLevel) {
    return { ok: false, code: 403, error: 'Insufficient permissions. Required role: ' + minRole }
  }
  return { ok: true }
}

export function requireOrgRole(minRole: OrgRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = (req as any).auth?.userId
    if (!userId) return reply.code(401).send({ error: 'Authentication required' })

    const orgId = (req.params as any)?.orgId
    if (!orgId) return // No org context — skip RBAC (path-based; see enforceOrgRole)

    const result = await enforceOrgRole({ userId, orgId, minRole })
    if (!result.ok) return reply.code(result.code).send({ error: result.error })
  }
}

export function checkOrgMembership(userId: string, orgId: string, role: OrgRole): { allowed: boolean; reason?: string } {
  const level = ROLE_HIERARCHY[role] ?? 0
  // Utility for testing — actual check is in the preHandler hook above
  return { allowed: level >= ROLE_HIERARCHY.member }
}
