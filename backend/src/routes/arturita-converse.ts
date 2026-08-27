// Arturita J1 — the /converse endpoint (Clerk-secured). The Jarvis front door.
//
// By DEFAULT Arturita answers the operator directly herself — a single
// conversational LLM turn through the F1 fallback chain (llm-fallback-runtime).
// She only routes a request into the task/agent-swarm flow when the operator
// EXPLICITLY asks her to build/do/delegate, or when the intent is destructive
// (which must go through the task + A2 approval gate). That decision is the pure
// `decideConverseMode` (arturita-converse.ts); this route applies it.
//
// Nothing dangerous runs here: `answer` mode takes no actions (no file/send/sign/
// delegate); `delegate` mode creates a `pending` task exactly like the voice
// endpoint (destructive intents route to execute-mode → the A2 approval gate).
// The reply is a conversational answer or a short acknowledgement — never a
// destructive side-effect.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { documentEndpoint } from '../services/openapi'
import {
  parseLlmChain, usableLlmChain, usableServerLlmChain, usableCloudProviders,
  serverOllamaBaseUrl, serverOllamaEnabled,
} from '../services/arturita-pipeline'
import { resolveLlmCreds, keyAvailableFor } from '../services/custom-model'
import { estimateInputTokens, parseCapUsd } from '../services/preflight'
import { extractText } from '../services/document-ingest'
import {
  checkAttachment, clipAttachmentText,
  MAX_ATTACHMENT_BYTES, SUPPORTED_ATTACHMENT_EXTS,
} from '../services/converse-attachments'
import {
  formatImageBytes,
  MAX_IMAGE_BYTES, SUPPORTED_IMAGE_EXTS,
} from '../services/converse-images'
import {
  loadThread, targetAgentKey,
  getOrgJiraProjectKey, setOrgJiraProjectKey, parseJiraProjectKey,
} from '../services/command-center-thread'
import { getJiraCfg, jiraAuth, jiraBase } from './jira'
import { streamLLMWithFallback } from '../services/llm-fallback-runtime'
import {
  ConverseBody,
  ConverseTurnError,
  NO_LLM_MESSAGE,
  ensureArturita,
  runArturitaConverseTurn,
} from '../services/arturita-converse-turn'
import { assertAgentInOrg } from '../services/tenant-guard'

export { NO_LLM_MESSAGE }

const ProjectBody = z.object({
  projectKey: z.string().nullable().optional(),
})

type JiraProjectKeysResult = { ok: boolean; keys: string[]; error?: string }

async function listJiraProjectKeys(orgId: string): Promise<JiraProjectKeysResult> {
  const cfg = await getJiraCfg(orgId)
  if (!cfg) return { ok: true, keys: [] }
  const res = await fetch(`${jiraBase(cfg.domain)}/project/search?maxResults=50`, {
    headers: { Authorization: jiraAuth(cfg.email, cfg.apiToken), Accept: 'application/json' },
  })
  if (!res.ok) return { ok: false, keys: [], error: 'Jira API error' }
  const data = await res.json() as any
  return { ok: true, keys: (data.values ?? []).map((p: any) => String(p.key)).filter(Boolean) }
}

// MOB-7b: base64 inflates by 4/3, so a 3.75 MB photo is a 5 MB field — far past
// Fastify's 1 MB default body limit, which would reject an image turn with a
// bare 413 and no usable message. Lifted for THIS route only (the rest of the
// API keeps the tight default), with headroom for the message + history that
// ride alongside. The real image ceiling stays MAX_IMAGE_BYTES, enforced with a
// clean message below; this is only the transport's outer bound.
const CONVERSE_BODY_LIMIT = 8 * 1024 * 1024

export async function arturitaConverseRoutes(app: FastifyInstance) {
  // GC-2 — load persisted Command Center thread (survives refresh).
  app.get('/api/orgs/:orgId/arturita/thread', async (req, reply) => {
    const { orgId } = req.params as any
    const q = (req.query ?? {}) as any
    const agent = await ensureArturita(orgId)
    const requested = q.agentId ? String(q.agentId) : null
    if (requested && requested !== agent.id) {
      const err = await assertAgentInOrg(requested, orgId)
      if (err) return reply.code(404).send({ error: 'Not found' })
    }
    const key = targetAgentKey(requested, agent.id)
    const loaded = await loadThread(orgId, key)
    const jiraProjectKey = await getOrgJiraProjectKey(orgId)
    return {
      viewer: (req as any).auth?.userId ?? (req as any).userId ?? null,
      targetAgentKey: key,
      taskThreadId: loaded.taskThreadId,
      jiraProjectKey,
      turns: loaded.turns,
    }
  })

  // GC-3 — persist the org's Jira project selection in the GC-2 store (no second table).
  app.put('/api/orgs/:orgId/arturita/project', async (req, reply) => {
    const { orgId } = req.params as any
    let body: z.infer<typeof ProjectBody>
    try { body = ProjectBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }
    let projectKey: string | null
    try { projectKey = parseJiraProjectKey(body.projectKey) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid project key' }) }
    if (projectKey) {
      const cfg = await getJiraCfg(orgId)
      if (!cfg) return reply.code(400).send({ error: 'Jira not connected' })
      const listed = await listJiraProjectKeys(orgId)
      if (!listed.ok) return reply.code(502).send({ error: listed.error ?? 'Jira API error' })
      if (listed.keys.length && !listed.keys.includes(projectKey)) {
        return reply.code(400).send({ error: 'Unknown Jira project key for this org' })
      }
    }
    await setOrgJiraProjectKey(orgId, projectKey)
    return { jiraProjectKey: projectKey }
  })

  app.post('/api/orgs/:orgId/arturita/converse', { bodyLimit: CONVERSE_BODY_LIMIT }, async (req, reply) => {
    const { orgId } = req.params as any
    let b: z.infer<typeof ConverseBody>
    try { b = ConverseBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }
    const authorUser = (req as any).auth?.userId ?? (req as any).userId ?? null
    try {
      return await runArturitaConverseTurn({ orgId, authorUser, body: b })
    } catch (e: any) {
      if (e instanceof ConverseTurnError) {
        return reply.code(e.statusCode).send({ error: e.message, ...(e.extra ?? {}) })
      }
      throw e
    }
  })

  // ── CC-ATT: attachment text extraction ──────────────────────────────────────
  // The operator attaches a document to a Command Center turn. This endpoint is
  // the ONLY thing that touches the file: it extracts plain text with the SAME
  // parser the knowledge ingest-file route uses (`extractText` → officeparser)
  // and hands the text straight back. The document is NEVER written to the DB,
  // never embedded, and never logged — the buffer is garbage after the reply.
  // The client then sends that text back on the next /converse turn as
  // `attachment`, which keeps the JSON converse contract (and the deferAnswer /
  // local-Ollama path) intact. That round-trip grants the client no new power:
  // it could already put arbitrary text in `message`.
  //
  // Auth + tenancy come from the enclosing `secured` scope (Clerk onRequest +
  // requireOrgMembership preHandler on the `:orgId` path) — identical to
  // /converse itself. Every failure is clean JSON; none is a 500 with a stack.
  app.post('/api/orgs/:orgId/arturita/attachments/extract', async (req, reply) => {
    let data: any
    try {
      data = await (req as any).file?.({ limits: { fileSize: MAX_ATTACHMENT_BYTES } })
    } catch {
      return reply.code(400).send({ error: 'Attach the document as a multipart file upload.' })
    }
    if (!data) return reply.code(400).send({ error: 'No file attached.' })

    const filename: string = data.filename ?? ''
    // Gate on type BEFORE reading the body — no point buffering 10 MB of a file
    // the parser can't read anyway.
    const typeCheck = checkAttachment({ filename, size: 1 })
    if (typeCheck) return reply.code(415).send({ error: typeCheck.error, code: typeCheck.code })

    let buffer: Buffer
    try {
      buffer = await data.toBuffer()
    } catch (err: any) {
      // @fastify/multipart aborts the stream past `limits.fileSize`.
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || /file too large/i.test(String(err?.message))) {
        return reply.code(413).send({
          error: `That file is over the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB limit.`,
          code: 'too_large',
        })
      }
      return reply.code(400).send({ error: 'Could not read the uploaded file.', code: 'unreadable' })
    }

    const sizeCheck = checkAttachment({ filename, size: buffer.byteLength })
    if (sizeCheck) {
      const status = sizeCheck.code === 'too_large' ? 413 : sizeCheck.code === 'empty' ? 422 : 415
      return reply.code(status).send({ error: sizeCheck.error, code: sizeCheck.code })
    }

    let raw: string
    try {
      raw = await extractText(buffer, filename)
    } catch (err) {
      // Log the FAILURE, never the document. `err` from officeparser can carry
      // file content in its message, so only the name/size go to the log.
      req.log.warn({ filename, bytes: buffer.byteLength }, 'converse attachment extraction failed')
      return reply.code(422).send({
        error: `I couldn't read “${filename}” — it may be corrupt, password-protected, or a scanned image with no text layer.`,
        code: 'unreadable',
      })
    }
    if (!raw || !raw.trim()) {
      return reply.code(422).send({
        error: `I couldn't find any text in “${filename}”. If it's a scan, it needs OCR first.`,
        code: 'empty',
      })
    }

    const { text, truncated } = clipAttachmentText(raw)
    return {
      attachment: { name: filename, text, truncated },
      bytes: buffer.byteLength,
      chars: raw.length,
      truncated,
    }
  })

  // ── Talk-path LLM reachability probe (for the Config self-test) ─────────────
  // Two real 1-token pings:
  //   • answerUsable — the FULL server chain `deferAnswer:false` /converse uses
  //     (S3-B: co-located Fly Ollama before cloud/guarantee hops);
  //   • cloudUsable — cloud-only (browser-local Ollama is probed separately).
  // Read-only, operator-initiated.
  app.get('/api/orgs/:orgId/arturita/llm-status', async (req, reply) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })
    const agent = await ensureArturita(orgId)
    const deployCfg = (org.deployConfig ?? {}) as Record<string, any>
    const keyAvailable = keyAvailableFor(deployCfg)
    const provider = agent.llmProvider ?? 'anthropic'
    const model = agent.llmModel ?? 'claude-sonnet-4-20250514'
    const configuredProviders = usableCloudProviders(parseLlmChain(deployCfg), keyAvailable)
    const resolveProbeCreds = (prov: string) => {
      const creds = resolveLlmCreds(deployCfg, prov)
      if (prov === 'ollama' && !creds.baseURL) return { ...creds, baseURL: serverOllamaBaseUrl() }
      return creds
    }
    const capUsd = parseCapUsd(org.deployConfig as any, agent.id)
    const pingBase = { system: 'Reply with the single word: ok', messages: [{ role: 'user' as const, content: 'ping' }], onToken: () => {} }
    const pingTokens = estimateInputTokens(['ping'])

    // Primary — same chain as server-side /converse (incl. hosted Ollama).
    const answerChain = usableServerLlmChain({
      entries: parseLlmChain(deployCfg),
      keyAvailable,
      guaranteed: { provider, model },
      serverOllama: serverOllamaEnabled(),
    })
    let answerUsable = false
    let answerDetail = answerChain.length === 0
      ? 'No LLM hop is configured for the hosted answer path.'
      : 'Hosted answer path not probed.'
    let answerProvider: string | null = null
    let answerModel: string | null = null
    if (answerChain.length > 0) {
      try {
        const fb = await streamLLMWithFallback({
          base: pingBase,
          chain: answerChain,
          resolveCreds: resolveProbeCreds,
          inputTokens: pingTokens,
          capUsd,
        })
        answerUsable = true
        answerProvider = fb.used.provider
        answerModel = fb.used.model
        answerDetail = fb.used.provider === 'ollama'
          ? `Hosted Ollama reachable via ${fb.used.provider} (${fb.used.model}) on the backend.`
          : `Answer path reachable via ${fb.used.provider} (${fb.used.model}).`
      } catch (e: any) {
        const raw = String(e?.message ?? 'provider chain unavailable')
        answerDetail = /invalid|x-api-key|401|403|authentication/i.test(raw)
          ? `Hosted answer chain failed — a configured key was rejected. Hops tried: ${answerChain.map(c => c.provider).join(', ')}.`
          : `Hosted answer chain unreachable: ${raw.slice(0, 160)}`
      }
    }

    // Secondary — cloud-only (legacy self-test leg; browser probes local Ollama).
    const cloudEntries = parseLlmChain(deployCfg).filter(e => e.mode !== 'local' && e.provider !== 'ollama')
    const cloudChain = usableLlmChain({ entries: cloudEntries, keyAvailable, guaranteed: { provider, model } })
    if (cloudChain.length === 0) {
      return {
        answerUsable, answerDetail, answerProvider, answerModel,
        cloudUsable: false, configuredProviders, checked: answerChain.length > 0,
        detail: 'No cloud LLM provider with a key is configured.',
      }
    }
    try {
      const fb = await streamLLMWithFallback({
        base: pingBase,
        chain: cloudChain,
        resolveCreds: (prov) => resolveLlmCreds(deployCfg, prov),
        inputTokens: pingTokens,
        capUsd,
      })
      return {
        answerUsable, answerDetail, answerProvider, answerModel,
        cloudUsable: true, checked: true, provider: fb.used.provider, model: fb.used.model,
        configuredProviders, detail: `Cloud LLM reachable via ${fb.used.provider} (${fb.used.model}).`,
      }
    } catch (e: any) {
      const raw = String(e?.message ?? 'provider chain unavailable')
      const detail = /invalid|x-api-key|401|403|authentication/i.test(raw)
        ? `A configured cloud key was rejected (invalid or expired). Providers tried: ${cloudChain.map(c => c.provider).join(', ')}.`
        : `Cloud LLM unreachable: ${raw.slice(0, 160)}`
      return {
        answerUsable, answerDetail, answerProvider, answerModel,
        cloudUsable: false, checked: true, configuredProviders, detail,
      }
    }
  })

  documentEndpoint('GET', '/api/orgs/:orgId/arturita/thread', {
    summary: 'Load persisted Command Center thread (GC-2) and org Jira project (GC-3)',
    tag: 'arturita',
  })
  documentEndpoint('PUT', '/api/orgs/:orgId/arturita/project', {
    summary: 'Persist Command Center Jira project selection (GC-3)',
    tag: 'arturita', body: ProjectBody,
  })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/converse', {
    summary: 'Conversational front door — Arturita answers directly (F1 fallback chain) unless the operator explicitly delegates/builds (→ task/agent flow). '
      + `Optionally carries a document (\`attachment\`, text extracted via /attachments/extract) or a photo (\`image\`, raw base64; ${SUPPORTED_IMAGE_EXTS.join('/')}; ≤${formatImageBytes(MAX_IMAGE_BYTES)}) `
      + 'which is passed to the model as a real image block. An image turn runs only on vision-capable hops; if none are configured the reply says so. Neither is stored.',
    tag: 'arturita', body: ConverseBody,
  })
  documentEndpoint('POST', '/api/orgs/:orgId/arturita/attachments/extract', {
    summary: `Extract plain text from a document attached to a Command Center turn (multipart file; ${SUPPORTED_ATTACHMENT_EXTS.join('/')}; ≤${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB). Nothing is stored — the text is returned for the next /converse turn's \`attachment\`.`,
    tag: 'arturita',
  })
  documentEndpoint('GET', '/api/orgs/:orgId/arturita/llm-status', {
    summary: 'Talk-path cloud-LLM reachability probe (real 1-token ping) — powers the Config self-test; catches stored-but-invalid keys',
    tag: 'arturita',
  })
}
