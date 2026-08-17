import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLlmChain, parseSttChain, parseTtsChain, filterForContext,
  usableLlmChain, usableServerLlmChain, usableCloudProviders, resolvePipeline, validatePipelineConfig,
  DEFAULT_LLM_CHAIN, DEFAULT_STT_CHAIN, DEFAULT_TTS_CHAIN, PIPELINE_KEYS,
  serverOllamaBaseUrl, serverOllamaEnabled, DEFAULT_SERVER_OLLAMA_BASE_URL,
} from '../services/arturita-pipeline'

// ─── Free-first defaults when unconfigured ───────────────────────────────────

test('[J2] unconfigured org gets the free-first defaults (local Ollama/whisper/Piper first)', () => {
  assert.deepEqual(parseLlmChain(null), DEFAULT_LLM_CHAIN)
  assert.deepEqual(parseSttChain(undefined), DEFAULT_STT_CHAIN)
  assert.deepEqual(parseTtsChain({}), DEFAULT_TTS_CHAIN)
  assert.equal(DEFAULT_LLM_CHAIN[0].provider, 'ollama')
  assert.equal(DEFAULT_STT_CHAIN[0].engine, 'whisper_cpp')
  assert.equal(DEFAULT_TTS_CHAIN[0].engine, 'piper')
})

// Lock the LLM default as strictly LOCAL-FIRST: the two Ollama models lead (fast
// primary, then heavier), and NO cloud/provider entry ever precedes a local one.
// This is the shipped guarantee that the invalid cloud key is only a fallback.
test('[J2] LLM default is strictly local-first: Ollama primary + no cloud before local', () => {
  assert.equal(DEFAULT_LLM_CHAIN[0].provider, 'ollama')
  assert.equal(DEFAULT_LLM_CHAIN[0].model, 'llama3.2:3b')   // fast primary
  assert.equal(DEFAULT_LLM_CHAIN[0].mode, 'local')
  assert.equal(DEFAULT_LLM_CHAIN[1].provider, 'ollama')
  assert.equal(DEFAULT_LLM_CHAIN[1].model, 'qwen3:8b')      // heavier local next
  assert.equal(DEFAULT_LLM_CHAIN[1].mode, 'local')
  // Every local entry precedes every provider entry (no cloud jumps the queue).
  const firstProvider = DEFAULT_LLM_CHAIN.findIndex(e => e.mode === 'provider')
  const lastLocal = DEFAULT_LLM_CHAIN.map(e => e.mode).lastIndexOf('local')
  assert.ok(firstProvider === -1 || firstProvider > lastLocal, 'a provider entry precedes a local one')
  // No cloud provider is anthropic (the bad-key provider) — it only ever enters
  // at runtime as the appended `guaranteed` last-resort hop, never in the default.
  assert.ok(!DEFAULT_LLM_CHAIN.some(e => e.provider === 'anthropic'))
})

// With the default chain and no cloud keys, the usable chain keeps both local
// Ollama hops FIRST and puts the guaranteed cloud hop (bad key) strictly LAST.
test('[J2] usable default chain: local Ollama hops first, cloud guarantee strictly last', () => {
  const chain = usableLlmChain({
    entries: DEFAULT_LLM_CHAIN,
    keyAvailable: () => false,                                   // off-Mac, no free-tier keys
    guaranteed: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  })
  assert.equal(chain[0].provider, 'ollama')
  assert.equal(chain[1].provider, 'ollama')
  assert.equal(chain[chain.length - 1].provider, 'anthropic')   // last resort only
  const firstCloud = chain.findIndex(c => c.provider !== 'ollama')
  const lastLocal = chain.map(c => c.provider === 'ollama').lastIndexOf(true)
  assert.ok(firstCloud > lastLocal, 'a cloud hop precedes a local one')
})

// Lock the STT default as strictly WHISPER-FIRST: a local whisper engine leads,
// browser Web Speech is only a fallback, and no provider entry ever precedes the
// local one. This is the shipped guarantee that the operator's reachable local
// whisper bridge is used automatically without flipping a switch (typed input is
// always available as the UI's final fallback, not modelled in the chain).
test('[J2] STT default is strictly whisper-first: local whisper primary + no provider before local', () => {
  const LOCAL_STT = new Set(['whisper_cpp', 'faster_whisper', 'whisper'])
  assert.ok(LOCAL_STT.has(DEFAULT_STT_CHAIN[0].engine), 'primary STT engine must be a local whisper engine')
  assert.equal(DEFAULT_STT_CHAIN[0].mode, 'local')
  assert.equal(DEFAULT_STT_CHAIN[DEFAULT_STT_CHAIN.length - 1].engine, 'web_speech') // browser fallback last
  // Every local entry precedes every provider entry (no cloud/provider jumps the queue).
  const firstProvider = DEFAULT_STT_CHAIN.findIndex(e => e.mode === 'provider')
  const lastLocal = DEFAULT_STT_CHAIN.map(e => e.mode).lastIndexOf('local')
  assert.ok(firstProvider === -1 || firstProvider > lastLocal, 'a provider STT entry precedes a local one')
  // An unconfigured org (no stored arturita_stt_chain override) gets this default.
  assert.deepEqual(parseSttChain(null), DEFAULT_STT_CHAIN)
  assert.deepEqual(parseSttChain({}), DEFAULT_STT_CHAIN)
})

// ─── Parsing configured chains (array or JSON string) ────────────────────────

test('[J2] parses a configured LLM chain and infers mode from provider', () => {
  const cfg = { [PIPELINE_KEYS.llm]: [
    { provider: 'ollama', model: 'qwen3:8b' },              // → local (inferred)
    { provider: 'anthropic', model: 'claude-sonnet-4' },   // → provider (inferred)
    { provider: 'groq', model: 'llama-3.3-70b', mode: 'provider' },
  ] }
  const chain = parseLlmChain(cfg)
  assert.equal(chain.length, 3)
  assert.equal(chain[0].mode, 'local')
  assert.equal(chain[1].mode, 'provider')
})

test('[J2] accepts a JSON-string chain too', () => {
  const cfg = { [PIPELINE_KEYS.stt]: JSON.stringify([{ engine: 'whisper_cpp', model: 'base', mode: 'local' }]) }
  const chain = parseSttChain(cfg)
  assert.equal(chain.length, 1)
  assert.equal(chain[0].model, 'base')
})

test('[J2] LLM back-compat: falls through to the shipped arturita_fallback_chain', () => {
  const cfg = { arturita_fallback_chain: 'ollama/llama3.2:3b, anthropic/claude-sonnet-4' }
  const chain = parseLlmChain(cfg)
  assert.equal(chain[0].provider, 'ollama')
  assert.equal(chain[0].mode, 'local')
  assert.equal(chain[1].provider, 'anthropic')
  assert.equal(chain[1].mode, 'provider')
})

test('[J2] malformed entries are dropped; empty result → defaults', () => {
  assert.deepEqual(parseLlmChain({ [PIPELINE_KEYS.llm]: [{ provider: 'ollama' }] }), DEFAULT_LLM_CHAIN) // no model → dropped → default
  assert.deepEqual(parseTtsChain({ [PIPELINE_KEYS.tts]: 'not json' }), DEFAULT_TTS_CHAIN)
})

// ─── Privacy filter (S1) ─────────────────────────────────────────────────────

test('[J2] a sensitive context drops every provider (cloud) entry', () => {
  const llm = filterForContext(DEFAULT_LLM_CHAIN, { sensitive: true })
  assert.ok(llm.every(e => e.mode === 'local'))
  assert.ok(llm.length >= 1)                       // the Ollama locals survive
  const stt = filterForContext(DEFAULT_STT_CHAIN, { sensitive: true })
  assert.ok(stt.every(e => e.mode === 'local'))    // web_speech (provider) dropped
  const notSensitive = filterForContext(DEFAULT_LLM_CHAIN, { sensitive: false })
  assert.equal(notSensitive.length, DEFAULT_LLM_CHAIN.length)
})

test('[J2] resolvePipeline applies the privacy filter across all layers', () => {
  const r = resolvePipeline(null, { sensitive: true })
  assert.ok(r.llm.every(e => e.mode === 'local'))
  assert.ok(r.stt.every(e => e.mode === 'local'))
  assert.ok(r.tts.every(e => e.mode === 'local'))
})

// ─── usableLlmChain: prune unusable cloud hops, guarantee a last resort ──────

test('[J2] usableLlmChain keeps local/ollama, drops keyless cloud, appends the guarantee', () => {
  const chain = usableLlmChain({
    entries: DEFAULT_LLM_CHAIN,                       // ollama, ollama, groq, google
    keyAvailable: () => false,                        // no cloud keys (Fly w/o free-tier keys)
    guaranteed: { provider: 'anthropic', model: 'claude-sonnet-4' },
  })
  // ollama hops kept (keyless), groq/google dropped (no key), anthropic appended
  assert.deepEqual(chain, [
    { provider: 'ollama', model: 'llama3.2:3b' },
    { provider: 'ollama', model: 'qwen3:8b' },
    { provider: 'anthropic', model: 'claude-sonnet-4' },
  ])
})

test('[J2] usableLlmChain keeps a cloud hop when its key is available, dedups the guarantee', () => {
  const chain = usableLlmChain({
    entries: [{ provider: 'groq', model: 'llama-3.3-70b', mode: 'provider' }, { provider: 'anthropic', model: 'claude-sonnet-4', mode: 'provider' }],
    keyAvailable: (p) => p === 'groq' || p === 'anthropic',
    guaranteed: { provider: 'anthropic', model: 'claude-sonnet-4' },
  })
  assert.deepEqual(chain, [
    { provider: 'groq', model: 'llama-3.3-70b' },
    { provider: 'anthropic', model: 'claude-sonnet-4' },   // guarantee already present → not duplicated
  ])
})

test('[J2] usableLlmChain never returns empty when a guarantee is given', () => {
  const chain = usableLlmChain({ entries: [{ provider: 'groq', model: 'x', mode: 'provider' }], keyAvailable: () => false, guaranteed: { provider: 'anthropic', model: 'claude' } })
  assert.equal(chain.length, 1)
  assert.equal(chain[0].provider, 'anthropic')
})

// ─── validatePipelineConfig ──────────────────────────────────────────────────

test('[J2] validate accepts well-formed layers and cleans them', () => {
  const v = validatePipelineConfig({
    [PIPELINE_KEYS.llm]: [{ provider: 'ollama', model: 'llama3.2:3b', mode: 'local' }],
    [PIPELINE_KEYS.tts]: [{ engine: 'piper', voice: 'en_US-amy' }],
  })
  assert.equal(v.ok, true)
  assert.equal(v.value.llm?.length, 1)
  assert.equal(v.value.tts?.[0].engine, 'piper')
})

test('[J2] validate flags malformed entries and non-arrays', () => {
  const v = validatePipelineConfig({ [PIPELINE_KEYS.llm]: [{ provider: 'ollama' }], [PIPELINE_KEYS.stt]: 'nope' })
  assert.equal(v.ok, false)
  assert.ok(v.errors.length >= 2)
})

test('[J2] validate ignores absent layers (partial update)', () => {
  const v = validatePipelineConfig({ [PIPELINE_KEYS.tts]: [{ engine: 'speech_synth' }] })
  assert.equal(v.ok, true)
  assert.equal(v.value.llm, undefined)
  assert.equal(v.value.stt, undefined)
  assert.equal(v.value.tts?.length, 1)
})

// ─── usableCloudProviders: the cloud fallback the self-test actually depends on ─

test('[talk] usableCloudProviders excludes local/ollama hops and keys the rest', () => {
  // default chain: 2 local ollama hops + groq + google (providers)
  const withGroq = usableCloudProviders(DEFAULT_LLM_CHAIN, p => p === 'groq')
  assert.deepEqual(withGroq, ['groq'])           // only the provider WITH a key
})

test('[talk] usableCloudProviders is empty when no cloud key is present (the live failure)', () => {
  // no keys at all → the cloud fallback cannot answer → empty
  assert.deepEqual(usableCloudProviders(DEFAULT_LLM_CHAIN, () => false), [])
})

test('[talk] usableCloudProviders dedupes and skips local-mode entries even for cloud providers', () => {
  const chain = [
    { provider: 'ollama', model: 'llama3.2:3b', mode: 'local' as const },
    { provider: 'groq', model: 'a', mode: 'provider' as const },
    { provider: 'groq', model: 'b', mode: 'provider' as const },       // dup provider
    { provider: 'google', model: 'g', mode: 'local' as const },        // marked local → skipped
  ]
  assert.deepEqual(usableCloudProviders(chain, () => true), ['groq'])
})

// ─── S3-B: server-side Ollama fallback chain ─────────────────────────────────

test('[S3-B] serverOllamaBaseUrl prefers OLLAMA_BASE_URL and normalizes /v1', () => {
  assert.equal(serverOllamaBaseUrl({}), DEFAULT_SERVER_OLLAMA_BASE_URL)
  assert.equal(serverOllamaBaseUrl({ OLLAMA_BASE_URL: 'http://ollama.internal:11434' }), 'http://ollama.internal:11434/v1')
  assert.equal(serverOllamaBaseUrl({ SERVER_OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1' }), 'http://127.0.0.1:11434/v1')
})

test('[S3-B] serverOllamaEnabled honours MC_SERVER_OLLAMA=0', () => {
  assert.equal(serverOllamaEnabled({}), true)
  assert.equal(serverOllamaEnabled({ MC_SERVER_OLLAMA: '0' }), false)
  assert.equal(serverOllamaEnabled({ MC_SERVER_OLLAMA: 'false' }), false)
})

test('[S3-B] usableServerLlmChain: no cloud keys + server Ollama → ollama hops before guarantee', () => {
  const chain = usableServerLlmChain({
    entries: DEFAULT_LLM_CHAIN,
    keyAvailable: () => false,
    guaranteed: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    serverOllama: true,
  })
  assert.deepEqual(chain.slice(0, 2), [
    { provider: 'ollama', model: 'llama3.2:3b' },
    { provider: 'ollama', model: 'qwen3:8b' },
  ])
  assert.equal(chain[chain.length - 1].provider, 'anthropic')
})

test('[S3-B] usableServerLlmChain: server Ollama disabled → cloud guarantee only', () => {
  const chain = usableServerLlmChain({
    entries: DEFAULT_LLM_CHAIN,
    keyAvailable: () => false,
    guaranteed: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    serverOllama: false,
  })
  assert.deepEqual(chain, [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }])
})

test('[S3-B] usableServerLlmChain skips browser-only local hops but keeps keyed cloud', () => {
  const entries = [
    { provider: 'ollama', model: 'llama3.2:3b', mode: 'local' as const },
    { provider: 'whisper_local', model: 'x', mode: 'local' as const, baseUrl: 'http://127.0.0.1:8790/v1', custom: true },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', mode: 'provider' as const },
  ]
  const chain = usableServerLlmChain({
    entries,
    keyAvailable: p => p === 'groq',
    guaranteed: { provider: 'anthropic', model: 'claude' },
  })
  assert.deepEqual(chain, [
    { provider: 'ollama', model: 'llama3.2:3b' },
    { provider: 'whisper_local', model: 'x' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { provider: 'anthropic', model: 'claude' },
  ])
})
