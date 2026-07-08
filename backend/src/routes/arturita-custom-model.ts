// Arturita J2+ — custom operator-defined LLM model endpoints (Clerk-secured,
// owner-gated for writes). The operator adds an arbitrary OpenAI-compatible (or
// keyless local base-URL) model from the Config panel; it slots into the same
// `arturita_llm_chain` as any built-in and rides the F1 breaker/failover.
//
// Secret handling: the API key is stored ENCRYPTED in deployConfig
// (`<slug>_api_key_enc`, AES-256-GCM) and is NEVER returned or logged — responses
// carry only a masked tail. Pure slug/validation/mutation lives in
// services/custom-model.ts; this file is the DB + network shell.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireOrgRole } from '../middleware/rbac'
import { documentEndpoint } from '../services/openapi'
import { parseLlmChain } from '../services/arturita-pipeline'
import {
  validateCustomModel, applyCustomModel, removeCustomModel,
  resolveLlmCreds, hasStoredKey,
} from '../services/custom-model'

const CustomModelBody = z.object({
  label: z.string().optional(),
  provider: z.string().optional(),
  model: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  mode: z.enum(['local', 'provider']).optional(),
})

const TestBody = z.object({
  model: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  /** existing slug — test with the stored key when apiKey is omitted. */
  provider: z.string().optional(),
})

/** Reachability probe for an OpenAI-compatible endpoint. Tries GET /models, then
 *  a 1-token POST /chat/completions. Never logs the key. Returns a plain result. */
async function probeEndpoint(input: { baseUrl: string; apiKey?: string; model: string }, timeoutMs = 6000): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const base = input.baseUrl.replace(/\/$/, '')
  const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.apiKey) authHeaders.Authorization = `Bearer ${input.apiKey}`
  const withTimeout = async (fn: (signal: AbortSignal) => Promise<Response>): Promise<Response> => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try { return await fn(ctrl.signal) } finally { clearTimeout(t) }
  }
  // 1) GET /models — cheapest liveness + auth check.
  try {
    const res = await withTimeout(s => fetch(`${base}/models`, { headers: authHeaders, signal: s }))
    if (res.ok) return { ok: true, status: res.status, detail: 'reachable (GET /models)' }
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: 'authentication failed — check the API key' }
    // 404/405 → server may not expose /models; fall through to a chat probe.
  } catch (e: any) {
    if (e?.name !== 'AbortError') return { ok: false, status: null, detail: `unreachable — ${e?.message ?? 'network error'}` }
  }
  // 2) POST /chat/completions with a 1-token request.
  try {
    const res = await withTimeout(s => fetch(`${base}/chat/completions`, {
      method: 'POST', headers: authHeaders, signal: s,
      body: JSON.stringify({ model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }))
    if (res.ok) return { ok: true, status: res.status, detail: 'reachable (chat/completions)' }
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: 'authentication failed — check the API key' }
    if (res.status === 404) return { ok: false, status: res.status, detail: 'model or endpoint not found — check the base URL + model id' }
    return { ok: false, status: res.status, detail: `endpoint returned ${res.status}` }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, status: null, detail: `timed out after ${timeoutMs}ms` }
    return { ok: false, status: null, detail: `unreachable — ${e?.message ?? 'network error'}` }
  }
}

export async function arturitaCustomModelRoutes(app: FastifyInstance) {
  // Add / update a custom model → persists base URL (+ encrypted key) and upserts
  // the entry into the LLM chain.
  app.post('/api/orgs/:orgId/arturita/custom-model', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId } = req.params as any
    let b: z.infer<typeof CustomModelBody>
    try { b = CustomModelBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }

    const v = validateCustomModel(b)
    if (!v.ok || !v.entry || !v.slug) return reply.code(400).send({ error: v.errors.join('; '), errors: v.errors })

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })

    const { deployConfig, chain, maskedKey } = applyCustomModel({
      deployConfig: (org.deployConfig ?? {}) as Record<string, unknown>,
      slug: v.slug, entry: v.entry, apiKey: b.apiKey,
    })
    await db.update(schema.organisations).set({ deployConfig: deployConfig as any }).where(eq(schema.organisations.id, orgId))

    reply.code(201)
    // Never echo the key — masked tail only.
    return { ok: true, slug: v.slug, entry: v.entry, maskedKey, llm: chain }
  })

  // Reachability / auth self-test for a (possibly unsaved) endpoint. Uses the
  // inline apiKey if given, else the stored key for the slug.
  app.post('/api/orgs/:orgId/arturita/custom-model/test', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId } = req.params as any
    let b: z.infer<typeof TestBody>
    try { b = TestBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }

    let apiKey = b.apiKey
    if (!apiKey && b.provider) {
      const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })
      const creds = resolveLlmCreds((org?.deployConfig ?? {}) as Record<string, unknown>, b.provider)
      apiKey = creds.orgApiKey
    }
    const result = await probeEndpoint({ baseUrl: b.baseUrl, apiKey, model: b.model })
    return result // { ok, status, detail } — no key echoed
  })

  // Remove a custom model (chain entry + base URL + stored key).
  app.delete('/api/orgs/:orgId/arturita/custom-model/:provider', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, provider } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })
    const had = hasStoredKey((org.deployConfig ?? {}) as any, provider) ||
      parseLlmChain((org.deployConfig ?? {}) as any).some(e => e.provider === provider)
    const { deployConfig, chain } = removeCustomModel({ deployConfig: (org.deployConfig ?? {}) as Record<string, unknown>, slug: provider })
    await db.update(schema.organisations).set({ deployConfig: deployConfig as any }).where(eq(schema.organisations.id, orgId))
    return { ok: true, removed: had, llm: chain }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/arturita/custom-model', {
    summary: 'Add/update a custom OpenAI-compatible LLM for Arturita (key stored encrypted; slots into the LLM fallback chain)',
    tag: 'arturita', body: CustomModelBody,
  })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/custom-model/test', {
    summary: 'Reachability/auth self-test for a custom LLM endpoint (no key echoed)',
    tag: 'arturita', body: TestBody,
  })
  documentEndpoint('DELETE', '/api/orgs/:orgId/arturita/custom-model/:provider', {
    summary: 'Remove a custom LLM (chain entry + base URL + stored key)',
    tag: 'arturita',
  })
}
