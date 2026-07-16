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
import { eq, and, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { documentEndpoint } from '../services/openapi'
import { buildArturitaAgent } from '../services/arturita-session'
import { decideConverseMode, buildConverseSystemPrompt } from '../services/arturita-converse'
import { routeVoiceCommand } from '../services/voice-routing'
import { streamLLMWithFallback } from '../services/llm-fallback-runtime'
import { parseLlmChain, usableLlmChain, usableCloudProviders } from '../services/arturita-pipeline'
import { resolveLlmCreds, keyAvailableFor } from '../services/custom-model'
import { estimateInputTokens, parseCapUsd } from '../services/preflight'
import { extractText } from '../services/document-ingest'
import {
  checkAttachment, clipAttachmentText, withAttachmentContext,
  MAX_ATTACHMENT_BYTES, SUPPORTED_ATTACHMENT_EXTS,
} from '../services/converse-attachments'

const ConverseBody = z.object({
  message: z.string(),
  /** CC-ATT: a document the operator attached to this turn. `text` is the
   *  extracted plain text from POST /arturita/attachments/extract — the doc
   *  itself is never uploaded here and never stored. */
  attachment: z.object({
    name: z.string().min(1).max(300),
    text: z.string(),
    truncated: z.boolean().optional(),
  }).nullable().optional(),
  /** the operator opted this turn into the agent flow (UI "delegate" toggle). */
  explicitDelegate: z.boolean().optional(),
  /** conversational continuity — the running task thread, if any. */
  existingThreadId: z.string().nullable().optional(),
  /** prior turns (role/content) so a direct answer has short-term memory. */
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(20).optional(),
  /** J-prod: the client can stream the answer itself from a local engine (e.g.
   *  browser→Ollama). When set + the turn is an ANSWER, the endpoint returns the
   *  built prompt (system + messages) INSTEAD of calling the LLM, so the client
   *  streams tokens locally. Delegation still runs server-side. */
  deferAnswer: z.boolean().optional(),
})

// Shown when no language model can answer — deliberately actionable (names the
// two operator fixes) instead of a vague "network error"/"check config".
export const NO_LLM_MESSAGE =
  "I can't reach any language model right now, so I can't answer this turn. " +
  "Two ways to fix it: run local Ollama on the machine you're talking to me from " +
  "(Ollama started + `OLLAMA_ORIGINS=https://app.7ei.ai`, then restart Ollama), " +
  "or add a working cloud key (a free Groq or Gemini key works) in ⚙ Pipeline config below."

async function ensureArturita(orgId: string): Promise<typeof schema.agents.$inferSelect> {
  const existing = await db.query.agents.findFirst({
    where: and(eq(schema.agents.orgId, orgId), eq(schema.agents.agentType, 'arturita')),
  })
  if (existing) return existing
  const agent = buildArturitaAgent(orgId, randomUUID(), new Date())
  await db.insert(schema.agents).values(agent as any)
  return (await db.query.agents.findFirst({ where: eq(schema.agents.id, agent.id) }))!
}

// Lightweight system-awareness block (context/knows-current-state — a Jarvis
// trait). Kept cheap: two counts, no heavy joins. Never blocks the reply.
async function buildContextBlock(orgId: string): Promise<string | null> {
  try {
    const agents = await db.select({ status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const openTasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
      .where(and(eq(schema.tasks.orgId, orgId), inArray(schema.tasks.status, ['pending', 'in_progress'])))
    const active = agents.filter(a => a.status === 'active').length
    return [
      '=== LIVE SYSTEM AWARENESS (read-only, for grounding your answer) ===',
      `Agent fleet: ${agents.length} agent(s), ${active} active.`,
      `Open work: ${openTasks.length} task(s) pending or in progress.`,
      '=== END SYSTEM AWARENESS ===',
    ].join('\n')
  } catch { return null }
}

export async function arturitaConverseRoutes(app: FastifyInstance) {
  app.post('/api/orgs/:orgId/arturita/converse', async (req, reply) => {
    const { orgId } = req.params as any
    let b: z.infer<typeof ConverseBody>
    try { b = ConverseBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }

    const message = String(b.message ?? '').trim()
    // An attachment alone is a legitimate turn ("read this") — but there must be
    // SOMETHING to act on.
    if (!message && !b.attachment) return reply.code(400).send({ error: 'message is required' })

    // Re-clip server-side: the client already clips, but it is not the enforcer.
    const attachment = b.attachment
      ? (() => {
          const { text, truncated } = clipAttachmentText(b.attachment.text)
          return { name: b.attachment.name, text, truncated: truncated || !!b.attachment.truncated }
        })()
      : null

    // Routing decides on the OPERATOR's words only — never the document's. A doc
    // that happens to contain "delete the production database" must not be able
    // to route the turn into execute-mode; the operator's intent is the only
    // input to that decision.
    const decision = decideConverseMode({ transcript: message, explicitDelegate: b.explicitDelegate })
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    const agent = await ensureArturita(orgId)

    // ── Delegate: route into the existing task/agent flow (ask vs execute) ──────
    if (decision.mode === 'delegate') {
      const route = routeVoiceCommand({ transcript: message, existingThreadId: b.existingThreadId ?? null })
      const taskId = randomUUID()
      await db.insert(schema.tasks).values({
        id: taskId, agentId: agent.id, orgId,
        title: message.slice(0, 120),
        input: message,
        status: 'pending',
        workMode: route.workMode,
        inboxState: 'none',
        parentTaskId: route.isFollowUp ? (b.existingThreadId ?? null) : null,
        createdAt: new Date(),
      } as any)
      let ack = decision.destructive
        ? "Got it — I've put it on the board and I'll stop for your approval before anything irreversible."
        : "Got it — I've put it on the board for the office to run."
      // Delegated tasks are executed later by an agent, so an attachment held only
      // for this turn cannot travel with them (persisting it is a separate story).
      // Say so rather than letting the operator believe the doc went with the task.
      if (attachment) ack += ` Note: “${attachment.name}” stays with this conversation — I didn't attach it to the task, so mention anything from it the office will need.`
      return {
        mode: 'delegate',
        routing: { trigger: decision.trigger, reason: decision.reason, workMode: route.workMode, destructive: decision.destructive, approvalType: decision.approvalType ?? null, isFollowUp: route.isFollowUp },
        taskId,
        reply: { text: ack, provider: 'arturita' },
      }
    }

    // ── Answer: one conversational LLM turn via the F1 fallback chain ───────────
    const contextBlock = await buildContextBlock(orgId)
    const system = buildConverseSystemPrompt({
      agentName: agent.name, orgName: org?.name ?? null,
      orgMission: org?.mission ?? null, orgCulture: org?.culture ?? null,
      persona: agent.persona ?? null, personality: agent.personality ?? null,
      contextBlock,
    })
    const history = (b.history ?? []).map(h => ({ role: h.role, content: h.content }))
    // The attached document rides on THIS turn only — delimited, after the
    // operator's question. It is never added to `history`, so it doesn't re-enter
    // the prompt (and re-bill) on every later turn of the thread.
    const userContent = withAttachmentContext(message || 'Please read the attached document.', attachment)
    const messages = [...history, { role: 'user' as const, content: userContent }]

    // J-prod: hand the built prompt back so the client streams tokens locally
    // (browser→Ollama). No LLM call here, no secrets in the payload.
    if (b.deferAnswer) {
      return {
        mode: 'answer',
        deferred: true,
        routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
        prompt: { system, messages },
      }
    }

    const provider = agent.llmProvider ?? 'anthropic'
    const model = agent.llmModel ?? 'claude-sonnet-4-20250514'
    // J2 — free-first LLM chain (Ollama-local first, free-tier cloud, …), pruned
    // to usable hops with the agent's own model guaranteed as the last resort so
    // the live path never breaks when local Ollama / free-tier keys are absent.
    const deployCfg = (org?.deployConfig ?? {}) as Record<string, any>
    const keyAvailable = keyAvailableFor(deployCfg)  // shared with GET /arturita/llm-status
    const chain = usableLlmChain({
      entries: parseLlmChain(deployCfg),
      keyAvailable,
      guaranteed: { provider, model },
    })
    const capUsd = parseCapUsd(org?.deployConfig as any, agent.id)
    const inputTokens = estimateInputTokens([system, ...messages.map(m => m.content)])

    try {
      const fb = await streamLLMWithFallback({
        base: { system, messages, onToken: () => { /* buffered; the client reveals it */ } },
        chain,
        // Handles plaintext AND encrypted (custom-model) keys + per-provider base URL.
        resolveCreds: (prov) => resolveLlmCreds(deployCfg, prov),
        inputTokens,
        capUsd,
      })
      return {
        mode: 'answer',
        routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
        reply: { text: fb.result.output, provider: fb.used.provider, model: fb.used.model },
      }
    } catch (e: any) {
      // Failover exhausted / no key configured → honest, non-fatal reply.
      return {
        mode: 'answer',
        routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
        degraded: true,
        reply: { text: NO_LLM_MESSAGE, provider: 'text_only' },
        error: e?.message ?? 'llm unavailable',
      }
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
  // Answers the honest question the reachability-of-`/pipeline` check can't: can
  // the CLOUD fallback actually produce a token? It runs a tiny real completion
  // through the usable cloud chain, so a stored-but-INVALID key (e.g. an expired
  // Anthropic key) is reported as unusable — not a false ✓. Local Ollama is NOT
  // probed here (it lives on the operator's machine; the browser probes that
  // directly). Read-only, operator-initiated; capped to a 1-token ping.
  app.get('/api/orgs/:orgId/arturita/llm-status', async (req, reply) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Organisation not found' })
    const agent = await ensureArturita(orgId)
    const deployCfg = (org.deployConfig ?? {}) as Record<string, any>
    const keyAvailable = keyAvailableFor(deployCfg)
    const provider = agent.llmProvider ?? 'anthropic'
    const model = agent.llmModel ?? 'claude-sonnet-4-20250514'
    // Cloud-only chain: drop local/ollama hops; keep the guaranteed hop (backend
    // env key) so a working env key still counts even without an org key.
    const cloudEntries = parseLlmChain(deployCfg).filter(e => e.mode !== 'local' && e.provider !== 'ollama')
    const chain = usableLlmChain({ entries: cloudEntries, keyAvailable, guaranteed: { provider, model } })
    const configuredProviders = usableCloudProviders(parseLlmChain(deployCfg), keyAvailable)

    if (chain.length === 0) {
      return { cloudUsable: false, configuredProviders, checked: false, detail: 'No cloud LLM provider with a key is configured.' }
    }
    try {
      const fb = await streamLLMWithFallback({
        base: { system: 'Reply with the single word: ok', messages: [{ role: 'user', content: 'ping' }], onToken: () => {} },
        chain,
        resolveCreds: (prov) => resolveLlmCreds(deployCfg, prov),
        inputTokens: estimateInputTokens(['ping']),
        capUsd: parseCapUsd(org.deployConfig as any, agent.id),
      })
      return { cloudUsable: true, checked: true, provider: fb.used.provider, model: fb.used.model, configuredProviders, detail: `Cloud LLM reachable via ${fb.used.provider} (${fb.used.model}).` }
    } catch (e: any) {
      const raw = String(e?.message ?? 'provider chain unavailable')
      // Surface the common cause plainly without leaking the key/full payload.
      const detail = /invalid|x-api-key|401|403|authentication/i.test(raw)
        ? `A configured cloud key was rejected (invalid or expired). Providers tried: ${chain.map(c => c.provider).join(', ')}.`
        : `Cloud LLM unreachable: ${raw.slice(0, 160)}`
      return { cloudUsable: false, checked: true, configuredProviders, detail }
    }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/arturita/converse', {
    summary: 'Conversational front door — Arturita answers directly (F1 fallback chain) unless the operator explicitly delegates/builds (→ task/agent flow)',
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
