// D1 — bound Telegram chat text routes through Arturita /converse, not Arturito task executor.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'telegram-d1-test-key'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret'

let db: any, schema: any, eq: any
let app: FastifyInstance
let ollama: Server
let sentMessages: Array<{ chat_id: number; text: string }> = []

const ORG = 'tg-d1-org'
const CHAT = 424242
const WEBHOOK = '/api/telegram/webhook'

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  await (await import('../db/setup')).setupDatabase()
  ;({ eq } = await import('drizzle-orm'))

  ollama = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Arturita says hi from Telegram' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(r => ollama.listen(0, '127.0.0.1', () => r()))
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}/v1`

  await db.insert(schema.organisations).values({
    id: ORG, name: 'TG D1 Org', ownerId: 'owner-1', createdAt: new Date(), deployConfig: {},
  })
  await db.insert(schema.orgMembers).values({
    id: 'm-tg', orgId: ORG, userId: 'owner-1', role: 'owner',
    telegramChatId: String(CHAT), createdAt: new Date(),
  })

  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    if (url.includes('api.telegram.org')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (url.includes('sendMessage')) sentMessages.push({ chat_id: body.chat_id, text: body.text })
      if (url.includes('sendChatAction')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
    }
    return origFetch(input, init)
  }) as typeof fetch

  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { telegramWebhookRoutes } = await import('../routes/telegram-webhook')

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  await app.register(telegramWebhookRoutes)
  await app.ready()
})

after(async () => {
  delete process.env.OLLAMA_BASE_URL
  if (app) await app.close()
  if (ollama) await new Promise<void>(r => ollama.close(() => r()))
})

test('[D1] plain text from bound chat returns Arturita converse reply (not task executor)', async () => {
  sentMessages = []
  const res = await app.inject({
    method: 'POST',
    url: WEBHOOK,
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'test-webhook-secret',
    },
    payload: {
      message: { chat: { id: CHAT }, text: 'Hello Arturita' },
    },
  })
  assert.equal(res.statusCode, 200)
  assert.ok(sentMessages.length >= 1, 'bot should send at least one message')
  const reply = sentMessages.find(m => m.chat_id === CHAT && m.text.includes('Arturita says hi'))
  assert.ok(reply, `expected Arturita converse reply, got: ${JSON.stringify(sentMessages)}`)

  const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.orgId, ORG))
  assert.equal(tasks.length, 0, 'plain text should not create an Arturito-style task row')
})

test('[D1] setup-webhook refuses registration when no signing secret is configured', async () => {
  const prevTelegram = process.env.TELEGRAM_WEBHOOK_SECRET
  const prevWebhook = process.env.WEBHOOK_SIGNING_SECRET
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  delete process.env.WEBHOOK_SIGNING_SECRET
  try {
    const res = await app.inject({ method: 'POST', url: '/api/telegram/setup-webhook' })
    assert.equal(res.statusCode, 400)
    assert.match(res.body, /TELEGRAM_WEBHOOK_SECRET/)
  } finally {
    if (prevTelegram !== undefined) process.env.TELEGRAM_WEBHOOK_SECRET = prevTelegram
    if (prevWebhook !== undefined) process.env.WEBHOOK_SIGNING_SECRET = prevWebhook
  }
})
