import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and, inArray, desc, isNull } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { agentAuth } from '../middleware/agent-token'
import { decrypt, resolveSecretsForAgent, AGENT_RESOLVABLE_SCOPES } from '../services/secrets'
import { workspaceRuntime } from '../services/workspaces'
import { parseVaultConfig, isSafeVaultPath, isMarkdownPath, vaultList, vaultRead, vaultWrite } from '../services/vault-connector'
import { parseBlockedBy, blockersSatisfied, isClaimable, appendLog } from '../services/runs'
import { agentRecentPath, appendSection, formatSessionSummary } from '../services/agent-memory'
import { parseCapabilities, isCapabilityAllowed, signRunToken, requiresApproval } from '../services/governance2'
import { prepareApprovalRecord } from '../services/dangerous-approvals'
import { notifyApprovalCreated } from '../services/push'
import { documentEndpoint } from '../services/openapi'

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

const SessionSummarySchema = z.object({
  focus: z.string().min(1).max(2000),
  completed: z.string().max(4000).optional(),
  blockers: z.string().max(2000).optional(),
  next: z.string().max(2000).optional(),
  date: z.string().optional(),
})

const ResultSchema = z.object({
  output: z.string(),
  status: z.enum(['done', 'failed']).default('done'),
  runId: z.string().optional(),
  tokensUsed: z.number().optional(),
  costUsd: z.number().optional(),
})

// Request-body shapes for routes that validate ad-hoc (used only to enrich
// /api/openapi.json — the runtime validation stays inline in each handler).
const CommentBody = z.object({ body: z.string().max(4000) })
const RunLogBody = z.object({ log: z.string().optional(), sessionState: z.string().optional(), tokensUsed: z.number().optional(), costUsd: z.number().optional() })
const MemoryWriteBody = z.object({ path: z.string(), markdown: z.string(), message: z.string().optional() })
const AttachmentBody = z.object({ url: z.string().optional(), name: z.string().optional(), markdown: z.string().optional(), contentType: z.string().optional() })
const RuntimeBody = z.object({ status: z.string().optional(), previewUrl: z.string().optional(), devUrl: z.string().optional() })
const RunTokenBody = z.object({ runId: z.string().optional() })
const ApprovalBody = z.object({ type: z.string(), summary: z.string(), payload: z.any().optional() })
const MessageBody = z.object({ taskId: z.string().optional(), content: z.string() })
const PluginResultBody = z.object({ status: z.enum(['done', 'failed']).optional(), result: z.any().optional() })

// Self-describing API (MCA-85 D1): summaries + request bodies for the whole
// agent-facing surface — this is what a BYO runtime reads to configure itself.
function documentAgentApi() {
  documentEndpoint('GET', '/api/agent/me', { summary: 'Identity of the authenticated agent (build a system prompt from it)' })
  documentEndpoint('GET', '/api/agent/secrets', { summary: 'Decrypted company+agent-scoped secrets to inject as env' })
  documentEndpoint('GET', '/api/agent/memory/tree', { summary: 'List the shared Obsidian vault at ?path=' })
  documentEndpoint('GET', '/api/agent/memory/file', { summary: 'Read a markdown note from the vault at ?path=' })
  documentEndpoint('PUT', '/api/agent/memory/file', { summary: 'Write a markdown note to the vault (commits as the agent)', body: MemoryWriteBody })
  documentEndpoint('POST', '/api/agent/memory/session-summary', { summary: 'Append a session-continuity summary to the agent’s own recent.md', body: SessionSummarySchema })
  documentEndpoint('POST', '/api/agent/runs/:id/log', { summary: 'Stream run progress: append a log line, update cost/tokens, persist sessionState', body: RunLogBody })
  documentEndpoint('POST', '/api/agent/tasks/:taskId/comment', { summary: 'Comment on a task thread as the agent', body: CommentBody })
  documentEndpoint('POST', '/api/agent/tasks/:taskId/attachment', { summary: 'Attach a work product (markdown → vault) or a link', body: AttachmentBody })
  documentEndpoint('POST', '/api/agent/workspaces/:id/runtime', { summary: 'Report a running dev server + preview URL for a workspace', body: RuntimeBody })
  documentEndpoint('POST', '/api/agent/run-token', { summary: 'Mint a short-lived HMAC per-run token scoped to this agent', body: RunTokenBody })
  documentEndpoint('GET', '/api/agent/plugin-jobs', { summary: 'Pull up to 5 queued plugin jobs for this org' })
  documentEndpoint('POST', '/api/agent/plugin-jobs/:id/claim', { summary: 'Atomically claim a queued plugin job' })
  documentEndpoint('POST', '/api/agent/plugin-jobs/:id/result', { summary: 'Report a plugin job result (done|failed)', body: PluginResultBody })
  documentEndpoint('POST', '/api/agent/heartbeat', { summary: 'Liveness heartbeat; returns who the runtime is authenticated as', body: HeartbeatSchema })
  documentEndpoint('GET', '/api/agent/tasks', { summary: 'This agent’s queue. ?state=assigned|in_progress|open|all' })
  documentEndpoint('POST', '/api/agent/tasks/:taskId/claim', { summary: 'Atomic checkout: assigned → in_progress (returns runId + sessionState)' })
  documentEndpoint('POST', '/api/agent/tasks/:taskId/result', { summary: 'Report a task result (done|failed)', body: ResultSchema })
  documentEndpoint('POST', '/api/agent/approvals', { summary: 'Request human sign-off for a sensitive action', body: ApprovalBody })
  documentEndpoint('POST', '/api/agent/messages', { summary: 'Free-form progress/chatter message from the runtime', body: MessageBody })
}

export async function agentApiRoutes(app: FastifyInstance) {
  app.addHook('onRequest', agentAuth)
  documentAgentApi()

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
  //
  // AUDIT-ONB3 M-3: the scope filter is in the WHERE clause, not only in the resolver.
  // ONB3 parks a PENDING joining agent's declared secrets in a `join_request` scope
  // whose inertness depends on `resolveSecretsForAgent` ignoring it — so this query
  // used to fetch and DECRYPT those rows on every agent poll before throwing them
  // away. Filter first: an unapprovable secret is never read out of the DB at all.
  app.get('/api/agent/secrets', async (req) => {
    const agent = (req as any).agent
    const rows = await db.select().from(schema.secrets).where(and(
      eq(schema.secrets.orgId, agent.orgId),
      inArray(schema.secrets.scope, [...AGENT_RESOLVABLE_SCOPES]),
    ))
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
    // S4.2 capability gate + S4.1 execution policy gate.
    if (!isCapabilityAllowed(parseCapabilities(agent.permissions), 'memory:write')) return reply.code(403).send({ error: 'agent lacks capability memory:write' })
    const pols = await db.select().from(schema.executionPolicies).where(and(eq(schema.executionPolicies.orgId, agent.orgId), eq(schema.executionPolicies.action, 'memory.write')))
    if (requiresApproval(pols as any, 'memory.write')) {
      const approvalId = randomUUID()
      const summary = `${agent.name} → write ${String((req.body as any)?.path ?? '')}`
      await db.insert(schema.approvalRequests).values({ id: approvalId, orgId: agent.orgId, type: 'memory.write', summary, payload: { agentId: agent.id, path: (req.body as any)?.path }, status: 'pending', requestedByAgentId: agent.id, decidedBy: null, decidedAt: null, createdAt: new Date() } as any)
      notifyApprovalCreated({ id: approvalId, orgId: agent.orgId, type: 'memory.write', summary }).catch(() => {})
      return reply.code(202).send({ pending: true, error: 'requires human approval (policy: memory.write)' })
    }
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

  // MCA-75 — append a session-continuity summary to the agent's OWN recent.md.
  // The path is derived from the agent's name; the agent cannot choose it.
  app.post('/api/agent/memory/session-summary', async (req, reply) => {
    const agent = (req as any).agent
    // S4.2 capability gate + S4.1 execution policy gate (same action as memory/file).
    if (!isCapabilityAllowed(parseCapabilities(agent.permissions), 'memory:write')) return reply.code(403).send({ error: 'agent lacks capability memory:write' })
    const pols = await db.select().from(schema.executionPolicies).where(and(eq(schema.executionPolicies.orgId, agent.orgId), eq(schema.executionPolicies.action, 'memory.write')))
    if (requiresApproval(pols as any, 'memory.write')) {
      const approvalId = randomUUID()
      const summary = `${agent.name} → session summary`
      await db.insert(schema.approvalRequests).values({ id: approvalId, orgId: agent.orgId, type: 'memory.write', summary, payload: { agentId: agent.id }, status: 'pending', requestedByAgentId: agent.id, decidedBy: null, decidedAt: null, createdAt: new Date() } as any)
      notifyApprovalCreated({ id: approvalId, orgId: agent.orgId, type: 'memory.write', summary }).catch(() => {})
      return reply.code(202).send({ pending: true, error: 'requires human approval (policy: memory.write)' })
    }
    const { token, cfg } = await resolveVault(agent.orgId)
    if (!token) return reply.code(400).send({ error: 'vault not connected' })
    const body = SessionSummarySchema.parse(req.body ?? {})
    const date = body.date || new Date().toISOString().slice(0, 10)
    const path = agentRecentPath(agent.name, cfg.root)
    const existing = await vaultRead(token, cfg, path)
    const markdown = appendSection(
      existing.ok ? existing.markdown : undefined,
      formatSessionSummary({ date, focus: body.focus, completed: body.completed, blockers: body.blockers, next: body.next, agentName: agent.name }),
    )
    const committer = { name: `${agent.name} (7Ei agent)`, email: 'agents@7ei.ai' }
    const r = await vaultWrite(token, cfg, path, markdown, `mc(${agent.name}): session summary ${date}`, committer)
    if (!r.ok) return reply.code(r.status).send({ error: r.error ?? `GitHub ${r.status}` })
    return { ok: true, path, commit: r.commit }
  })

  // S1.2 — stream a run's progress: append a log line, update running cost/tokens,
  // and persist sessionState so the next heartbeat resumes instead of restarting.
  app.post('/api/agent/runs/:id/log', async (req, reply) => {
    const agent = (req as any).agent
    const { id } = req.params as any
    const body = (req.body ?? {}) as any
    const run = await db.query.agentRuns.findFirst({ where: eq(schema.agentRuns.id, id) })
    if (!run || run.agentId !== agent.id) return reply.code(404).send({ error: 'Run not found' })
    const patch: any = { updatedAt: new Date() }
    if (typeof body.log === 'string') patch.logs = appendLog(run.logs, body.log)
    if (typeof body.sessionState === 'string') patch.sessionState = body.sessionState
    if (typeof body.tokensUsed === 'number') patch.tokensUsed = body.tokensUsed
    if (typeof body.costUsd === 'number') patch.costUsd = body.costUsd
    await db.update(schema.agentRuns).set(patch).where(eq(schema.agentRuns.id, id))
    return { ok: true }
  })

  // S1.4 — comment on a task (ticket discussion), authored by the agent.
  app.post('/api/agent/tasks/:taskId/comment', async (req, reply) => {
    const agent = (req as any).agent
    const { taskId } = req.params as any
    const body = (req.body ?? {}) as any
    if (!body.body) return reply.code(400).send({ error: 'body required' })
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task || task.orgId !== agent.orgId) return reply.code(404).send({ error: 'Task not found' })
    const row = { id: randomUUID(), orgId: agent.orgId, taskId, authorAgentId: agent.id, authorUser: null, body: String(body.body).slice(0, 4000), createdAt: new Date() }
    await db.insert(schema.taskComments).values(row)
    return { ok: true, comment: row }
  })

  // MCA-WORK S3.1 — attach a work product (markdown → committed to the vault) or a link.
  app.post('/api/agent/tasks/:taskId/attachment', async (req, reply) => {
    const agent = (req as any).agent
    const { taskId } = req.params as any
    const b = (req.body ?? {}) as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task || task.orgId !== agent.orgId) return reply.code(404).send({ error: 'Task not found' })
    if (!isCapabilityAllowed(parseCapabilities(agent.permissions), 'attachment:write')) return reply.code(403).send({ error: 'agent lacks capability attachment:write' })
    let kind = 'link', url: string | null = b.url ?? null, name = b.name ?? 'attachment', sha: string | null = null
    if (typeof b.markdown === 'string') {
      const { token, cfg } = await resolveVault(agent.orgId)
      if (!token) return reply.code(400).send({ error: 'vault not connected (required for work products)' })
      const safeName = String(b.name || `work-product-${Date.now()}.md`).replace(/[^A-Za-z0-9._-]/g, '-')
      const path = `${cfg.root}/07-Agents/work-products/${taskId}/${safeName}`
      if (!isMarkdownPath(path)) return reply.code(400).send({ error: 'work product name must end .md/.markdown/.txt' })
      const w = await vaultWrite(token, cfg, path, b.markdown, `mc(${agent.name}): work product for ${taskId}`, { name: `${agent.name} (7Ei agent)`, email: 'agents@7ei.ai' })
      if (!w.ok) return reply.code(w.status).send({ error: w.error ?? `GitHub ${w.status}` })
      kind = 'work_product'; url = `vault:${path}`; name = safeName; sha = w.commit ?? null
    } else if (!url) {
      return reply.code(400).send({ error: 'provide markdown (work product) or url (link)' })
    }
    const row = { id: randomUUID(), orgId: agent.orgId, taskId, kind, name: String(name).slice(0, 300), url, contentType: b.contentType ?? (kind === 'work_product' ? 'text/markdown' : null), sizeBytes: null, sha, createdByAgentId: agent.id, createdByUser: null, createdAt: new Date() }
    await db.insert(schema.taskAttachments).values(row)
    return { ok: true, attachment: row }
  })

  // MCA-WORK S3.3 — report a running dev server + preview URL for a workspace.
  app.post('/api/agent/workspaces/:id/runtime', async (req, reply) => {
    const agent = (req as any).agent
    const { id } = req.params as any
    const b = (req.body ?? {}) as any
    const ws = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.id, id) })
    if (!ws || ws.orgId !== agent.orgId) return reply.code(404).send({ error: 'Workspace not found' })
    const patch: any = { runtimeStatus: b.status ?? 'running' }
    if (typeof b.previewUrl === 'string') patch.previewUrl = b.previewUrl
    if (typeof b.devUrl === 'string') patch.devUrl = b.devUrl
    await db.update(schema.workspaces).set(patch).where(eq(schema.workspaces.id, id))
    return { ok: true, workspaceId: id, runtimeStatus: patch.runtimeStatus }
  })

  // MCA-GOV2 S4.3 — mint a short-lived per-run token (HMAC) scoped to this agent.
  app.post('/api/agent/run-token', async (req, reply) => {
    const agent = (req as any).agent
    const b = (req.body ?? {}) as any
    const secret = process.env.RUN_TOKEN_SECRET || process.env.SECRETS_ENC_KEY || 'dev-7ei-mc-run'
    const token = signRunToken({ agentId: agent.id, orgId: agent.orgId, runId: b.runId ?? null }, secret)
    return { token, tokenType: 'run', expiresInSec: 900 }
  })

  // MCA-GOV2 S4.4 — plugin worker: pull queued jobs, claim atomically, report result.
  app.get('/api/agent/plugin-jobs', async (req) => {
    const agent = (req as any).agent
    const jobs = await db.select().from(schema.pluginJobs)
      .where(and(eq(schema.pluginJobs.orgId, agent.orgId), eq(schema.pluginJobs.status, 'queued')))
      .orderBy(schema.pluginJobs.createdAt).limit(5)
    return { jobs }
  })
  app.post('/api/agent/plugin-jobs/:id/claim', async (req, reply) => {
    const agent = (req as any).agent
    const { id } = req.params as any
    const job = await db.query.pluginJobs.findFirst({ where: eq(schema.pluginJobs.id, id) })
    if (!job || job.orgId !== agent.orgId) return reply.code(404).send({ error: 'Job not found' })
    const res: any = await db.update(schema.pluginJobs).set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(schema.pluginJobs.id, id), eq(schema.pluginJobs.status, 'queued')))
    if ((res?.rowsAffected ?? 0) === 0) return reply.code(409).send({ error: 'already claimed' })
    return { ok: true, job: { ...job, status: 'running' } }
  })
  app.post('/api/agent/plugin-jobs/:id/result', async (req, reply) => {
    const agent = (req as any).agent
    const { id } = req.params as any
    const b = (req.body ?? {}) as any
    const job = await db.query.pluginJobs.findFirst({ where: eq(schema.pluginJobs.id, id) })
    if (!job || job.orgId !== agent.orgId) return reply.code(404).send({ error: 'Job not found' })
    await db.update(schema.pluginJobs).set({ status: b.status === 'failed' ? 'failed' : 'done', result: b.result ? JSON.stringify(b.result) : null, updatedAt: new Date() }).where(eq(schema.pluginJobs.id, id))
    return { ok: true }
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

    // S1.4 — all blocker dependencies must be done first.
    const blockers = parseBlockedBy((task as any).blockedBy)
    if (blockers.length) {
      const rows = await db.select({ status: schema.tasks.status }).from(schema.tasks).where(inArray(schema.tasks.id, blockers))
      if (!blockersSatisfied(rows.map(r => r.status))) {
        return reply.code(409).send({ error: 'Task is blocked by unfinished dependencies', blockedBy: blockers })
      }
    }

    // S1.1 — atomic checkout. Claim when assigned, or reclaim an in_progress task
    // whose lease has expired (orphaned run). Compare-and-swap on the lock owner
    // so exactly one concurrent claimer wins.
    if (!isClaimable(task as any)) return reply.code(409).send({ error: 'Task is locked by an active run' })
    const lockToken = randomUUID()
    const now = new Date()
    const guard = task.status === 'assigned'
      ? and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'assigned'))
      : and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'in_progress'),
          task.lockToken ? eq(schema.tasks.lockToken, task.lockToken) : isNull(schema.tasks.lockToken))
    const res: any = await db.update(schema.tasks)
      .set({ status: 'in_progress', kanbanColumn: 'in_progress', lockToken, lockedAt: now })
      .where(guard)
    if ((res?.rowsAffected ?? 0) === 0) return reply.code(409).send({ error: 'Task was just claimed by another run' })

    // S1.2 — orphan any stale running runs for this task, then start a fresh run,
    // resuming sessionState from the most recent prior run so work continues.
    await db.update(schema.agentRuns).set({ status: 'orphaned', endedAt: now })
      .where(and(eq(schema.agentRuns.taskId, taskId), eq(schema.agentRuns.status, 'running')))
    const prior = await db.select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.taskId, taskId)).orderBy(desc(schema.agentRuns.startedAt)).limit(1)
    const sessionState = prior[0]?.sessionState ?? null
    const runId = randomUUID()
    await db.insert(schema.agentRuns).values({
      id: runId, orgId: agent.orgId, agentId: agent.id, taskId, status: 'running',
      sessionState, logs: null, tokensUsed: null, costUsd: null, startedAt: now, updatedAt: now, endedAt: null,
    })
    await db.update(schema.agents).set({ status: 'active' }).where(eq(schema.agents.id, agent.id))
    return { ok: true, runId, sessionState, task: { ...task, status: 'in_progress', lockToken } }
  })

  // Post the result of a task: done | failed.
  app.post('/api/agent/tasks/:taskId/result', async (req, reply) => {
    const agent = (req as any).agent
    const { taskId } = req.params as any
    const parsed = ResultSchema.parse(req.body ?? {})
    const { output, status } = parsed
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task || task.agentId !== agent.id) return reply.code(404).send({ error: 'Task not found' })
    const now = new Date()
    await db.update(schema.tasks)
      .set({
        output, status, kanbanColumn: status === 'done' ? 'done' : 'blocked',
        inboxState: status === 'done' ? 'awaiting_review' : 'needs_attention',  // MCA-PC A3
        completedAt: now,
        lockToken: null, lockedAt: null,  // S1.1 release the execution lock
        tokensUsed: parsed.tokensUsed ?? task.tokensUsed, costUsd: parsed.costUsd ?? task.costUsd,
      })
      .where(eq(schema.tasks.id, taskId))
    // S1.2 finish the run (explicit runId, else the task's running run)
    const runWhere = parsed.runId
      ? eq(schema.agentRuns.id, parsed.runId)
      : and(eq(schema.agentRuns.taskId, taskId), eq(schema.agentRuns.status, 'running'))
    await db.update(schema.agentRuns)
      .set({ status: status === 'done' ? 'done' : 'failed', endedAt: now, updatedAt: now,
        tokensUsed: parsed.tokensUsed ?? undefined, costUsd: parsed.costUsd ?? undefined })
      .where(runWhere)
    await db.insert(schema.messages).values({
      id: randomUUID(), agentId: agent.id, taskId, role: 'assistant', content: output, createdAt: new Date(),
    })
    // MCA-83 W1: post a system-notice to the ticket thread on failure → recovery card.
    if (status !== 'done') {
      await db.insert(schema.taskComments).values({
        id: randomUUID(), orgId: task.orgId, taskId, authorAgentId: null, authorUser: null,
        kind: 'system_notice', body: `Agent reported failure${output ? `: ${String(output).slice(0, 1000)}` : '.'}`,
        createdAt: new Date(),
      }).catch(() => {})
    }
    await db.update(schema.agents)
      .set({ status: 'idle', lastHeartbeatAt: new Date(), heartbeatStatus: 'green' })
      .where(eq(schema.agents.id, agent.id))
    return { ok: true }
  })

  // Request human sign-off for a sensitive action (MCA-PC B2).
  //
  // CC2 — for a DANGEROUS type (machine_exec / file_destructive / wallet_tx /
  // email_send) the summary is MACHINE-rendered VERBATIM from the structured
  // `action` (never the agent's prose), fail-closed on a bad payload, and tagged
  // `requiresStepUp`. This is the propose-and-approve bridge: when the Claude
  // Code adapter proposes a command it files `{type:'machine_exec', action:{argv,…}}`
  // and the human approves the exact argv (with a fresh session), never model text.
  app.post('/api/agent/approvals', async (req, reply) => {
    const agent = (req as any).agent
    const b = (req.body ?? {}) as any
    if (!b.type) return reply.code(400).send({ error: 'type is required' })
    const prepared = prepareApprovalRecord({ type: b.type, summary: b.summary, action: b.action, payload: b.payload })
    if (!prepared.ok) return reply.code(400).send({ error: prepared.error })
    const approval = {
      id: randomUUID(), orgId: agent.orgId, type: b.type, summary: prepared.summary, payload: prepared.payload ?? null,
      status: 'pending', requestedByAgentId: agent.id, decidedBy: null, decidedAt: null, createdAt: new Date(),
    }
    await db.insert(schema.approvalRequests).values(approval as any)
    // MOB-3B: an agent-proposed approval (incl. dangerous types) pings the owner's phone.
    notifyApprovalCreated({ id: approval.id, orgId: agent.orgId, type: approval.type, summary: approval.summary }).catch(() => {})
    return { ok: true, approval, warnings: prepared.warnings }
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
