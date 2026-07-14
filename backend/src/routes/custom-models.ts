// Epic AG — custom adapters/models for AGENTS: an operator-defined, OpenAI-
// compatible endpoint (NVIDIA NIM, Together, vLLM, a local server, or any
// OpenAI-standard provider) that an agent can be pointed at from its
// Configuration tab and that its runs actually use.
//
// This is the SAME machinery as Arturita's custom model (#207) — the validation,
// slugging, AES-256-GCM key storage, credential resolution and reachability probe
// all come from services/custom-model.ts. The only thing that differs is WHERE
// the entry is registered: `custom_models`, not `arturita_llm_chain`. That chain
// is Arturita's ordered FAILOVER list, and defining a model for some other agent
// must not silently change what Arturita falls back to. Both lists are surfaced
// by GET /available-models, so a model added at either door is selectable at both.
//
// Secrets: the API key is stored ENCRYPTED and is never returned or logged —
// responses carry a masked tail and a `hasKey` flag, nothing more.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { requireOrgRole } from '../middleware/rbac'
import { documentEndpoint } from '../services/openapi'
import {
  CATALOG_KEY, applyCustomModel, encKeyKey, hasStoredKey, parseCustomModels, probeEndpoint,
  removeCustomModel, resolveLlmCreds, validateCustomModel,
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
  /** existing slug — probe with the STORED key when apiKey is omitted. */
  provider: z.string().optional(),
})

const cfgOf = async (orgId: string) =>
  db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })

/** The catalog as the UI sees it: never the key, only whether one is stored. */
const view = (cfg: Record<string, unknown>) =>
  parseCustomModels(cfg).map(e => ({ ...e, hasKey: hasStoredKey(cfg, e.provider) }))

export async function customModelRoutes(app: FastifyInstance) {
  // List. Member-visible: it is a catalogue of endpoints, and carries no secrets.
  app.get('/api/orgs/:orgId/custom-models', async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    const org = await cfgOf(orgId)
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })
    return { models: view((org.deployConfig ?? {}) as Record<string, unknown>) }
  })

  // Add or update. Owner-gated — this stores a credential and changes what the
  // agents pointed at it will call.
  app.post('/api/orgs/:orgId/custom-models', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    let b: z.infer<typeof CustomModelBody>
    try { b = CustomModelBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }

    const v = validateCustomModel(b)
    if (!v.ok || !v.entry || !v.slug) return reply.code(400).send({ error: v.errors.join('; '), errors: v.errors })

    const org = await cfgOf(orgId)
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })

    const before = (org.deployConfig ?? {}) as Record<string, unknown>

    // Key semantics, because "blank" is ambiguous and getting it wrong either
    // wipes a working credential or makes one impossible to clear:
    //   apiKey omitted   → KEEP whatever is stored (the edit dialog leaves the
    //                      field blank because the key can never be shown again)
    //   apiKey: ''       → explicitly CLEAR the stored key (a keyless endpoint)
    //   apiKey: '…'      → replace it
    const clearing = b.apiKey === ''
    const keeping = b.apiKey === undefined && hasStoredKey(before, v.slug)

    const { deployConfig, maskedKey } = applyCustomModel({
      deployConfig: before, slug: v.slug, entry: v.entry,
      apiKey: clearing ? '' : b.apiKey, catalogKey: CATALOG_KEY,
    })
    // applyCustomModel drops the key when none is supplied — carry the stored
    // (still-encrypted) blob forward when the operator simply didn't retype it.
    if (keeping) deployConfig[encKeyKey(v.slug)] = before[encKeyKey(v.slug)]

    await db.update(schema.organisations).set({ deployConfig: deployConfig as any }).where(eq(schema.organisations.id, orgId))
    await snapshot(orgId, v.slug, before, deployConfig, req)

    reply.code(201)
    return {
      ok: true, slug: v.slug, entry: v.entry,
      maskedKey, hasKey: hasStoredKey(deployConfig, v.slug),
      models: view(deployConfig),
    }
  })

  // Reachability + auth probe for a (possibly unsaved) endpoint — the form's
  // "Test connection". Uses the typed key if given, else the stored one.
  app.post('/api/orgs/:orgId/custom-models/test', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    let b: z.infer<typeof TestBody>
    try { b = TestBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }

    let apiKey = b.apiKey
    if (!apiKey && b.provider) {
      const org = await cfgOf(orgId)
      apiKey = resolveLlmCreds((org?.deployConfig ?? {}) as Record<string, unknown>, b.provider).orgApiKey
    }
    return probeEndpoint({ baseUrl: b.baseUrl, apiKey, model: b.model })  // no key echoed
  })

  // Remove: catalogue entry + base URL + stored key. Agents still pointed at the
  // slug are reported, so the operator learns before they discover it at runtime.
  app.delete('/api/orgs/:orgId/custom-models/:provider', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, provider } = req.params as { orgId: string; provider: string }
    const org = await cfgOf(orgId)
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })

    const before = (org.deployConfig ?? {}) as Record<string, unknown>
    const had = parseCustomModels(before).some(e => e.provider === provider) || hasStoredKey(before, provider)
    const { deployConfig } = removeCustomModel({ deployConfig: before, slug: provider, catalogKey: CATALOG_KEY })
    await db.update(schema.organisations).set({ deployConfig: deployConfig as any }).where(eq(schema.organisations.id, orgId))
    await snapshot(orgId, provider, before, deployConfig, req)

    const stranded = (await db.select({ id: schema.agents.id, name: schema.agents.name, llmProvider: schema.agents.llmProvider })
      .from(schema.agents).where(eq(schema.agents.orgId, orgId)))
      .filter(a => a.llmProvider === provider)
      .map(({ id, name }) => ({ id, name }))

    return { ok: true, removed: had, models: view(deployConfig), stranded }
  })

  documentEndpoint('GET', '/api/orgs/:orgId/custom-models', {
    summary: 'List operator-defined custom adapters/models (no key material)', tag: 'agents',
  })
  documentEndpoint('POST', '/api/orgs/:orgId/custom-models', {
    summary: 'Add/update a custom OpenAI-compatible adapter for agents (key stored AES-256-GCM encrypted, never returned)',
    tag: 'agents', body: CustomModelBody,
  })
  documentEndpoint('POST', '/api/orgs/:orgId/custom-models/test', {
    summary: 'Reachability/auth probe for a custom endpoint (no key echoed)', tag: 'agents', body: TestBody,
  })
  documentEndpoint('DELETE', '/api/orgs/:orgId/custom-models/:provider', {
    summary: 'Remove a custom adapter (entry + base URL + stored key)', tag: 'agents',
  })
}

/** Config-revision snapshot, with key material scrubbed — a revision is an audit
 *  record, not a second place the credential lives. */
async function snapshot(orgId: string, slug: string, before: unknown, after: unknown, req: unknown) {
  return db.insert(schema.configRevisions).values({
    id: randomUUID(), orgId, entity: 'custom-model', entityId: slug,
    before: JSON.stringify(scrub(before)), after: JSON.stringify(scrub(after)),
    actor: (req as { userId?: string }).userId ?? 'human', createdAt: new Date(),
  }).catch(() => {})
}

/** Drop every stored credential from a deployConfig before it is written to an
 *  audit row. Encrypted or not, a key does not belong in a revision snapshot. */
export function scrub(cfg: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries((cfg ?? {}) as Record<string, unknown>)) {
    if (k.endsWith('_api_key') || k.endsWith('_api_key_enc')) continue
    out[k] = v
  }
  return out
}
