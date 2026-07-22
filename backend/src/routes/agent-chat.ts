// ─── MCC-1 — chat with an agent, replies included ────────────────────────────
//
// The thread IS the `messages` table (role user/assistant per agent) — no new
// store. Sending rides the existing task machinery: an INTERNAL agent answers
// synchronously through executeAgentTask (the legacy /api/agents/:agentId/chat
// pattern), and an EXTERNAL agent gets the message as an assigned task its poll
// loop claims — its POST /api/agent/tasks/:taskId/result already inserts the
// assistant reply into this same thread, so the UI only has to poll the GET.
//
// Tenancy: both routes are org-scoped and re-assert the agent belongs to the org
// via agentInOrg() (the AAD-1 pattern), 404 on wrong-org / unknown / soft-deleted
// — indistinguishable, no existence oracle. The legacy top-level
// GET /api/agents/:agentId/messages predates this and stays for compat; these are
// the blessed paths.
import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { agentInOrg } from './agent-detail'
import { executeAgentTask } from '../services/agent-executor'
import { isExternalAgent } from '../services/agent-runtime'

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 100
const MAX_CONTENT_CHARS = 8000
// How much prior thread the internal executor replays as context. Server-built:
// the legacy /chat trusted a client-supplied history array, which let the caller
// put words in the assistant's mouth; reading it back from the DB does not.
const HISTORY_ROWS = 40

export async function agentChatRoutes(app: FastifyInstance) {
  // ── Read the thread ──────────────────────────────────────────────────────
  // Newest-N returned in ascending render order. An ascending LIMIT N without
  // the desc-then-reverse would return the OLDEST N — wrong window.
  //
  // ORDERING (audit MCC-1 #1): `createdAt` is stored at SECOND precision
  // (drizzle integer timestamp), and message ids are random UUIDs — so id is
  // NOT a usable tie-break. `rowid` is: it is SQLite's monotonic insertion
  // order, and every writer of this thread (chat POST below, the agent /result
  // handler) inserts the question before its answer. Same-second pairs
  // therefore render in true order, deterministically.
  //
  // `since` (ms epoch) is a cheap-poll window, GTE at second granularity: the
  // boundary second is RE-delivered rather than newer same-second rows being
  // missed (gt at floored seconds silently dropped them — audit #3). Clients
  // merge by id, so re-delivery is free and loss is not.
  app.get('/api/orgs/:orgId/agents/:agentId/chat', async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const agent = await agentInOrg(orgId, agentId)
    if (!agent || (agent as any).deletedAt) return reply.code(404).send({ error: 'Not found' })
    const q = (req.query ?? {}) as any
    const limit = Math.max(1, Math.min(Number(q.limit) || DEFAULT_LIMIT, MAX_LIMIT))
    let since: number | null = null
    if (q.since !== undefined) {
      since = Number(q.since)
      if (!Number.isFinite(since)) return reply.code(400).send({ error: 'since must be a millisecond timestamp' })
    }
    const where = since !== null
      ? and(eq(schema.messages.agentId, agentId), gte(schema.messages.createdAt, new Date(since)))
      : eq(schema.messages.agentId, agentId)
    const rows = await db.select().from(schema.messages).where(where)
      .orderBy(desc(schema.messages.createdAt), desc(sql`rowid`)).limit(limit)
    rows.reverse()
    return {
      messages: rows,
      agent: {
        id: agent.id, name: agent.name,
        avatarEmoji: (agent as any).avatarEmoji ?? null,
        runtime: (agent as any).runtime ?? 'internal',
        external: isExternalAgent(agent as any),
      },
    }
  })

  // ── Send into the thread ─────────────────────────────────────────────────
  // Member-level deliberately (talking to staff is not a destructive act); the
  // org-membership gate on the secured scope has already run.
  app.post('/api/orgs/:orgId/agents/:agentId/chat', async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const agent = await agentInOrg(orgId, agentId)
    if (!agent || (agent as any).deletedAt) return reply.code(404).send({ error: 'Not found' })
    const content = String((req.body as any)?.content ?? '').trim()
    if (!content) return reply.code(400).send({ error: 'content is required' })
    if (content.length > MAX_CONTENT_CHARS) {
      return reply.code(400).send({ error: `content too long (max ${MAX_CONTENT_CHARS} chars)` })
    }

    // The message becomes a task so BOTH runtimes share one lifecycle — and so
    // the external poll loop can see it at all. orgId comes from the PATH the
    // membership gate authorised, never from the body (GC-0b).
    const taskId = randomUUID()
    await db.insert(schema.tasks).values({
      id: taskId, agentId, orgId, title: `chat: ${content.slice(0, 80)}`,
      input: content, status: 'pending', priority: 'medium', createdAt: new Date(),
    } as any)
    const userMsg = { id: randomUUID(), agentId, taskId, role: 'user' as const, content, createdAt: new Date() }
    await db.insert(schema.messages).values(userMsg)

    if (isExternalAgent(agent as any)) {
      // Assign for the runtime's poll loop; its /result inserts the assistant
      // reply. The placeholder output is a status, NOT a message — inserting it
      // would put boilerplate in the thread ahead of the real reply.
      await executeAgentTask({ agentId, taskId, input: content, conversationHistory: [] })
      return { ok: true, async: true, taskId, message: userMsg }
    }

    // Internal: answer now, replaying the recent thread as context.
    // PROVENANCE FILTER (audit MCC-1 #4): only rows tied to a TASK are replayed.
    // Chat and task flows always write a taskId; the two plantable writers do
    // not — `POST …/comms/inbox/send` (same-org member can insert an
    // assistant-role row) and the Telegram webhook (unauthenticated when no
    // signing secret is set) both insert taskId:null. Those rows may still
    // RENDER in the thread, but they never re-enter the model's prompt.
    // Also excluded: the row just written (executeAgentTask appends `input`
    // itself — including it would send the question twice).
    const prior = await db.select().from(schema.messages)
      .where(eq(schema.messages.agentId, agentId))
      .orderBy(desc(schema.messages.createdAt), desc(sql`rowid`)).limit(HISTORY_ROWS)
    const history = prior.reverse()
      .filter(m => m.id !== userMsg.id && !!m.taskId && (m.role === 'user' || m.role === 'assistant') && !!m.content)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    // Refusals and failures must not become "replies" (audit MCC-1 #5): a
    // governance/budget/preflight hard-stop is a NOTICE to the operator, not
    // the agent speaking — persisting it would pollute the thread and the next
    // turn's history. And a THROW (budget/concurrency guards) must fail the
    // task it already created rather than 500 with an orphaned pending row.
    let result
    try {
      result = await executeAgentTask({ agentId, taskId, input: content, conversationHistory: history })
    } catch (e: any) {
      const msg = String(e?.message ?? 'Agent execution failed.')
      await db.update(schema.tasks).set({ status: 'failed', output: msg } as any)
        .where(eq(schema.tasks.id, taskId)).catch(() => {})
      return reply.code(502).send({ error: msg, taskId })
    }
    const REFUSAL_PROVIDERS = new Set(['governance', 'budget', 'preflight'])
    if (REFUSAL_PROVIDERS.has(String((result as any).provider ?? ''))) {
      return { ok: false, async: false, taskId, message: userMsg, notice: result.output }
    }
    const assistant = { id: randomUUID(), agentId, taskId, role: 'assistant' as const, content: result.output, createdAt: new Date() }
    await db.insert(schema.messages).values(assistant)
    return { ok: true, async: false, taskId, message: userMsg, reply: assistant, tokensUsed: result.tokensUsed, costUsd: result.costUsd }
  })
}
