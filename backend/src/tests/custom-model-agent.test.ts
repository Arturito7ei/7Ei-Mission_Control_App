// Epic AG — custom adapters/models for agents, driven through the real routes
// against a real SQLite file. The things that must be true:
//
//   1. The API key is stored ENCRYPTED and never comes back out.
//   2. A saved model is selectable as an agent's model (available-models).
//   3. The agent's RUN path can resolve the key — the executor used to read only
//      the plaintext `<slug>_api_key`, which the save path never writes, so a
//      custom model with a key could not have authenticated on a single run.
//   4. Registering an agent model does NOT disturb Arturita's failover chain.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'ag-custom-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
delete process.env.DATABASE_AUTH_TOKEN
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64)

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { customModelRoutes, scrub } = await import('../routes/custom-models')
const { agentRoutes } = await import('../routes/all')
const { resolveLlmCreds, parseCustomModels, CATALOG_KEY } = await import('../services/custom-model')
const { PIPELINE_KEYS } = await import('../services/arturita-pipeline')
const { eq } = await import('drizzle-orm')

const ORG = 'org-cm', OWNER = 'user-owner', MEMBER = 'user-member', AGENT = 'agent-cm'
const KEY = 'nvapi-super-secret-key-value'

let app: FastifyInstance

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(customModelRoutes)
  a.register(agentRoutes)
  return a
}

const cfg = async () => {
  const o = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, ORG), columns: { deployConfig: true } })
  return (o?.deployConfig ?? {}) as Record<string, unknown>
}

const add = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/orgs/${ORG}/custom-models`, payload })

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values({ id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now } as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
    { id: randomUUID(), orgId: ORG, userId: MEMBER, role: 'member', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values({
    id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', runtime: 'internal', createdAt: now,
  } as any)
  app = appAs(OWNER)
  await app.ready()
})

after(async () => {
  await app?.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('[AG-CM] adding a custom model stores it and never echoes the key', async () => {
  const res = await add({
    label: 'NVIDIA Llama 3.3', baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct', apiKey: KEY,
  })
  assert.equal(res.statusCode, 201, res.body)

  assert.ok(!res.body.includes(KEY), 'the response must not contain the key')
  const masked = res.json().maskedKey as string
  assert.ok(!masked.includes(KEY) && masked.length < KEY.length, 'only a masked tail comes back')
  assert.ok(masked.endsWith(KEY.slice(-4)), 'the tail is what lets the operator recognise which key it is')
  assert.equal(res.json().entry.baseUrl, 'https://integrate.api.nvidia.com/v1')
})

test('[AG-CM] the key is stored encrypted, not in plaintext', async () => {
  const c = await cfg()
  const slug = 'nvidia_llama_3_3'
  assert.equal(c[`${slug}_api_key`], undefined, 'no plaintext key may be stored')
  const enc = c[`${slug}_api_key_enc`] as string
  assert.ok(enc, 'an encrypted key must be stored')
  assert.ok(!enc.includes(KEY), 'the stored blob must not contain the key')
  assert.ok(!JSON.stringify(c).includes(KEY), 'the key must appear nowhere in deployConfig')
})

test('[AG-CM] the RUN path resolves the encrypted key + base URL', async () => {
  // This is the interop the feature turns on. resolveLlmCreds is exactly what
  // agent-executor now calls for every provider, built-in or custom.
  const creds = resolveLlmCreds(await cfg(), 'nvidia_llama_3_3')
  assert.equal(creds.orgApiKey, KEY, 'the executor must be able to decrypt the key, or every run 401s')
  assert.equal(creds.baseURL, 'https://integrate.api.nvidia.com/v1')
})

test('[AG-CM] the model is selectable as an agent’s model', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/available-models` })
  assert.equal(res.statusCode, 200)
  const opt = res.json().models.find((m: any) => m.id === 'meta/llama-3.3-70b-instruct')
  assert.ok(opt, 'the custom model must appear in the Model picker')
  assert.equal(opt.provider, 'nvidia_llama_3_3')
  assert.equal(opt.custom, true)
  assert.equal(opt.tier, 'custom')
})

test('[AG-CM] the list never carries key material, only whether one is stored', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/custom-models` })
  assert.equal(res.statusCode, 200)
  assert.ok(!res.body.includes(KEY))
  const m = res.json().models[0]
  assert.equal(m.hasKey, true)
  assert.equal(m.provider, 'nvidia_llama_3_3')
})

test('[AG-CM] registering an agent model does not touch Arturita’s failover chain', async () => {
  const c = await cfg()
  assert.equal((c[PIPELINE_KEYS.llm] as unknown[] | undefined) ?? undefined, undefined,
    'the agent catalogue must not be written into arturita_llm_chain')
  assert.equal(parseCustomModels(c).length, 1)
  assert.ok(Array.isArray(c[CATALOG_KEY]))
})

test('[AG-CM] a keyless local endpoint is allowed (and drops any stale key)', async () => {
  const res = await add({ label: 'Local vLLM', baseUrl: 'http://localhost:8000/v1', model: 'qwen2.5-7b', mode: 'local' })
  assert.equal(res.statusCode, 201, res.body)
  assert.equal(res.json().maskedKey, null)
  const creds = resolveLlmCreds(await cfg(), 'local_vllm')
  assert.equal(creds.orgApiKey, undefined)
  assert.equal(creds.baseURL, 'http://localhost:8000/v1')
})

test('[AG-CM] re-saving without a key keeps the stored one', async () => {
  // The dialog leaves the key field blank when editing — that must not wipe it.
  const res = await add({
    provider: 'nvidia_llama_3_3', label: 'NVIDIA Llama 3.3',
    baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct',
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().hasKey, true)
  const creds = resolveLlmCreds(await cfg(), 'nvidia_llama_3_3')
  assert.equal(creds.orgApiKey, KEY, 're-saving an existing model without retyping the key must keep it')
})

test('[AG-CM] an explicit empty key clears the stored one', async () => {
  // Blank-because-not-retyped and blank-because-I-want-it-gone are different
  // intents; `apiKey: ''` is the second, and must actually clear.
  const res = await add({
    provider: 'nvidia_llama_3_3', label: 'NVIDIA Llama 3.3',
    baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', apiKey: '',
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().hasKey, false)
  assert.equal(resolveLlmCreds(await cfg(), 'nvidia_llama_3_3').orgApiKey, undefined)

  // Put it back for the removal test below.
  await add({
    provider: 'nvidia_llama_3_3', label: 'NVIDIA Llama 3.3',
    baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', apiKey: KEY,
  })
  assert.equal(resolveLlmCreds(await cfg(), 'nvidia_llama_3_3').orgApiKey, KEY)
})

test('[AG-CM] a bad base URL is refused', async () => {
  for (const baseUrl of ['javascript:alert(1)', 'not-a-url', '']) {
    const res = await add({ label: 'Bad', baseUrl, model: 'm' })
    assert.equal(res.statusCode, 400, `${baseUrl} should be refused`)
  }
})

test('[AG-CM] a missing model id is refused', async () => {
  const res = await add({ label: 'No model', baseUrl: 'https://x.example/v1', model: '' })
  assert.equal(res.statusCode, 400)
})

test('[AG-CM] a custom slug can never clobber a built-in provider key', async () => {
  const res = await add({ provider: 'openai', baseUrl: 'https://evil.example/v1', model: 'gpt-4o', apiKey: 'sk-evil' })
  assert.equal(res.statusCode, 201)
  assert.equal(res.json().slug, 'custom_openai', 'a reserved provider name must be namespaced')
  const c = await cfg()
  assert.equal(c['openai_api_key_enc'], undefined, 'the real openai key slot must be untouched')
})

test('[AG-CM] audit snapshots carry no key material', async () => {
  const revs = await db.select().from(schema.configRevisions).where(eq(schema.configRevisions.orgId, ORG))
  assert.ok(revs.length > 0, 'custom-model changes must be auditable')
  for (const r of revs) {
    assert.ok(!(r.before ?? '').includes(KEY) && !(r.after ?? '').includes(KEY), 'a revision must never hold a key')
    assert.ok(!(r.after ?? '').includes('_api_key_enc'), 'not even the encrypted blob belongs in an audit row')
  }
  assert.deepEqual(scrub({ a: 1, x_api_key: 'p', x_api_key_enc: 'e' }), { a: 1 })
})

test('[AG-CM] a member cannot add or remove a custom model', async () => {
  const member = appAs(MEMBER)
  await member.ready()
  const post = await member.inject({
    method: 'POST', url: `/api/orgs/${ORG}/custom-models`,
    payload: { label: 'Sneaky', baseUrl: 'https://x.example/v1', model: 'm' },
  })
  assert.equal(post.statusCode, 403)
  const del = await member.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/custom-models/nvidia_llama_3_3` })
  assert.equal(del.statusCode, 403)
  await member.close()
})

test('[AG-CM] removing a model takes its key with it and names the stranded agents', async () => {
  await db.update(schema.agents).set({ llmProvider: 'nvidia_llama_3_3' }).where(eq(schema.agents.id, AGENT))

  const res = await app.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/custom-models/nvidia_llama_3_3` })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().removed, true)
  assert.deepEqual(res.json().stranded.map((a: any) => a.name), ['Vera'],
    'an agent still pointed at the deleted model must be reported, not left to fail at run time')

  const c = await cfg()
  assert.equal(c['nvidia_llama_3_3_api_key_enc'], undefined, 'the stored key must be gone')
  assert.equal(resolveLlmCreds(c, 'nvidia_llama_3_3').orgApiKey, undefined)
  assert.ok(!parseCustomModels(c).some(e => e.provider === 'nvidia_llama_3_3'))
})
