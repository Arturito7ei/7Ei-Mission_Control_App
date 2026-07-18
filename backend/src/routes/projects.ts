import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// ─── PROJECTS ────────────────────────────────────────────────────────────────
//
// GC-0 — WHY THESE SCHEMAS EXIST.
//
// `PATCH /api/projects/:projectId` was `db.update(projects).set(req.body as any)`:
// the raw request body written straight to the row, no parse, no allow-list. Since
// `orgId` is a column, any member of org A could re-home a project into org B with
// `{"orgId":"org-b"}` — a cross-TENANT write, taking the project's board and every
// task hanging off it along with it.
//
// The surface-wide membership gate cannot catch this. `resolveRequestOrg`
// (middleware/rbac.ts) derives the org for `/api/projects/:projectId` FROM THE ROW,
// which it reads BEFORE the handler mutates it. At check time the caller really is a
// member of the project's org, so the gate passes; the handler then moves the row
// out from under it. A gate that authorises against the pre-image cannot defend a
// field that REWRITES the pre-image — only an allow-list can.
//
// THE RULE, matching `toPublicOrg` on the read side: the client names the fields it
// may write, and nothing else is even looked at. A column added to `projects` later
// is unwritable until someone adds it here deliberately.

// The COMPLETE set of project columns a client may write. Deliberately absent:
//   • `orgId`     — the tenant boundary. This is the vulnerability.
//   • `id`        — identity; rewriting it orphans the board and every task.
//   • `createdAt` — immutable provenance, and an audit-ordering input.
// `.strict()` is NOT used: unknown keys are STRIPPED rather than rejected, so a
// client that round-trips a full project object through PATCH (sending back the
// `id`/`orgId`/`createdAt` it was given) still succeeds — it just cannot move the
// row. Rejecting outright would break that benign shape and tempt a caller to
// strip fields client-side, which is not where this decision belongs.
const ProjectPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
})

const ProjectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
})

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/projects', async (req) => {
    const { orgId } = req.params as any
    return { projects: await db.select().from(schema.projects).where(eq(schema.projects.orgId, orgId)) }
  })

  app.post('/api/orgs/:orgId/projects', async (req, reply) => {
    const { orgId } = req.params as any
    const parsed = ProjectCreateSchema.safeParse(req.body ?? {})
    // `name` is NOT NULL in the schema; the unvalidated handler passed `undefined`
    // straight through and turned a client typo into a 500.
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid project' })
    // `orgId` comes from the PATH, never the body — the body cannot name a tenant.
    const project = {
      id: randomUUID(),
      orgId,
      departmentId: parsed.data.departmentId ?? null,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      createdAt: new Date(),
    }
    await db.insert(schema.projects).values(project)
    reply.code(201); return { project }
  })

  app.patch('/api/projects/:projectId', async (req, reply) => {
    const { projectId } = req.params as any
    const parsed = ProjectPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid project' })

    // Resolve the row explicitly so a missing project is an honest 404 rather than a
    // silent no-op `UPDATE ... WHERE id = <nothing>` reporting `{ ok: true }`.
    // (The membership gate 403s a project belonging to another org before we get here.)
    const existing = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) })
    if (!existing) return reply.code(404).send({ error: 'Project not found' })

    // Only the keys the caller actually sent, so PATCH stays a PATCH and an omitted
    // field is left alone rather than nulled.
    const patch = parsed.data
    if (Object.keys(patch).length > 0) {
      await db.update(schema.projects).set(patch).where(eq(schema.projects.id, projectId))
    }
    return { ok: true }
  })

  app.delete('/api/projects/:projectId', async (req, reply) => {
    await db.delete(schema.projects).where(eq(schema.projects.id, (req.params as any).projectId))
    reply.code(204)
  })

  app.get('/api/projects/:projectId/board', async (req) => {
    const { projectId } = req.params as any
    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId))
    return { board: { todo: tasks.filter(t => t.kanbanColumn === 'todo'), in_progress: tasks.filter(t => t.kanbanColumn === 'in_progress'), blocked: tasks.filter(t => t.kanbanColumn === 'blocked'), done: tasks.filter(t => t.kanbanColumn === 'done') } }
  })
}
