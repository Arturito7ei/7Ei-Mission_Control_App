// Option C — vault grounding on default Arturita converse + connectors mid-chat via CONN-9.
//
// Proves:
//   1. Lean `/converse` injects org/agent vault notes into the system prompt when configured.
//   2. Default Arturita (no picker) with connector capability routes through executeAgentTask.
//   3. deferAnswer + image contracts stay on the lean path (no silent connector fork).
//   4. A write connector from default Arturita still parks at CONN-7 with step-up.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'opt-c-vault-connectors-test-key'
process.env.VAULT_GH_TOKEN = 'gh-test-vault-token'

let db: any, schema: any, eq: any
let app: FastifyInstance
let provider: Server
let captured: any[] = []
let fetchCalls: string[] = []

const ORG = 'optc-org'
const OWNER = 'optc-owner'
const ARTURITA = 'optc-arturita'
const CONVERSE = `/api/orgs/${ORG}/arturita/converse`
const CREATED_AT = new Date('2020-01-01T00:00:00Z')

const agentRow = (over: Record<string, unknown>) => ({
  llmProvider: 'openai', llmModel: 'gpt-test', status: 'idle',
  agentType: 'standard', runtime: 'internal', trustMode: 'standard',
  avatarEmoji: '🌸', createdAt: CREATED_AT, permissions: JSON.stringify([]), ...over,
})

const origFetch = globalThis.fetch

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ eq } = await import('drizzle-orm'))

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? '')
    fetchCalls.push(url)
    // Vault long-term reads (org + agent)
    if (url.includes('/contents/vault/Memory/long-term.md')) {
      return new Response(JSON.stringify({
        content: Buffer.from('# Org memory\nWe ship agent-native software.').toString('base64'),
        encoding: 'base64',
      }), { status: 200 })
    }
    if (url.includes('/contents/vault/Memory/agents/arturita/long-term.md')) {
      return new Response(JSON.stringify({
        content: Buffer.from('# Arturita notes\nSkills: GitHub read, vault grounding.').toString('base64'),
        encoding: 'base64',
      }), { status: 200 })
    }
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    }
    return origFetch(input, init)
  }) as typeof fetch

  provider = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body: any = {}
      try { body = JSON.parse(raw) } catch { body = { unparsed: raw } }
      captured.push(body)
      const text = (globalThis as any).__reply ?? 'vault-grounded-ok'
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: text } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }))
    })
  })
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`

  await db.insert(schema.organisations).values({
    id: ORG, name: 'Opt C Org', ownerId: OWNER, createdAt: CREATED_AT,
    deployConfig: {
      arturita_llm_chain: [{ provider: 'openai', model: 'gpt-test', mode: 'provider' }],
      openai_api_key: 'test-key', openai_base_url: base,
    },
  })
  await db.insert(schema.orgMembers).values({
    id: 'optc-m1', orgId: ORG, userId: OWNER, role: 'owner', createdAt: CREATED_AT,
  })
  await db.insert(schema.agents).values([
    agentRow({
      id: ARTURITA, orgId: ORG, name: 'Arturita', role: 'Chief of Staff', agentType: 'arturita',
    }),
  ] as any)

  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { arturitaConverseRoutes } = await import('../routes/arturita-converse')

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(arturitaConverseRoutes)
  })
  await app.ready()
})

after(async () => {
  globalThis.fetch = origFetch
  delete process.env.VAULT_GH_TOKEN
  if (app) await app.close()
  if (provider) await new Promise<void>(r => provider.close(() => r()))
})

const as = (body: unknown) =>
  app.inject({
    method: 'POST', url: CONVERSE,
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })

const lastSystemPrompt = (): string => {
  const last = captured[captured.length - 1]
  if (!last) return ''
  return String(last.system ?? (last.messages ?? []).find((m: any) => m.role === 'system')?.content ?? '')
}

beforeEach(async () => {
  captured = []
  fetchCalls = []
  ;(globalThis as any).__reply = 'vault-grounded-ok'
  const { clearSharedMemoryCache } = await import('../services/agent-memory')
  clearSharedMemoryCache()
  await db.delete(schema.tasks)
  await db.delete(schema.approvalRequests)
  await db.delete(schema.agentConnectors)
  await db.update(schema.agents).set({ permissions: JSON.stringify([]) }).where(eq(schema.agents.id, ARTURITA))
})

test('[Opt-C] lean answer injects vault shared memory into the system prompt', async () => {
  const res = await as({ message: 'what llm you run on?', deferAnswer: false })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.mode, 'answer')
  assert.equal(body.routing?.trigger, 'default_answer')

  const sys = lastSystemPrompt()
  assert.match(sys, /SHARED MEMORY \(org long-term\)/)
  assert.match(sys, /agent-native software/)
  assert.match(sys, /AGENT LONG-TERM MEMORY/)
  assert.match(sys, /Skills: GitHub read/)
  assert.ok(fetchCalls.some(u => u.includes('Memory/long-term.md')), 'org vault file was not fetched')
})

test('[Opt-C] deferAnswer stays lean — returns built prompt with vault block, no executor task', async () => {
  const res = await as({ message: 'summarise our principles', deferAnswer: true })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.deferred, true)
  assert.equal(body.mode, 'answer')
  assert.ok(body.prompt?.system)
  assert.match(body.prompt.system, /SHARED MEMORY/)
  const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.orgId, ORG))
  assert.equal(tasks.length, 0, 'deferAnswer must not create an executor task')
})

test('[Opt-C] default Arturita with connectors routes through executeAgentTask', async () => {
  await db.update(schema.agents)
    .set({ permissions: JSON.stringify(['connector:github']) })
    .where(eq(schema.agents.id, ARTURITA))
  await db.insert(schema.agentConnectors).values([{
    id: 'optc-ac-1', orgId: ORG, agentId: ARTURITA, connectorId: 'github',
    trustLevel: 'read_only', status: 'configured',
    config: { repo: 'acme/widgets' }, createdAt: CREATED_AT, updatedAt: CREATED_AT,
  }] as any)

  const res = await as({ message: 'list open issues on the repo', deferAnswer: false })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.mode, 'answer', 'Arturita executor path still reports answer mode')
  assert.equal(body.agent.id, ARTURITA)

  const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.agentId, ARTURITA))
  assert.equal(tasks.length, 1, 'connector-capable default Arturita must run executeAgentTask')
  assert.equal(tasks[0].workMode, 'execute')

  const sys = lastSystemPrompt()
  assert.match(sys, /CONNECTOR TOOLS|GitHub/i, 'executor prompt must expose connector tools')
})

test('[Opt-C] write connector from default Arturita parks at CONN-7 with step-up', async () => {
  await db.update(schema.agents)
    .set({ permissions: JSON.stringify(['connector:github']) })
    .where(eq(schema.agents.id, ARTURITA))
  await db.insert(schema.agentConnectors).values([{
    id: 'optc-ac-2', orgId: ORG, agentId: ARTURITA, connectorId: 'github',
    trustLevel: 'approval_required', status: 'configured',
    config: { repo: 'acme/widgets' }, createdAt: CREATED_AT, updatedAt: CREATED_AT,
  }] as any)

  ;(globalThis as any).__reply = '[CONNECTOR: github.issue.create | {"title":"from Arturita CC","body":"hi"}]'

  const res = await as({ message: 'create a github issue about the flaky test', deferAnswer: false })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.mode, 'answer')
  assert.ok((body.pendingApprovals ?? 0) >= 1, 'chat must report a parked approval')
  assert.match(String(body.pendingApprovalNote), /approval/i)

  const approvals = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.orgId, ORG))
  const conn = approvals.filter((a: any) => a.type === 'connector_action')
  assert.ok(conn.length >= 1)
  assert.equal(conn[0].requestedByAgentId, ARTURITA)
  assert.equal((conn[0].payload as any)?.requiresStepUp, true)
})
