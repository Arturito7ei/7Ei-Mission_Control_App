// MOB-7b — the photo-attach ROUTE contract, driven through the real gates.
//
// Boots /converse exactly the way src/index.ts does (Clerk onRequest →
// requireOrgMembership preHandler → the plugin) against a real in-memory DB, and
// points the LLM chain at a LOCAL HTTP SERVER standing in for an
// OpenAI-compatible vision provider. That server captures the request body, so
// the happy-path test asserts the thing that actually matters and cannot be
// faked: the bytes the provider receives contain a real image block.
//
// Mocking `streamLLM` instead would prove only that the route calls a function.
// Capturing the wire proves the whole path — route → chain prune → fallback
// runtime → router → provider mapping — and would catch a regression in any of
// them. What's proven here:
//
//   1. auth       — no session → 401.
//   2. tenancy    — a logged-in NON-MEMBER of the org → 403.
//   3. fail-closed— unsupported / oversized / empty → clean JSON, never a 500.
//   4. happy path — the image reaches the provider as an image block, and the
//                   blind hops ahead of it in the chain are skipped.
//   5. no vision  — a blind-only chain TELLS the operator instead of dropping it.
//   6. no leak    — the image is not persisted, and its bytes never hit the log.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'converse-image-test-key'

let db: any, schema: any
let app: FastifyInstance
let provider: Server
let captured: any[] = []
let logLines: string[] = []

const ORG = 'org-img'
const OWNER = 'user-owner'
const OUTSIDER = 'user-outsider'
const CONVERSE = `/api/orgs/${ORG}/arturita/converse`

// A 1×1 transparent PNG — a real, decodable image, small enough to inline.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const photo = (over: Record<string, unknown> = {}) => ({
  name: 'photo.png', mediaType: 'image/png', data: PNG_1PX, ...over,
})

/** Point the org's LLM chain at the local fake provider. `models` becomes the
 *  chain in order, so a test can put blind hops in front of a sighted one. */
async function setChain(models: Array<{ provider: string; model: string }>, base: string) {
  await db.update(schema.organisations).set({
    deployConfig: {
      arturita_llm_chain: models.map(m => ({ ...m, mode: 'provider' })),
      openai_api_key: 'test-key',
      openai_base_url: base,
      // The fake server answers every provider slug we point at it.
      deepseek_api_key: 'test-key',
      deepseek_base_url: base,
    },
  }).where((await import('drizzle-orm')).eq(schema.organisations.id, ORG))
}

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  const { setupDatabase } = await import('../db/setup')
  await setupDatabase()
  const { createClerkAuth } = await import('../middleware/clerk-auth')
  const { requireOrgMembership } = await import('../middleware/rbac')
  const { registerJsonBodyParser } = await import('../middleware/body-parser')
  const { arturitaConverseRoutes } = await import('../routes/arturita-converse')

  // ── the stand-in vision provider ──────────────────────────────────────────
  provider = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try { captured.push(JSON.parse(body)) } catch { captured.push({ unparseable: body.length }) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A single transparent pixel.' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 6 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r))

  await db.insert(schema.organisations).values({ id: ORG, name: '7Ei', ownerId: OWNER, createdAt: new Date() })
  await db.insert(schema.orgMembers).values([{ id: 'm-owner', orgId: ORG, userId: OWNER, role: 'owner', createdAt: new Date() }])

  app = Fastify({
    // Capture every log line so the "no image bytes in the log" test is real
    // rather than an inspection of the source.
    logger: { level: 'trace', stream: { write: (s: string) => { logLines.push(s) } } },
  })
  registerJsonBodyParser(app)
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async (token: string) => ({ sub: token })))
    secured.addHook('preHandler', requireOrgMembership)
    await secured.register(arturitaConverseRoutes)
  })
  await app.ready()
})

after(async () => { await app?.close(); provider?.close() })

const providerBase = () => `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`

const send = (payload: object, user: string | null = OWNER) =>
  app.inject({
    method: 'POST', url: CONVERSE, payload,
    headers: { ...(user ? { authorization: `Bearer ${user}` } : {}) },
  })

// ── 1. auth ───────────────────────────────────────────────────────────────────

test('[MOB-7b] a photo turn requires a session', async () => {
  const res = await send({ message: 'what is this?', image: photo() }, null)
  assert.equal(res.statusCode, 401)
})

// ── 2. tenancy ────────────────────────────────────────────────────────────────

test('[MOB-7b] a photo turn is org-scoped — a non-member is refused', async () => {
  const res = await send({ message: 'what is this?', image: photo() }, OUTSIDER)
  assert.equal(res.statusCode, 403)
})

// ── 3. fail closed, cleanly ───────────────────────────────────────────────────

test('[MOB-7b] an unsupported image type is refused with a readable error, not a 500', async () => {
  const res = await send({ message: 'look', image: photo({ mediaType: 'image/heic' }) })
  assert.equal(res.statusCode, 415)
  const body = res.json()
  assert.equal(body.code, 'unsupported_type')
  assert.match(body.error, /JPEG/i)          // names the fix for the iPhone default
  assert.ok(!('stack' in body), 'must not leak a stack')
})

test('[MOB-7b] an oversized image is refused with the limit named', async () => {
  const { MAX_IMAGE_BYTES } = await import('../services/converse-images.ts')
  // Base64 of just over the cap. 'A' repeated decodes at 3/4 the length.
  const oversized = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1024) * 4 / 3))
  const res = await send({ message: 'look', image: photo({ data: oversized }) })
  assert.equal(res.statusCode, 413)
  const body = res.json()
  assert.equal(body.code, 'too_large')
  assert.match(body.error, /3\.8 MB/)
})

test('[MOB-7b] an empty turn — no message, no attachment, no photo — is a clean 400', async () => {
  const res = await send({ message: '   ' })
  assert.equal(res.statusCode, 400)
  assert.ok(res.json().error)
})

// ── 4. the happy path: the image reaches the provider ─────────────────────────

test('[MOB-7b] the photo reaches the provider as a real image block, blind hops skipped', async () => {
  captured = []
  // A blind hop FIRST, then the sighted one. If the prune regresses, the request
  // lands on gpt-3.5 and this test sees the wrong model — which is the bug this
  // whole story exists to prevent.
  await setChain([{ provider: 'openai', model: 'gpt-3.5-turbo' }, { provider: 'openai', model: 'gpt-4o' }], providerBase())

  const res = await send({ message: 'what is in this photo?', image: photo() })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.mode, 'answer')
  assert.ok(!body.degraded, 'a sighted chain must not degrade')
  assert.equal(body.reply.text, 'A single transparent pixel.')
  assert.equal(body.reply.model, 'gpt-4o', 'the blind hop must be pruned, not attempted')

  // What the provider actually received.
  assert.equal(captured.length, 1, 'exactly one provider call')
  const sent = captured[0]
  assert.equal(sent.model, 'gpt-4o')
  const userTurn = sent.messages.at(-1)
  assert.equal(userTurn.role, 'user')
  assert.ok(Array.isArray(userTurn.content), 'an image turn must be content PARTS, not a string')
  const image = userTurn.content.find((p: any) => p.type === 'image_url')
  assert.ok(image, 'no image block reached the provider — Arturita would be answering blind')
  assert.equal(image.image_url.url, `data:image/png;base64,${PNG_1PX}`)
  // …and the question still precedes it.
  const text = userTurn.content.find((p: any) => p.type === 'text')
  assert.match(text.text, /what is in this photo\?/)
  assert.ok(userTurn.content.indexOf(text) < userTurn.content.indexOf(image))
})

test('[MOB-7b] a photo alone, with no typed message, is a valid turn', async () => {
  captured = []
  await setChain([{ provider: 'openai', model: 'gpt-4o' }], providerBase())
  const res = await send({ message: '', image: photo() })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().mode, 'answer')
  const text = captured[0].messages.at(-1).content.find((p: any) => p.type === 'text')
  assert.match(text.text, /look at the attached photo/i)
})

test('[MOB-7b] a text-only turn still sends a plain string — the additive guarantee', async () => {
  captured = []
  await setChain([{ provider: 'openai', model: 'gpt-4o' }], providerBase())
  const res = await send({ message: 'hello there' })
  assert.equal(res.statusCode, 200)
  // The whole compatibility claim in one assertion: no image → the request is
  // shaped exactly as it was before this story.
  assert.equal(captured[0].messages.at(-1).content, 'hello there')
})

test('[MOB-7b] a photo turn is answered server-side even when the client asks to defer', async () => {
  // deferAnswer hands the prompt back for the browser to stream from local
  // Ollama — which is text-only by default and would drop the image silently.
  captured = []
  await setChain([{ provider: 'openai', model: 'gpt-4o' }], providerBase())
  const res = await send({ message: 'what is this?', image: photo(), deferAnswer: true })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(!body.deferred, 'an image turn must not be deferred to a blind local engine')
  assert.equal(body.reply.text, 'A single transparent pixel.')
  // A text turn may still defer — the optimisation is intact where it is safe.
  const textTurn = await send({ message: 'hello', deferAnswer: true })
  assert.equal(textTurn.json().deferred, true)
})

// ── 5. no vision configured → tell the operator ───────────────────────────────

test('[MOB-7b] a blind-only chain TELLS the operator instead of dropping the photo', async () => {
  captured = []
  // Blind chain AND a blind guaranteed hop (the agent's own model), so nothing
  // sighted remains.
  const { eq } = await import('drizzle-orm')
  await db.update(schema.agents).set({ llmProvider: 'ollama', llmModel: 'mistral' })
    .where(eq(schema.agents.orgId, ORG))
  await setChain([{ provider: 'deepseek', model: 'deepseek-chat' }], providerBase())

  const res = await send({ message: 'what is this?', image: photo() })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.degraded, true)
  assert.equal(body.code, 'no_vision_model')
  assert.match(body.reply.text, /none of the language models/i)
  assert.match(body.reply.text, /Claude|GPT-4o|Gemini/)
  // The load-bearing assertion: we did NOT quietly answer from the text alone.
  assert.equal(captured.length, 0, 'the image must never be sent to a blind model')

  // restore for any later test
  await db.update(schema.agents).set({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514' })
    .where(eq(schema.agents.orgId, ORG))
})

// ── 6. the image is never kept ────────────────────────────────────────────────

test('[MOB-7b] the image is not persisted anywhere', async () => {
  captured = []
  await setChain([{ provider: 'openai', model: 'gpt-4o' }], providerBase())
  await send({ message: 'remember this', image: photo() })

  // Nothing in the knowledge store, and no task carries it.
  const items = await db.select().from(schema.knowledgeItems)
  assert.equal(items.filter((i: any) => JSON.stringify(i).includes(PNG_1PX)).length, 0)
  const tasks = await db.select().from(schema.tasks)
  assert.equal(tasks.filter((t: any) => JSON.stringify(t).includes(PNG_1PX)).length, 0)
})

test('[MOB-7b] image bytes never reach the log', async () => {
  // The photo is the most sensitive thing in the request. A well-meaning
  // `req.log.info({ body })` would dump it into Fly's log retention forever —
  // so assert against the REAL captured log stream, not against the source.
  logLines = []
  await setChain([{ provider: 'openai', model: 'gpt-4o' }], providerBase())
  await send({ message: 'what is this?', image: photo() })
  const all = logLines.join('\n')
  assert.ok(!all.includes(PNG_1PX), 'the image base64 was written to the log')
  // A distinctive slice, in case something logged a truncated copy.
  assert.ok(!all.includes(PNG_1PX.slice(0, 40)), 'a fragment of the image reached the log')
})

test('[MOB-7b] a delegated photo turn says the photo stays behind', async () => {
  // The office runs a task later, when the image is long gone. Saying nothing
  // would let the operator believe the agents can see it.
  const res = await send({ message: 'build me a landing page like this', image: photo(), explicitDelegate: true })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.mode, 'delegate')
  assert.match(body.reply.text, /photo “photo\.png” stays with this conversation/)
})
