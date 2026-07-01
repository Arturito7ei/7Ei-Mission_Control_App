import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and, inArray, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { agentAuth } from '../middleware/agent-token'
import { decrypt, resolveSecretsForAgent } from '../services/secrets'
import { workspaceRuntime } from '../services/workspaces'
import { parseVaultConfig, isSafeVaultPath, isMarkdownPath, vaultList, vaultRead, vaultWrite } from '../services/vault-connector'

const RUNTIME_BRANCH: Record<string, string> = { openclaw: 'claw', cursor: 'cursor', claude_code: 'cc' }

// ─── AGENT-FACING API (MCA-EXT) ────────────────────────────────────────────
//
// Called by external / self-hosted runtimes (OpenClaw, Cursor, custom) using
// their agent token (Authorization: Bearer mca_...). Every route is scoped to
// the single agent resolved from the token (req.agent). NOT Clerk-protected —
// registered in the public scope with its own onRequest hook.

const HeartbeatSchema = z.object({
  status: z.enum(['green', 'amber', 'stale']).default('green'),
  note: z.string().max(500).optional(),
})

const ResultSchema = z.object({
  output: z.string(),
  status: z.enum(['done', 'failed']).default('done'),
})

export async function agentApiRoutes(app: FastifyInstance) {
  app.addHook('onRequest', agentAuth)

  // Identity of the authenticated agent — lets a runtime build its system prompt.
  app.get('/api/agent/me', async (req) => {
    const a = (req as any).agent
    return {
      agent: {
        id: a.id, orgId: a.orgId, name: a.name, role: a.role,
        runtime: a.runtime, llmProvider: a.llmProvider, llmModel: a.llmModel,
        termsOfReference: a.termsOfReference ?? null, persona: a.persona ?? null,
        skills: a.skills ?? [],
      },
    }
  })

  // Scoped secrets for this runtime (MCA-PC D4) — decrypted, company+agent scope.
  // Lets a BYO runtime inject secrets as env without ever putting them in a prompt.
  app.get('/api/agent/secrets', async (req) => {
    const agent = (req as any).agent
    const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.orgId, agent.orgId))
    const decrypted = rows.map(s => { try { return { scope: s.scope, scopeId: s.scopeId, key: s.key, value: decrypt(s.valueEncrypted) } } catch { return null } }).filter(Boolean) as any[]
    return { secrets: resolveSecretsForAgent(decrypted, agent.id) }
  })

  // ── Shared memory (Obsidian vault) ───────────────────────────────────────
  // All agents read/write ONE shared vault (the org's Obsidian repo). This is
  // how agents leave notes other agents can read. Config + token come from the
  // org's Connectors → Obsidian setup. Writes commit as the agent.
  const resolveVault = async (orgId: string) => {
    const rows = await db.select().from(schema.secrets).where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'company')))
    const get = (k: string): string | null => { const r = rows.find(x => x.key === k); if (!r) return null; try { return decrypt(r.valueEncrypted) } catch { return null } }
    return { token: process.env.VAULT_GH_TOKEN || get('GITHUB_VAULT_TOKEN'), cfg: parseVaultConfig(get('VAULT_CONFIG')) }
  }

  app.get('/api/agent/memory/tree', async (req, reply) => {
    const agent = (req as any).agent
    const { token, cfg } = await resolveVault(agent.orgId)
    if (!token) return reply.code(400).send({ error: 'vault not connected' })
    const path = ((req.query as any)?.path) || cfg.root
    if (!isSafeVaultPath(path, cfg.root)) return reply.code(400).send({ error: 'invalid path' })
    const r = await vaultList(token, cfg, path)
    if (!r.ok) return reply.code(r.status).send({ error: `GitHub ${r.status}` })
    return { path, repo: cfg.repo, root: cfg.root, entries: r.entries }
  })

  app.get('/api/agent/memory/file', async (req, reply) => {
    const agent = (req as any).agent
    const { token, cfg } = await resolveVault(agent.orgId)
    if (!token) return reply.code(400).send({ error: 'vault not connected' })
    const path = ((req.query as any)?.path) || ''
    if (!isSafeVaultPath(path, cfg.root) || !isMarkdownPath(path)) return reply.code(400).send({ error: 'invalid path' })
    const r = await vaultRead(token, cfg, path)
    if (!r.ok) return reply.code(r.status).send({ error: `GitHub ${r.status}` })
    return { path, markdown: r.markdown }
  })

  app.put('/api/agent/memory/file', async (req, reply) => {
    const agent = (req as any).agent
    const { token, cfg } = await resolveVault(agent.orgId)
    if (!token) return reply.code(400).send({ error: 'vault not connected' })
    const body = (req.body ?? {}) as any
    const path = String(body.path ?? '')
    if (!isSafeVaultPath(path, cfg.root) || !isMarkdownPath(path)) return reply.code(400).send({ error: 'path must be a .md/.markdown/.txt file inside the vault root' })
    const committer = { name: `${agent.name} (7Ei agent)`, email: 'agents@7ei.ai' }
    const r = await vaultWrite(token, cfg, path, String(body.markdown ?? ''), body.message || `mc(${agent.name}): update ${path}`, committer)
    if (!r.ok) return reply.code(r.status).send({ error: r.error ?? `GitHub ${r.status}` })
    return { ok: true, path, commit: r.commit }
  })

  // Liveness/heartbeat — also returns who the runtime is authenticated as.
  app.post('/api/agent/heartbeat', async (req) => {
    const agent = (req as any).agent
    const { status } = HeartbeatSchema.parse(req.body ?? {})
    await db.update(schema.agents)
      .set({ lastHeartbeatAt: new Date(), heartbeatStatus: status, status: 'idle' })
      .where(eq(schema.agents.id, agent.id))
    return { ok: true, agentId: agent.id, name: agent.name, runtime: agent.runtime }
  })

  // The agent's claimable / active queue. ?state=assigned (default) | in_progress | all
  app.get('/api/agent/tasks', async (req) => {
    const agent = (req as any).agent
    const state = ((req.query as any)?.state ?? 'assigned') as string
    const statusFilter: Record<string, string[]> = {
      assigned: ['assigned'],
      in_progress: ['in_progress'],
      open: ['assigned', 'in_progress'],
      all: ['assigned', 'in_progress', 'pending', 'blocked', 'done', 'failed'],
    }
    const states = statusFilter[state] ?? statusFilter.assigned
    const tasks = await db.select().from(schema.tasks)
      .where(and(eq(schema.tasks.agentId, agent.id), inArray(schema.tasks.status, states)))
      .orderBy(desc(schema.tasks.createdAt)).limit(50)
    // MCA-PC D1: enrich tasks that target a workspace with runtime/branch info.
    const wsIds = [...new Set(tasks.map(t => (t as any).workspaceId).filter(Boolean))] as string[]
    if (wsIds.length) {
      const wss = await db.select().from(schema.workspaces).where(inArray(schema.workspaces.id, wsIds))
      const wmap = new Map(wss.map(w => [w.id, w]))
      const prefix = RUNTIME_BRANCH[agent.runtime] ?? 'op'
      for (const t of tasks as any[]) {
        const w = t.workspaceId ? wmap.get(t.workspaceId) : null
        if (w) t.workspace = workspaceRuntime(w as any, t.id, prefix)
      }
    }
    return { tasks }
  })

  // Claim a task: assigned → in_progress (only this agent's tasks).
  app.post('/api/agent/tasks/:taskId/claim', async (req, reply) => {
    const agent = (req as any).agent
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task || task.agentId !== agent.id) return reply.code(404).send({ error: 'Task not found' })
    if (task.status === 'done') return reply.code(409).send({ error: 'Task already completed' })
    await db.update(schema.tasks).set({ status: 'in_progress', kanbanColumn: 'in_progress' })
      .where(eq(schema.tasks.id, taskId))
    await db.update(schema.agents).set({ status: 'active' }).where(eq(schema.agents.id, agent.id))
    return { ok: true, task: { ...task, status: 'in_progress' } }
  })

  // Post the result of a task: done | failed.
  app.post('/api/agent/tasks/:taskId/result', async (req, reply) => {
    const agent = (req as any).agent
    const { taskId } = req.params as any
    const { output, status } = ResultSchema.parse(req.body ?? {})
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task || task.agentId !== agent.id) return reply.code(404).send({ error: 'Task not found' })
    await db.update(schema.tasks)
      .set({
        output, status, kanbanColumn: status === 'done' ? 'done' : 'blocked',
        inboxState: status === 'done' ? 'awaiting_review' : 'needs_attention',  // MCA-PC A3
        completedAt: new Date(),
      })
      .where(eq(schema.tasks.id, taskId))
    await db.insert(schema.messages).values({
      id: randomUUID(), agentId: agent.id, taskId, role: 'assistant', content: output, createdAt: new Date(),
    })
    await db.update(schema.agents)
      .set({ status: 'idle', lastHeartbeatAt: new Date(), heartbeatStatus: 'green' })
      .where(eq(schema.agents.id, agent.id))
    return { ok: true }
  })

  // Request human sign-off for a sensitive action (MCA-PC B2).
  app.post('/api/agent/approvals', async (req, reply) => {
    const agent = (req as any).agent
    const { type, summary, payload } = (req.body ?? {}) as any
    if (!type || !summary) return reply.code(400).send({ error: 'type and summary required' })
    await db.insert(schema.approvalRequests).values({
      id: randomUUID(), orgId: agent.orgId, type, summary, payload: payload ?? null,
      status: 'pending', requestedByAgentId: agent.id, decidedBy: null, decidedAt: null, createdAt: new Date(),
    } as any)
    return { ok: true }
  })

  // Free-form progress / chatter message from the runtime.
  app.post('/api/agent/messages', async (req) => {
    const agent = (req as any).agent
    const { taskId, content } = (req.body as any) ?? {}
    await db.insert(schema.messages).values({
      id: randomUUID(), agentId: agent.id, taskId: taskId ?? null, role: 'assistant',
      content: String(content ?? ''), createdAt: new Date(),
    })
    return { ok: true }
  })
}
