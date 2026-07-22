import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { deriveWebhookSecret, verifyWebhookSecret, checkWebhook, webhookFailClosed } from '../services/webhook-auth'
import { commsWebhookRoutes } from '../routes/comms'
import { jiraWebhookRoutes } from '../routes/jira-webhook'

// ─── Per-org inbound webhook signature verification (MCA-85 hardening) ────────
//
// The per-org receivers POST /api/telegram/webhook/:orgId and
// POST /api/jira/webhook/:orgId are public (the external service has no Clerk
// session). Before this change anyone could POST forged events for any org.
// A deterministic per-org shared secret closes the hole.

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('[MCA-85] deriveWebhookSecret is deterministic', () => {
  const a = deriveWebhookSecret('server-secret', 'telegram', 'org-1')
  const b = deriveWebhookSecret('server-secret', 'telegram', 'org-1')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/, 'expected a 64-char hex HMAC-SHA256 digest')
})

test('[MCA-85] deriveWebhookSecret is distinct per org, channel, and server secret', () => {
  const base = deriveWebhookSecret('s', 'telegram', 'org-1')
  assert.notEqual(base, deriveWebhookSecret('s', 'telegram', 'org-2'), 'different org must differ')
  assert.notEqual(base, deriveWebhookSecret('s', 'jira', 'org-1'), 'different channel must differ')
  assert.notEqual(base, deriveWebhookSecret('other', 'telegram', 'org-1'), 'different server secret must differ')
})

test('[MCA-85] verifyWebhookSecret matches only the exact token', () => {
  const expected = deriveWebhookSecret('s', 'jira', 'org-1')
  assert.equal(verifyWebhookSecret(expected, expected), true)
  assert.equal(verifyWebhookSecret('nope', expected), false)
  assert.equal(verifyWebhookSecret(undefined, expected), false)
  assert.equal(verifyWebhookSecret(null, expected), false)
  assert.equal(verifyWebhookSecret('', expected), false)
  assert.equal(verifyWebhookSecret(expected + 'x', expected), false, 'length mismatch must not throw')
})

test('[MCA-85] checkWebhook: no server secret → verification disabled (dev)', () => {
  const r = checkWebhook(undefined, 'telegram', 'org-1', undefined)
  assert.deepEqual(r, { authorized: true, enforced: false })
})

test('[MCC-2] checkWebhook fails CLOSED in production when no secret is configured', () => {
  // These receivers write user-role rows into agent threads MCC-1 renders and
  // replays — an open posture in prod was unauthenticated message injection.
  assert.deepEqual(
    checkWebhook(undefined, 'telegram', 'org-1', undefined, true),
    { authorized: false, enforced: true },
  )
  // …and a caller-provided "secret" cannot talk its way past a missing config.
  assert.deepEqual(
    checkWebhook(undefined, 'telegram', 'org-1', 'anything', true),
    { authorized: false, enforced: true },
  )
  // A configured secret behaves exactly as before, failClosed or not.
  const secret = 'srv'
  const good = deriveWebhookSecret(secret, 'telegram', 'org-1')
  assert.deepEqual(checkWebhook(secret, 'telegram', 'org-1', good, true), { authorized: true, enforced: true })
})

test('[MCC-2] webhookFailClosed is true only for production', () => {
  assert.equal(webhookFailClosed('production'), true)
  assert.equal(webhookFailClosed('development'), false)
  assert.equal(webhookFailClosed('test'), false)
  assert.equal(webhookFailClosed(undefined), false)
  assert.equal(webhookFailClosed(null), false)
})

test('[MCA-85] checkWebhook: configured secret enforces the correct token', () => {
  const secret = 'server-secret'
  const good = deriveWebhookSecret(secret, 'telegram', 'org-1')
  assert.deepEqual(checkWebhook(secret, 'telegram', 'org-1', good), { authorized: true, enforced: true })
  assert.deepEqual(checkWebhook(secret, 'telegram', 'org-1', undefined), { authorized: false, enforced: true })
  assert.deepEqual(checkWebhook(secret, 'telegram', 'org-1', 'forged'), { authorized: false, enforced: true })
})

test('[MCA-85] checkWebhook rejects a token minted for a different org or channel (no replay)', () => {
  const secret = 'server-secret'
  const otherOrg = deriveWebhookSecret(secret, 'jira', 'org-2')
  const otherChannel = deriveWebhookSecret(secret, 'telegram', 'org-1')
  assert.equal(checkWebhook(secret, 'jira', 'org-1', otherOrg).authorized, false, 'cross-org replay rejected')
  assert.equal(checkWebhook(secret, 'jira', 'org-1', otherChannel).authorized, false, 'cross-channel replay rejected')
})

// ── Receiver integration: enforcement when a signing secret is configured ─────

async function withSigningSecret(value: string, fn: () => Promise<void>) {
  const prevWebhook = process.env.WEBHOOK_SIGNING_SECRET
  const prevTelegram = process.env.TELEGRAM_WEBHOOK_SECRET
  const prevJira = process.env.JIRA_WEBHOOK_SECRET
  process.env.WEBHOOK_SIGNING_SECRET = value
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  delete process.env.JIRA_WEBHOOK_SECRET
  try {
    await fn()
  } finally {
    if (prevWebhook === undefined) delete process.env.WEBHOOK_SIGNING_SECRET; else process.env.WEBHOOK_SIGNING_SECRET = prevWebhook
    if (prevTelegram !== undefined) process.env.TELEGRAM_WEBHOOK_SECRET = prevTelegram
    if (prevJira !== undefined) process.env.JIRA_WEBHOOK_SECRET = prevJira
  }
}

test('[MCA-85] telegram receiver: rejects a forged/absent secret, accepts the derived one', async () => {
  await withSigningSecret('test-signing-secret', async () => {
    const app = Fastify({ logger: false })
    await app.register(commsWebhookRoutes)
    await app.ready()

    const noSecret = await app.inject({
      method: 'POST', url: '/api/telegram/webhook/o1',
      payload: {}, headers: { 'content-type': 'application/json' },
    })
    assert.equal(noSecret.statusCode, 403, 'missing secret must be rejected')

    const forged = await app.inject({
      method: 'POST', url: '/api/telegram/webhook/o1',
      payload: {}, headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
    })
    assert.equal(forged.statusCode, 403, 'forged secret must be rejected')

    const good = deriveWebhookSecret('test-signing-secret', 'telegram', 'o1')
    const ok = await app.inject({
      method: 'POST', url: '/api/telegram/webhook/o1',
      payload: {}, headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': good },
    })
    assert.equal(ok.statusCode, 200, 'the derived per-org secret must be accepted')
    assert.deepEqual(ok.json(), { ok: true })

    // A secret minted for another org must not unlock o1.
    const crossOrg = deriveWebhookSecret('test-signing-secret', 'telegram', 'o2')
    const replay = await app.inject({
      method: 'POST', url: '/api/telegram/webhook/o1',
      payload: {}, headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': crossOrg },
    })
    assert.equal(replay.statusCode, 403, 'a token for o2 must not authorize o1')

    await app.close()
  })
})

test('[MCA-85] jira receiver: rejects a forged/absent secret, accepts the derived query token', async () => {
  await withSigningSecret('test-signing-secret', async () => {
    const app = Fastify({ logger: false })
    await app.register(jiraWebhookRoutes)
    await app.ready()

    const noSecret = await app.inject({
      method: 'POST', url: '/api/jira/webhook/o1',
      payload: {}, headers: { 'content-type': 'application/json' },
    })
    assert.equal(noSecret.statusCode, 403, 'missing secret must be rejected')

    const forged = await app.inject({
      method: 'POST', url: '/api/jira/webhook/o1?secret=wrong',
      payload: {}, headers: { 'content-type': 'application/json' },
    })
    assert.equal(forged.statusCode, 403, 'forged secret must be rejected')

    const good = deriveWebhookSecret('test-signing-secret', 'jira', 'o1')
    const ok = await app.inject({
      method: 'POST', url: `/api/jira/webhook/o1?secret=${good}`,
      payload: {}, headers: { 'content-type': 'application/json' },
    })
    assert.equal(ok.statusCode, 200, 'the derived per-org query token must be accepted')
    assert.deepEqual(ok.json(), { ok: true })

    // Header form is also accepted (for non-Jira posters).
    const viaHeader = await app.inject({
      method: 'POST', url: '/api/jira/webhook/o1',
      payload: {}, headers: { 'content-type': 'application/json', 'x-webhook-secret': good },
    })
    assert.equal(viaHeader.statusCode, 200, 'x-webhook-secret header must also be accepted')

    await app.close()
  })
})

test('[MCA-85] receivers stay open when no signing secret is configured (dev parity)', async () => {
  const prevWebhook = process.env.WEBHOOK_SIGNING_SECRET
  const prevTelegram = process.env.TELEGRAM_WEBHOOK_SECRET
  const prevJira = process.env.JIRA_WEBHOOK_SECRET
  delete process.env.WEBHOOK_SIGNING_SECRET
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  delete process.env.JIRA_WEBHOOK_SECRET
  try {
    const app = Fastify({ logger: false })
    await app.register(commsWebhookRoutes)
    await app.register(jiraWebhookRoutes)
    await app.ready()

    const tg = await app.inject({ method: 'POST', url: '/api/telegram/webhook/o1', payload: {}, headers: { 'content-type': 'application/json' } })
    assert.equal(tg.statusCode, 200, 'telegram receiver stays public with no secret set')

    const jira = await app.inject({ method: 'POST', url: '/api/jira/webhook/o1', payload: {}, headers: { 'content-type': 'application/json' } })
    assert.equal(jira.statusCode, 200, 'jira receiver stays public with no secret set')

    await app.close()
  } finally {
    if (prevWebhook !== undefined) process.env.WEBHOOK_SIGNING_SECRET = prevWebhook
    if (prevTelegram !== undefined) process.env.TELEGRAM_WEBHOOK_SECRET = prevTelegram
    if (prevJira !== undefined) process.env.JIRA_WEBHOOK_SECRET = prevJira
  }
})
