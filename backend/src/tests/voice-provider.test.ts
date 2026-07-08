import { test } from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeSpeech, chatterboxNvidiaSynthesize } from '../services/voice-provider'

// A fake fetch returning 3 bytes of "audio".
const okFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, text: async () => '' })
const errFetch = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'down' })

test('[B1/S1] provider mode + key + healthy provider → Chatterbox audio', async () => {
  const r = await synthesizeSpeech({
    text: 'On it.', mode: 'provider',
    caps: { providerKeyPresent: true, localAvailable: false },
    apiKey: 'nvapi-fake', fetchImpl: okFetch as any,
  })
  assert.equal(r.provider, 'chatterbox_nvidia')
  assert.equal(r.mime, 'audio/mpeg')
  assert.ok(r.audioBase64 && r.audioBase64.length > 0)
  assert.equal(r.degraded, false)
})

test('[B1/S1] provider mode without a key → text-only, no throw', async () => {
  const r = await synthesizeSpeech({ text: 'hi', mode: 'provider', caps: { providerKeyPresent: false, localAvailable: false }, apiKey: null })
  assert.equal(r.provider, 'text_only')
  assert.equal(r.audioBase64, null)
})

test('[B1/S1] a provider outage degrades to text-only (never throws)', async () => {
  const r = await synthesizeSpeech({
    text: 'hi', mode: 'provider',
    caps: { providerKeyPresent: true, localAvailable: false },
    apiKey: 'nvapi-fake', fetchImpl: errFetch as any,
  })
  assert.equal(r.provider, 'text_only')
  assert.equal(r.degraded, true)
  assert.match(r.note, /failed|text-only/)
})

test('[B1/S1] local mode uses the local engine hook when present', async () => {
  const r = await synthesizeSpeech({
    text: 'private', mode: 'local',
    caps: { providerKeyPresent: false, localAvailable: true },
    localSynthesize: async () => ({ audioBase64: 'bG9jYWw=', mime: 'audio/wav' }),
  })
  assert.equal(r.provider, 'local')
  assert.equal(r.mime, 'audio/wav')
})

test('[B1/S1] local mode without a local engine → text-only (no cloud leak)', async () => {
  const r = await synthesizeSpeech({ text: 'private', mode: 'local', caps: { providerKeyPresent: true, localAvailable: false }, apiKey: 'nvapi-fake' })
  assert.equal(r.provider, 'text_only') // key present but local mode → never cloud
})

test('[B1/S1] chatterboxNvidiaSynthesize sends Bearer auth + returns base64', async () => {
  let sawAuth = ''
  const spyFetch = async (_url: string, init: any) => { sawAuth = init.headers.Authorization; return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9]).buffer, text: async () => '' } }
  const out = await chatterboxNvidiaSynthesize({ text: 'hi', apiKey: 'nvapi-secret', fetchImpl: spyFetch as any })
  assert.equal(sawAuth, 'Bearer nvapi-secret')
  assert.equal(out.mime, 'audio/mpeg')
  assert.ok(out.audioBase64.length > 0)
})
