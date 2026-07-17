// MOB-7d (audit fix) — the api-client write helpers, exercised against the REAL
// backend response ENVELOPES.
//
// The bug this file exists to prevent: `api<{ agent: Agent }>(…)` is an UNCHECKED
// type assertion — TypeScript believes whatever shape you name, and no test hit
// the wire. Two write helpers claimed the routes answer `{ agent }`, but
// `PUT …/model-profile` answers `{ agentId, profile, resolved }` and `PUT …/trust`
// answers `{ agentId, trustMode, boundary }` (verified in backend/src/routes/
// agents.ts). So `.then(r => r.agent)` returned `undefined` on a SUCCESSFUL save —
// which blanked the on-screen agent and threw a false "your changes are still
// here" error even though the write landed. Config (`{ agent }`) and skills (the
// payload itself) were correct.
//
// These tests stub global `fetch` and assert each helper unwraps the ACTUAL
// envelope — so a helper reading a field the route doesn't return fails here
// rather than in the operator's hands. `api.ts`'s only imports are `import type`
// (erased under --experimental-strip-types); it uses global fetch/FormData, so it
// loads outside Metro like every other pure module the suite covers.

import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { Api } from './api.ts'

const BASE = 'https://api.example'
const TOKEN = 't0ken'

let lastCall: { url: string; method: string; body: unknown } | null = null
const realFetch = globalThis.fetch

/** Stub fetch to return `envelope` as a 200 JSON body, capturing the request. */
function stubFetch(envelope: unknown) {
  lastCall = null
  globalThis.fetch = (async (url: string, opts: any) => {
    lastCall = {
      url: String(url),
      method: String(opts?.method ?? 'GET').toUpperCase(),
      body: opts?.body != null ? JSON.parse(opts.body) : undefined,
    }
    return {
      status: 200,
      ok: true,
      json: async () => envelope,
    } as any
  }) as any
}

afterEach(() => {
  globalThis.fetch = realFetch
  lastCall = null
})

// ─── The two helpers the audit fixed ────────────────────────────────────────────

test('updateModelProfile unwraps the REAL { agentId, profile, resolved } envelope', async () => {
  // Exactly what backend PUT …/model-profile returns (agents.ts).
  const envelope = {
    agentId: 'a1',
    profile: { primaryModel: 'claude-opus-4-8', cheapModel: 'claude-haiku-4-5', cheapModelEnabled: true, reasoningEffort: 'high' },
    resolved: { primary: 'claude-opus-4-8', cheap: 'claude-haiku-4-5', cheapEnabled: true, reasoningEffort: 'high' },
  }
  stubFetch(envelope)
  const profile = await Api.updateModelProfile(BASE, TOKEN, 'org1', 'a1', {
    primaryModel: 'claude-opus-4-8',
    cheapModel: 'claude-haiku-4-5',
    cheapModelEnabled: true,
    reasoningEffort: 'high',
  })
  // The regression: the old `.then(r => r.agent)` returned undefined here.
  assert.notEqual(profile, undefined)
  assert.deepEqual(profile, envelope.profile)
  assert.equal(profile.primaryModel, 'claude-opus-4-8')
  // It targeted the owner-gated route with the right method + body.
  assert.equal(lastCall?.method, 'PUT')
  assert.equal(lastCall?.url, `${BASE}/api/orgs/org1/agents/a1/model-profile`)
  assert.equal((lastCall?.body as any)?.cheapModelEnabled, true)
})

test('updateModelProfile carries a null reasoningEffort through (provider default)', async () => {
  stubFetch({ agentId: 'a1', profile: { primaryModel: null, cheapModel: null, cheapModelEnabled: false, reasoningEffort: null }, resolved: {} })
  const profile = await Api.updateModelProfile(BASE, TOKEN, 'org1', 'a1', { primaryModel: '', cheapModel: '', cheapModelEnabled: false, reasoningEffort: '' })
  assert.equal(profile.reasoningEffort, null)
  assert.equal(profile.primaryModel, null)
})

test('updateAgentTrust unwraps the REAL { agentId, trustMode, boundary } envelope', async () => {
  const envelope = { agentId: 'a1', trustMode: 'low_trust_review', boundary: { projects: [], tasks: [], agents: [] } }
  stubFetch(envelope)
  const trustMode = await Api.updateAgentTrust(BASE, TOKEN, 'org1', 'a1', { trustMode: 'low_trust_review' })
  // The regression: the old `.then(r => r.agent)` returned undefined here.
  assert.notEqual(trustMode, undefined)
  assert.equal(trustMode, 'low_trust_review')
  assert.equal(lastCall?.method, 'PUT')
  assert.equal(lastCall?.url, `${BASE}/api/orgs/org1/agents/a1/trust`)
  assert.equal((lastCall?.body as any)?.trustMode, 'low_trust_review')
})

// ─── The two helpers that were already correct (locked so a refactor can't flip) ─

test('updateAgentConfig reads { agent } — the config route DOES wrap in `agent`', async () => {
  const agent = { id: 'a1', name: 'Aria', role: 'Engineer' }
  stubFetch({ agent })
  const got = await Api.updateAgentConfig(BASE, TOKEN, 'org1', 'a1', { name: 'Aria', role: 'Engineer' })
  assert.deepEqual(got, agent)
  assert.equal(lastCall?.method, 'PUT')
  assert.equal(lastCall?.url, `${BASE}/api/orgs/org1/agents/a1/config`)
})

test('updateAgentSkills returns the payload itself (no wrapper) — the whole selection write', async () => {
  const payload = { installed: [], other: [], orphaned: [], selectedCount: 0, adapter: 'internal', model: 'claude' }
  stubFetch(payload)
  const got = await Api.updateAgentSkills(BASE, TOKEN, 'org1', 'a1', ['search'])
  assert.deepEqual(got, payload)
  assert.equal(lastCall?.method, 'PUT')
  assert.equal(lastCall?.url, `${BASE}/api/orgs/org1/agents/a1/skills`)
  assert.deepEqual((lastCall?.body as any)?.skills, ['search'])
})

test('agentSkills (GET) returns the payload itself', async () => {
  const payload = { installed: [{ id: '1', name: 'search', installed: true }], other: [], orphaned: [], selectedCount: 1, adapter: 'internal', model: 'claude' }
  stubFetch(payload)
  const got = await Api.agentSkills(BASE, TOKEN, 'org1', 'a1')
  assert.deepEqual(got, payload)
  assert.equal(lastCall?.method, 'GET')
})
