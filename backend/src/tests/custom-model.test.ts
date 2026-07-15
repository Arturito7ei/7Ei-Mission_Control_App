import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slugifyProvider, isValidBaseUrl, validateCustomModel,
  applyCustomModel, removeCustomModel, resolveLlmCreds, hasStoredKey,
  baseUrlKey, encKeyKey, plainKeyKey,
} from '../services/custom-model'
import { parseLlmChain, usableLlmChain, PIPELINE_KEYS, DEFAULT_LLM_CHAIN } from '../services/arturita-pipeline'

// ─── slugifyProvider ─────────────────────────────────────────────────────────

test('[J2+] slugifyProvider makes a safe key segment and namespaces built-ins', () => {
  assert.equal(slugifyProvider('Together Llama 3.3'), 'together_llama_3_3')
  assert.equal(slugifyProvider('  My-Provider!! '), 'my_provider')
  assert.equal(slugifyProvider(''), 'custom_model')
  // reserved built-ins must NOT clobber real provider keys
  assert.equal(slugifyProvider('openai'), 'custom_openai')
  assert.equal(slugifyProvider('ollama'), 'custom_ollama')
})

// ─── isValidBaseUrl ──────────────────────────────────────────────────────────

test('[J2+] isValidBaseUrl accepts http(s) incl. localhost, rejects other schemes', () => {
  assert.ok(isValidBaseUrl('https://api.together.xyz/v1'))
  assert.ok(isValidBaseUrl('http://localhost:11434/v1'))
  assert.ok(!isValidBaseUrl('javascript:alert(1)'))
  assert.ok(!isValidBaseUrl('ftp://x/y'))
  assert.ok(!isValidBaseUrl(''))
  assert.ok(!isValidBaseUrl('not a url'))
})

// ─── validateCustomModel ─────────────────────────────────────────────────────

test('[J2+] validateCustomModel builds an entry + slug for a valid submission', () => {
  const v = validateCustomModel({ label: 'Together L3', model: 'meta/Llama-3.3', baseUrl: 'https://api.together.xyz/v1', apiKey: 'sk-x' })
  assert.equal(v.ok, true)
  assert.equal(v.slug, 'together_l3')
  assert.deepEqual(v.entry, { provider: 'together_l3', model: 'meta/Llama-3.3', mode: 'provider', label: 'Together L3', baseUrl: 'https://api.together.xyz/v1', custom: true })
})

test('[J2+] validateCustomModel requires model + a valid base URL', () => {
  assert.deepEqual(validateCustomModel({ baseUrl: 'https://x/v1' }).ok, false)
  assert.deepEqual(validateCustomModel({ model: 'm' }).ok, false)
  const bad = validateCustomModel({ model: 'm', baseUrl: 'javascript:1' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(' '), /base URL/)
})

test('[J2+] validateCustomModel defaults label + mode, honours local mode', () => {
  const v = validateCustomModel({ model: 'phi3', baseUrl: 'http://localhost:11434/v1', mode: 'local' })
  assert.equal(v.entry?.mode, 'local')
  assert.equal(v.entry?.label, `${v.slug} · phi3`)
})

// ─── applyCustomModel ────────────────────────────────────────────────────────

// injectable fake encryptor that actually obscures the plaintext (base64), so the
// "no raw key in serialized config" assertion is meaningful.
const enc = (s: string) => 'ENC:' + Buffer.from(s, 'utf8').toString('base64')
const dec = (s: string) => Buffer.from(String(s).replace(/^ENC:/, ''), 'base64').toString('utf8')

test('[J2+] applyCustomModel stores base URL, encrypts the key, and upserts the chain', () => {
  const v = validateCustomModel({ label: 'Together', model: 'llama', baseUrl: 'https://t/v1', apiKey: 'sk-secret' })
  const out = applyCustomModel({ deployConfig: {}, slug: v.slug!, entry: v.entry!, apiKey: 'sk-secret', encryptFn: enc })
  assert.equal(out.deployConfig[baseUrlKey(v.slug!)], 'https://t/v1')
  assert.match(String(out.deployConfig[encKeyKey(v.slug!)]), /^ENC:/)
  assert.equal(dec(String(out.deployConfig[encKeyKey(v.slug!)])), 'sk-secret')  // round-trips
  assert.ok(!(plainKeyKey(v.slug!) in out.deployConfig))     // never plaintext
  assert.equal(out.maskedKey, '••••cret')
  // unconfigured org materializes the free-first defaults + the custom entry (last).
  assert.equal(out.chain.length, DEFAULT_LLM_CHAIN.length + 1)
  assert.equal(out.chain.at(-1)!.provider, v.slug)
  assert.equal(out.chain.filter(e => e.provider === v.slug).length, 1)
  // the raw key must not leak anywhere in the serialized config
  assert.ok(!JSON.stringify(out.deployConfig).includes('sk-secret'))
})

test('[J2+] applyCustomModel de-dupes a same-slug+model re-save (update, not append)', () => {
  const v = validateCustomModel({ label: 'X', model: 'm1', baseUrl: 'https://t/v1', apiKey: 'k' })
  const first = applyCustomModel({ deployConfig: {}, slug: v.slug!, entry: v.entry!, apiKey: 'k', encryptFn: enc })
  const v2 = validateCustomModel({ label: 'X', model: 'm1', baseUrl: 'https://t2/v1', apiKey: 'k2' })
  const second = applyCustomModel({ deployConfig: first.deployConfig, slug: v2.slug!, entry: v2.entry!, apiKey: 'k2', encryptFn: enc })
  assert.equal(second.chain.filter(e => e.provider === v2.slug).length, 1)  // replaced, not duplicated
  assert.equal(second.chain.find(e => e.provider === v2.slug)!.baseUrl, 'https://t2/v1')
})

test('[J2+] applyCustomModel keyless save drops any previously stored key', () => {
  const v = validateCustomModel({ label: 'Local', model: 'phi3', baseUrl: 'http://localhost:11434/v1', mode: 'local' })
  const withKey = applyCustomModel({ deployConfig: {}, slug: v.slug!, entry: v.entry!, apiKey: 'k', encryptFn: enc })
  const keyless = applyCustomModel({ deployConfig: withKey.deployConfig, slug: v.slug!, entry: v.entry!, apiKey: '', encryptFn: enc })
  assert.ok(!(encKeyKey(v.slug!) in keyless.deployConfig))
  assert.equal(keyless.maskedKey, null)
})

// AVL-10 — the Arturita PIPELINE panel's blank-key behaviour, pinned explicitly.
//
// The pipeline route (arturita-custom-model.ts) passes the form's `apiKey` STRAIGHT
// to applyCustomModel — so an OMITTED key (undefined) is treated identically to an
// explicit '' and clears any stored key. There is deliberately NO keep-on-blank at
// this layer: unlike the AGENT route (custom-models.ts:83-92), which restores the
// stored blob on `undefined` because its dialog edits an existing model in place,
// the pipeline panel (web AssistantPipelineConfig.tsx `CustomModelForm`) is
// ADD-ONLY — it resets every field on each add and never reopens an existing entry
// with a blank key. So there is no stored credential to protect: a blank key on the
// pipeline panel always means "add a keyless entry". This test pins that
// undefined ≡ '' equivalence so the two paths cannot silently diverge. (The
// keep-on-blank path is the AGENT panel's, covered by custom-model-agent.test.ts:140.)
test('[J2+] applyCustomModel (pipeline default) treats an OMITTED key the same as empty — no keep-on-blank (the pipeline panel is add-only)', () => {
  const v = validateCustomModel({ label: 'Local', model: 'phi3', baseUrl: 'http://localhost:11434/v1', mode: 'local' })
  const withKey = applyCustomModel({ deployConfig: {}, slug: v.slug!, entry: v.entry!, apiKey: 'k', encryptFn: enc })
  assert.ok(encKeyKey(v.slug!) in withKey.deployConfig, 'precondition: a key is stored')
  // apiKey omitted entirely (undefined) — exactly what the route passes when the
  // pipeline form's key field is left blank (`apiKey.trim() || undefined`).
  const omitted = applyCustomModel({ deployConfig: withKey.deployConfig, slug: v.slug!, entry: v.entry!, encryptFn: enc })
  assert.ok(!(encKeyKey(v.slug!) in omitted.deployConfig), 'an omitted key clears the stored one, identically to apiKey: ""')
  assert.equal(omitted.maskedKey, null)
})

// ─── round-trip through the pipeline parser + fallback chain ─────────────────

test('[J2+] a saved custom entry round-trips through parseLlmChain with its label/baseUrl', () => {
  const v = validateCustomModel({ label: 'Together', model: 'llama', baseUrl: 'https://t/v1', apiKey: 'k' })
  const out = applyCustomModel({ deployConfig: {}, slug: v.slug!, entry: v.entry!, apiKey: 'k', encryptFn: enc })
  const chain = parseLlmChain(out.deployConfig)
  const custom = chain.find(e => e.provider === v.slug)!
  assert.equal(custom.label, 'Together')
  assert.equal(custom.baseUrl, 'https://t/v1')
  assert.equal(custom.custom, true)
})

test('[J2+] usableLlmChain keeps a keyed custom provider and a keyless local base-URL entry', () => {
  const keyed = validateCustomModel({ label: 'Hosted', model: 'm', baseUrl: 'https://h/v1', apiKey: 'k' })
  const cfgA = applyCustomModel({ deployConfig: {}, slug: keyed.slug!, entry: keyed.entry!, apiKey: 'k', encryptFn: enc }).deployConfig
  const local = validateCustomModel({ label: 'Home', model: 'phi3', baseUrl: 'http://localhost:11434/v1', mode: 'local' })
  const cfg = applyCustomModel({ deployConfig: cfgA, slug: local.slug!, entry: local.entry!, apiKey: '', encryptFn: enc }).deployConfig

  const chain = usableLlmChain({
    entries: parseLlmChain(cfg),
    keyAvailable: p => hasStoredKey(cfg, p),   // mirrors the converse route
    guaranteed: { provider: 'anthropic', model: 'claude-sonnet-4' },
  })
  const providers = chain.map(l => l.provider)
  assert.ok(providers.includes(keyed.slug!), 'keyed custom provider kept')
  assert.ok(providers.includes(local.slug!), 'keyless local base-URL kept')
})

test('[J2+] usableLlmChain drops a keyless *provider*-mode custom entry (no key, not local)', () => {
  // provider mode + no stored key → not runnable, must be pruned
  const v = validateCustomModel({ label: 'NoKey', model: 'm', baseUrl: 'https://h/v1' }) // provider mode default
  const cfg = { [PIPELINE_KEYS.llm]: [v.entry] }
  const chain = usableLlmChain({ entries: parseLlmChain(cfg), keyAvailable: () => false, guaranteed: { provider: 'anthropic', model: 'x' } })
  assert.ok(!chain.some(l => l.provider === v.slug), 'unkeyed hosted custom entry pruned')
})

// ─── removeCustomModel ───────────────────────────────────────────────────────

test('[J2+] removeCustomModel strips the entry + base URL + stored key', () => {
  const v = validateCustomModel({ label: 'X', model: 'm', baseUrl: 'https://t/v1', apiKey: 'k' })
  const cfg = applyCustomModel({ deployConfig: {}, slug: v.slug!, entry: v.entry!, apiKey: 'k', encryptFn: enc }).deployConfig
  const { deployConfig, chain } = removeCustomModel({ deployConfig: cfg, slug: v.slug! })
  assert.ok(!chain.some(e => e.provider === v.slug))
  assert.ok(!(baseUrlKey(v.slug!) in deployConfig))
  assert.ok(!(encKeyKey(v.slug!) in deployConfig))
})

// ─── resolveLlmCreds / hasStoredKey ──────────────────────────────────────────

test('[J2+] resolveLlmCreds decrypts the stored key and returns the base URL', () => {
  const cfg = { [encKeyKey('together')]: enc('sk-x'), [baseUrlKey('together')]: 'https://t/v1' }
  const creds = resolveLlmCreds(cfg, 'together', dec)
  assert.equal(creds.orgApiKey, 'sk-x')
  assert.equal(creds.baseURL, 'https://t/v1')
})

test('[J2+] resolveLlmCreds still honours a legacy plaintext key', () => {
  const cfg = { [plainKeyKey('openai')]: 'sk-plain' }
  assert.equal(resolveLlmCreds(cfg, 'openai', dec).orgApiKey, 'sk-plain')
})

test('[J2+] resolveLlmCreds tolerates a corrupt encrypted blob (returns no key)', () => {
  const boom = () => { throw new Error('bad blob') }
  const creds = resolveLlmCreds({ [encKeyKey('x')]: 'garbage' }, 'x', boom)
  assert.equal(creds.orgApiKey, undefined)
})

test('[J2+] hasStoredKey sees both plaintext and encrypted keys', () => {
  assert.equal(hasStoredKey({ [plainKeyKey('a')]: 'k' }, 'a'), true)
  assert.equal(hasStoredKey({ [encKeyKey('b')]: 'ENC(k)' }, 'b'), true)
  assert.equal(hasStoredKey({}, 'c'), false)
})
