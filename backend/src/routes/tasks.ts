import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { executeAgentTask } from '../services/agent-executor'
import { assertAgentInOrg } from '../services/tenant-guard'
import { buildInbox } from '../services/inbox'
import { buildGoalTree } from '../services/goals'
import { runHeartbeatSweep } from '../services/heartbeat-engine'
import { spendForScope, evaluatePolicy } from '../services/budget'
import { buildExport, remapImport } from '../services/portability'
import { encrypt, decrypt, maskValue } from '../services/secrets'
import { isSafeVaultPath, isMarkdownPath, parseVaultConfig, vaultList, vaultRead, vaultWrite, vaultTree } from '../services/vault-connector'
import { buildNativeGraph, capGraph, selectGraphifyGraph, type VaultGraph } from '../services/vault-graph'

// In-memory cache for the (expensive) native vault-graph build — keyed per
// org+config. Small and TTL-bounded; a process restart just rebuilds on demand.
const graphCache = new Map<string, { at: number; graph: any }>()
import { normalizeAttachmentKind, buildTimeline } from '../services/tickets'
import { buildRecovery } from '../services/recovery'
import { rollupCost } from '../services/worksurface'
import { decideWake, hasActiveRun, threadHistory, buildWakeInput } from '../services/thread'
import { normalizeWorkMode } from '../services/askmode'
import { parseWatchdogSpec } from '../services/watchdogs'
import { decideApproval } from '../services/approvals'
import { toPublicApproval } from '../services/approval-public'
import { notifyApprovalCreated } from '../services/push'
// Epic ONB / ONB3 — deciding an `agent_join_request` card in this queue IS the
// board-approval gate; it runs the same decision path as the dedicated owner routes.
import { JOIN_APPROVAL_TYPE, joinRequestView, parseJoinDecision } from '../services/join-requests'
import { applyJoinDecision } from '../services/join-approvals'
import { isDangerousType, prepareApprovalRecord } from '../services/dangerous-approvals'
import { evaluateLowTrustAction, buildReviewCaseRow, REVIEW_CASE_TYPE } from '../services/review'
// AUDIT-ONB3 H-1 — the generic decide route has no `:orgId` in its path, so
// `requireOrgRole` no-ops on it (the R-4 trap). We derive the org from the approval
// row and enforce the type-mapped role through the SAME check the owner routes use.
import { requiredRoleForApproval } from '../services/approval-authz'
import { enforceOrgRole } from '../middleware/rbac'
import { hashToken, isFresh } from '../services/arturita-session'
import { validateManifest, grantedCapabilities, exposedTools } from '../services/plugins'

// ─── TASKS ───────────────────────────────────────────────────────────────────

// GC-0 (audit) — the COMPLETE set of `goals` columns a client may write, mirroring
// `ProjectPatchSchema` in routes/projects.ts. Deliberately absent:
//   • `orgId`     — the tenant boundary. THIS is the vulnerability (see PATCH below).
//   • `id`        — identity; rewriting it orphans every child goal pointing at it.
//   • `createdAt` — immutable provenance.
// Not `.strict()`, for the same reason projects isn't: unknown keys are STRIPPED, so a
// client that round-trips a whole goal object back through PATCH still succeeds — it
// just cannot move the row.
//
// ⚠️ `parentGoalId` and `ownerAgentId` ARE writable (they are the point of the route),
// and neither is validated to live in the same org. That is a PRE-EXISTING gap this
// change does not widen: it can dangle a reference, but it cannot move the goal's
// tenancy, which is what the gate depends on. Flagged in the audit as a follow-up.
// GC-0b — the COMPLETE set of `tasks` columns a client may write through
// `PATCH /api/tasks/:taskId`. Deliberately absent:
//   • `orgId`     — the tenant boundary. THIS is the vulnerability (see the route).
//   • `id`        — identity; rewriting it orphans every comment, run and attachment.
//   • `createdAt` — immutable provenance, and an audit-ordering input.
//   • `lockToken` / `lockedAt` — the MCA-EXEC S1.1 atomic checkout lock. Client-writable
//     lock state would let one caller steal or forge another runner's claim.
//   • `tokensUsed` / `inputTokens` / `outputTokens` / `cachedTokens` / `costUsd` /
//     `durationMs` — metering the EXECUTOR writes. Client-writable spend understates
//     usage against the org budget cap, so it is a billing-integrity field, not a data one.
//
// `agentId` IS present but is same-org validated in the handler — see there for why.
// ⚠️ `projectId` / `goalId` / `parentTaskId` are org-scoped references that are NOT
// same-org validated; that is the pre-existing dangling-reference gap the goals fix
// flagged. They can dangle, they cannot move the task's tenancy. Follow-up, not widened.
const TaskPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  input: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
  status: z.string().max(50).optional(),
  priority: z.string().max(50).optional(),
  kanbanColumn: z.string().max(50).nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  inboxState: z.string().max(50).nullable().optional(),
  workMode: z.string().max(50).optional(),
  labels: z.string().nullable().optional(),
  blockedBy: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  agentId: z.string().optional(),
  projectId: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
})

const GoalPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().nullable().optional(),
  metric: z.string().nullable().optional(),
  status: z.enum(['active', 'done', 'paused', 'dropped']).optional(),
  ownerAgentId: z.string().nullable().optional(),
  parentGoalId: z.string().nullable().optional(),
})

export async function taskRoutes(app: FastifyInstance) {
  // ─── Unified inbox (MCA-PC A3) ──────────────────────────────────────────
  const inboxCols = {
    id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status,
    inboxState: schema.tasks.inboxState, priority: schema.tasks.priority,
    agentId: schema.tasks.agentId, output: schema.tasks.output, createdAt: schema.tasks.createdAt,
  }
  const dismissedSet = async (orgId: string, userId: string) => new Set(
    (await db.select({ taskId: schema.inboxDismissals.taskId }).from(schema.inboxDismissals)
      .where(and(eq(schema.inboxDismissals.orgId, orgId), eq(schema.inboxDismissals.userId, userId)))).map(d => d.taskId))

  app.get('/api/orgs/:orgId/inbox', async (req) => {
    const { orgId } = req.params as any
    const userId = (req as any).userId ?? 'anon'
    const [tasks, dismissed, agents, approvals] = await Promise.all([
      db.select(inboxCols).from(schema.tasks).where(eq(schema.tasks.orgId, orgId)).orderBy(desc(schema.tasks.createdAt)).limit(300),
      dismissedSet(orgId, userId),
      db.select({ id: schema.agents.id, name: schema.agents.name, avatarEmoji: schema.agents.avatarEmoji }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.orgId, orgId), eq(schema.approvalRequests.status, 'pending'))).orderBy(desc(schema.approvalRequests.createdAt)).limit(50),
    ])
    // GC-0: the approval row carries an agent-authored `payload` (machine_exec argv,
    // wallet destinations, email recipients). Project it — see services/approval-public.ts.
    const publicApprovals = approvals.map(toPublicApproval)
    const amap = new Map(agents.map(a => [a.id, a]))
    const items = buildInbox(tasks as any, dismissed).map(i => ({
      ...i, agentName: amap.get(i.agentId)?.name ?? '—', agentEmoji: amap.get(i.agentId)?.avatarEmoji ?? '🤖',
    }))
    // ACT-1 note: the recently-DECIDED tail is deliberately NOT added here. Both
    // surfaces read it from `GET /api/orgs/:orgId/activity?kind=approval_decided`, so
    // there is ONE projected+bounded shape for a decided approval rather than a second
    // one grown on this route for the desk's convenience. `count` therefore stays the
    // decision-PENDING count — a badge that counts things already dealt with is a badge
    // nobody can clear.
    return { items, approvals: publicApprovals, count: items.length + publicApprovals.length }
  })
  app.get('/api/orgs/:orgId/inbox/count', async (req) => {
    const { orgId } = req.params as any
    const userId = (req as any).userId ?? 'anon'
    const [tasks, dismissed, pendingApprovals] = await Promise.all([
      db.select(inboxCols).from(schema.tasks).where(eq(schema.tasks.orgId, orgId)).limit(300),
      dismissedSet(orgId, userId),
      db.select({ id: schema.approvalRequests.id }).from(schema.approvalRequests).where(and(eq(schema.approvalRequests.orgId, orgId), eq(schema.approvalRequests.status, 'pending'))),
    ])
    return { count: buildInbox(tasks as any, dismissed).length + pendingApprovals.length }
  })
  app.post('/api/orgs/:orgId/inbox/dismiss', async (req, reply) => {
    const { orgId } = req.params as any
    const userId = (req as any).userId ?? 'anon'
    const { taskId } = (req.body ?? {}) as any
    if (!taskId) return reply.code(400).send({ error: 'taskId is required' })
    await db.insert(schema.inboxDismissals).values({ id: randomUUID(), orgId, userId, taskId, createdAt: new Date() })
    return { ok: true }
  })

  // V2 board read receipts: bump the operator's seenAt for a task (they opened
  // it) — the board clears the "new activity" flag. One row per (user, task).
  app.post('/api/tasks/:taskId/read', async (req, reply) => {
    const { taskId } = req.params as any
    const userId = (req as any).userId ?? 'anon'
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    await db.delete(schema.taskReads).where(and(eq(schema.taskReads.userId, userId), eq(schema.taskReads.taskId, taskId)))
    await db.insert(schema.taskReads).values({ id: randomUUID(), orgId: task.orgId, userId, taskId, seenAt: new Date() })
    return { ok: true }
  })

  // ─── Goals & goal alignment (MCA-PC B1) ─────────────────────────────────
  app.get('/api/orgs/:orgId/goals', async (req) => {
    const { orgId } = req.params as any
    const rows = await db.select().from(schema.goals).where(eq(schema.goals.orgId, orgId))
    return { tree: buildGoalTree(rows as any), goals: rows }
  })
  app.post('/api/orgs/:orgId/goals', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.title) return reply.code(400).send({ error: 'title is required' })
    // GC-0b (audit) — `ownerAgentId` is a body-supplied agent reference. Unlike the
    // task/routine cases nothing EXECUTES a goal's owner (it is read for display, the
    // recovery card and portability), so this is a cross-tenant reference disclosure
    // rather than cross-tenant execution: a goal in org A would render org B's agent
    // name and emoji in the goal tree. One line to close, and it retires the
    // "dangling reference" follow-up the GC-0 goals fix flagged for this field.
    {
      const err = await assertAgentInOrg(b.ownerAgentId, orgId)
      if (err) return reply.code(400).send({ error: err })
    }
    const goal = {
      id: randomUUID(), orgId, parentGoalId: b.parentGoalId ?? null, title: b.title,
      description: b.description ?? null, metric: b.metric ?? null,
      status: b.status ?? 'active', ownerAgentId: b.ownerAgentId ?? null, createdAt: new Date(),
    }
    await db.insert(schema.goals).values(goal)
    reply.code(201); return { goal }
  })
  app.patch('/api/goals/:goalId', async (req, reply) => {
    const { goalId } = req.params as any
    // GC-0 (audit) — the SAME cross-org write hole the projects route had, and for the
    // same structural reason. `resolveRequestOrg` (middleware/rbac.ts) derives this
    // route's org FROM THE GOAL ROW, and reads it BEFORE this handler mutates that row.
    // At check time the caller really is a member of the goal's org, so the gate passes;
    // `set(req.body as any)` then wrote `orgId` and moved the goal into another tenant.
    // A gate that authorises against the pre-image cannot defend a field that REWRITES
    // the pre-image — only an allow-list can. Proven exploitable at 200 pre-fix.
    const parsed = GoalPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid goal' })
    const patch = parsed.data
    if (Object.keys(patch).length > 0) {
      await db.update(schema.goals).set(patch).where(eq(schema.goals.id, goalId))
    }
    return { goal: await db.query.goals.findFirst({ where: eq(schema.goals.id, goalId) }) }
  })
  app.delete('/api/goals/:goalId', async (req, reply) => {
    await db.delete(schema.goals).where(eq(schema.goals.id, (req.params as any).goalId))
    reply.code(204)
  })

  // ─── Approvals & governance (MCA-PC B2) ─────────────────────────────────
  app.get('/api/orgs/:orgId/approvals', async (req) => {
    const { orgId } = req.params as any
    const status = (req.query as any)?.status
    const conds = [eq(schema.approvalRequests.orgId, orgId)]
    if (status) conds.push(eq(schema.approvalRequests.status, status))
    // GC-0: projected, not the raw row — this is the route the PHONE reads
    // (`Api.pendingApprovals`, apps/mobile/src/api.ts), so it leaked the payload
    // blob to a mobile device. See services/approval-public.ts.
    const rows = await db.select().from(schema.approvalRequests).where(and(...conds)).orderBy(desc(schema.approvalRequests.createdAt)).limit(100)
    return { approvals: rows.map(toPublicApproval) }
  })
  app.post('/api/orgs/:orgId/approvals', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.type) return reply.code(400).send({ error: 'type is required' })
    // Arturita A2: a dangerous approval's summary is MACHINE-regenerated from the
    // structured `action` payload (verbatim, never model prose). The action is
    // persisted so the card + audit show exactly what will run; any client-
    // supplied `summary` is ignored for these types. Shared with the agent-facing
    // route via `prepareApprovalRecord` (single source of truth — CC2).
    const prepared = prepareApprovalRecord({ type: b.type, summary: b.summary, action: b.action, payload: b.payload })
    if (!prepared.ok) return reply.code(400).send({ error: prepared.error })
    const approval = { id: randomUUID(), orgId, type: b.type, summary: prepared.summary, payload: prepared.payload ?? null, status: 'pending', requestedByAgentId: b.requestedByAgentId ?? null, decidedBy: null, decidedAt: null, createdAt: new Date() }
    await db.insert(schema.approvalRequests).values(approval as any)
    // MOB-3B: ping the owner's phone the moment an approval is filed (fire-and-forget).
    notifyApprovalCreated({ id: approval.id, orgId, type: approval.type, summary: approval.summary }).catch(() => {})
    reply.code(201); return { approval, warnings: prepared.warnings }
  })

  // ─── Epic P / P1 — low-trust review queue + evaluation chokepoint ─────────
  // The quarantine queue is just the pending `low_trust_review` approvals (we
  // reuse approval_requests + the tri-state decide loop, no parallel store). This
  // is a convenience filter for the operator's review surface.
  app.get('/api/orgs/:orgId/review-queue', async (req) => {
    const { orgId } = req.params as any
    const status = (req.query as any)?.status ?? 'pending'
    const conds = [eq(schema.approvalRequests.orgId, orgId), eq(schema.approvalRequests.type, REVIEW_CASE_TYPE)]
    if (status && status !== 'all') conds.push(eq(schema.approvalRequests.status, status))
    // GC-0: a review case IS an approval row — same blob, same projection. (No client
    // consumes this route today; the desk reads the queue through Governance.)
    const rows = await db.select().from(schema.approvalRequests).where(and(...conds)).orderBy(desc(schema.approvalRequests.createdAt)).limit(100)
    return { cases: rows.map(toPublicApproval) }
  })

  // Server-side enforcement chokepoint: an action-producer asks whether a
  // low-trust agent's action may take effect. `allow` → proceed; `refuse` →
  // dropped (boundary escape, logged); `quarantine` → a pending review case is
  // FILED and the action must NOT execute until a human approves it. Fail-closed:
  // an unknown agent or missing action → refuse.
  app.post('/api/orgs/:orgId/agents/:agentId/review-evaluate', async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const b = (req.body ?? {}) as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent || agent.orgId !== orgId) return reply.code(404).send({ error: 'Agent not found' })
    const action = b.action
    const evaluation = evaluateLowTrustAction({
      trustMode: (agent as any).trustMode,
      boundary: (agent as any).trustBoundary,
      action,
    })
    if (evaluation.decision === 'quarantine') {
      const row = buildReviewCaseRow({ id: randomUUID(), orgId, agentId, action, evaluation, now: new Date() })
      await db.insert(schema.approvalRequests).values(row as any)
      // MOB-3B: a quarantined low-trust action is a review case that needs a human — ping.
      notifyApprovalCreated({ id: (row as any).id, orgId, type: (row as any).type, summary: (row as any).summary }).catch(() => {})
      reply.code(202) // Accepted-but-held
      return { decision: 'quarantine', reason: evaluation.reason, approval: row }
    }
    if (evaluation.decision === 'refuse') {
      reply.code(403)
      return { decision: 'refuse', reason: evaluation.reason }
    }
    return { decision: 'allow', reason: evaluation.reason }
  })
  // Heartbeat engine (MCA-PC C1): run a sweep on demand (orphan recovery + wakes).
  app.post('/api/orgs/:orgId/heartbeat/sweep', async (req) => {
    const { orgId } = req.params as any
    return { result: await runHeartbeatSweep(orgId) }
  })

  // ─── Scoped budget policies (MCA-PC C2) ─────────────────────────────────
  app.get('/api/orgs/:orgId/budgets', async (req) => {
    const { orgId } = req.params as any
    const [policies, tasks] = await Promise.all([
      db.select().from(schema.budgetPolicies).where(eq(schema.budgetPolicies.orgId, orgId)),
      db.select({ costUsd: schema.tasks.costUsd, agentId: schema.tasks.agentId, projectId: schema.tasks.projectId, goalId: schema.tasks.goalId }).from(schema.tasks).where(eq(schema.tasks.orgId, orgId)),
    ])
    const budgets = policies.map(p => {
      const spend = spendForScope(tasks as any, p.scope as any, p.scope === 'company' ? null : p.scopeId)
      const ev = evaluatePolicy(p as any, spend)
      return { ...p, spend, state: ev.state, pct: ev.pct }
    })
    return { budgets }
  })
  app.post('/api/orgs/:orgId/budgets', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.scope || b.limitUsd == null) return reply.code(400).send({ error: 'scope and limitUsd required' })
    const policy = { id: randomUUID(), orgId, scope: b.scope, scopeId: b.scopeId ?? null, limitUsd: Number(b.limitUsd), warnPct: b.warnPct ?? 0.8, hardStop: b.hardStop ?? true, createdAt: new Date() }
    await db.insert(schema.budgetPolicies).values(policy as any)
    reply.code(201); return { policy }
  })
  app.delete('/api/budgets/:id', async (req, reply) => {
    await db.delete(schema.budgetPolicies).where(eq(schema.budgetPolicies.id, (req.params as any).id))
    reply.code(204)
  })

  // ─── Scoped secret store (MCA-PC D4) ────────────────────────────────────
  app.get('/api/orgs/:orgId/secrets', async (req) => {
    const { orgId } = req.params as any
    const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.orgId, orgId))
    // Never return plaintext — only key, scope, and a masked hint.
    return { secrets: rows.map(s => { let m = '••••'; try { m = maskValue(decrypt(s.valueEncrypted)) } catch {} ; return { id: s.id, scope: s.scope, scopeId: s.scopeId, key: s.key, masked: m } }) }
  })
  app.post('/api/orgs/:orgId/secrets', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.key || b.value == null) return reply.code(400).send({ error: 'key and value required' })
    const scope = b.scope === 'agent' ? 'agent' : 'company'
    const row = { id: randomUUID(), orgId, scope, scopeId: scope === 'agent' ? (b.scopeId ?? null) : null, key: b.key, valueEncrypted: encrypt(String(b.value)), createdAt: new Date() }
    await db.insert(schema.secrets).values(row)
    reply.code(201); return { secret: { id: row.id, scope: row.scope, scopeId: row.scopeId, key: row.key, masked: maskValue(String(b.value)) } }
  })
  app.delete('/api/secrets/:id', async (req, reply) => {
    await db.delete(schema.secrets).where(eq(schema.secrets.id, (req.params as any).id))
    reply.code(204)
  })

  // ─── Plugin registry (MCA-PC D2) ────────────────────────────────────────
  app.get('/api/orgs/:orgId/plugins', async (req) => {
    const { orgId } = req.params as any
    const rows = await db.select().from(schema.plugins).where(eq(schema.plugins.orgId, orgId))
    return { plugins: rows.map(p => ({ id: p.id, name: p.name, version: p.version, enabled: p.enabled, capabilities: grantedCapabilities((p.manifest ?? {}) as any), tools: exposedTools((p.manifest ?? {}) as any), description: (p.manifest as any)?.description ?? null })) }
  })
  app.post('/api/orgs/:orgId/plugins', async (req, reply) => {
    const { orgId } = req.params as any
    const manifest = (req.body as any)?.manifest ?? req.body
    const v = validateManifest(manifest)
    if (!v.ok) return reply.code(400).send({ error: 'invalid manifest', errors: v.errors })
    const row = { id: randomUUID(), orgId, name: manifest.name, version: manifest.version, manifest, enabled: false, createdAt: new Date() }
    await db.insert(schema.plugins).values(row as any)
    reply.code(201); return { plugin: { id: row.id, name: row.name, version: row.version, enabled: false, capabilities: grantedCapabilities(manifest), tools: exposedTools(manifest) } }
  })
  app.patch('/api/plugins/:id', async (req) => {
    const { id } = req.params as any
    const { enabled } = (req.body ?? {}) as any
    await db.update(schema.plugins).set({ enabled: !!enabled }).where(eq(schema.plugins.id, id))
    return { ok: true, enabled: !!enabled }
  })
  app.delete('/api/plugins/:id', async (req, reply) => {
    await db.delete(schema.plugins).where(eq(schema.plugins.id, (req.params as any).id))
    reply.code(204)
  })

  // ─── Workspaces & runtime (MCA-PC D1) ───────────────────────────────────
  app.get('/api/orgs/:orgId/workspaces', async (req) => {
    const { orgId } = req.params as any
    return { workspaces: await db.select().from(schema.workspaces).where(eq(schema.workspaces.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/workspaces', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.name) return reply.code(400).send({ error: 'name required' })
    const ws = { id: randomUUID(), orgId, projectId: b.projectId ?? null, name: b.name, repoUrl: b.repoUrl ?? null, baseBranch: b.baseBranch ?? 'main', previewUrl: b.previewUrl ?? null, createdAt: new Date() }
    await db.insert(schema.workspaces).values(ws)
    reply.code(201); return { workspace: ws }
  })
  // MCA-WORK S3.3 — set a workspace's preview URL / dev-server runtime status.
  app.patch('/api/workspaces/:id', async (req) => {
    const { id } = req.params as any
    const b = (req.body ?? {}) as any
    const patch: any = {}
    if (typeof b.previewUrl === 'string') patch.previewUrl = b.previewUrl
    if (typeof b.devUrl === 'string') patch.devUrl = b.devUrl
    if (typeof b.runtimeStatus === 'string') patch.runtimeStatus = b.runtimeStatus
    if (Object.keys(patch).length) await db.update(schema.workspaces).set(patch).where(eq(schema.workspaces.id, id))
    return { ok: true }
  })
  app.delete('/api/workspaces/:id', async (req, reply) => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, (req.params as any).id))
    reply.code(204)
  })

  // ─── Obsidian vault connector · Memory tab ──────────────────────────────
  // Reads the shared vault repo's markdown via GitHub, using a token stored in
  // the org secret store (company secret GITHUB_VAULT_TOKEN) or env VAULT_GH_TOKEN.
  // Vault (Obsidian shared memory) — token + config resolved per org. Config is
  // set via the Connectors tab's Obsidian card (VAULT_CONFIG); token in GITHUB_VAULT_TOKEN.
  const resolveVaultToken = async (orgId: string): Promise<string | null> => {
    if (process.env.VAULT_GH_TOKEN) return process.env.VAULT_GH_TOKEN
    const row = await db.query.secrets.findFirst({ where: and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'company'), eq(schema.secrets.key, 'GITHUB_VAULT_TOKEN')) })
    try { return row ? decrypt(row.valueEncrypted) : null } catch { return null }
  }
  const resolveVaultConfig = async (orgId: string) => {
    const row = await db.query.secrets.findFirst({ where: and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'company'), eq(schema.secrets.key, 'VAULT_CONFIG')) })
    let raw: string | null = null
    try { raw = row ? decrypt(row.valueEncrypted) : null } catch {}
    return parseVaultConfig(raw)
  }
  const NO_VAULT = { error: 'Vault not connected — configure it in Connectors → Obsidian Vault (repo, root, branch, GitHub token).' }

  app.get('/api/orgs/:orgId/memory/tree', async (req, reply) => {
    const { orgId } = req.params as any
    const cfg = await resolveVaultConfig(orgId)
    const path = ((req.query as any)?.path) || cfg.root
    if (!isSafeVaultPath(path, cfg.root)) return reply.code(400).send({ error: 'invalid path' })
    const token = await resolveVaultToken(orgId)
    if (!token) return reply.code(400).send(NO_VAULT)
    const r = await vaultList(token, cfg, path)
    if (!r.ok) return reply.code(r.status).send({ error: `GitHub ${r.status}` })
    return { path, repo: cfg.repo, root: cfg.root, branch: cfg.branch, entries: r.entries }
  })
  app.get('/api/orgs/:orgId/memory/file', async (req, reply) => {
    const { orgId } = req.params as any
    const cfg = await resolveVaultConfig(orgId)
    const path = ((req.query as any)?.path) || ''
    if (!isSafeVaultPath(path, cfg.root) || !isMarkdownPath(path)) return reply.code(400).send({ error: 'invalid path' })
    const token = await resolveVaultToken(orgId)
    if (!token) return reply.code(400).send(NO_VAULT)
    const r = await vaultRead(token, cfg, path)
    if (!r.ok) return reply.code(r.status).send({ error: `GitHub ${r.status}` })
    return { path, markdown: r.markdown }
  })
  app.put('/api/orgs/:orgId/memory/file', async (req, reply) => {
    const { orgId } = req.params as any
    const body = (req.body ?? {}) as any
    const path = String(body.path ?? '')
    const cfg = await resolveVaultConfig(orgId)
    if (!isSafeVaultPath(path, cfg.root) || !isMarkdownPath(path)) return reply.code(400).send({ error: 'path must be a .md/.markdown/.txt file inside the vault root' })
    const token = await resolveVaultToken(orgId)
    if (!token) return reply.code(400).send(NO_VAULT)
    const r = await vaultWrite(token, cfg, path, String(body.markdown ?? ''), body.message || `mc: update ${path}`)
    if (!r.ok) return reply.code(r.status).send({ error: r.error ?? `GitHub ${r.status}` })
    return { ok: true, path, commit: r.commit }
  })

  // ─── Memory graph (Epic M — vault graph map) ────────────────────────────
  // Force-directed graph of the vault for the Memory tab. Prefers a Graphify
  // `graph.json` committed to the vault (richer AST/semantic backend); falls
  // back to a native [[wikilink]]/#tag parse. Native reads are capped + cached
  // (they cost one GitHub call per note); Graphify is one fetch. `?rebuild=1`
  // busts the cache. `?tags=0` drops tag nodes from the native graph.
  const GRAPH_TTL_MS = 10 * 60_000
  const NATIVE_FILE_CAP = 120
  // MEM-1 — hard ceiling on nodes RETURNED. The native path is already bounded
  // by NATIVE_FILE_CAP at the fetch; this bounds the Graphify path, which is one
  // read of a `graph.json` that a big vault makes arbitrarily large. 1500 keeps
  // the JSON in the low MBs and the client's force sim interactive; the client
  // caps what it DRAWS lower still (see web/app/dashboard/VaultGraph.tsx).
  // `?max=` lets a caller ask for less — the phone does, since it renders a list
  // and has no use for the tail.
  const GRAPH_NODE_CAP = 1500
  app.get('/api/orgs/:orgId/memory/graph', async (req, reply) => {
    const { orgId } = req.params as any
    const q = (req.query as any) ?? {}
    const cfg = await resolveVaultConfig(orgId)
    const token = await resolveVaultToken(orgId)
    if (!token) return reply.code(400).send(NO_VAULT)

    const includeTags = String(q.tags ?? '1') !== '0'
    const rebuild = String(q.rebuild ?? '') === '1'
    // `?max=` — a caller may ask for FEWER nodes than the ceiling (the phone
    // renders a list, so it has no use for the long tail). Never more: the
    // ceiling is the payload bound, not a default a client can raise.
    const askedMax = Number.parseInt(String(q.max ?? ''), 10)
    const maxNodes = Number.isFinite(askedMax) && askedMax > 0 ? Math.min(askedMax, GRAPH_NODE_CAP) : GRAPH_NODE_CAP
    // The cache holds the UNCAPPED graph and the cap is applied on the way out,
    // so two clients asking for different `max` can't poison each other's view.
    const cacheKey = `${orgId}:${cfg.repo}:${cfg.root}:${cfg.branch}:${includeTags ? 't' : 'n'}`
    if (!rebuild) {
      const hit = graphCache.get(cacheKey)
      if (hit && Date.now() - hit.at < GRAPH_TTL_MS) return { ...capGraph(hit.graph, maxNodes), cached: true }
    }

    // 1) Graphify graph.json (fast path — one fetch). Candidates: inside the
    //    vault root first, then repo-root `graphify-out/`.
    const root = String(cfg.root ?? '').replace(/^\/+|\/+$/g, '')
    const graphifyCandidates = [`${root}/graphify-out/graph.json`, 'graphify-out/graph.json'].filter(Boolean)
    // FIX-1 — the candidate loop lives in vault-graph.ts so its "an EMPTY parse is
    // not an answer" rule is reachable by a test. `graph` is null when nothing useful
    // was found, and the native fallback below then runs as it should. `error` says
    // WHY, when there was a candidate we could not use — a corrupt graph.json must not
    // look identical to no graph.json at all.
    const graphify = await selectGraphifyGraph(
      graphifyCandidates,
      async cand => { const gr = await vaultRead(token, cfg, cand); return gr.ok ? gr.markdown ?? null : null },
      cfg.root,
    )
    let graph: VaultGraph | null = graphify.graph
    const graphPath: string | undefined = graphify.path
    const graphifyError: string | undefined = graphify.error

    // 2) Native fallback — parse markdown ourselves.
    if (!graph) {
      const tree = await vaultTree(token, cfg)
      if (!tree.ok) return reply.code(tree.status).send({ error: `GitHub ${tree.status}` })
      const all = tree.paths ?? []
      const picked = all.slice(0, NATIVE_FILE_CAP)
      const files = (await Promise.all(picked.map(async p => {
        const r = await vaultRead(token, cfg, p)
        return r.ok && r.markdown != null ? { path: p, markdown: r.markdown } : null
      }))).filter(Boolean) as { path: string; markdown: string }[]
      graph = buildNativeGraph(files, cfg.root, { includeTags, truncated: all.length > picked.length })
    }

    const rebuildCommand = `graphify update ${cfg.root} --no-cluster && git -C <vault> add ${cfg.root}/graphify-out/graph.json && git -C <vault> commit -m "chore: refresh vault graph"`
    const payload: VaultGraph & { repo: string; root: string; branch: string; hasGraphify: boolean; graphPath?: string; graphifyError?: string; rebuildCommand: string } = {
      ...graph, repo: cfg.repo, root: cfg.root, branch: cfg.branch,
      hasGraphify: graph.source === 'graphify', graphPath, graphifyError, rebuildCommand,
    }
    graphCache.set(cacheKey, { at: Date.now(), graph: payload })
    return capGraph(payload, maxNodes)
  })

  // ─── Company portability (MCA-PC D3) ────────────────────────────────────
  app.get('/api/orgs/:orgId/export', async (req) => {
    const { orgId } = req.params as any
    const [org, agents, goals, budgets, routines] = await Promise.all([
      db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) }),
      db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      db.select().from(schema.goals).where(eq(schema.goals.orgId, orgId)),
      db.select().from(schema.budgetPolicies).where(eq(schema.budgetPolicies.orgId, orgId)),
      db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.orgId, orgId)),
    ])
    return { bundle: buildExport({ org, agents, goals, budgets, routines }) }
  })
  app.post('/api/orgs/import', async (req, reply) => {
    const body = (req.body ?? {}) as any
    const bundle = body.bundle ?? body
    if (!bundle?.org || !Array.isArray(bundle.agents)) return reply.code(400).send({ error: 'invalid bundle' })
    const userId = (req as any).userId ?? 'system'
    const newOrgId = randomUUID()
    await db.insert(schema.organisations).values({
      id: newOrgId, name: bundle.org.name ?? 'Imported Org', description: bundle.org.description ?? null,
      mission: bundle.org.mission ?? null, culture: bundle.org.culture ?? null,
      deployMode: bundle.org.deployMode ?? null, cloudProvider: bundle.org.cloudProvider ?? null,
      preferredLlm: bundle.org.preferredLlm ?? null, ownerId: userId, createdAt: new Date(),
    } as any)
    const r = remapImport(bundle, newOrgId, () => randomUUID())
    if (r.agents.length) await db.insert(schema.agents).values(r.agents as any)
    if (r.goals.length) await db.insert(schema.goals).values(r.goals as any)
    if (r.budgets.length) await db.insert(schema.budgetPolicies).values(r.budgets as any)
    if (r.routines.length) await db.insert(schema.scheduledTasks).values(r.routines as any)
    reply.code(201)
    return { orgId: newOrgId, counts: { agents: r.agents.length, goals: r.goals.length, budgets: r.budgets.length, routines: r.routines.length } }
  })
  // V2 tri-state: approved | rejected | revision_requested (+ reviewer note).
  // Arturita A2: approving a dangerous type (file_destructive/wallet_tx/
  // email_send/machine_exec) requires STEP-UP — a fresh Arturita command session
  // (A1's isFresh), presented as a token via `x-arturita-session` or body
  // `sessionToken`. Reject / revision-requested are never step-up-gated.
  app.post('/api/approvals/:id/decide', async (req, reply) => {
    const { id } = req.params as any
    const { decision, note } = (req.body ?? {}) as any
    const approval = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, id) })
    if (!approval) return reply.code(404).send({ error: 'approval not found' })

    // AUDIT-ONB3 H-1 — the board-approval gate, on the door the Inbox card uses.
    // This route has no `:orgId` path param, so `requireOrgRole` cannot see it (R-4);
    // instead we derive the org FROM THE ROW and enforce the role the approval TYPE
    // demands — OWNER for agent-minting (`agent_join_request`/`agent_create`, or a
    // `low_trust_review` wrapping one), MEMBER for everything else, before ANY
    // decision logic runs. Membership is now always required: an authenticated caller
    // with no `org_members` row for the approval's org is refused, for every type.
    const minRole = requiredRoleForApproval({
      type: approval.type,
      actionType: (approval.payload as any)?.actionType,
    })
    const gate = await enforceOrgRole({
      userId: (req as any).auth?.userId,
      orgId: approval.orgId,
      minRole,
    })
    if (!gate.ok) return reply.code(gate.code).send({ error: gate.error })

    // Step-up is required for a direct dangerous type OR for a low-trust review
    // case wrapping a dangerous action (payload.requiresStepUp) — the review gate
    // never becomes a cheaper path to a dangerous action than a direct A2 approval.
    const requireStepUp = isDangerousType(approval.type) || (approval.payload as any)?.requiresStepUp === true
    let stepUpSatisfied = false
    if (requireStepUp && decision === 'approved') {
      const token = (req.headers['x-arturita-session'] as string) || (req.body as any)?.sessionToken
      if (typeof token === 'string' && token.trim()) {
        const session = await db.query.arturitaSessions.findFirst({
          where: and(eq(schema.arturitaSessions.orgId, approval.orgId), eq(schema.arturitaSessions.tokenHash, hashToken(token.trim()))),
        })
        stepUpSatisfied = isFresh(session as any)
      }
    }

    const result = decideApproval({ decision, note, actor: (req as any).userId ?? 'human', requireStepUp, stepUpSatisfied })
    if (!result.ok) {
      // A failed step-up is an auth problem (403); other validation errors 400.
      const code = /step-up required/.test(result.error ?? '') ? 403 : 400
      return reply.code(code).send({ error: result.error })
    }
    await db.update(schema.approvalRequests).set(result.patch!).where(eq(schema.approvalRequests.id, id))

    // Epic ONB / ONB3 — the board-approval gate. An `agent_join_request` card in this
    // queue is not a note-to-self: deciding it is what creates (or refuses) the agent.
    // We funnel it through the SAME `applyJoinDecision` the dedicated owner routes use,
    // so an owner clicking Approve in the Inbox cannot mark a request approved without
    // the contained agent actually being created — and there is no second code path to
    // drift. `revision_requested` (the third tri-state) is not a join outcome: the card
    // stays as the reviewer left it and no agent is created.
    let joinRequest: unknown = undefined
    if (approval.type === JOIN_APPROVAL_TYPE) {
      const joinRequestId = String((approval.payload as any)?.joinRequestId ?? '')
      const joinDecision = parseJoinDecision(decision)
      if (joinRequestId && joinDecision) {
        const applied = await applyJoinDecision({
          joinRequestId, orgId: approval.orgId, decision: joinDecision,
          actor: (req as any).auth?.userId ?? (req as any).userId ?? 'human',
        })
        // A 409 here means it was already decided (e.g. via the dedicated route) — the
        // approval card is now closed either way, which is the state the operator wants.
        joinRequest = applied.ok === true ? joinRequestView(applied.record) : { error: applied.error }
      }
    }

    // GC-0: the decided row echoes back projected too. Neither client reads this body
    // (web drops the card on success, mobile refetches), so nothing depends on the blob.
    const decided = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, id) })
    return {
      approval: decided ? toPublicApproval(decided) : decided,
      ...(joinRequest !== undefined ? { joinRequest, agentToken: null } : {}),
    }
  })

  app.get('/api/orgs/:orgId/tasks', async (req) => {
    const { orgId } = req.params as any
    const q = req.query as any
    const conditions = [eq(schema.tasks.orgId, orgId)]
    if (q.agentId) conditions.push(eq(schema.tasks.agentId, q.agentId))
    if (q.status) conditions.push(eq(schema.tasks.status, q.status))
    if (q.projectId) conditions.push(eq(schema.tasks.projectId, q.projectId))
    return { tasks: await db.select().from(schema.tasks).where(and(...conditions)).orderBy(desc(schema.tasks.createdAt)).limit(200) }
  })
  app.post('/api/orgs/:orgId/tasks', async (req, reply) => {
    const { orgId } = req.params as any
    const body = req.body as any
    // GC-0b (audit) — the CREATE-side half of the class. `orgId` correctly comes from
    // the PATH, and that is exactly what made this invisible: with the tenant column
    // safe, the body-supplied `agentId` looked harmless. It is not. `agentId` is what
    // the executor runs the task AS — `POST /api/tasks/:taskId/execute` resolves the
    // agent BY ID ALONE (services/agent-executor.ts) and then uses `agent.orgId` for
    // the LLM keys, budget, knowledge base and connectors. So a member of org A could
    // create a task in org A naming ORG B's agent, fire it, and have org B's agent run
    // attacker-authored input under org B's credentials, billed to org B, with the
    // output landing in a row org A can read.
    //
    // The membership gate cannot catch it: it authorises `:orgId` from the PATH, and
    // nothing ever looks at `body.agentId`. Same fix as the PATCH sibling below —
    // the agent must live in the org the task is being created in.
    {
      const err = await assertAgentInOrg(body.agentId, orgId)
      if (err) return reply.code(400).send({ error: err })
    }
    const task = { id: randomUUID(), orgId, agentId: body.agentId, projectId: body.projectId ?? null, title: body.title, input: body.input ?? null, output: null, status: 'pending', priority: body.priority ?? 'medium', kanbanColumn: body.kanbanColumn ?? 'todo', workMode: normalizeWorkMode(body.workMode), llmModel: null, tokensUsed: null, costUsd: null, durationMs: null, assignedTo: body.assignedTo ?? null, dueAt: body.dueAt ? new Date(body.dueAt) : null, blockedBy: body.blockedBy ? JSON.stringify(body.blockedBy) : null, createdAt: new Date(), completedAt: null }
    await db.insert(schema.tasks).values(task)
    reply.code(201); return { task }
  })
  app.get('/api/tasks/:taskId', async (req, reply) => {
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Not found' })
    return { task }
  })
  // MCA-EXEC S1.4 — ticket comments + S1.2 run history (read side for the UI).
  app.get('/api/tasks/:taskId/comments', async (req) => {
    const { taskId } = req.params as any
    const comments = await db.select().from(schema.taskComments).where(eq(schema.taskComments.taskId, taskId)).orderBy(schema.taskComments.createdAt)
    // W3: enrich agent-authored comments with name + emoji so the thread reads as a
    // conversation, not "agent 3f2a1c…".
    const agentIds = [...new Set(comments.map(c => c.authorAgentId).filter(Boolean) as string[])]
    const agents = agentIds.length
      ? await db.select({ id: schema.agents.id, name: schema.agents.name, avatarEmoji: schema.agents.avatarEmoji }).from(schema.agents).where(inArray(schema.agents.id, agentIds))
      : []
    const amap = new Map(agents.map(a => [a.id, a]))
    return { comments: comments.map(c => ({
      ...c,
      authorName: c.authorAgentId ? (amap.get(c.authorAgentId)?.name ?? null) : null,
      authorEmoji: c.authorAgentId ? (amap.get(c.authorAgentId)?.avatarEmoji ?? '🤖') : null,
    })) }
  })
  app.post('/api/tasks/:taskId/comments', async (req, reply) => {
    const { taskId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.body) return reply.code(400).send({ error: 'body required' })
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    const row = { id: randomUUID(), orgId: task.orgId, taskId, authorAgentId: null, authorUser: (req as any).userId ?? null, kind: 'user', body: String(b.body).slice(0, 4000), createdAt: new Date() }
    await db.insert(schema.taskComments).values(row)

    // MCA-83 W3 — wake-on-comment: a human comment on an idle task re-runs the
    // assigned agent with the comment as a follow-up and the prior thread as
    // context. executeAgentTask owns the status/run transitions (internal → LLM
    // loop, external → re-notify); we only decide whether to fire.
    const runs = await db.select({ status: schema.agentRuns.status }).from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId))
    const decision = decideWake({
      status: task.status, hasAgent: !!task.agentId, activeRun: hasActiveRun(runs),
      authorIsUser: true, requested: typeof b.wake === 'boolean' ? b.wake : undefined,
    })
    if (decision.wake && task.agentId) {
      const prior = await db.select().from(schema.taskComments).where(eq(schema.taskComments.taskId, taskId))
      const history = threadHistory(prior.filter((c) => c.id !== row.id))
      // Durable marker so the async operator sees the comment relit the task.
      await db.insert(schema.taskComments).values({
        id: randomUUID(), orgId: task.orgId, taskId, authorAgentId: null, authorUser: null,
        kind: 'system_notice', body: 'Agent woken to address the comment above.', createdAt: new Date(),
      }).catch(() => {})
      executeAgentTask({ agentId: task.agentId, taskId, input: buildWakeInput(task.title, row.body), conversationHistory: history })
        .catch(err => console.warn('Wake-on-comment execution failed:', err))
    }
    reply.code(201); return { comment: row, woke: decision.wake, wakeReason: decision.reason }
  })
  app.get('/api/tasks/:taskId/runs', async (req) => {
    const { taskId } = req.params as any
    const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId)).orderBy(desc(schema.agentRuns.startedAt)).limit(20)
    return { runs }
  })

  // MCA-WORK S3.1 — attachments + work products.
  app.get('/api/tasks/:taskId/attachments', async (req) => {
    const { taskId } = req.params as any
    const attachments = await db.select().from(schema.taskAttachments).where(eq(schema.taskAttachments.taskId, taskId)).orderBy(desc(schema.taskAttachments.createdAt))
    return { attachments }
  })
  app.post('/api/tasks/:taskId/attachments', async (req, reply) => {
    const { taskId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.name || !b.url) return reply.code(400).send({ error: 'name and url required' })
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    const row = { id: randomUUID(), orgId: task.orgId, taskId, kind: normalizeAttachmentKind(b.kind), name: String(b.name).slice(0, 300), url: String(b.url).slice(0, 2000), contentType: b.contentType ?? null, sizeBytes: b.sizeBytes ?? null, sha: null, createdByAgentId: null, createdByUser: (req as any).userId ?? null, createdAt: new Date() }
    await db.insert(schema.taskAttachments).values(row); reply.code(201); return { attachment: row }
  })
  app.delete('/api/attachments/:id', async (req, reply) => {
    const { id } = req.params as any
    await db.delete(schema.taskAttachments).where(eq(schema.taskAttachments.id, id)); reply.code(204)
  })

  // MCA-WORK S3.2 — labels, subtasks, unified ticket timeline.
  app.patch('/api/tasks/:taskId/labels', async (req) => {
    const { taskId } = req.params as any
    const b = (req.body ?? {}) as any
    const labels = Array.isArray(b.labels) ? b.labels.map(String) : []
    await db.update(schema.tasks).set({ labels: JSON.stringify(labels) }).where(eq(schema.tasks.id, taskId))
    return { ok: true, labels }
  })
  app.get('/api/tasks/:taskId/subtasks', async (req) => {
    const { taskId } = req.params as any
    const [subtasks, parent] = await Promise.all([
      db.select().from(schema.tasks).where(eq(schema.tasks.parentTaskId, taskId)).orderBy(schema.tasks.createdAt),
      db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }),
    ])
    // W2: roll the sub-tasks' spend up into the parent so a decomposed task shows
    // its true cost, not just the coordinator's slice.
    return { subtasks, rollup: rollupCost(parent, subtasks) }
  })
  app.get('/api/tasks/:taskId/timeline', async (req, reply) => {
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    const [comments, runs, attachments] = await Promise.all([
      db.select().from(schema.taskComments).where(eq(schema.taskComments.taskId, taskId)),
      db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId)),
      db.select().from(schema.taskAttachments).where(eq(schema.taskAttachments.taskId, taskId)),
    ])
    return { timeline: buildTimeline({ task, comments, runs, attachments }) }
  })

  // MCA-83 W1 — recovery card: structured owner/source-run/evidence/next-action
  // for a task that needs a decision (failed run, stalled agent, or blocked on
  // upstream work). Returns { recovery: null } when nothing is open.
  app.get('/api/tasks/:taskId/recovery', async (req, reply) => {
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    const [runs, comments] = await Promise.all([
      db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId)),
      db.select().from(schema.taskComments).where(eq(schema.taskComments.taskId, taskId)),
    ])
    // W2: resolve upstream blocker ids to task rows for the reasoned chips.
    let blockerIds: string[] = []
    try { const a = JSON.parse(task.blockedBy ?? '[]'); if (Array.isArray(a)) blockerIds = a.filter((x) => typeof x === 'string') } catch {}
    const blockerTasks = blockerIds.length
      ? await db.select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status })
          .from(schema.tasks).where(inArray(schema.tasks.id, blockerIds))
      : []
    const card = buildRecovery({ task, runs, comments, blockerTasks })
    if (!card) return { recovery: null }
    const owner = card.ownerAgentId
      ? await db.query.agents.findFirst({ where: eq(schema.agents.id, card.ownerAgentId) })
      : null
    return { recovery: { ...card, ownerName: owner?.name ?? null, ownerEmoji: owner?.avatarEmoji ?? null } }
  })

  // MCA-83 W4 — task watchdogs: declarative checks the operator attaches to a
  // task; the scheduler evaluates them each tick and posts a system-notice comment
  // when one flips state. Read/create/toggle/remove here; evaluation lives in the
  // scheduler sweep (services/watchdogs.ts).
  app.get('/api/tasks/:taskId/watchdogs', async (req) => {
    const { taskId } = req.params as any
    const watchdogs = await db.select().from(schema.taskWatchdogs)
      .where(eq(schema.taskWatchdogs.taskId, taskId)).orderBy(desc(schema.taskWatchdogs.createdAt))
    return { watchdogs }
  })
  app.post('/api/tasks/:taskId/watchdogs', async (req, reply) => {
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    let spec
    try { spec = parseWatchdogSpec((req.body ?? {}) as any) }
    catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'Invalid watchdog' }) }
    const watchdog = {
      id: randomUUID(), orgId: task.orgId, taskId, kind: spec.kind, threshold: spec.threshold,
      state: 'ok', lastMessage: null, enabled: true,
      createdByUser: (req as any).userId ?? null, createdAt: new Date(), lastEvaluatedAt: null, triggeredAt: null,
    }
    await db.insert(schema.taskWatchdogs).values(watchdog as any)
    reply.code(201); return { watchdog }
  })
  app.patch('/api/watchdogs/:id', async (req) => {
    const { id } = req.params as any
    const b = (req.body ?? {}) as any
    const patch: Record<string, unknown> = {}
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled
    if (Object.keys(patch).length) await db.update(schema.taskWatchdogs).set(patch as any).where(eq(schema.taskWatchdogs.id, id))
    return { ok: true }
  })
  app.delete('/api/watchdogs/:id', async (req, reply) => {
    await db.delete(schema.taskWatchdogs).where(eq(schema.taskWatchdogs.id, (req.params as any).id))
    reply.code(204)
  })

  app.patch('/api/tasks/:taskId', async (req, reply) => {
    const { taskId } = req.params as any
    // GC-0b — the third instance of the class. Same structural cause as projects and
    // goals: `resolveRequestOrg` derives this route's org FROM THE TASK ROW (the
    // `:taskId` branch in middleware/rbac.ts) and reads it BEFORE this handler mutates
    // that row, so `set(req.body as any)` let a member of org A write `orgId` and move
    // the task — with its input, output and whole comment thread — into org B.
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    const parsed = TaskPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid task' })
    const patch = parsed.data
    // `agentId` IS writable — reassigning a ticket to another agent is real product
    // behaviour, not a loophole — but ONLY WITHIN THE TASK'S OWN ORG. Left unchecked
    // it is the sharper half of this route's hole: `agentId` is what the executor runs
    // the task AS, so re-pointing it at another org's agent hands that agent this
    // task's `input` and makes it execute work for a tenant it does not belong to.
    // Validated against the TASK's org (`task.orgId`), never against an org named in
    // the body — the body cannot move the task, so the pre-image org is the truth here.
    {
      const err = await assertAgentInOrg(patch.agentId, task.orgId)
      if (err) return reply.code(400).send({ error: err })
    }
    if (Object.keys(patch).length > 0) {
      await db.update(schema.tasks).set(patch).where(eq(schema.tasks.id, taskId))
    }
    return { ok: true }
  })
  app.patch('/api/tasks/:taskId/move', async (req) => {
    const { taskId } = req.params as any
    const { column } = req.body as any
    const statusMap: Record<string, string> = { todo: 'pending', in_progress: 'in_progress', blocked: 'blocked', done: 'done' }
    await db.update(schema.tasks).set({ kanbanColumn: column, status: statusMap[column] ?? 'pending' } as any).where(eq(schema.tasks.id, taskId))
    return { ok: true }
  })
  app.delete('/api/tasks/:taskId', async (req, reply) => {
    await db.delete(schema.tasks).where(eq(schema.tasks.id, (req.params as any).taskId))
    reply.code(204)
  })

  app.post('/api/tasks/:taskId/execute', async (req, reply) => {
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    if (!task.agentId) return reply.code(400).send({ error: 'Task has no assigned agent' })
    if (task.status === 'done') return reply.code(400).send({ error: 'Task already completed' })

    reply.code(202)

    // Fire-and-forget execution
    executeAgentTask({
      agentId: task.agentId,
      taskId: task.id,
      input: task.input ?? task.title,
    }).catch(err => console.warn('Task execution failed:', err))

    return { taskId, status: 'executing' }
  })

  // MCA-83 W5 — ask an agent a question. Creates an ask-mode task and fires the
  // lean single-turn run; the answer lands in the task thread (poll
  // GET /api/tasks/:id/comments) and mirrors to task.output. Ergonomic entry point
  // for the UI/CLI — the plain execute path also honours a task's stored workMode.
  app.post('/api/agents/:agentId/ask', async (req, reply) => {
    const { agentId } = req.params as any
    const b = (req.body ?? {}) as any
    const question = String(b.question ?? b.input ?? '').trim()
    if (!question) return reply.code(400).send({ error: 'question is required' })
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const task = {
      id: randomUUID(), orgId: agent.orgId, agentId, projectId: b.projectId ?? null,
      title: (b.title ? String(b.title) : question).slice(0, 200), input: question, output: null,
      status: 'pending', priority: 'medium', kanbanColumn: 'todo', workMode: 'ask',
      llmModel: null, tokensUsed: null, costUsd: null, durationMs: null, assignedTo: null,
      dueAt: null, blockedBy: null, createdAt: new Date(), completedAt: null,
    }
    await db.insert(schema.tasks).values(task as any)
    reply.code(202)
    executeAgentTask({ agentId, taskId: task.id, input: question }).catch(err => console.warn('Ask execution failed:', err))
    return { taskId: task.id, status: 'asking' }
  })

  // CSV export
  app.get('/api/orgs/:orgId/tasks/export', async (req, reply) => {
    const { orgId } = req.params as any
    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.orgId, orgId)).orderBy(desc(schema.tasks.createdAt))
    const agents = await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const agentMap = new Map(agents.map(a => [a.id, a.name]))

    const csvEscape = (val: string | null | undefined) => {
      if (val == null) return ''
      const s = String(val)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }

    const header = 'id,title,status,agentId,agentName,createdAt,completedAt'
    const rows = tasks.map(t =>
      [t.id, csvEscape(t.title), t.status, t.agentId, csvEscape(agentMap.get(t.agentId) ?? 'Unknown'),
       t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
       t.completedAt instanceof Date ? t.completedAt.toISOString() : t.completedAt ?? ''].join(',')
    )
    const csv = [header, ...rows].join('\n')
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', 'attachment; filename=tasks-export.csv')
    return csv
  })
}
