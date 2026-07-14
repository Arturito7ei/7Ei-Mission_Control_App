// Epic AG — routes behind the per-agent detail page. Everything here is
// org-scoped (`/api/orgs/:orgId/agents/:agentId/...`) so `requireOrgRole` can
// actually gate it — the RBAC helper reads `:orgId` from the path and silently
// no-ops without it, which is why these do NOT live under `/api/agents/:id/...`.
//
// Aggregation is pure (`services/agent-overview.ts`); these handlers only fetch
// rows and hand them over.
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { requireOrgRole } from '../middleware/rbac'
import { buildAgentOverview, OVERVIEW_DAYS } from '../services/agent-overview'
import {
  MAX_EXTRA_FILES, isManaged, listBundle, normalizeFileName, readFile, validateContent,
} from '../services/agent-files'
import { resolveSelection, splitSkills } from '../services/agent-skills'
import { validateConfigPatch } from '../services/agent-config'
import { buildAvatarDataUri } from '../services/agent-avatar'

/** The agent, but only if it belongs to this org. Null otherwise (→ 404). */
export async function agentInOrg(orgId: string, agentId: string) {
  const agent = await db.query.agents.findFirst({
    where: and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)),
  })
  return agent ?? null
}

export async function agentDetailRoutes(app: FastifyInstance) {
  // AG2 — Dashboard tab: latest run, 14-day charts, recent tasks, costs.
  app.get('/api/orgs/:orgId/agents/:agentId/overview', async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const windowStart = new Date(Date.now() - OVERVIEW_DAYS * 86_400_000)

    const [runs, tasks] = await Promise.all([
      db.select().from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agentId)))
        .orderBy(desc(schema.agentRuns.startedAt)).limit(200),
      db.select().from(schema.tasks)
        .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.agentId, agentId)))
        .orderBy(desc(schema.tasks.createdAt)).limit(200),
    ])

    // Charts cover the window; the Costs strip covers the same window's tasks so
    // the numbers on screen belong to the period the charts claim to show.
    const windowTasks = tasks.filter(t => (t.createdAt?.getTime() ?? 0) >= windowStart.getTime())

    return {
      overview: buildAgentOverview({ agentId, runs, tasks: windowTasks, now: Date.now() }),
      // Recent tasks are the agent's newest overall, not window-clipped — an idle
      // agent should still show what it last worked on.
      recentTasks: buildAgentOverview({ agentId, runs: [], tasks, now: Date.now() }).recentTasks,
    }
  })

  // AG2/AG6 — the agent's run history (there was only a per-task runs route).
  app.get('/api/orgs/:orgId/agents/:agentId/runs', async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const { limit } = req.query as { limit?: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
    const runs = await db.select().from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agentId)))
      .orderBy(desc(schema.agentRuns.startedAt)).limit(n)
    return { runs }
  })

  // ─── AG3 — Instructions: the managed markdown bundle ────────────────────────
  // Owner-gated: these files ARE the agent's instructions, so editing one changes
  // what the agent does. Reading is owner-gated too — SOUL.md/AGENTS.md can carry
  // operating detail that is not for every member.

  const filesOf = (orgId: string, agentId: string) =>
    db.select().from(schema.agentFiles)
      .where(and(eq(schema.agentFiles.orgId, orgId), eq(schema.agentFiles.agentId, agentId)))

  // List the bundle: always the four managed files (stored or not) + any extras.
  app.get('/api/orgs/:orgId/agents/:agentId/files', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const rows = await filesOf(orgId, agentId)
    return { files: listBundle(rows, { ...agent, skills: (agent.skills as string[]) ?? [] }) }
  })

  // Read one file. A managed file that has never been saved returns its generated
  // default with `stored:false` — the editor always has something to show.
  app.get('/api/orgs/:orgId/agents/:agentId/files/content', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const path = normalizeFileName((req.query as { path?: string }).path)
    if (!path) return reply.code(400).send({ error: 'Invalid file name. Use a bare .md filename.' })

    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const rows = await filesOf(orgId, agentId)
    const file = readFile(rows, path, { ...agent, skills: (agent.skills as string[]) ?? [] })
    if (!file) return reply.code(404).send({ error: 'File not found' })
    return { path, ...file, managed: isManaged(path) }
  })

  // Create or update a file (upsert on the unique (agent_id, path) index).
  app.put('/api/orgs/:orgId/agents/:agentId/files', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const body = (req.body ?? {}) as { path?: string; content?: string }

    const path = normalizeFileName(body.path)
    if (!path) return reply.code(400).send({ error: 'Invalid file name. Use a bare .md filename (no paths).' })

    const content = body.content ?? ''
    const valid = validateContent(content)
    if (valid.ok === false) return reply.code(400).send({ error: valid.error })

    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const rows = await filesOf(orgId, agentId)
    const existing = rows.find(r => r.path === path)

    // Cap the extras so a bundle can't grow without bound.
    if (!existing && !isManaged(path)) {
      const extras = rows.filter(r => !isManaged(r.path)).length
      if (extras >= MAX_EXTRA_FILES) return reply.code(400).send({ error: `An agent may have at most ${MAX_EXTRA_FILES} extra files.` })
    }

    const now = new Date()
    if (existing) {
      await db.update(schema.agentFiles).set({ content, updatedAt: now }).where(eq(schema.agentFiles.id, existing.id))
    } else {
      await db.insert(schema.agentFiles).values({ id: randomUUID(), orgId, agentId, path, content, createdAt: now, updatedAt: now })
    }
    return { file: { path, bytes: Buffer.byteLength(content, 'utf8'), managed: isManaged(path), stored: true, updatedAt: now.getTime() } }
  })

  // Delete an extra file. A managed file cannot be deleted — clearing its content
  // is how you empty it, and deleting its row would just resurrect the default.
  app.delete('/api/orgs/:orgId/agents/:agentId/files', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const path = normalizeFileName((req.query as { path?: string }).path)
    if (!path) return reply.code(400).send({ error: 'Invalid file name.' })
    if (isManaged(path)) return reply.code(400).send({ error: `${path} is a managed file and cannot be deleted. Clear its contents instead.` })

    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    await db.delete(schema.agentFiles)
      .where(and(eq(schema.agentFiles.agentId, agentId), eq(schema.agentFiles.orgId, orgId), eq(schema.agentFiles.path, path)))
    return reply.code(204).send()
  })

  // ─── AG4 — Skills: the company library, split by what this agent has ───────

  // Read is member-visible (the roster shows skill counts already).
  app.get('/api/orgs/:orgId/agents/:agentId/skills', async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const library = await db.select().from(schema.skills)
    const split = splitSkills(library, (agent.skills as string[]) ?? [])
    return {
      ...split,
      // Footer of the mockup: which adapter these skills get applied to.
      adapter: agent.runtime,
      model: agent.primaryModel || agent.llmModel,
    }
  })

  // Write the WHOLE selection. Install and uninstall are the same idempotent call,
  // which is what the checkbox list actually means — and it's the only uninstall
  // path that exists (the legacy route could only append).
  app.put('/api/orgs/:orgId/agents/:agentId/skills', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const library = await db.select().from(schema.skills)
    const resolved = resolveSelection(library, (req.body as { skills?: unknown })?.skills)
    if (resolved.ok === false) return reply.code(400).send({ error: resolved.error })

    await db.update(schema.agents).set({ skills: resolved.names }).where(eq(schema.agents.id, agentId))
    const after = await agentInOrg(orgId, agentId)

    // Same audit trail as any other config change (MCA-GOV2 S4.1).
    await db.insert(schema.configRevisions).values({
      id: randomUUID(), orgId, entity: 'agent', entityId: agentId,
      before: JSON.stringify(agent), after: JSON.stringify(after),
      actor: (req as any).userId ?? 'human', createdAt: new Date(),
    }).catch(() => {})

    return { ...splitSkills(library, resolved.names), adapter: agent.runtime, model: agent.primaryModel || agent.llmModel }
  })

  // ─── AG5 — Configuration: identity, reports-to, adapter/model, avatar ──────

  /** Snapshot every config change for audit + rollback (MCA-GOV2 S4.1). */
  const snapshot = async (orgId: string, agentId: string, before: unknown, after: unknown, req: unknown) =>
    db.insert(schema.configRevisions).values({
      id: randomUUID(), orgId, entity: 'agent', entityId: agentId,
      before: JSON.stringify(before), after: JSON.stringify(after),
      actor: (req as { userId?: string }).userId ?? 'human', createdAt: new Date(),
    }).catch(() => {})

  // Owner-gated + field-allowlisted. Deliberately NOT the legacy
  // `PATCH /api/agents/:agentId`, which takes an unvalidated body straight into
  // db.update and is not owner-gated — the config surface must not widen that.
  app.put('/api/orgs/:orgId/agents/:agentId/config', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const roster = await db.select({ id: schema.agents.id, reportsTo: schema.agents.reportsTo })
      .from(schema.agents).where(eq(schema.agents.orgId, orgId))

    const result = validateConfigPatch((req.body ?? {}) as Record<string, unknown>, { agentId, agents: roster })
    if (result.ok === false) return reply.code(400).send({ error: result.error })

    await db.update(schema.agents).set(result.fields).where(eq(schema.agents.id, agentId))
    const after = await agentInOrg(orgId, agentId)
    await snapshot(orgId, agentId, agent, after, req)
    return { agent: after }
  })

  // Avatar upload (multipart). The image is stored as a capped data URI on the
  // agent row — see services/agent-avatar.ts for why there is no blob store.
  app.post('/api/orgs/:orgId/agents/:agentId/avatar', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const file = await (req as any).file?.()
    if (!file) return reply.code(400).send({ error: 'No image uploaded.' })

    let data: Buffer
    try {
      data = await file.toBuffer()
    } catch {
      // @fastify/multipart throws when the 25MB transport limit is exceeded.
      return reply.code(400).send({ error: 'That image is too large to upload.' })
    }

    const built = buildAvatarDataUri(file.mimetype, data)
    if (built.ok === false) return reply.code(400).send({ error: built.error })

    await db.update(schema.agents).set({ avatarUrl: built.dataUri }).where(eq(schema.agents.id, agentId))
    await snapshot(orgId, agentId, { avatarUrl: agent.avatarUrl }, { avatarUrl: '(image updated)' }, req)
    return { avatarUrl: built.dataUri, bytes: built.bytes, contentType: built.contentType }
  })

  // Remove the picture — the agent falls back to its icon/emoji.
  app.delete('/api/orgs/:orgId/agents/:agentId/avatar', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as { orgId: string; agentId: string }
    const agent = await agentInOrg(orgId, agentId)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    await db.update(schema.agents).set({ avatarUrl: null }).where(eq(schema.agents.id, agentId))
    await snapshot(orgId, agentId, { avatarUrl: agent.avatarUrl }, { avatarUrl: null }, req)
    return reply.code(204).send()
  })
}
