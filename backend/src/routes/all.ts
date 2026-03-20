import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and, desc, gte } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { executeAgentTask } from '../services/agent-executor'

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
  const OrgSchema = z.object({ name: z.string().min(1).max(100), description: z.string().optional(), logoUrl: z.string().url().optional() })

  app.get('/api/orgs', async (req) => {
    const userId = (req as any).auth?.userId ?? ''
    return { orgs: await db.select().from(schema.organisations).where(eq(schema.organisations.ownerId, userId)) }
  })
  app.post('/api/orgs', async (req, reply) => {
    const userId = (req as any).auth?.userId ?? 'anon'
    const body = OrgSchema.parse(req.body)
    const org = { id: randomUUID(), name: body.name, description: body.description ?? null, logoUrl: body.logoUrl ?? null, ownerId: userId, createdAt: new Date() }
    await db.insert(schema.organisations).values(org)
    reply.code(201); return { org }
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
  app.delete('/api/orgs/:orgId', async (req, reply) => {
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
  app.patch('/api/agents/:agentId', async (req) => {
    const { agentId } = req.params as any
    await db.update(schema.agents).set(req.body as any).where(eq(schema.agents.id, agentId))
    return { agent: await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) }) }
  })
  app.patch('/api/agents/:agentId/status', async (req) => {
    const { agentId } = req.params as any
    const { status } = req.body as any
    await db.update(schema.agents).set({ status }).where(eq(schema.agents.id, agentId))
    return { ok: true }
  })
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
    return { output: result.output, taskId, tokensUsed: result.tokensUsed, costUsd: result.costUsd }
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
            socket.send(JSON.stringify({ type: 'done', taskId, tokensUsed: result.tokensUsed, costUsd: result.costUsd }))
          },
        })
      } catch (err: any) { socket.send(JSON.stringify({ type: 'error', data: err.message })) }
    })
  })
}

// ─── TASKS ───────────────────────────────────────────────────────────────────

export async function taskRoutes(app: FastifyInstance) {
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
    const task = { id: randomUUID(), orgId, agentId: body.agentId, projectId: body.projectId ?? null, title: body.title, input: body.input ?? null, output: null, status: 'pending', priority: body.priority ?? 'medium', kanbanColumn: body.kanbanColumn ?? 'todo', llmModel: null, tokensUsed: null, costUsd: null, durationMs: null, assignedTo: body.assignedTo ?? null, dueAt: body.dueAt ? new Date(body.dueAt) : null, createdAt: new Date(), completedAt: null }
    await db.insert(schema.tasks).values(task)
    reply.code(201); return { task }
  })
  app.get('/api/tasks/:taskId', async (req, reply) => {
    const { taskId } = req.params as any
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Not found' })
    return { task }
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
}

// ─── KNOWLEDGE ───────────────────────────────────────────────────────────────

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
}
