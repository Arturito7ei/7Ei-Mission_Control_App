import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'

// ─── MOB-5a — hosted speech-to-text ──────────────────────────────────────────
//
// Two layers, mirroring how the voice suites are split:
//  1. the PURE provider layer (`services/stt-provider.ts`) — the deployment
//     matrix (which provider runs where) is decided there, so it is tested there
//     with a fake fetch and no environment at all;
//  2. the ROUTE — booted the way src/index.ts boots it (secured scope + a
//     membership gate) so the auth/multi-tenant/guard-rail behaviour is proven
//     against real Fastify multipart, not a hand-rolled stub.

import {
  selectSttProvider,
  parseSttSetting,
  isAcceptedAudioMime,
  extForAudioMime,
  cleanTranscript,
  transcribeOpenAICompatible,
  transcribeAudio,
  STT_MAX_BYTES,
  STT_TIMEOUT_MS,
  positiveFiniteEnv,
  LOCAL_STT_URL,
  OPENAI_STT_URL,
} from '../services/stt-provider'
import { arturitaSttRoutes, STT_AUDIO_FIELD } from '../routes/arturita-stt'

// ─── 1. Provider selection — the deployment matrix ───────────────────────────

test('[MOB-5a] auto prefers cloud when a key is present (the only leg that works on Fly)', () => {
  const pick = selectSttProvider({ setting: 'auto', caps: { cloudKeyPresent: true, localConfigured: true } })
  assert.strictEqual(pick.provider, 'cloud_openai')
})

test('[MOB-5a] auto falls to the local daemon when no cloud key is configured', () => {
  const pick = selectSttProvider({ setting: 'auto', caps: { cloudKeyPresent: false, localConfigured: true } })
  assert.strictEqual(pick.provider, 'local_whisper')
})

test('[MOB-5a] auto with neither leg configured selects nothing (→ a clean 503, not a crash)', () => {
  const pick = selectSttProvider({ setting: 'auto', caps: { cloudKeyPresent: false, localConfigured: false } })
  assert.strictEqual(pick.provider, null)
  assert.match(pick.reason, /no STT provider/i)
})

test('[MOB-5a] off hard-disables STT even when both legs are available', () => {
  const pick = selectSttProvider({ setting: 'off', caps: { cloudKeyPresent: true, localConfigured: true } })
  assert.strictEqual(pick.provider, null)
})

test('[MOB-5a] a pinned provider NEVER silently falls back to the other', () => {
  // Pinning local then quietly shipping the audio to a cloud would be a privacy
  // downgrade the operator explicitly configured away from. Fail instead.
  const local = selectSttProvider({ setting: 'local', caps: { cloudKeyPresent: true, localConfigured: false } })
  assert.strictEqual(local.provider, null)
  const cloud = selectSttProvider({ setting: 'cloud', caps: { cloudKeyPresent: false, localConfigured: true } })
  assert.strictEqual(cloud.provider, null)
})

test('[MOB-5a] the provider setting parses, defaulting to auto', () => {
  assert.strictEqual(parseSttSetting('cloud'), 'cloud')
  assert.strictEqual(parseSttSetting(' LOCAL '), 'local')
  assert.strictEqual(parseSttSetting('off'), 'off')
  assert.strictEqual(parseSttSetting(undefined), 'auto')
  assert.strictEqual(parseSttSetting('nonsense'), 'auto')
})

// ─── 2. Content-type + helper purity ────────────────────────────────────────

test('[MOB-5a] accepts what expo-av produces on iOS/Android and the browser', () => {
  for (const m of ['audio/m4a', 'audio/x-m4a', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/3gpp']) {
    assert.ok(isAcceptedAudioMime(m), `${m} should be accepted`)
  }
  assert.ok(isAcceptedAudioMime('audio/webm;codecs=opus'), 'parameters must be tolerated')
  assert.ok(isAcceptedAudioMime('AUDIO/WAV'), 'case must be tolerated')
})

test('[MOB-5a] rejects non-audio content — including octet-stream', () => {
  for (const m of ['application/pdf', 'text/plain', 'image/png', 'video/mp4', 'application/octet-stream', '', null, undefined]) {
    assert.ok(!isAcceptedAudioMime(m as any), `${m} must be rejected`)
  }
})

test('[MOB-5a] extForAudioMime maps containers to a friendly filename', () => {
  assert.strictEqual(extForAudioMime('audio/m4a'), 'm4a')
  assert.strictEqual(extForAudioMime('audio/webm;codecs=opus'), 'webm')
  assert.strictEqual(extForAudioMime('audio/wav'), 'wav')
  assert.strictEqual(extForAudioMime('audio/mpeg'), 'mp3')
  assert.strictEqual(extForAudioMime('audio/weird'), 'm4a')  // safe default
})

test('[MOB-5a] cleanTranscript collapses whitespace', () => {
  assert.strictEqual(cleanTranscript('  hello   there\n world \n'), 'hello there world')
  assert.strictEqual(cleanTranscript(null), '')
})

// ─── 2b. Limit overrides must never fail open ───────────────────────────────
//
// The failure this guards is silent: `bytes > NaN` is false, so a typo'd byte
// cap would not raise an error — it would accept clips of any size.

test('[MOB-5a] a garbage byte cap falls back to 10MB rather than failing open', () => {
  assert.strictEqual(positiveFiniteEnv('not-a-number', 10 * 1024 * 1024), 10 * 1024 * 1024)
  assert.strictEqual(positiveFiniteEnv('', 10 * 1024 * 1024), 10 * 1024 * 1024)
  assert.strictEqual(positiveFiniteEnv(undefined, 10 * 1024 * 1024), 10 * 1024 * 1024)
})

test('[MOB-5a] a garbage timeout falls back to the default rather than throwing', () => {
  assert.strictEqual(positiveFiniteEnv('abc', 60_000), 60_000)
  assert.strictEqual(positiveFiniteEnv('Infinity', 60_000), 60_000)
})

test('[MOB-5a] non-positive overrides fall back — a negative cap would reject everything', () => {
  assert.strictEqual(positiveFiniteEnv('-1', 10 * 1024 * 1024), 10 * 1024 * 1024)
  assert.strictEqual(positiveFiniteEnv('0', 60_000), 60_000)
})

test('[MOB-5a] a valid override is still honoured', () => {
  assert.strictEqual(positiveFiniteEnv('2048', 10 * 1024 * 1024), 2048)
  assert.strictEqual(positiveFiniteEnv('1500', 60_000), 1500)
})

test('[MOB-5a] the exported limits are positive finite numbers whatever the env holds', () => {
  assert.ok(Number.isFinite(STT_MAX_BYTES) && STT_MAX_BYTES > 0)
  assert.ok(Number.isFinite(STT_TIMEOUT_MS) && STT_TIMEOUT_MS > 0)
})

// ─── 3. The network adapter ─────────────────────────────────────────────────

function fakeFetch(impl: (url: string, init: any) => any) {
  return async (url: string, init: any) => impl(url, init)
}

test('[MOB-5a] cloud calls OpenAI-compatible /audio/transcriptions with the key attached', async () => {
  let seenUrl = ''
  let seenAuth: string | undefined
  const out = await transcribeOpenAICompatible({
    audio: Buffer.from('fake-audio'),
    mime: 'audio/m4a',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    fetchImpl: fakeFetch((url, init) => {
      seenUrl = url
      seenAuth = init.headers?.Authorization
      return { ok: true, status: 200, json: async () => ({ text: ' hello  world ' }), text: async () => '' }
    }) as any,
  })
  assert.strictEqual(seenUrl, 'https://api.example.com/v1/audio/transcriptions')
  assert.strictEqual(seenAuth, 'Bearer sk-test')
  assert.strictEqual(out.text, 'hello world')
})

test('[MOB-5a] the local daemon is called WITHOUT an Authorization header', async () => {
  // The daemon is 127.0.0.1-bound and keyless; sending a cloud key to it would
  // leak the key to a process that never needed it.
  let headers: any = null
  await transcribeOpenAICompatible({
    audio: Buffer.from('x'),
    mime: 'audio/wav',
    baseUrl: 'http://127.0.0.1:8790',
    apiKey: null,
    fetchImpl: fakeFetch((_u, init) => {
      headers = init.headers
      return { ok: true, status: 200, json: async () => ({ text: 'ok' }), text: async () => '' }
    }) as any,
  })
  assert.ok(!headers?.Authorization, 'no Authorization header to the local daemon')
})

test('[MOB-5a] transcribeAudio routes a local pick to the local URL and never attaches the key', async () => {
  let seenUrl = ''
  let seenAuth: string | undefined
  const res = await transcribeAudio({
    audio: Buffer.from('x'), mime: 'audio/wav',
    setting: 'local',
    apiKey: 'sk-should-not-travel',
    localUrl: 'http://127.0.0.1:8790',
    fetchImpl: fakeFetch((url, init) => {
      seenUrl = url; seenAuth = init.headers?.Authorization
      return { ok: true, status: 200, json: async () => ({ text: 'local said this' }), text: async () => '' }
    }) as any,
  })
  assert.ok(res.ok && res.provider === 'local_whisper')
  assert.strictEqual(seenUrl, 'http://127.0.0.1:8790/audio/transcriptions')
  assert.strictEqual(seenAuth, undefined)
})

test('[MOB-5a] the default base URLs resolve to the exact paths each provider serves', async () => {
  // The local daemon matches `req.url === '/v1/audio/transcriptions'` EXACTLY
  // (adapters/arturita-stt/src/server.mjs:73) — a base URL missing `/v1` 404s
  // every local transcription. Lock both defaults against their real endpoints.
  const calls: string[] = []
  const spy = fakeFetch((url) => {
    calls.push(url)
    return { ok: true, status: 200, json: async () => ({ text: 'x' }), text: async () => '' }
  }) as any
  await transcribeAudio({ audio: Buffer.from('x'), mime: 'audio/wav', setting: 'local', localUrl: LOCAL_STT_URL, fetchImpl: spy })
  await transcribeAudio({ audio: Buffer.from('x'), mime: 'audio/wav', setting: 'cloud', apiKey: 'sk-t', cloudUrl: OPENAI_STT_URL, fetchImpl: spy })
  assert.deepEqual(calls, [
    'http://127.0.0.1:8790/v1/audio/transcriptions',
    'https://api.openai.com/v1/audio/transcriptions',
  ])
})

test('[MOB-5a] a trailing slash on a configured base URL does not double up', async () => {
  let seen = ''
  await transcribeAudio({
    audio: Buffer.from('x'), mime: 'audio/wav', setting: 'local', localUrl: 'http://127.0.0.1:8790/v1/',
    fetchImpl: fakeFetch((url) => {
      seen = url
      return { ok: true, status: 200, json: async () => ({ text: 'x' }), text: async () => '' }
    }) as any,
  })
  assert.strictEqual(seen, 'http://127.0.0.1:8790/v1/audio/transcriptions')
})

test('[MOB-5a] a provider non-2xx becomes a typed failure, never a throw', async () => {
  const res = await transcribeAudio({
    audio: Buffer.from('x'), mime: 'audio/m4a', setting: 'cloud', apiKey: 'sk-test',
    fetchImpl: fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'upstream exploded' })) as any,
  })
  assert.strictEqual(res.ok, false)
  assert.ok(!res.ok && res.code === 'provider_error')
  // The upstream body must NOT reach the caller — it can echo request content.
  assert.ok(!res.ok && !/exploded/.test(res.message))
})

test('[MOB-5a] a transport throw becomes a typed failure, never a throw', async () => {
  const res = await transcribeAudio({
    audio: Buffer.from('x'), mime: 'audio/m4a', setting: 'cloud', apiKey: 'sk-test',
    fetchImpl: fakeFetch(() => { throw new Error('ECONNREFUSED') }) as any,
  })
  assert.ok(!res.ok && res.code === 'provider_error')
})

test('[MOB-5a] a timeout is classified distinctly from a provider error', async () => {
  const res = await transcribeAudio({
    audio: Buffer.from('x'), mime: 'audio/m4a', setting: 'cloud', apiKey: 'sk-test',
    fetchImpl: fakeFetch(() => { const e: any = new Error('timed out'); e.name = 'TimeoutError'; throw e }) as any,
  })
  assert.ok(!res.ok && res.code === 'timeout')
})

test('[MOB-5a] no configured provider returns not_configured without calling out', async () => {
  let called = false
  const res = await transcribeAudio({
    audio: Buffer.from('x'), mime: 'audio/m4a', setting: 'auto', apiKey: null, localUrl: null,
    fetchImpl: fakeFetch(() => { called = true; return { ok: true, status: 200, json: async () => ({ text: '' }), text: async () => '' } }) as any,
  })
  assert.ok(!res.ok && res.code === 'not_configured')
  assert.strictEqual(called, false, 'must not attempt a provider call')
})

// ─── 4. The route — auth, multi-tenancy, guard rails ────────────────────────

/** Boot the route the way src/index.ts does: a secured scope whose onRequest hook
 *  authenticates (401 without a bearer) and whose preHandler proves membership of
 *  the org in the PATH. `members` lists the orgs the fake caller belongs to. */
async function bootRoute(opts: { members?: string[] } = {}) {
  const members = opts.members ?? ['org-1']
  const app = Fastify({ logger: false })
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } })  // the GLOBAL document limit, as in index.ts
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (req: any, reply) => {
      const auth = req.headers.authorization
      if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Unauthorized' })
      req.userId = 'user-1'
      req.auth = { userId: 'user-1' }
    })
    secured.addHook('preHandler', async (req: any, reply) => {
      const orgId = req.params?.orgId
      if (orgId && !members.includes(orgId)) return reply.code(403).send({ error: 'Not a member of this org' })
    })
    await secured.register(arturitaSttRoutes)
  })
  await app.ready()
  return app
}

/** Build a multipart body. Hand-rolled so the test controls the exact bytes,
 *  field name and content type on the wire. */
function multipartBody(opts: { field?: string; filename?: string; contentType?: string; data: Buffer }) {
  const boundary = '----mob5aTestBoundary'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${opts.field ?? STT_AUDIO_FIELD}"; ` +
    `filename="${opts.filename ?? 'clip.m4a'}"\r\nContent-Type: ${opts.contentType ?? 'audio/m4a'}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { payload: Buffer.concat([head, opts.data, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

test('[MOB-5a] 401 without a bearer token — STT is never unauthenticated', async () => {
  const app = await bootRoute()
  const body = multipartBody({ data: Buffer.from('audio') })
  const res = await app.inject({
    method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
    headers: { 'content-type': body.contentType }, payload: body.payload,
  })
  assert.strictEqual(res.statusCode, 401)
  await app.close()
})

test('[MOB-5a] 403 for an org the caller is not a member of (multi-tenant scoping)', async () => {
  const app = await bootRoute({ members: ['org-1'] })
  const body = multipartBody({ data: Buffer.from('audio') })
  const res = await app.inject({
    method: 'POST', url: '/api/orgs/org-2/arturita/transcribe',   // a foreign org
    headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
  })
  assert.strictEqual(res.statusCode, 403)
  await app.close()
})

test('[MOB-5a] happy path returns { transcript } with the provider mocked', async () => {
  const app = await bootRoute()
  const realFetch = globalThis.fetch
  const prev = { key: process.env.OPENAI_API_KEY, url: process.env.MC_STT_CLOUD_URL, p: process.env.MC_STT_PROVIDER }
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.MC_STT_CLOUD_URL = 'https://stt.example.com/v1'
  process.env.MC_STT_PROVIDER = 'cloud'
  ;(globalThis as any).fetch = async () => ({
    ok: true, status: 200, json: async () => ({ text: 'deploy the backend' }), text: async () => '',
  })
  try {
    const body = multipartBody({ data: Buffer.from('fake-m4a-bytes'), contentType: 'audio/m4a' })
    const res = await app.inject({
      method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
      headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
    })
    assert.strictEqual(res.statusCode, 200)
    const json = res.json()
    assert.strictEqual(json.transcript, 'deploy the backend')
    assert.strictEqual(json.provider, 'cloud_openai')
    // `text` mirrors `transcript` so the existing web client (web/lib/whisper.ts:37,
    // which reads json.text and posts field `file`) can point here by URL swap alone.
    assert.strictEqual(json.text, json.transcript)
    assert.strictEqual(STT_AUDIO_FIELD, 'file')
  } finally {
    ;(globalThis as any).fetch = realFetch
    process.env.OPENAI_API_KEY = prev.key; process.env.MC_STT_CLOUD_URL = prev.url; process.env.MC_STT_PROVIDER = prev.p
    if (prev.key === undefined) delete process.env.OPENAI_API_KEY
    if (prev.url === undefined) delete process.env.MC_STT_CLOUD_URL
    if (prev.p === undefined) delete process.env.MC_STT_PROVIDER
    await app.close()
  }
})

test('[MOB-5a] 415 for a non-audio content type', async () => {
  const app = await bootRoute()
  const body = multipartBody({ data: Buffer.from('%PDF-1.4'), filename: 'doc.pdf', contentType: 'application/pdf' })
  const res = await app.inject({
    method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
    headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
  })
  assert.strictEqual(res.statusCode, 415)
  assert.strictEqual(res.json().code, 'unsupported_type')
  await app.close()
})

test('[MOB-5a] 415 when the request is not multipart at all', async () => {
  const app = await bootRoute()
  const res = await app.inject({
    method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, payload: { transcript: 'nope' },
  })
  assert.strictEqual(res.statusCode, 415)
  assert.strictEqual(res.json().code, 'not_multipart')
  await app.close()
})

test('[MOB-5a] 400 when the file arrives under the wrong field name', async () => {
  const app = await bootRoute()
  const body = multipartBody({ field: 'audio', data: Buffer.from('audio') })
  const res = await app.inject({
    method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
    headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
  })
  assert.strictEqual(res.statusCode, 400)
  assert.strictEqual(res.json().code, 'bad_field')
  await app.close()
})

test('[MOB-5a] 413 for a clip over the per-route cap — well under the 25MB document limit', async () => {
  // Proves the route clamps to its OWN limit rather than inheriting the global
  // multipart one registered for document uploads.
  const app = await bootRoute()
  const body = multipartBody({ data: Buffer.alloc(STT_MAX_BYTES + 1024, 0x41), contentType: 'audio/wav' })
  const res = await app.inject({
    method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
    headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
  })
  assert.strictEqual(res.statusCode, 413)
  assert.strictEqual(res.json().code, 'too_large')
  await app.close()
})

test('[MOB-5a] 400 for an empty clip — no provider call is wasted on it', async () => {
  const app = await bootRoute()
  const body = multipartBody({ data: Buffer.alloc(0), contentType: 'audio/m4a' })
  const res = await app.inject({
    method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
    headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
  })
  assert.strictEqual(res.statusCode, 400)
  assert.strictEqual(res.json().code, 'empty_audio')
  await app.close()
})

test('[MOB-5a] a provider error is clean JSON — 502, no stack, no upstream body', async () => {
  const app = await bootRoute()
  const realFetch = globalThis.fetch
  const prev = { key: process.env.OPENAI_API_KEY, p: process.env.MC_STT_PROVIDER }
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.MC_STT_PROVIDER = 'cloud'
  ;(globalThis as any).fetch = async () => ({
    ok: false, status: 500, json: async () => ({}), text: async () => 'upstream stack trace here',
  })
  try {
    const body = multipartBody({ data: Buffer.from('fake'), contentType: 'audio/m4a' })
    const res = await app.inject({
      method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
      headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
    })
    assert.strictEqual(res.statusCode, 502)
    const json = res.json()
    assert.strictEqual(json.code, 'provider_error')
    assert.ok(!/stack trace/.test(JSON.stringify(json)), 'the upstream body must not reach the client')
    assert.ok(!('stack' in json))
  } finally {
    ;(globalThis as any).fetch = realFetch
    process.env.OPENAI_API_KEY = prev.key; process.env.MC_STT_PROVIDER = prev.p
    if (prev.key === undefined) delete process.env.OPENAI_API_KEY
    if (prev.p === undefined) delete process.env.MC_STT_PROVIDER
    await app.close()
  }
})

test('[MOB-5a] 503 when no transcriber is configured on this deployment', async () => {
  const app = await bootRoute()
  const prev = { key: process.env.OPENAI_API_KEY, p: process.env.MC_STT_PROVIDER, l: process.env.MC_STT_LOCAL_URL }
  delete process.env.OPENAI_API_KEY
  delete process.env.MC_STT_LOCAL_URL
  process.env.MC_STT_PROVIDER = 'auto'
  try {
    const body = multipartBody({ data: Buffer.from('fake'), contentType: 'audio/m4a' })
    const res = await app.inject({
      method: 'POST', url: '/api/orgs/org-1/arturita/transcribe',
      headers: { 'content-type': body.contentType, authorization: 'Bearer t' }, payload: body.payload,
    })
    assert.strictEqual(res.statusCode, 503)
    assert.strictEqual(res.json().code, 'not_configured')
  } finally {
    if (prev.key !== undefined) process.env.OPENAI_API_KEY = prev.key
    if (prev.p !== undefined) process.env.MC_STT_PROVIDER = prev.p; else delete process.env.MC_STT_PROVIDER
    if (prev.l !== undefined) process.env.MC_STT_LOCAL_URL = prev.l
    await app.close()
  }
})
