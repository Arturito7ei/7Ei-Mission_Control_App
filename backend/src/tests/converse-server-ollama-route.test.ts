// S3-B — server-side Ollama fallback on /converse + degraded turn persistence (GC-2).
//
// Proves the talk path that Command Center uses when browser-local Ollama is absent
// (deferAnswer:false): the backend reaches co-located Ollama via OLLAMA_BASE_URL
// before falling through to a keyless guaranteed hop, and a degraded NO_LLM reply
// survives a thread reload with meta.degraded intact.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 's3b-server-ollama-test-key'

let db: any, schema: any, eq: any
let app: FastifyInstance
let ollama: Server
let captured: any[] = []

const ORG = 's3b-org'
const OWNER = 's3b-owner'
const CONVERSE = `/api/orgs/${ORG}/arturita/converse`
const THREAD = `/api/orgs/${ORG}/arturita/thread`

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ eq } = await import('drizzle-orm'))

  ollama = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body: any = {}
      try { body = JSON.parse(raw) } catch { body = {} }
      captured.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fly-ollama-ok' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(r => ollama.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}/v1`
  process.env.OLLAMA_BASE_URL = base

  await db.insert(schema.organisations).values({
    id: ORG, name: 'S3B Org', ownerId: OWNER, createdAt: new Date(),
    deployConfig: {},
  })
  await db.insert(schema.orgMembers).values({
    id: 'm1', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date(),
  })

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

beforeEach(() => { captured = [] })

after(async () => {
  delete process.env.OLLAMA_BASE_URL
  if (app) await app.close()
  if (ollama) await new Promise<void>(r => ollama.close(() => r()))
})

test('[S3-B] converse with deferAnswer:false reaches server Ollama before cloud guarantee', async () => {
  const res = await app.inject({
    method: 'POST', url: CONVERSE,
    headers: { authorization: `Bearer ${OWNER}` },
    payload: { message: 'hello from hosted CC', deferAnswer: false },
  })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.mode, 'answer')
  assert.equal(body.reply?.text, 'fly-ollama-ok')
  assert.equal(body.reply?.provider, 'ollama')
  assert.equal(body.degraded, undefined)
  assert.ok(captured.length >= 1, 'server Ollama should have been called')
  assert.equal(captured[0].model, 'llama3.2:3b')
})

test('[S3-B] llm-status reports answerUsable via hosted Ollama when cloud keys are absent', async () => {
  const res = await app.inject({
    method: 'GET', url: `/api/orgs/${ORG}/arturita/llm-status`,
    headers: { authorization: `Bearer ${OWNER}` },
  })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.answerUsable, true)
  assert.equal(body.answerProvider, 'ollama')
  assert.equal(body.cloudUsable, false)
})

test('[S3-B] degraded NO_LLM turn persists meta.degraded through GET /thread', async () => {
  process.env.MC_SERVER_OLLAMA = '0'
  try {
    const res = await app.inject({
      method: 'POST', url: CONVERSE,
      headers: { authorization: `Bearer ${OWNER}` },
      payload: { message: 'need an llm', deferAnswer: false },
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.equal(body.degraded, true)
    assert.equal(body.reply?.provider, 'text_only')
    assert.match(String(body.reply?.text ?? ''), /can't reach any language model/i)

    const thread = await app.inject({
      method: 'GET', url: THREAD,
      headers: { authorization: `Bearer ${OWNER}` },
    })
    assert.equal(thread.statusCode, 200)
    const turns = thread.json().turns ?? []
    assert.ok(turns.length >= 2)
    const assistant = turns[turns.length - 1]
    assert.match(String(assistant.content), /can't reach any language model/i)
    assert.equal(assistant.meta?.degraded, true)
    assert.equal(assistant.meta?.via, 'text_only')
  } finally {
    delete process.env.MC_SERVER_OLLAMA
  }
})
