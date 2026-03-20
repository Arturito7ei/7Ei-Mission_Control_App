import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// ─── Jira Integration ─────────────────────────────────────────────────────────
// Project key: O7MC (per ADR + ITERATION_PLAN)
// Auth: Jira API token (Basic auth: email:token base64)

function jiraAuth(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
}

function jiraBase(domain: string): string {
  return `https://${domain}.atlassian.net/rest/api/3`
}

const ConnectSchema = z.object({
  domain: z.string().min(1),
  email: z.string().email(),
  apiToken: z.string().min(1),
  defaultProjectKey: z.string().default('O7MC'),
})

const jiraConfigs = new Map<string, { domain: string; email: string; apiToken: string; defaultProjectKey: string }>()

export async function jiraRoutes(app: FastifyInstance) {

  app.post('/api/orgs/:orgId/jira/connect', async (req, reply) => {
    const { orgId } = req.params as any
    const body = ConnectSchema.parse(req.body)
    const testRes = await fetch(`${jiraBase(body.domain)}/myself`, {
      headers: { Authorization: jiraAuth(body.email, body.apiToken), Accept: 'application/json' },
    })
    if (!testRes.ok) return reply.code(401).send({ error: 'Invalid Jira credentials' })
    const user = await testRes.json() as any
    jiraConfigs.set(orgId, body)
    return { ok: true, jiraUser: user.displayName, email: user.emailAddress }
  })

  app.get('/api/orgs/:orgId/jira/status', async (req) => {
    const { orgId } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    return { connected: !!cfg, domain: cfg?.domain, defaultProjectKey: cfg?.defaultProjectKey }
  })

  app.delete('/api/orgs/:orgId/jira/connect', async (req, reply) => {
    const { orgId } = req.params as any
    jiraConfigs.delete(orgId)
    reply.code(204)
  })

  app.get('/api/orgs/:orgId/jira/projects', async (req, reply) => {
    const { orgId } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const res = await fetch(`${jiraBase(cfg.domain)}/project/search?maxResults=50`, {
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json' },
    })
    if (!res.ok) return reply.code(502).send({ error: 'Jira API error' })
    const data = await res.json() as any
    return { projects: data.values?.map((p: any) => ({ id: p.id, key: p.key, name: p.name, type: p.projectTypeKey })) ?? [] }
  })

  app.get('/api/orgs/:orgId/jira/issues', async (req, reply) => {
    const { orgId } = req.params as any
    const { projectKey, maxResults = '30', startAt = '0', status } = req.query as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const pk = projectKey ?? cfg.defaultProjectKey
    let jql = `project = ${pk} ORDER BY created DESC`
    if (status) jql = `project = ${pk} AND status = "${status}" ORDER BY created DESC`
    const url = `${jiraBase(cfg.domain)}/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&startAt=${startAt}&fields=summary,status,assignee,priority,issuetype,description,created,updated`
    const res = await fetch(url, { headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json' } })
    if (!res.ok) return reply.code(502).send({ error: 'Jira API error' })
    const data = await res.json() as any
    return {
      issues: (data.issues ?? []).map((i: any) => ({
        id: i.id, key: i.key, summary: i.fields.summary,
        status: i.fields.status?.name, priority: i.fields.priority?.name,
        issueType: i.fields.issuetype?.name, assignee: i.fields.assignee?.displayName ?? null,
        created: i.fields.created, updated: i.fields.updated,
      })),
      total: data.total, startAt: data.startAt, maxResults: data.maxResults,
    }
  })

  app.get('/api/orgs/:orgId/jira/issues/:issueKey', async (req, reply) => {
    const { orgId, issueKey } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const res = await fetch(`${jiraBase(cfg.domain)}/issue/${issueKey}`, {
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json' },
    })
    if (!res.ok) return reply.code(502).send({ error: 'Jira API error' })
    const i = await res.json() as any
    return {
      issue: {
        id: i.id, key: i.key, summary: i.fields.summary,
        description: extractJiraText(i.fields.description),
        status: i.fields.status?.name, priority: i.fields.priority?.name,
        issueType: i.fields.issuetype?.name, assignee: i.fields.assignee?.displayName ?? null,
        created: i.fields.created, updated: i.fields.updated,
      },
    }
  })

  app.post('/api/orgs/:orgId/jira/issues', async (req, reply) => {
    const { orgId } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const { summary, description, issueType = 'Task', priority = 'Medium', projectKey, assigneeEmail, agentId } = req.body as any
    const pk = projectKey ?? cfg.defaultProjectKey
    const body: any = {
      fields: {
        project: { key: pk }, summary, issuetype: { name: issueType }, priority: { name: priority },
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description ?? summary }] }] },
      },
    }
    if (assigneeEmail) body.fields.assignee = { emailAddress: assigneeEmail }
    const res = await fetch(`${jiraBase(cfg.domain)}/issue`, {
      method: 'POST',
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any
      return reply.code(502).send({ error: err.errorMessages?.[0] ?? 'Jira API error' })
    }
    const issue = await res.json() as any
    if (agentId) {
      await db.insert(schema.tasks).values({
        id: randomUUID(), orgId, agentId,
        title: `[Jira ${issue.key}] ${summary}`,
        input: description ?? summary, status: 'pending',
        priority: priority.toLowerCase(), createdAt: new Date(),
      }).catch(() => {})
    }
    reply.code(201)
    return { issue: { id: issue.id, key: issue.key, url: `https://${cfg.domain}.atlassian.net/browse/${issue.key}` } }
  })

  app.patch('/api/orgs/:orgId/jira/issues/:issueKey', async (req, reply) => {
    const { orgId, issueKey } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const { summary, priority, description } = req.body as any
    const fields: any = {}
    if (summary) fields.summary = summary
    if (priority) fields.priority = { name: priority }
    if (description) fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] }
    const res = await fetch(`${jiraBase(cfg.domain)}/issue/${issueKey}`, {
      method: 'PUT',
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
    if (!res.ok) return reply.code(502).send({ error: 'Jira API error' })
    return { ok: true }
  })

  app.get('/api/orgs/:orgId/jira/issues/:issueKey/transitions', async (req, reply) => {
    const { orgId, issueKey } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const res = await fetch(`${jiraBase(cfg.domain)}/issue/${issueKey}/transitions`, {
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json' },
    })
    if (!res.ok) return reply.code(502).send({ error: 'Jira API error' })
    const data = await res.json() as any
    return { transitions: (data.transitions ?? []).map((t: any) => ({ id: t.id, name: t.name, to: t.to?.name })) }
  })

  app.post('/api/orgs/:orgId/jira/issues/:issueKey/transitions', async (req, reply) => {
    const { orgId, issueKey } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const { transitionId } = req.body as any
    const res = await fetch(`${jiraBase(cfg.domain)}/issue/${issueKey}/transitions`, {
      method: 'POST',
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: transitionId } }),
    })
    if (!res.ok) return reply.code(502).send({ error: 'Jira API error' })
    return { ok: true }
  })

  app.post('/api/orgs/:orgId/jira/issues/:issueKey/comments', async (req, reply) => {
    const { orgId, issueKey } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const { body: commentBody } = req.body as any
    const res = await fetch(`${jiraBase(cfg.domain)}/issue/${issueKey}/comment`, {
      method: 'POST',
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: commentBody }] }] } }),
    })
    if (!res.ok) return reply.code(502).send({ error: 'Jira API error' })
    const comment = await res.json() as any
    reply.code(201)
    return { commentId: comment.id }
  })

  app.post('/api/orgs/:orgId/jira/sync', async (req, reply) => {
    const { orgId } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const { agentId, projectKey } = req.body as any
    if (!agentId) return reply.code(400).send({ error: 'agentId required' })
    const pk = projectKey ?? cfg.defaultProjectKey
    const jql = `project = ${pk} AND status != Done ORDER BY updated DESC`
    const url = `${jiraBase(cfg.domain)}/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,status,priority,description`
    const res = await fetch(url, { headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json' } })
    if (!res.ok) return reply.code(502).send({ error: 'Jira sync failed' })
    const data = await res.json() as any
    let created = 0
    for (const issue of data.issues ?? []) {
      await db.insert(schema.tasks).values({
        id: randomUUID(), orgId, agentId,
        title: `[${issue.key}] ${issue.fields.summary}`,
        input: extractJiraText(issue.fields.description) ?? issue.fields.summary,
        status: mapJiraStatus(issue.fields.status?.name),
        priority: mapJiraPriority(issue.fields.priority?.name),
        createdAt: new Date(),
      }).catch(() => {})
      created++
    }
    return { synced: created, projectKey: pk }
  })

  app.post('/api/orgs/:orgId/jira/from-task/:taskId', async (req, reply) => {
    const { orgId, taskId } = req.params as any
    const cfg = jiraConfigs.get(orgId)
    if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    const body = {
      fields: {
        project: { key: cfg.defaultProjectKey }, summary: task.title.slice(0, 255),
        issuetype: { name: 'Task' },
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: task.output ?? task.input ?? task.title }] }] },
      },
    }
    const res = await fetch(`${jiraBase(cfg.domain)}/issue`, {
      method: 'POST',
      headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return reply.code(502).send({ error: 'Jira create failed' })
    const issue = await res.json() as any
    reply.code(201)
    return { issue: { key: issue.key, url: `https://${cfg.domain}.atlassian.net/browse/${issue.key}` } }
  })
}

function extractJiraText(adf: any): string | null {
  if (!adf || !adf.content) return null
  const texts: string[] = []
  function walk(node: any) {
    if (node.type === 'text') texts.push(node.text)
    if (node.content) node.content.forEach(walk)
  }
  adf.content.forEach(walk)
  return texts.join(' ') || null
}

function mapJiraStatus(s?: string): string {
  if (!s) return 'pending'
  const l = s.toLowerCase()
  if (l.includes('progress') || l.includes('review')) return 'in_progress'
  if (l.includes('done') || l.includes('closed') || l.includes('resolved')) return 'done'
  if (l.includes('blocked')) return 'blocked'
  return 'pending'
}

function mapJiraPriority(p?: string): string {
  if (!p) return 'medium'
  const l = p.toLowerCase()
  if (l === 'highest' || l === 'critical') return 'highest'
  if (l === 'high') return 'high'
  if (l === 'low') return 'low'
  if (l === 'lowest' || l === 'trivial') return 'lowest'
  return 'medium'
}
