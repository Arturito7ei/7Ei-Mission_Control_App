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
 * URL-PREFIX → owning-table derivation for the TOP-LEVEL RECORD ROUTES (AUDIT-MCA
 * HIGH-1). These are org-scoped routes whose org lives in a row, not the URL, and
 * whose param is either record-specific (`:projectId`, `:goalId`, `:itemId`,
 * `:skillId`) or the GENERIC `:id` shared across ~10 tables. The `:id` param name
 * cannot disambiguate the table, so we key on the route PREFIX (`req.routeOptions.url`),
 * exactly the fix the audit required.
 *
 * Each entry FAILS CLOSED: a record that resolves to no row → `orgId: null` →
 * `enforceOrgRole` → 403 (never a silent skip), the same contract as the
 * `:agentId`/`:taskId` tail. Prefixes are disjoint; the first whose prefix matches
 * AND whose id param is present wins. A prefix match with the id param ABSENT is a
 * collection/utility sub-route (e.g. `/api/scheduled/presets`, `/api/skills/sync`) —
 * it falls through to `{ scoped: false }` and MUST be on the leak-guard's exempt
 * allowlist (`tests/membership-scoping.test.ts`), so it can't silently reopen.
 */
type RbacQueryDb = Pick<typeof defaultDb, 'query'>
type RecordOrgRoute = {
  prefix: string
  param: string
  find: (database: RbacQueryDb, id: string) => Promise<{ orgId: string | null } | undefined>
  /**
   * `skills` only: a row with a NULL `orgId` is a SHARED GLOBAL library skill, not
   * org-scoped — the gate must stand down for it (`scoped:false`) rather than 403
   * everyone out of the shared library. A MISSING skill still fails closed (403).
   * (The global-library skill *collection* routes — list/create/sync — are handled
   * as org-agnostic on the leak-guard allowlist; per-org custom skills, `orgId != null`,
   * are membership-enforced here.)
   */
  nullOrgIsGlobal?: boolean
}

const RECORD_ORG_ROUTES: RecordOrgRoute[] = [
  { prefix: '/api/projects/',    param: 'projectId', find: (d, id) => d.query.projects.findFirst({ where: eq(schema.projects.id, id) }) },
  { prefix: '/api/goals/',       param: 'goalId',    find: (d, id) => d.query.goals.findFirst({ where: eq(schema.goals.id, id) }) },
  { prefix: '/api/knowledge/',   param: 'itemId',    find: (d, id) => d.query.knowledgeItems.findFirst({ where: eq(schema.knowledgeItems.id, id) }) },
  { prefix: '/api/skills/',      param: 'skillId',   find: (d, id) => d.query.skills.findFirst({ where: eq(schema.skills.id, id) }), nullOrgIsGlobal: true },
  { prefix: '/api/secrets/',     param: 'id',        find: (d, id) => d.query.secrets.findFirst({ where: eq(schema.secrets.id, id) }) },
  { prefix: '/api/budgets/',     param: 'id',        find: (d, id) => d.query.budgetPolicies.findFirst({ where: eq(schema.budgetPolicies.id, id) }) },
  { prefix: '/api/plugins/',     param: 'id',        find: (d, id) => d.query.plugins.findFirst({ where: eq(schema.plugins.id, id) }) },
  { prefix: '/api/workspaces/',  param: 'id',        find: (d, id) => d.query.workspaces.findFirst({ where: eq(schema.workspaces.id, id) }) },
  { prefix: '/api/attachments/', param: 'id',        find: (d, id) => d.query.taskAttachments.findFirst({ where: eq(schema.taskAttachments.id, id) }) },
  { prefix: '/api/watchdogs/',   param: 'id',        find: (d, id) => d.query.taskWatchdogs.findFirst({ where: eq(schema.taskWatchdogs.id, id) }) },
  { prefix: '/api/scheduled/',   param: 'id',        find: (d, id) => d.query.scheduledTasks.findFirst({ where: eq(schema.scheduledTasks.id, id) }) },
  { prefix: '/api/webhooks/',    param: 'id',        find: (d, id) => d.query.webhooks.findFirst({ where: eq(schema.webhooks.id, id) }) },
  { prefix: '/api/policies/',    param: 'id',        find: (d, id) => d.query.executionPolicies.findFirst({ where: eq(schema.executionPolicies.id, id) }) },
  { prefix: '/api/revisions/',   param: 'id',        find: (d, id) => d.query.configRevisions.findFirst({ where: eq(schema.configRevisions.id, id) }) },
]

/**
 * Resolve the org a request targets, for the surface-wide membership gate below.
 *
 *  - The `:orgId` path param wins (the `/api/orgs/:orgId/*` surface — the bulk).
 *  - Otherwise derive the org from the record the path DOES carry: an `:agentId`
 *    or `:taskId`. This is the R-4 tail — routes that are org-scoped but keep the
 *    org in a row, not the URL (e.g. `/api/agents/:agentId`, `/api/tasks/:taskId/*`).
 *  - Otherwise, if `routeUrl` matches a TOP-LEVEL RECORD ROUTE prefix (AUDIT-MCA
 *    HIGH-1: `/api/secrets/:id`, `/api/knowledge/:itemId`, `/api/projects/:projectId`,
 *    …), derive the org from that record via `RECORD_ORG_ROUTES` above. This closes
 *    the ~25 routes whose org lived in a differently-named param and so slipped the
 *    original 3-param resolver, letting any logged-in user read/delete another org's
 *    secret / knowledge doc / project / policy / webhook.
 *  - Otherwise there is NO org context in the request at all (user- or global-scoped
 *    routes: `GET /api/orgs`, the global skill library, model catalogue). Those are
 *    not membership-gatable by an org, and `{ scoped: false }` tells the gate to stand
 *    down for them — every such route is asserted org-agnostic-by-allowlist in the
 *    leak-guard, so a NEW route landing here fails the test unless it's justified.
 *
 * Fail-closed by construction: an `:agentId`/`:taskId`/record id that resolves to no
 * row yields `{ scoped: true, orgId: null }`, which `enforceOrgRole` turns into a 403 —
 * a request that CLAIMS an org context but can't prove one is refused, never skipped.
 * The generic `POST /api/approvals/:id/decide` is deliberately NOT derived here: it
 * carries only an opaque `:id`, maps role from the approval TYPE, and already runs
 * its own `enforceOrgRole` in-handler (AUDIT-ONB3 H-1) — so it lands in `scoped:false`
 * and enforces itself, with no double check and no type-role lost.
 */
export async function resolveRequestOrg(
  params: Record<string, any> | undefined,
  database: Pick<typeof defaultDb, 'query'> = defaultDb,
  routeUrl?: string,
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
  // Top-level record routes: derive the owning org from the record the URL PREFIX
  // identifies. Prefix, not param name — the generic `:id` is shared across ~10 tables.
  if (routeUrl) {
    for (const rec of RECORD_ORG_ROUTES) {
      if (!routeUrl.startsWith(rec.prefix)) continue
      const id = p[rec.param]
      if (id === undefined) continue // collection/utility sub-route under this prefix
      const row = await rec.find(database, id)
      if (!row) return { scoped: true, orgId: null }          // missing record → fail closed (403)
      if (rec.nullOrgIsGlobal && row.orgId == null) return { scoped: false } // shared global-library item
      return { scoped: true, orgId: row.orgId ?? null }
    }
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

  // The matched route pattern (e.g. `/api/secrets/:id`) disambiguates the generic
  // `:id` param to its owning table for the top-level record routes (AUDIT-MCA HIGH-1).
  const routeUrl = (req as any).routeOptions?.url as string | undefined
  const resolved = await resolveRequestOrg(req.params as any, defaultDb, routeUrl)
  if (!resolved.scoped) return // no org context in this request — nothing to gate

  const result = await enforceOrgRole({ userId, orgId: resolved.orgId, minRole: 'member' })
  if (!result.ok) return reply.code(result.code).send({ error: result.error })
}

export function checkOrgMembership(userId: string, orgId: string, role: OrgRole): { allowed: boolean; reason?: string } {
  const level = ROLE_HIERARCHY[role] ?? 0
  // Utility for testing — actual check is in the preHandler hook above
  return { allowed: level >= ROLE_HIERARCHY.member }
}
