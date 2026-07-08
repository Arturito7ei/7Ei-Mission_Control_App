// Arturita J2 — the Jarvis pipeline config endpoint (Clerk-secured).
//
// Reads/writes the three free-first fallback chains (LLM · STT · TTS) that the
// Config panel edits, persisted in org.deployConfig under the PIPELINE_KEYS.
// Pure parse/validate/resolve lives in `arturita-pipeline.ts`; this route is the
// thin DB shell. No secrets in/out here — chains reference providers/engines by
// id; keys live in the encrypted secret store and are injected at call time.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { documentEndpoint } from '../services/openapi'
import {
  parseLlmChain, parseSttChain, parseTtsChain, validatePipelineConfig,
  PIPELINE_KEYS, DEFAULT_LLM_CHAIN, DEFAULT_STT_CHAIN, DEFAULT_TTS_CHAIN,
} from '../services/arturita-pipeline'

export async function arturitaPipelineRoutes(app: FastifyInstance) {
  // Current chains (configured or free-first defaults) + the defaults for the UI.
  app.get('/api/orgs/:orgId/arturita/pipeline', async (req, reply) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })
    const cfg = (org.deployConfig ?? {}) as Record<string, unknown>
    return {
      keys: PIPELINE_KEYS,
      llm: parseLlmChain(cfg),
      stt: parseSttChain(cfg),
      tts: parseTtsChain(cfg),
      defaults: { llm: DEFAULT_LLM_CHAIN, stt: DEFAULT_STT_CHAIN, tts: DEFAULT_TTS_CHAIN },
    }
  })

  // Save one or more layer chains (partial update; absent layers untouched).
  app.put('/api/orgs/:orgId/arturita/pipeline', async (req, reply) => {
    const { orgId } = req.params as any
    const v = validatePipelineConfig(req.body ?? {})
    if (!v.ok) return reply.code(400).send({ error: v.errors.join('; '), errors: v.errors })

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })
    const cfg = { ...((org.deployConfig ?? {}) as Record<string, unknown>) }
    if (v.value.llm) cfg[PIPELINE_KEYS.llm] = v.value.llm
    if (v.value.stt) cfg[PIPELINE_KEYS.stt] = v.value.stt
    if (v.value.tts) cfg[PIPELINE_KEYS.tts] = v.value.tts
    await db.update(schema.organisations).set({ deployConfig: cfg as any }).where(eq(schema.organisations.id, orgId))

    return { saved: true, llm: parseLlmChain(cfg), stt: parseSttChain(cfg), tts: parseTtsChain(cfg) }
  })

  documentEndpoint('GET', '/api/orgs/:orgId/arturita/pipeline', {
    summary: 'Arturita free-first pipeline chains (LLM/STT/TTS) — configured or free-first defaults',
    tag: 'arturita',
  })
  documentEndpoint('PUT', '/api/orgs/:orgId/arturita/pipeline', {
    summary: 'Set Arturita pipeline chains (partial: any of arturita_llm_chain/stt_chain/tts_chain)',
    tag: 'arturita',
  })
}
