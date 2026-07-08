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
import { parseFallbackChain } from '../services/llm-fallback'
import { estimateInputTokens, parseCapUsd } from '../services/preflight'

const ConverseBody = z.object({
  message: z.string(),
  /** the operator opted this turn into the agent flow (UI "delegate" toggle). */
  explicitDelegate: z.boolean().optional(),
  /** conversational continuity — the running task thread, if any. */
  existingThreadId: z.string().nullable().optional(),
  /** prior turns (role/content) so a direct answer has short-term memory. */
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(20).optional(),
})

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

    const provider = agent.llmProvider ?? 'anthropic'
    const model = agent.llmModel ?? 'claude-sonnet-4-20250514'
    const fbChain = parseFallbackChain(org?.deployConfig as any, agent.id)
    const chain = fbChain.length > 0 ? fbChain : [{ provider, model }]
    const capUsd = parseCapUsd(org?.deployConfig as any, agent.id)
    const inputTokens = estimateInputTokens([system, ...messages.map(m => m.content)])

    try {
      const fb = await streamLLMWithFallback({
        base: { system, messages, onToken: () => { /* buffered; the client reveals it */ } },
        chain,
        resolveCreds: (prov) => ({
          orgApiKey: (org?.deployConfig as any)?.[`${prov}_api_key`],
          baseURL: (org?.deployConfig as any)?.[`${prov}_base_url`],
        }),
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
        reply: { text: "I couldn't reach a language model just now — the provider chain is unavailable. Try again in a moment, or check the LLM config.", provider: 'text_only' },
        error: e?.message ?? 'llm unavailable',
      }
    }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/arturita/converse', {
    summary: 'Conversational front door — Arturita answers directly (F1 fallback chain) unless the operator explicitly delegates/builds (→ task/agent flow)',
    tag: 'arturita', body: ConverseBody,
  })
}
