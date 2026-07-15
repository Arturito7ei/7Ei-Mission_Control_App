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

  // Determine the caller's effective role. GRANDFATHER: an org's `ownerId` IS an
  // owner, even with no `org_members` row. Org creation has inserted that row since
  // MCA, but nothing backfilled orgs created before it — and now that membership is
  // enforced surface-wide, a rowless owner would be locked out of their OWN org. The
  // org's `ownerId` column is the durable source of truth for ownership, so we honour
  // it. The org lookup only runs when there is no membership row (the common member
  // path stays a single query); it never GRANTS access to a non-owner.
  let userLevel = membership ? (ROLE_HIERARCHY[membership.role as OrgRole] ?? 0) : 0
  if (!membership) {
    const org = await database.query.organisations.findFirst({
      where: eq(schema.organisations.id, orgId),
    })
    if (org && org.ownerId === userId) userLevel = ROLE_HIERARCHY.owner
    else return { ok: false, code: 403, error: 'Not a member of this organisation' }
  }

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

/**
 * Resolve the org a request targets, for the surface-wide membership gate below.
 *
 *  - The `:orgId` path param wins (the `/api/orgs/:orgId/*` surface — the bulk).
 *  - Otherwise derive the org from the record the path DOES carry: an `:agentId`
 *    or `:taskId`. This is the R-4 tail — routes that are org-scoped but keep the
 *    org in a row, not the URL (e.g. `/api/agents/:agentId`, `/api/tasks/:taskId/*`).
 *  - Otherwise there is NO org context in the request at all (user- or global-scoped
 *    routes: `GET /api/orgs`, `/api/skills`, `/api/agent-templates`, model catalogue).
 *    Those are not membership-gatable by an org, and `{ scoped: false }` tells the
 *    gate to stand down for them.
 *
 * Fail-closed by construction: an `:agentId`/`:taskId` that resolves to no row
 * yields `{ scoped: true, orgId: null }`, which `enforceOrgRole` turns into a 403 —
 * a request that CLAIMS an org context but can't prove one is refused, never skipped.
 * The generic `POST /api/approvals/:id/decide` is deliberately NOT derived here: it
 * carries only an opaque `:id`, maps role from the approval TYPE, and already runs
 * its own `enforceOrgRole` in-handler (AUDIT-ONB3 H-1) — so it lands in `scoped:false`
 * and enforces itself, with no double check and no type-role lost.
 */
export async function resolveRequestOrg(
  params: Record<string, any> | undefined,
  database: Pick<typeof defaultDb, 'query'> = defaultDb,
): Promise<{ scoped: false } | { scoped: true; orgId: string | null }> {
  const p = params ?? {}
  if (p.orgId !== undefined) return { scoped: true, orgId: p.orgId ?? null }
  if (p.agentId !== undefined) {
    const agent = await database.query.agents.findFirst({ where: eq(schema.agents.id, p.agentId) })
    return { scoped: true, orgId: agent?.orgId ?? null }
  }
  if (p.taskId !== undefined) {
    const task = await database.query.tasks.findFirst({ where: eq(schema.tasks.id, p.taskId) })
    return { scoped: true, orgId: task?.orgId ?? null }
  }
  return { scoped: false }
}

/**
 * THE surface-wide membership gate (multi-tenant hardening — the R-4 fix).
 *
 * Installed ONCE as a `preHandler` on the whole Clerk-secured scope (src/index.ts),
 * so it fires for EVERY authenticated route with no per-route opt-in to forget — the
 * exact failure mode that let 124 of ~159 org-scoped routes ship Clerk-authed but
 * membership-BLIND (any logged-in user could act on any org by swapping `:orgId`).
 *
 * It enforces the BASELINE: a logged-in caller with no `org_members` row for the
 * request's org gets 403. Stricter per-route gates still layer on top unchanged —
 * an `requireOrgRole('owner')` route runs this member check first, then its own owner
 * check. It reuses the single `enforceOrgRole` core (never a second membership impl).
 *
 * OPTIONS is skipped so the CORS preflight (which carries no session) still completes.
 * Routes with no org context (`scoped:false`) are left alone — they are user-/global-
 * scoped and self-authorize (e.g. `/api/orgs` lists only the caller's own orgs).
 */
export async function requireOrgMembership(req: FastifyRequest, reply: FastifyReply) {
  if (req.method === 'OPTIONS') return // CORS preflight carries no session — must pass
  const userId = (req as any).auth?.userId ?? (req as any).userId
  if (!userId) return reply.code(401).send({ error: 'Authentication required' })

  const resolved = await resolveRequestOrg(req.params as any)
  if (!resolved.scoped) return // no org context in this request — nothing to gate

  const result = await enforceOrgRole({ userId, orgId: resolved.orgId, minRole: 'member' })
  if (!result.ok) return reply.code(result.code).send({ error: result.error })
}

export function checkOrgMembership(userId: string, orgId: string, role: OrgRole): { allowed: boolean; reason?: string } {
  const level = ROLE_HIERARCHY[role] ?? 0
  // Utility for testing — actual check is in the preHandler hook above
  return { allowed: level >= ROLE_HIERARCHY.member }
}
