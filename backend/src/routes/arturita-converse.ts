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

const ConverseBody = z.object({
  message: z.string(),
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
    if (!message) return reply.code(400).send({ error: 'message is required' })

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
      const ack = decision.destructive
        ? "Got it — I've put it on the board and I'll stop for your approval before anything irreversible."
        : "Got it — I've put it on the board for the office to run."
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
    const messages = [...history, { role: 'user' as const, content: message }]

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
  documentEndpoint('GET', '/api/orgs/:orgId/arturita/llm-status', {
    summary: 'Talk-path cloud-LLM reachability probe (real 1-token ping) — powers the Config self-test; catches stored-but-invalid keys',
    tag: 'arturita',
  })
}
