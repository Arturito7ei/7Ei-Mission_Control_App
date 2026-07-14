// The transport layer that broke the avatar Remove. Fastify's stock JSON parser
// 400s a request that declares `Content-Type: application/json` and carries no
// body — which is every bodiless write the dashboard sends. See
// middleware/body-parser.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { parseJsonBody, registerJsonBodyParser } from '../middleware/body-parser.ts'

test('[AGFIX4] an empty JSON body parses to {} rather than failing', () => {
  assert.deepEqual(parseJsonBody(''), { ok: true, value: {} })
  assert.deepEqual(parseJsonBody('   \n '), { ok: true, value: {} })
})

test('[AGFIX4] a real JSON body still parses', () => {
  assert.deepEqual(parseJsonBody('{"a":1}'), { ok: true, value: { a: 1 } })
})

test('[AGFIX4] broken JSON is rejected with a message that names the problem', () => {
  const r = parseJsonBody('{"a":')
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /invalid json/i)
})

test('[AGFIX4] a bodiless DELETE with CT:json reaches its handler', async () => {
  const app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  app.delete('/thing', async (_req, reply) => reply.code(204).send())
  await app.ready()

  const res = await app.inject({ method: 'DELETE', url: '/thing', headers: { 'content-type': 'application/json' } })
  assert.equal(res.statusCode, 204, 'this is a 400 (FST_ERR_CTP_EMPTY_JSON_BODY) without the parser')
  await app.close()
})

test('[AGFIX4] without the parser the same request 400s — the bug this guards', async () => {
  const app = Fastify({ logger: false })
  app.delete('/thing', async (_req, reply) => reply.code(204).send())
  await app.ready()

  const res = await app.inject({ method: 'DELETE', url: '/thing', headers: { 'content-type': 'application/json' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'FST_ERR_CTP_EMPTY_JSON_BODY')
  await app.close()
})
