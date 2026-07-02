import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and, desc, gte, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { requireOrgRole } from '../middleware/rbac'
import { executeAgentTask } from '../services/agent-executor'
import { upsertDocument } from '../services/vector-search'
import { streamLLM } from '../services/llm-router'
import { buildAuthUrl, exchangeCode, SCOPES as GOOGLE_SCOPES } from '../services/google-auth'
import { generateAgentToken } from '../middleware/agent-token'
import { isExternalAgent, heartbeatFreshness } from '../services/agent-runtime'
import { buildOrgChart } from '../services/orgchart'
import { buildHirePrompt, parseHireProposal, isExternalRuntime } from '../services/hiring'
import { buildInbox } from '../services/inbox'
import { buildGoalTree } from '../services/goals'
import { runHeartbeatSweep } from '../services/heartbeat-engine'
import { spendForScope, evaluatePolicy } from '../services/budget'
import { buildExport, remapImport } from '../services/portability'
import { encrypt, decrypt, maskValue } from '../services/secrets'
import { isSafeVaultPath, isMarkdownPath, parseVaultConfig, vaultList, vaultRead, vaultWrite } from '../services/vault-connector'
import { normalizeAttachmentKind, buildTimeline } from '../services/tickets'
import { validateManifest, grantedCapabilities, exposedTools } from '../services/plugins'

// ─── AGENT TEMPLATES ────────────────────────────────────────────────────────

export const AGENT_TEMPLATES = {
  arturito: { name: 'Arturito', role: 'Chief of Staff & Master Orchestrator', avatarEmoji: '🎯', personality: 'Direct, strategic, Swiss-German efficiency. Routes tasks to the right agent, maintains oversight of all operations.', agentType: 'standard' },
  head_dev: { name: 'Dev', role: 'Head of Development', avatarEmoji: '💻', personality: 'Technical, precise, opinionated on architecture. Rejects shortcuts.', agentType: 'standard' },
  head_marketing: { name: 'Maya', role: 'Head of Marketing', avatarEmoji: '📣', personality: 'Creative, data-driven, narrative-focused. Balances brand with growth.', agentType: 'standard' },
  head_ops: { name: 'Ops', role: 'Head of Operations', avatarEmoji: '⚙️', personality: 'Systems thinker, process-oriented, eliminates friction.', agentType: 'standard' },
  head_finance: { name: 'CFO', role: 'Head of Finance', avatarEmoji: '📊', personality: 'Conservative, rigorous, model-driven. Questions every assumption.', agentType: 'standard' },
  head_rd: { name: 'R&D', role: 'Head of Research & Development', avatarEmoji: '🔬', personality: 'First-principles thinker. Explores the edges of what is possible.', agentType: 'standard' },
  advisor: { name: 'Advisor', role: 'Silver Board Advisor', avatarEmoji: '🎖️', personality: 'Speaks with the voice and wisdom of the assigned persona.', agentType: 'advisor' },
}

// ─── ORGS ────────────────────────────────────────────────────────────────────

export async function orgRoutes(app: FastifyInstance) {
  const OrgSchema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    logoUrl: z.string().url().optional(),
    mission: z.string().optional(),
    culture: z.string().optional(),
    deployMode: z.enum(['cloud', 'local']).optional(),
    cloudProvider: z.enum(['aws', 'aws_ch', 'gcp', 'gcp_ch', 'azure', 'oracle']).optional(),
    // Legacy preset key (mobile onboarding) — widened to accept any catalogue value.
    preferredLlm: z.string().optional(),
    // Explicit model selection (web onboarding): provider + model id, with optional
    // per-org credentials for hosted OpenAI-compatible / custom providers.
    llmProvider: z.string().optional(),
    llmModel: z.string().optional(),
    llmApiKey: z.string().optional(),
    llmBaseUrl: z.string().optional(),
    firstAgentRole: z.string().optional(),
  })

  // Map the legacy preferredLlm preset to a concrete provider + model.
  const PRESET_LLM: Record<string, { provider: string; model: string }> = {
    gpt4o:  { provider: 'openai', model: 'gpt-4o' },
    gemini: { provider: 'google', model: 'gemini-2.0-flash' },
    claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  }
  function resolveLlm(body: z.infer<typeof OrgSchema>): { provider: string; model: string } {
    if (body.llmProvider && body.llmModel) return { provider: body.llmProvider, model: body.llmModel }
    return PRESET_LLM[body.preferredLlm ?? 'claude'] ?? PRESET_LLM.claude
  }

  app.get('/api/orgs', async (req, reply) => {
    // req.userId is set by the Clerk auth pre-handler (MCA-14).
    const userId = (req as any).userId
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' })
    return { orgs: await db.select().from(schema.organisations).where(eq(schema.organisations.ownerId, userId)) }
  })
  app.post('/api/orgs', async (req, reply) => {
    // req.userId is set by the Clerk auth pre-handler (MCA-14). Never fall back to "anon".
    const userId = (req as any).userId
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' })
    const body = OrgSchema.parse(req.body)
    const llm = resolveLlm(body)
    // Persist per-org credentials for the chosen provider (consumed by the LLM router).
    const deployConfig: Record<string, string> = {}
    if (body.llmApiKey)  deployConfig[`${llm.provider}_api_key`]  = body.llmApiKey
    if (body.llmBaseUrl) deployConfig[`${llm.provider}_base_url`] = body.llmBaseUrl
    const org = { id: randomUUID(), name: body.name, description: body.description ?? null, logoUrl: body.logoUrl ?? null, ownerId: userId, createdAt: new Date(), mission: body.mission ?? null, culture: body.culture ?? null, deployMode: body.deployMode ?? null, cloudProvider: body.cloudProvider ?? null, preferredLlm: body.preferredLlm ?? null, deployConfig }
    await db.insert(schema.organisations).values(org)

    // 0. Create org membership for owner
    await db.insert(schema.orgMembers).values({
      id: randomUUID(), orgId: org.id, userId, role: 'owner', createdAt: new Date(),
    })

    // 1. Embed org knowledge into Pinecone (fire-and-forget)
    if (body.mission || body.culture) {
      const knowledgeText = [
        body.mission ? `Mission & Vision: ${body.mission}` : '',
        body.culture ? `Culture & Principles: ${body.culture}` : '',
      ].filter(Boolean).join('\n\n')
      upsertDocument({
        id: `${org.id}_onboarding`,
        orgId: org.id,
        text: knowledgeText,
        name: 'Onboarding — Mission & Culture',
        type: 'onboarding',
      }).catch(err => console.warn('Pinecone upsert failed (non-critical):', err))
    }

    // 2. Auto-create Arturito
    const arturitoId = randomUUID()
    const arturitoTOR = [
      `You are Arturito, Chief of Staff at ${body.name}.`,
      body.mission ? `Organisation mission: ${body.mission}` : '',
      body.culture ? `Culture: ${body.culture}` : '',
      'You orchestrate all agents, route tasks, and maintain strategic oversight.',
      'When asked to create agents, propose a full profile (name, role, TOR) using org context.',
    ].filter(Boolean).join('\n')

    await db.insert(schema.agents).values({
      id: arturitoId,
      orgId: org.id,
      departmentId: null,
      name: 'Arturito',
      role: 'Chief of Staff & Agent Orchestrator',
      personality: 'Direct, strategic. Routes tasks efficiently. Speaks in first person.',
      cv: null,
      termsOfReference: arturitoTOR,
      llmProvider: llm.provider,
      llmModel: llm.model,
      skills: [],
      status: 'idle',
      avatarEmoji: '🎯',
      agentType: 'standard',
      advisorPersona: null,
      memoryLongTerm: null,
      persona: 'You are Arturito, the AI Chief of Staff. You are professional, warm, and action-oriented. You speak clearly and concisely. You always have a plan.',
      expertise: 'Organization management, task delegation, strategic planning, team coordination, onboarding new agents',
      createdAt: new Date(),
    })

    // 3. First specialist agent (if selected)
    const FIRST_AGENT_TEMPLATES: Record<string, { name: string; role: string; emoji: string }> = {
      marketing:   { name: 'Maya', role: 'Head of Marketing',   emoji: '📣' },
      engineering: { name: 'Dev',  role: 'Head of Engineering', emoji: '💻' },
      finance:     { name: 'CFO',  role: 'Head of Finance',     emoji: '📊' },
      operations:  { name: 'Ops',  role: 'Head of Operations',  emoji: '⚙️' },
    }
    const firstRole = body.firstAgentRole
    if (firstRole && FIRST_AGENT_TEMPLATES[firstRole]) {
      const tmpl = FIRST_AGENT_TEMPLATES[firstRole]
      await db.insert(schema.agents).values({
        id: randomUUID(), orgId: org.id, departmentId: null,
        name: tmpl.name, role: tmpl.role,
        personality: null, cv: null,
        termsOfReference: `You are ${tmpl.name}, ${tmpl.role} at ${body.name}.`,
        llmProvider: llm.provider,
        llmModel: llm.model,
        skills: [], status: 'idle',
        avatarEmoji: tmpl.emoji, agentType: 'standard',
        advisorPersona: null, memoryLongTerm: null,
        createdAt: new Date(),
      })
    }

    // 4. Return org + arturitoId
    reply.code(201)
    return { org, arturitoId }
  })
  app.get('/api/orgs/:orgId', async (req, reply) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Not found' })
    return { org }
  })
  app.patch('/api/orgs/:orgId', async (req) => {
    const { orgId } = req.params as any
    await db.update(schema.organisations).set(req.body as any).where(eq(schema.organisations.id, orgId))
    return { ok: true }
  })
  app.delete('/api/orgs/:orgId', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, (req.params as any).orgId))
    reply.code(204)
  })
  app.get('/api/orgs/:orgId/departments', async (req) => {
    const { orgId } = req.params as any
    return { departments: await db.select().from(schema.departments).where(eq(schema.departments.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/departments', async (req, reply) => {
    const { orgId } = req.params as any
    const { name } = req.body as any
    const dept = { id: randomUUID(), orgId, name, createdAt: new Date() }
    await db.insert(schema.departments).values(dept)
    reply.code(201); return { department: dept }
  })
  app.delete('/api/orgs/:orgId/departments/:deptId', async (req, reply) => {
    await db.delete(schema.departments).where(eq(schema.departments.id, (req.params as any).deptId))
    reply.code(204)
  })
}

// ─── AGENTS ──────────────────────────────────────────────────────────────────

export async function agentRoutes(app: FastifyInstance) {
  const AgentSchema = z.object({
    name: z.string().min(1).max(100), role: z.string().min(1).max(200),
    departmentId: z.string().optional(), personality: z.string().optional(),
    cv: z.string().optional(), termsOfReference: z.string().optional(),
    llmProvider: z.string().default('anthropic'), llmModel: z.string().default('claude-sonnet-4-20250514'),
    avatarEmoji: z.string().default('🤖'), agentType: z.enum(['standard', 'advisor']).default('standard'),
    advisorPersona: z.string().optional(),
  })

  app.get('/api/agent-templates', async () => ({ templates: AGENT_TEMPLATES }))
  app.get('/api/orgs/:orgId/agents', async (req) => {
    const { orgId } = req.params as any
    return { agents: await db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/agents', async (req, reply) => {
    const { orgId } = req.params as any
    const body = AgentSchema.parse(req.body)
    const agent = { id: randomUUID(), orgId, departmentId: body.departmentId ?? null, name: body.name, role: body.role, personality: body.personality ?? null, cv: body.cv ?? null, termsOfReference: body.termsOfReference ?? null, llmProvider: body.llmProvider, llmModel: body.llmModel, skills: [] as string[], status: 'idle', avatarEmoji: body.avatarEmoji, agentType: body.agentType, advisorPersona: body.advisorPersona ?? null, memoryLongTerm: null, createdAt: new Date() }
    await db.insert(schema.agents).values(agent)
    reply.code(201); return { agent }
  })
  app.get('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent) return reply.code(404).send({ error: 'Not found' })
    return { agent }
  })
  app.patch('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as any
    const body = req.body as any
    // Validate advisorIds if provided (single query instead of N+1)
    if (body.advisorIds) {
      const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      const ids = typeof body.advisorIds === 'string' ? JSON.parse(body.advisorIds) : body.advisorIds
      if (ids.length > 0) {
        const found = await db.select({ id: schema.agents.id }).from(schema.agents)
          .where(and(inArray(schema.agents.id, ids), eq(schema.agents.orgId, agent.orgId)))
        if (found.length !== ids.length) {
          const foundIds = new Set(found.map(f => f.id))
          const invalid = ids.find((id: string) => !foundIds.has(id))
          return reply.code(400).send({ error: `Invalid advisorId: ${invalid}` })
        }
      }
      body.advisorIds = JSON.stringify(ids)
    }
    const _before = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    await db.update(schema.agents).set(body).where(eq(schema.agents.id, agentId))
    const _after = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    // MCA-GOV2 S4.1: snapshot the change for audit + rollback.
    if (_before) await db.insert(schema.configRevisions).values({ id: randomUUID(), orgId: _before.orgId, entity: 'agent', entityId: agentId, before: JSON.stringify(_before), after: JSON.stringify(_after), actor: (req as any).userId ?? 'human', createdAt: new Date() })
    return { agent: _after }
  })

  // MCA-GOV2 S4.2 — per-agent permissions (capabilities). null/empty = allow all.
  app.patch('/api/agents/:agentId/permissions', async (req) => {
    const { agentId } = req.params as any
    const b = (req.body ?? {}) as any
    const caps = Array.isArray(b.permissions) ? b.permissions.map(String) : []
    const before = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    await db.update(schema.agents).set({ permissions: JSON.stringify(caps) }).where(eq(schema.agents.id, agentId))
    if (before) await db.insert(schema.configRevisions).values({ id: randomUUID(), orgId: before.orgId, entity: 'agent', entityId: agentId, before: JSON.stringify(before), after: JSON.stringify({ ...before, permissions: JSON.stringify(caps) }), actor: (req as any).userId ?? 'human', createdAt: new Date() })
    return { ok: true, permissions: caps }
  })

  // MCA-GOV2 S4.1 — execution policies (action → requires approval).
  app.get('/api/orgs/:orgId/policies', async (req) => {
    const { orgId } = req.params as any
    return { policies: await db.select().from(schema.executionPolicies).where(eq(schema.executionPolicies.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/policies', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.action) return reply.code(400).send({ error: 'action required' })
    const row = { id: randomUUID(), orgId, action: String(b.action), requiresApproval: b.requiresApproval === false ? 0 : 1, createdAt: new Date() }
    await db.insert(schema.executionPolicies).values(row); reply.code(201); return { policy: row }
  })
  app.delete('/api/policies/:id', async (req, reply) => {
    await db.delete(schema.executionPolicies).where(eq(schema.executionPolicies.id, (req.params as any).id)); reply.code(204)
  })

  // MCA-GOV2 S4.1 — config revisions + rollback (restore a prior agent snapshot).
  app.get('/api/orgs/:orgId/revisions', async (req) => {
    const { orgId } = req.params as any
    const revisions = await db.select().from(schema.configRevisions).where(eq(schema.configRevisions.orgId, orgId)).orderBy(desc(schema.configRevisions.createdAt)).limit(100)
    return { revisions }
  })
  app.post('/api/revisions/:id/rollback', async (req, reply) => {
    const { id } = req.params as any
    const rev = await db.query.configRevisions.findFirst({ where: eq(schema.configRevisions.id, id) })
    if (!rev || !rev.before) return reply.code(404).send({ error: 'Revision not found' })
    let before: any; try { before = JSON.parse(rev.before) } catch { return reply.code(400).send({ error: 'corrupt snapshot' }) }
    if (rev.entity === 'agent') {
      const patch: any = {}
      for (const k of ['name', 'role', 'title', 'jobDescription', 'personality', 'permissions', 'reportsTo', 'status', 'llmProvider', 'llmModel', 'avatarEmoji', 'termsOfReference']) if (k in before) patch[k] = before[k]
      await db.update(schema.agents).set(patch).where(eq(schema.agents.id, rev.entityId))
      return { ok: true, entity: 'agent', entityId: rev.entityId, restored: Object.keys(patch) }
    }
    return reply.code(400).send({ error: `rollback not supported for entity ${rev.entity}` })
  })

  // MCA-GOV2 S4.4 — plugin job queue (enqueue + list).
  app.post('/api/orgs/:orgId/plugin-jobs', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.type) return reply.code(400).send({ error: 'type required' })
    const row = { id: randomUUID(), orgId, pluginId: b.pluginId ?? null, type: String(b.type), payload: b.payload ? JSON.stringify(b.payload) : null, status: 'queued', result: null, createdAt: new Date(), updatedAt: null }
    await db.insert(schema.pluginJobs).values(row); reply.code(201); return { job: row }
  })
  app.get('/api/orgs/:orgId/plugin-jobs', async (req) => {
    const { orgId } = req.params as any
    return { jobs: await db.select().from(schema.pluginJobs).where(eq(schema.pluginJobs.orgId, orgId)).orderBy(desc(schema.pluginJobs.createdAt)).limit(100) }
  })

  app.patch('/api/agents/:agentId/status', async (req) => {
    const { agentId } = req.params as any
    const { status } = req.body as any
    await db.update(schema.agents).set({ status }).where(eq(schema.agents.id, agentId))
    return { ok: true }
  })
  // Governance controls (MCA-PC B2): pause / resume / terminate an agent.
  for (const [verb, status] of [['pause', 'paused'], ['resume', 'idle'], ['terminate', 'terminated']] as const) {
    app.post(`/api/agents/:agentId/${verb}`, async (req) => {
      await db.update(schema.agents).set({ status }).where(eq(schema.agents.id, (req.params as any).agentId))
      return { ok: true, status }
    })
  }
  app.delete('/api/agents/:agentId', async (req, reply) => {
    await db.delete(schema.agents).where(eq(schema.agents.id, (req.params as any).agentId))
    reply.code(204)
  })
  app.get('/api/agents/:agentId/messages', async (req) => {
    const { agentId } = req.params as any
    return { messages: await db.select().from(schema.messages).where(eq(schema.messages.agentId, agentId)) }
  })
  app.post('/api/agents/:agentId/skills', async (req) => {
    const { agentId } = req.params as any
    const { skillId } = req.body as any
    const [agent, skill] = await Promise.all([
      db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) }),
      db.query.skills.findFirst({ where: eq(schema.skills.id, skillId) }),
    ])
    if (!agent || !skill) throw new Error('Agent or skill not found')
    const current = (agent.skills as string[]) ?? []
    if (!current.includes(skill.name)) await db.update(schema.agents).set({ skills: [...current, skill.name] }).where(eq(schema.agents.id, agentId))
    return { ok: true }
  })
  app.post('/api/agents/:agentId/chat', async (req, reply) => {
    const { agentId } = req.params as any
    const { input, history } = req.body as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent) return reply.code(404).send({ error: 'Not found' })
    const taskId = randomUUID()
    await db.insert(schema.tasks).values({ id: taskId, agentId, orgId: agent.orgId, title: input.slice(0, 100), input, status: 'pending', priority: 'medium', createdAt: new Date() })
    await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'user', content: input, createdAt: new Date() })
    const result = await executeAgentTask({ agentId, taskId, input, conversationHistory: history ?? [] })
    await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'assistant', content: result.output, createdAt: new Date() })
    return { output: result.output, taskId, tokensUsed: result.tokensUsed, costUsd: result.costUsd, budgetWarning: result.budgetWarning }
  })
  app.get('/api/agents/:agentId/stream', { websocket: true }, async (socket: any, req: any) => {
    socket.on('message', async (raw: Buffer) => {
      try {
        const { input, history } = JSON.parse(raw.toString())
        const { agentId } = req.params
        const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
        if (!agent) { socket.send(JSON.stringify({ type: 'error', data: 'Agent not found' })); return }
        const taskId = randomUUID()
        await db.insert(schema.tasks).values({ id: taskId, agentId, orgId: agent.orgId, title: input.slice(0, 100), input, status: 'pending', priority: 'medium', createdAt: new Date() })
        await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'user', content: input, createdAt: new Date() })
        socket.send(JSON.stringify({ type: 'start', taskId }))
        await executeAgentTask({
          agentId, taskId, input, conversationHistory: history ?? [],
          onToken: (token) => socket.send(JSON.stringify({ type: 'token', data: token })),
          onDone: async (result) => {
            await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'assistant', content: result.output, createdAt: new Date() })
            socket.send(JSON.stringify({ type: 'done', taskId, tokensUsed: result.tokensUsed, costUsd: result.costUsd, budgetWarning: result.budgetWarning }))
          },
        })
      } catch (err: any) { socket.send(JSON.stringify({ type: 'error', data: err.message })) }
    })
  })
  app.get('/api/orgs/:orgId/agents/advisors', async (req) => {
    const { orgId } = req.params as any
    return { agents: await db.select().from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.agentType, 'advisor'))) }
  })
  app.post('/api/orgs/:orgId/agents/propose', async (req, reply) => {
    const { orgId } = req.params as any
    const { role } = req.body as any
    if (!role) return reply.code(400).send({ error: 'role is required' })

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })

    const prompt = [
      `You are proposing an agent profile for the role: ${role}`,
      org.mission ? `Organisation mission: ${org.mission}` : '',
      org.culture  ? `Culture: ${org.culture}` : '',
      '',
      'Return a JSON object with exactly these keys:',
      '{ "name": string, "role": string, "termsOfReference": string, "cv": string, "avatarEmoji": string }',
      'Return ONLY the JSON object. No preamble, no markdown.',
    ].filter(Boolean).join('\n')

    let fullOutput = ''
    await streamLLM({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      system: 'You are an expert org designer. Output valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      onToken: (t) => { fullOutput += t },
    })

    try {
      const json = JSON.parse(fullOutput.replace(/```json|```/g, '').trim())
      return { proposal: json }
    } catch {
      return reply.code(500).send({ error: 'LLM returned invalid JSON', raw: fullOutput })
    }
  })

  // ─── EXTERNAL / BRING-YOUR-OWN RUNTIME AGENTS (MCA-EXT) ──────────────────
  const ExternalAgentSchema = z.object({
    name: z.string().min(1).max(100),
    role: z.string().min(1).max(200),
    runtime: z.enum(['openclaw', 'cursor', 'claude_code', 'custom']),
    llmProvider: z.string().default('minimax'),
    llmModel: z.string().default('minimax'),
    termsOfReference: z.string().optional(),
    avatarEmoji: z.string().default('🤖'),
    externalEndpoint: z.string().url().optional(),
    contactChannel: z.string().optional(),  // telegram chat id / email for pings
  })

  // Onboard an external agent. Returns the agent token ONCE — only its hash is stored.
  app.post('/api/orgs/:orgId/agents/external', async (req, reply) => {
    const { orgId } = req.params as any
    const body = ExternalAgentSchema.parse(req.body)
    const { token, hash } = generateAgentToken()
    const agent = {
      id: randomUUID(), orgId, departmentId: null, name: body.name, role: body.role,
      personality: null, cv: null, termsOfReference: body.termsOfReference ?? null,
      llmProvider: body.llmProvider, llmModel: body.llmModel, skills: [] as string[],
      status: 'idle', avatarEmoji: body.avatarEmoji, agentType: 'external',
      advisorPersona: null, memoryLongTerm: null, runtime: body.runtime,
      externalEndpoint: body.externalEndpoint ?? null, apiTokenHash: hash,
      heartbeatStatus: 'unknown', contactChannel: body.contactChannel ?? null,
      createdAt: new Date(),
    }
    await db.insert(schema.agents).values(agent)
    reply.code(201)
    // Never echo the hash; the raw token is shown exactly once here.
    return { agent: { ...agent, apiTokenHash: undefined }, agentToken: token }
  })

  // Rotate an external agent's token (revokes the previous one).
  app.post('/api/agents/:agentId/rotate-token', async (req, reply) => {
    const { agentId } = req.params as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (!isExternalAgent(agent)) return reply.code(400).send({ error: 'Not an external agent' })
    const { token, hash } = generateAgentToken()
    await db.update(schema.agents).set({ apiTokenHash: hash }).where(eq(schema.agents.id, agentId))
    return { agentToken: token }
  })

  // Goal-driven hiring (MCA-PC A2): prompt → proposed profile; confirm → create + place.
  app.post('/api/orgs/:orgId/agents/hire', async (req, reply) => {
    const { orgId } = req.params as any
    const body = (req.body ?? {}) as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })

    // Confirm path → create the (possibly edited) proposed agent and place it.
    if (body.confirm && body.profile) {
      const p = parseHireProposal(JSON.stringify(body.profile))
      let reportsTo: string | null = null
      if (p.reportsTo) {
        const mgr = await db.query.agents.findFirst({ where: and(eq(schema.agents.id, p.reportsTo), eq(schema.agents.orgId, orgId)) })
        reportsTo = mgr ? mgr.id : null
      }
      const external = isExternalRuntime(p.runtime)
      const tok = external ? generateAgentToken() : null
      const agent = {
        id: randomUUID(), orgId, departmentId: null, name: p.name, role: p.role,
        personality: null, cv: null, termsOfReference: p.termsOfReference || null,
        llmProvider: p.llmProvider, llmModel: p.llmModel, skills: p.skills,
        status: 'idle', avatarEmoji: p.avatarEmoji, agentType: external ? 'external' : 'standard',
        advisorPersona: null, memoryLongTerm: null, runtime: p.runtime,
        externalEndpoint: null, apiTokenHash: tok ? tok.hash : null,
        heartbeatStatus: external ? 'unknown' : null, contactChannel: null,
        reportsTo, title: p.title, jobDescription: p.jobDescription, createdAt: new Date(),
      }
      await db.insert(schema.agents).values(agent as any)
      reply.code(201)
      return { agent: { ...agent, apiTokenHash: undefined }, agentToken: tok ? tok.token : undefined }
    }

    // Propose path → ask the LLM to design an agent from the prompt + org chart.
    if (!body.prompt) return reply.code(400).send({ error: 'prompt is required' })
    const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, title: schema.agents.title })
      .from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const { system, user } = buildHirePrompt(body.prompt, org, agents)
    let out = ''
    await streamLLM({ provider: 'anthropic', model: 'claude-sonnet-4-20250514', system, messages: [{ role: 'user', content: user }], maxTokens: 1024, onToken: (t) => { out += t } })
    const proposal = parseHireProposal(out)
    if (proposal.reportsTo && !agents.find(a => a.id === proposal.reportsTo)) proposal.reportsTo = null
    return { proposal }
  })

  // Cockpit payload: roster (with heartbeat freshness) + tasks + summary.
  // Shape matches the dashboard's STATE object (offline fallback ⇄ live mode).
  app.get('/api/orgs/:orgId/cockpit', async (req) => {
    const { orgId } = req.params as any
    const now = Date.now()
    const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const tasks = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.orgId, orgId)).orderBy(desc(schema.tasks.createdAt)).limit(200)
    const roster = agents.map(a => ({
      id: a.id, name: a.name, role: a.role, runtime: a.runtime,
      llmProvider: a.llmProvider, llmModel: a.llmModel, status: a.status,
      agentType: a.agentType, avatarEmoji: a.avatarEmoji,
      heartbeat: isExternalAgent(a) ? heartbeatFreshness(a.lastHeartbeatAt as any, now) : 'green',
      lastHeartbeatAt: a.lastHeartbeatAt,
    }))
    const inCol = (c: string) => tasks.filter(t => (t.kanbanColumn ?? 'todo') === c).length
    return {
      orgId, generatedAt: new Date().toISOString(), agents: roster, tasks,
      summary: {
        agents: roster.length,
        external: roster.filter(r => r.agentType === 'external').length,
        tasks: tasks.length,
        todo: inCol('todo'), in_progress: inCol('in_progress'),
        blocked: inCol('blocked'), done: inCol('done'),
      },
    }
  })

  // Org chart & hierarchy (MCA-PC A1): reporting tree built from agents.reportsTo.
  app.get('/api/orgs/:orgId/orgchart', async (req) => {
    const { orgId } = req.params as any
    const rows = await db.select({
      id: schema.agents.id, name: schema.agents.name, role: schema.agents.role,
      title: schema.agents.title, reportsTo: schema.agents.reportsTo,
      avatarEmoji: schema.agents.avatarEmoji, status: schema.agents.status,
      runtime: schema.agents.runtime,
    }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
    return { tree: buildOrgChart(rows), count: rows.length }
  })
}

// ─── TASKS ───────────────────────────────────────────────────────────────────

export async function taskRoutes(app: FastifyInstance) {
  // ─── Unified inbox (MCA-PC A3) ──────────────────────────────────────────
  const inboxCols = {
    id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status,
    inboxState: schema.tasks.inboxState, priority: schema.tasks.priority,
    agentId: schema.tasks.agentId, createdAt: schema.tasks.createdAt,
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
    const amap = new Map(agents.map(a => [a.id, a]))
    const items = buildInbox(tasks as any, dismissed).map(i => ({
      ...i, agentName: amap.get(i.agentId)?.name ?? '—', agentEmoji: amap.get(i.agentId)?.avatarEmoji ?? '🤖',
    }))
    return { items, approvals, count: items.length + approvals.length }
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
    const goal = {
      id: randomUUID(), orgId, parentGoalId: b.parentGoalId ?? null, title: b.title,
      description: b.description ?? null, metric: b.metric ?? null,
      status: b.status ?? 'active', ownerAgentId: b.ownerAgentId ?? null, createdAt: new Date(),
    }
    await db.insert(schema.goals).values(goal)
    reply.code(201); return { goal }
  })
  app.patch('/api/goals/:goalId', async (req) => {
    const { goalId } = req.params as any
    await db.update(schema.goals).set(req.body as any).where(eq(schema.goals.id, goalId))
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
    return { approvals: await db.select().from(schema.approvalRequests).where(and(...conds)).orderBy(desc(schema.approvalRequests.createdAt)).limit(100) }
  })
  app.post('/api/orgs/:orgId/approvals', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.type || !b.summary) return reply.code(400).send({ error: 'type and summary are required' })
    const approval = { id: randomUUID(), orgId, type: b.type, summary: b.summary, payload: b.payload ?? null, status: 'pending', requestedByAgentId: b.requestedByAgentId ?? null, decidedBy: null, decidedAt: null, createdAt: new Date() }
    await db.insert(schema.approvalRequests).values(approval as any)
    reply.code(201); return { approval }
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
  app.post('/api/approvals/:id/decide', async (req, reply) => {
    const { id } = req.params as any
    const { decision } = (req.body ?? {}) as any
    if (decision !== 'approved' && decision !== 'rejected') return reply.code(400).send({ error: 'decision must be approved|rejected' })
    await db.update(schema.approvalRequests).set({ status: decision, decidedBy: (req as any).userId ?? 'human', decidedAt: new Date() }).where(eq(schema.approvalRequests.id, id))
    return { approval: await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, id) }) }
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
    const task = { id: randomUUID(), orgId, agentId: body.agentId, projectId: body.projectId ?? null, title: body.title, input: body.input ?? null, output: null, status: 'pending', priority: body.priority ?? 'medium', kanbanColumn: body.kanbanColumn ?? 'todo', llmModel: null, tokensUsed: null, costUsd: null, durationMs: null, assignedTo: body.assignedTo ?? null, dueAt: body.dueAt ? new Date(body.dueAt) : null, blockedBy: body.blockedBy ? JSON.stringify(body.blockedBy) : null, createdAt: new Date(), completedAt: null }
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
    return { comments }
  })
  app.post('/api/tasks/:taskId/comments', async (req, reply) => {
    const { taskId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.body) return reply.code(400).send({ error: 'body required' })
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    const row = { id: randomUUID(), orgId: task.orgId, taskId, authorAgentId: null, authorUser: (req as any).userId ?? null, body: String(b.body).slice(0, 4000), createdAt: new Date() }
    await db.insert(schema.taskComments).values(row)
    reply.code(201); return { comment: row }
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
    const subtasks = await db.select().from(schema.tasks).where(eq(schema.tasks.parentTaskId, taskId)).orderBy(schema.tasks.createdAt)
    return { subtasks }
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

  app.patch('/api/tasks/:taskId', async (req) => {
    const { taskId } = req.params as any
    await db.update(schema.tasks).set(req.body as any).where(eq(schema.tasks.id, taskId))
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

// ─── PROJECTS ────────────────────────────────────────────────────────────────

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/projects', async (req) => {
    const { orgId } = req.params as any
    return { projects: await db.select().from(schema.projects).where(eq(schema.projects.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/projects', async (req, reply) => {
    const { orgId } = req.params as any
    const body = req.body as any
    const project = { id: randomUUID(), orgId, departmentId: body.departmentId ?? null, name: body.name, description: body.description ?? null, createdAt: new Date() }
    await db.insert(schema.projects).values(project)
    reply.code(201); return { project }
  })
  app.patch('/api/projects/:projectId', async (req) => {
    await db.update(schema.projects).set(req.body as any).where(eq(schema.projects.id, (req.params as any).projectId))
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

// ─── COSTS ───────────────────────────────────────────────────────────────────

export async function costRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/costs', async (req) => {
    const { orgId } = req.params as any
    const { groupBy = 'agent', period = '30d' } = req.query as any
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30
    const since = new Date(Date.now() - days * 86400000)
    const rawTasks = await db.select({ agentId: schema.tasks.agentId, projectId: schema.tasks.projectId, costUsd: schema.tasks.costUsd, tokensUsed: schema.tasks.tokensUsed, createdAt: schema.tasks.createdAt }).from(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), gte(schema.tasks.createdAt, since)))
    const totals = { totalCost: rawTasks.reduce((s, t) => s + (t.costUsd ?? 0), 0), totalTokens: rawTasks.reduce((s, t) => s + (t.tokensUsed ?? 0), 0), taskCount: rawTasks.length }
    if (groupBy === 'agent') {
      const map = new Map<string, any>()
      for (const t of rawTasks) {
        const e = map.get(t.agentId) ?? { agentId: t.agentId, totalCost: 0, totalTokens: 0, taskCount: 0 }
        e.totalCost += t.costUsd ?? 0; e.totalTokens += t.tokensUsed ?? 0; e.taskCount++
        map.set(t.agentId, e)
      }
      const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, avatarEmoji: schema.agents.avatarEmoji }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
      const agentMap = new Map(agents.map(a => [a.id, a]))
      return { costs: Array.from(map.values()).map(c => ({ ...c, agentName: agentMap.get(c.agentId)?.name ?? 'Unknown', avatarEmoji: agentMap.get(c.agentId)?.avatarEmoji ?? '🤖' })), period, groupBy, totals }
    }
    if (groupBy === 'day') {
      const dayMap = new Map<string, any>()
      for (const t of rawTasks) {
        const day = (t.createdAt as Date).toISOString().slice(0, 10)
        const e = dayMap.get(day) ?? { date: day, totalCost: 0, totalTokens: 0 }
        e.totalCost += t.costUsd ?? 0; e.totalTokens += t.tokensUsed ?? 0
        dayMap.set(day, e)
      }
      return { costs: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)), period, groupBy, totals }
    }
    return { costs: totals, period, groupBy }
  })
  app.get('/api/orgs/:orgId/costs/summary', async (req) => {
    const { orgId } = req.params as any
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfWeek = new Date(startOfToday.getTime() - startOfToday.getDay() * 86400000)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const allTasks = await db.select({
      costUsd: schema.tasks.costUsd,
      tokensUsed: schema.tasks.tokensUsed,
      createdAt: schema.tasks.createdAt,
    }).from(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), gte(schema.tasks.createdAt, startOfMonth)))

    const sumPeriod = (since: Date) => {
      const filtered = allTasks.filter(t => (t.createdAt as Date) >= since)
      return {
        cost: filtered.reduce((s, t) => s + (t.costUsd ?? 0), 0),
        tokens: filtered.reduce((s, t) => s + (t.tokensUsed ?? 0), 0),
        tasks: filtered.length,
      }
    }

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    const monthData = sumPeriod(startOfMonth)
    const budgetLimit = org?.budgetMonthlyUsd ?? null

    return {
      today: sumPeriod(startOfToday),
      week: sumPeriod(startOfWeek),
      month: monthData,
      budget: {
        monthlyLimitUsd: budgetLimit,
        usedThisMonth: monthData.cost,
        percentUsed: budgetLimit ? Math.round((monthData.cost / budgetLimit) * 100) : null,
      },
    }
  })

  // Cost CSV export
  app.get('/api/orgs/:orgId/costs/export', async (req, reply) => {
    const { orgId } = req.params as any
    const tasks = await db.select({
      createdAt: schema.tasks.createdAt, agentId: schema.tasks.agentId,
      llmModel: schema.tasks.llmModel, tokensUsed: schema.tasks.tokensUsed, costUsd: schema.tasks.costUsd,
    }).from(schema.tasks).where(eq(schema.tasks.orgId, orgId)).orderBy(desc(schema.tasks.createdAt))
    const agents = await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const agentMap = new Map(agents.map(a => [a.id, a.name]))

    const header = 'date,agentId,agentName,model,tokens,cost'
    const rows = tasks.filter(t => t.costUsd != null).map(t =>
      [t.createdAt instanceof Date ? t.createdAt.toISOString().slice(0, 10) : '',
       t.agentId, agentMap.get(t.agentId) ?? 'Unknown', t.llmModel ?? '',
       t.tokensUsed ?? 0, (t.costUsd ?? 0).toFixed(6)].join(',')
    )
    const csv = [header, ...rows].join('\n')
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', 'attachment; filename=costs-export.csv')
    return csv
  })
}

// ─── SKILLS ──────────────────────────────────────────────────────────────────

const SKILL_LIBRARY_REPO = 'Arturito7ei/skill-library'

export async function skillRoutes(app: FastifyInstance) {
  app.get('/api/skills', async () => ({ skills: await db.select().from(schema.skills) }))
  app.post('/api/skills', async (req, reply) => {
    const body = req.body as any
    const skill = { id: randomUUID(), name: body.name, description: body.description ?? null, domain: body.domain, content: body.content, source: body.source ?? 'custom', githubPath: null, orgId: body.orgId ?? null, lastSyncedAt: null, createdAt: new Date() }
    await db.insert(schema.skills).values(skill)
    reply.code(201); return { skill }
  })
  app.get('/api/skills/:skillId', async (req, reply) => {
    const { skillId } = req.params as any
    const skill = await db.query.skills.findFirst({ where: eq(schema.skills.id, skillId) })
    if (!skill) return reply.code(404).send({ error: 'Not found' })
    return { skill }
  })
  app.patch('/api/skills/:skillId', async (req) => {
    await db.update(schema.skills).set(req.body as any).where(eq(schema.skills.id, (req.params as any).skillId))
    return { ok: true }
  })
  app.delete('/api/skills/:skillId', async (req, reply) => {
    await db.delete(schema.skills).where(eq(schema.skills.id, (req.params as any).skillId))
    reply.code(204)
  })
  app.post('/api/skills/sync', async (_req, reply) => {
    const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `token ${process.env.GITHUB_TOKEN}`
    try {
      const res = await fetch(`https://api.github.com/repos/${SKILL_LIBRARY_REPO}/contents`, { headers })
      if (!res.ok) return reply.code(502).send({ error: 'GitHub fetch failed' })
      const dirs = (await res.json() as any[]).filter((f: any) => f.type === 'dir')
      let synced = 0
      for (const dir of dirs) {
        const fr = await fetch(`https://api.github.com/repos/${SKILL_LIBRARY_REPO}/contents/${dir.path}/SKILL.md`, { headers })
        if (!fr.ok) continue
        const fd = await fr.json() as any
        const content = Buffer.from(fd.content, 'base64').toString('utf-8')
        const name = content.split('\n').find((l: string) => l.startsWith('# '))?.replace('# ', '').trim() ?? dir.name
        const description = content.split('\n').find((l: string) => l.startsWith('> '))?.replace('> ', '').trim()
        const existing = await db.query.skills.findFirst({ where: eq(schema.skills.githubPath, dir.path) })
        if (existing) { await db.update(schema.skills).set({ content, lastSyncedAt: new Date() }).where(eq(schema.skills.id, existing.id)) }
        else { await db.insert(schema.skills).values({ id: randomUUID(), name, description: description ?? null, domain: 'integration', content, source: 'github', githubPath: dir.path, orgId: null, lastSyncedAt: new Date(), createdAt: new Date() }) }
        synced++
      }
      return { synced }
    } catch (err: any) { return reply.code(500).send({ error: err.message }) }
  })

  // ── Obsidian Vault Sync ────────────────────────────────────────────────
  // POST /api/skills/obsidian-sync
  // Body: { skills: Array<{ name, description?, domain, content, vaultPath } }
  // Upserts by (name + source='obsidian').
  app.post('/api/skills/obsidian-sync', async (req, reply) => {
    const body = req.body as any
    const skills: Array<{ name: string; description?: string; domain: string; content: string; vaultPath: string }> = body?.skills ?? []
    if (!Array.isArray(skills)) return reply.code(400).send({ error: 'skills must be an array' })
    let synced = 0
    for (const s of skills) {
      if (!s.name || !s.content) continue
      const existing = await db.query.skills.findFirst({
        where: and(eq(schema.skills.name, s.name), eq(schema.skills.source, 'obsidian'))
      })
      if (existing) {
        await db.update(schema.skills).set({
          description: s.description ?? existing.description,
          domain: s.domain ?? existing.domain,
          content: s.content,
          githubPath: s.vaultPath ?? existing.githubPath,
          lastSyncedAt: new Date(),
        }).where(eq(schema.skills.id, existing.id))
      } else {
        await db.insert(schema.skills).values({
          id: randomUUID(),
          name: s.name,
          description: s.description ?? null,
          domain: s.domain ?? 'integration',
          content: s.content,
          source: 'obsidian',
          githubPath: s.vaultPath ?? null,
          orgId: null,
          lastSyncedAt: new Date(),
          createdAt: new Date(),
        })
      }
      synced++
    }
    return { synced }
  })
}

// ─── KNOWLEDGE ───────────────────────────────────────────────────────────────

function chunkText(text: string, wordsPerChunk: number, overlapWords: number): string[] {
  const words = text.split(/\s+/)
  const chunks: string[] = []
  const step = wordsPerChunk - overlapWords
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '))
    if (i + wordsPerChunk >= words.length) break
  }
  return chunks.length > 0 ? chunks : [text]
}

export { chunkText }

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/knowledge/browse', async (req, reply) => {
    const { orgId } = req.params as any
    const { folderId = 'root', accessToken } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const q = `'${folderId}' in parents and trashed = false`
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,modifiedTime)`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return reply.code(502).send({ error: 'Google Drive error' })
    const data = await res.json() as any
    return { files: data.files.map((f: any) => ({ id: f.id, name: f.name, webUrl: f.webViewLink, modifiedAt: f.modifiedTime, type: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file', mimeType: f.mimeType })), folderId }
  })
  app.get('/api/orgs/:orgId/knowledge/file/:fileId', async (req, reply) => {
    const { fileId } = req.params as any
    const { accessToken, mimeType = 'text/plain' } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Access token required' })
    const url = mimeType.includes('google-apps') ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain` : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return reply.code(502).send({ error: 'Failed to read file' })
    return { content: await res.text(), fileId }
  })
  app.get('/api/orgs/:orgId/knowledge', async (req) => {
    const { orgId } = req.params as any
    return { items: await db.select().from(schema.knowledgeItems).where(eq(schema.knowledgeItems.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/knowledge', async (req, reply) => {
    const { orgId } = req.params as any
    const body = req.body as any
    const item = { id: randomUUID(), orgId, name: body.name, type: body.type, mimeType: body.mimeType ?? null, externalId: body.externalId, externalUrl: body.externalUrl ?? null, parentId: null, content: null, backend: body.backend ?? 'google_drive', createdAt: new Date() }
    await db.insert(schema.knowledgeItems).values(item)
    reply.code(201); return { item }
  })
  app.delete('/api/knowledge/:itemId', async (req, reply) => {
    await db.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.id, (req.params as any).itemId))
    reply.code(204)
  })
  app.post('/api/orgs/:orgId/knowledge/embed', async (req, reply) => {
    const { orgId } = req.params as any
    const { name, text, type = 'document' } = req.body as any
    if (!name || !text) return reply.code(400).send({ error: 'name and text are required' })

    const chunks = chunkText(text, 500, 50)
    const itemId = randomUUID()

    await db.insert(schema.knowledgeItems).values({
      id: itemId, orgId, name, type,
      mimeType: 'text/plain',
      externalId: null, externalUrl: null,
      parentId: null, content: text.slice(0, 2000),
      backend: 'text',
      createdAt: new Date(),
    })

    // Fire-and-forget embedding
    const embedPromises = chunks.map((chunk, i) =>
      upsertDocument({
        id: `${itemId}_chunk_${i}`,
        orgId, text: chunk,
        name: chunks.length > 1 ? `${name} (part ${i + 1})` : name,
        type,
      }).catch(err => console.warn('Embed chunk failed:', err))
    )
    Promise.all(embedPromises).catch(() => {})

    reply.code(201)
    return { item: { id: itemId, name, type, chunkCount: chunks.length } }
  })
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:orgId/auth/google', async (req) => {
    const { orgId } = req.params as any
    return { url: buildAuthUrl(orgId) }
  })

  app.get('/api/auth/google/callback', async (req, reply) => {
    const { code, state: orgId } = req.query as any
    if (!code || !orgId) return reply.code(400).send({ error: 'Missing code or state' })
    const tokens = await exchangeCode(code)
    const existing = await db.query.oauthTokens.findFirst({
      where: and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google'))
    })
    if (existing) {
      await db.update(schema.oauthTokens).set({
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      }).where(eq(schema.oauthTokens.id, existing.id))
    } else {
      await db.insert(schema.oauthTokens).values({
        id: randomUUID(), orgId, provider: 'google',
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt, scopes: GOOGLE_SCOPES,
        createdAt: new Date(),
      })
    }
    reply.redirect(`${process.env.ALLOWED_ORIGINS?.split(',')[0] ?? '/'}/dashboard?connected=google`)
  })

  app.get('/api/orgs/:orgId/auth/google/status', async (req) => {
    const { orgId } = req.params as any
    const token = await db.query.oauthTokens.findFirst({
      where: and(eq(schema.oauthTokens.orgId, orgId), eq(schema.oauthTokens.provider, 'google'))
    })
    return { connected: !!token, expiresAt: token?.expiresAt ?? null }
  })
}

// ─── CREDENTIALS ─────────────────────────────────────────────────────────────

export function maskKey(key: string): string {
  if (key.length <= 11) return '****'
  return key.slice(0, 7) + '...' + key.slice(-4)
}

export async function credentialRoutes(app: FastifyInstance) {
  app.post('/api/orgs/:orgId/credentials', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId } = req.params as any
    const { provider, apiKey } = req.body as any
    if (!provider || !apiKey) return reply.code(400).send({ error: 'provider and apiKey required' })
    const validProviders = ['anthropic', 'openai', 'gemini']
    if (!validProviders.includes(provider)) return reply.code(400).send({ error: `provider must be one of: ${validProviders.join(', ')}` })

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })
    const config = (org.deployConfig ?? {}) as Record<string, string>
    config[`${provider}_api_key`] = apiKey
    await db.update(schema.organisations).set({ deployConfig: config }).where(eq(schema.organisations.id, orgId))
    reply.code(201)
    return { ok: true, provider, maskedKey: maskKey(apiKey) }
  })

  app.get('/api/orgs/:orgId/credentials', async (req) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return { credentials: [] }
    const config = (org.deployConfig ?? {}) as Record<string, string>
    const credentials = ['anthropic', 'openai', 'gemini']
      .filter(p => config[`${p}_api_key`])
      .map(p => ({ provider: p, maskedKey: maskKey(config[`${p}_api_key`]) }))
    return { credentials }
  })

  app.delete('/api/orgs/:orgId/credentials/:provider', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, provider } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })
    const config = (org.deployConfig ?? {}) as Record<string, string>
    delete config[`${provider}_api_key`]
    await db.update(schema.organisations).set({ deployConfig: config }).where(eq(schema.organisations.id, orgId))
    reply.code(204)
  })
}
