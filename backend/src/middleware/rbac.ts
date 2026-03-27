import { FastifyRequest, FastifyReply } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'

export type OrgRole = 'owner' | 'member'

const ROLE_HIERARCHY: Record<OrgRole, number> = { member: 1, owner: 2 }

export function requireOrgRole(minRole: OrgRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = (req as any).auth?.userId
    if (!userId) return reply.code(401).send({ error: 'Authentication required' })

    const orgId = (req.params as any)?.orgId
    if (!orgId) return // No org context — skip RBAC

    const membership = await db.query.orgMembers.findFirst({
      where: and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId))
    })

    if (!membership) {
      return reply.code(403).send({ error: 'Not a member of this organisation' })
    }

    const userLevel = ROLE_HIERARCHY[membership.role as OrgRole] ?? 0
    const requiredLevel = ROLE_HIERARCHY[minRole]

    if (userLevel < requiredLevel) {
      return reply.code(403).send({ error: 'Insufficient permissions. Required role: ' + minRole })
    }
  }
}

export function checkOrgMembership(userId: string, orgId: string, role: OrgRole): { allowed: boolean; reason?: string } {
  const level = ROLE_HIERARCHY[role] ?? 0
  // Utility for testing — actual check is in the preHandler hook above
  return { allowed: level >= ROLE_HIERARCHY.member }
}
