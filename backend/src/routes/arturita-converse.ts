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
import { assertAgentInOrg } from '../services/tenant-guard'
import { executeAgentTask } from '../services/agent-executor'
import { admitHistory, pendingApprovalNote } from '../services/converse-agent-turn'
import { streamLLMWithFallback } from '../services/llm-fallback-runtime'
import { messageText } from '../services/llm-router'
import {
  parseLlmChain, usableLlmChain, usableServerLlmChain, usableCloudProviders,
  serverOllamaBaseUrl, serverOllamaEnabled,
} from '../services/arturita-pipeline'
import { resolveLlmCreds, keyAvailableFor } from '../services/custom-model'
import { estimateInputTokens, parseCapUsd } from '../services/preflight'
import { extractText } from '../services/document-ingest'
import {
  checkAttachment, clipAttachmentText, withAttachmentContext,
  MAX_ATTACHMENT_BYTES, SUPPORTED_ATTACHMENT_EXTS,
} from '../services/converse-attachments'
import {
  base64Bytes, buildImageContent, checkImage, formatImageBytes, visionChain,
  IMAGE_TOKEN_ALLOWANCE, MAX_IMAGE_BYTES, NO_VISION_MESSAGE, SUPPORTED_IMAGE_EXTS,
} from '../services/converse-images'
import {
  buildUserBubbleText, loadThread, appendTurns, targetAgentKey, turnsToConverseHistory,
  getOrgJiraProjectKey, setOrgJiraProjectKey, parseJiraProjectKey,
} from '../services/command-center-thread'
import { getJiraCfg, jiraAuth, jiraBase } from './jira'
import { resolveVaultForOrg, fetchSharedMemory } from '../services/agent-memory'
import { loadConnectorTools } from '../services/agent-connector-tools'
import { parseCapabilities } from '../services/governance2'

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
  /** MOB-7b: a photo the operator attached to this turn, as RAW base64 (no
   *  `data:` prefix). Unlike a document there is no extract round-trip — the
   *  pixels ARE the payload, so they ride the turn itself and reach the model as
   *  a real image content block. It is held only for this request: never written
   *  to the DB, never logged, and never added to `history`. */
  image: z.object({
    name: z.string().min(1).max(300),
    mediaType: z.string().min(1).max(100),
    data: z.string().min(1),
  }).nullable().optional(),
  /** the operator opted this turn into the agent flow (UI "delegate" toggle). */
  explicitDelegate: z.boolean().optional(),
  /** GC-1 — WHO the operator is talking to, from the Command Center's "To:" picker.
   *  Absent (or Arturita's own id) → the pre-GC-1 behaviour, byte for byte. Naming a
   *  real agent routes the turn to `executeAgentTask`, so that agent's own prompt,
   *  memory, org-chart position and CONNECTORS apply.
   *
   *  This is a body-supplied FK that carries EXECUTION authority — the exact shape of
   *  GC-0b instance #7 — so it is checked with `assertAgentInOrg` below and again by
   *  the executor's task.orgId === agent.orgId invariant. Both, deliberately. */
  agentId: z.string().nullable().optional(),
  /** conversational continuity — the running task thread, if any. */
  existingThreadId: z.string().nullable().optional(),
  /** prior turns (role/content) so a direct answer has short-term memory.
   *  GC-1: `fromAgent` marks a turn written by a picked agent — such turns are
   *  re-admitted FENCED as untrusted (services/converse-agent-turn.ts). */
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    fromAgent: z.string().max(120).nullable().optional(),
  })).max(20).optional(),
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
  "On app.7ei.ai with empty Pipeline keys, the hosted backend should reach Fly Ollama — " +
  "open ⚙ Pipeline config below and “Run self-test”; if the hosted leg fails, that's not fixed by adding cloud keys. " +
  "On your machine: run local Ollama (`OLLAMA_ORIGINS=https://app.7ei.ai`, then restart Ollama) " +
  "or add a working cloud key (a free Groq or Gemini key works) in Pipeline config."

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
// trait). Kept cheap: two counts, no heavy joins. Org/agent vault notes are
// injected when `GITHUB_VAULT_TOKEN` is configured (Option C / MCA-75).
async function buildContextBlock(orgId: string, agentName: string): Promise<string | null> {
  try {
    const agents = await db.select({ status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const openTasks = await db.select({ id: schema.tasks.id }).from(schema.tasks)
      .where(and(eq(schema.tasks.orgId, orgId), inArray(schema.tasks.status, ['pending', 'in_progress'])))
    const active = agents.filter(a => a.status === 'active').length
    const lines = [
      '=== LIVE SYSTEM AWARENESS (read-only, for grounding your answer) ===',
      `Agent fleet: ${agents.length} agent(s), ${active} active.`,
      `Open work: ${openTasks.length} task(s) pending or in progress.`,
      '=== END SYSTEM AWARENESS ===',
    ]
    try {
      const vault = await resolveVaultForOrg(orgId)
      if (vault.token) {
        const { block } = await fetchSharedMemory(vault.token, vault.cfg, agentName)
        if (block) lines.push(block)
      }
    } catch { /* non-critical — fleet counts still land */ }
    return lines.join('\n')
  } catch { return null }
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

    const message = String(b.message ?? '').trim()
    // An attachment or a photo alone is a legitimate turn ("read this" / "what is
    // this?") — but there must be SOMETHING to act on.
    if (!message && !b.attachment && !b.image) return reply.code(400).send({ error: 'message is required' })

    // Gate the photo BEFORE any work: format and size, on the DECODED length so
    // the limit means what it says. Rejections mirror the extract route's status
    // codes (415 unsupported / 413 too large / 422 empty) so both clients can
    // treat the two attach paths identically.
    const image = b.image ?? null
    if (image) {
      const bad = checkImage({ mediaType: image.mediaType, bytes: base64Bytes(image.data) })
      if (bad) {
        const status = bad.code === 'too_large' ? 413 : bad.code === 'empty' ? 422 : 415
        return reply.code(status).send({ error: bad.error, code: bad.code })
      }
    }

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

    // ── GC-1 — WHO is this turn addressed to? ───────────────────────────────────
    //
    // `agent` above is Arturita, the fixed per-org front door and still the DEFAULT.
    // `target` is who the operator picked. They are the same object unless the picker
    // was used, which is what keeps every pre-GC-1 path below unchanged.
    //
    // The tenancy check is FIRST, before any work and before the org/Arturita rows are
    // used for anything: `b.agentId` is a body-supplied foreign key that carries
    // EXECUTION authority (naming another tenant's agent would run that agent under its
    // own org's LLM credentials, budget and connectors, with the output landing here).
    // That is GC-0b instance #7 exactly. `assertAgentInOrg` is the ergonomic layer — it
    // 400s so no bad row is ever written and the operator gets a real message; the
    // authoritative layer is the executor's task.orgId === agent.orgId invariant, which
    // holds even if this check were removed. Both, on purpose.
    //
    // Missing and foreign ids are refused identically (the helper does not distinguish
    // them) — "no such agent" vs "not your agent" is a cross-tenant existence oracle.
    const requestedAgentId = b.agentId ?? null
    let target = agent
    if (requestedAgentId && requestedAgentId !== agent.id) {
      const err = await assertAgentInOrg(requestedAgentId, orgId)
      if (err) return reply.code(400).send({ error: err })
      target = (await db.query.agents.findFirst({ where: eq(schema.agents.id, requestedAgentId) }))!
    }
    /** True only when the operator picked someone other than Arturita. */
    const addressedToSpecialist = target.id !== agent.id

    // Option C — default Arturita turns with configured connectors run through the
    // same executor + CONN-9 loop as a picked agent. deferAnswer (browser Ollama)
    // and image turns stay on the lean `/converse` path; vault notes still inject
    // into that path via buildContextBlock.
    let arturitaConnectorTools: Awaited<ReturnType<typeof loadConnectorTools>> = []
    try {
      arturitaConnectorTools = await loadConnectorTools(
        orgId, agent.id, parseCapabilities(agent.permissions),
      )
    } catch { /* non-critical — lean path still answers */ }
    const useArturitaExecutor = !addressedToSpecialist && !b.deferAnswer && !image
      && arturitaConnectorTools.length > 0

    // GC-2 — server thread replaces client `history` when persisted turns exist.
    const ccKey = targetAgentKey(requestedAgentId, agent.id)
    const ccLoaded = await loadThread(orgId, ccKey)
    const ccHistory = turnsToConverseHistory(ccLoaded.turns)
    const converseHistoryIn = ccHistory.length ? ccHistory : (b.history ?? [])
    const authorUser = (req as any).auth?.userId ?? (req as any).userId ?? null
    const userBubble = buildUserBubbleText(
      message,
      attachment?.name ? { name: attachment.name } : null,
      image?.name ? { name: image.name } : null,
    )
    const finish = async (payload: Record<string, any>) => {
      const text = String(payload.reply?.text ?? '').trim()
      if (!text || payload.deferred) return payload
      const asstRole = payload.mode === 'agent' ? 'assistant' as const : 'arturita' as const
      await appendTurns({
        orgId,
        targetAgentKey: ccKey,
        authorUser,
        user: { content: userBubble },
        assistant: {
          role: asstRole,
          content: text,
          meta: {
            mode: payload.mode,
            via: payload.reply?.provider === 'ollama' && payload.reply?.model
              ? `ollama/${payload.reply.model}`
              : (payload.reply?.provider ?? null),
            taskId: payload.taskId ?? null,
            fromAgent: asstRole === 'assistant' ? target.name : null,
            agent: payload.agent ?? null,
            assignedTo: payload.assignedTo ?? null,
            pendingApprovalNote: payload.pendingApprovalNote ?? null,
            degraded: payload.degraded ?? false,
            routing: payload.routing ?? null,
          },
        },
        taskThreadId: payload.taskId ?? ccLoaded.taskThreadId ?? b.existingThreadId ?? null,
      })
      return payload
    }
    // Who the transcript should attribute the reply to. Sent on EVERY response shape so
    // both clients render one rule ("show who replied") rather than special-casing.
    const identityOf = (row: typeof agent) => ({
      id: row.id,
      name: row.name,
      avatarEmoji: (row as any).avatarEmoji ?? null,
      avatarUrl: (row as any).avatarUrl ?? null,
      role: (row as any).role ?? null,
    })
    const identity = identityOf(target)
    // GC-1 audit (LOW-1) — `agent` on a response means THE AUTHOR OF THIS REPLY, and
    // on the delegate branch that is ARTURITA, not the agent the work was handed to.
    // The two are the same object unless the picker was used, which is exactly why the
    // bug was invisible: with a specialist picked, Arturita's own canned acknowledgement
    // ("I've put it on the board for Bruno to run") rendered under Bruno's avatar and
    // name, as if Bruno had said it. Not attacker-controllable, but the transcript named
    // the wrong speaker — and the operator decides what to say next based on who he
    // believes he is talking to. WHO WROTE IT and WHO IT WENT TO are now separate fields.
    const arturitaIdentity = identityOf(agent)

    // ── Delegate: route into the existing task/agent flow (ask vs execute) ──────
    if (decision.mode === 'delegate') {
      const route = routeVoiceCommand({ transcript: message, existingThreadId: b.existingThreadId ?? null })
      const taskId = randomUUID()
      await db.insert(schema.tasks).values({
        // GC-1 FIX — assign to the CHOSEN agent, not to Arturita.
        //
        // This line used to read `agentId: agent.id`, which is Arturita's own id. So
        // "delegate" did not delegate: every task the Command Center created was
        // assigned to the front door itself. The operator saw "I've put it on the
        // board for the office to run" and the office never got it — the work sat on
        // Arturita's own queue. With no picker there was no other id to use, which is
        // why it went unnoticed; the picker is what makes the bug both visible and
        // fixable. `target` is Arturita when nobody picked, so the default is
        // unchanged (still her queue) — but a picked agent now actually receives it.
        id: taskId, agentId: target.id, orgId,
        title: message.slice(0, 120),
        input: message,
        status: 'pending',
        workMode: route.workMode,
        inboxState: 'none',
        parentTaskId: route.isFollowUp ? (b.existingThreadId ?? null) : null,
        createdAt: new Date(),
      } as any)
      let ack = decision.destructive
        ? `Got it — I've put it on the board${addressedToSpecialist ? ` for ${target.name}` : ''} and I'll stop for your approval before anything irreversible.`
        : `Got it — I've put it on the board for ${addressedToSpecialist ? target.name : 'the office'} to run.`
      // Delegated tasks are executed later by an agent, so an attachment held only
      // for this turn cannot travel with them (persisting it is a separate story).
      // Say so rather than letting the operator believe the doc went with the task.
      if (attachment) ack += ` Note: “${attachment.name}” stays with this conversation — I didn't attach it to the task, so mention anything from it the office will need.`
      // Same for a photo, and for the same reason: it is held for this turn only,
      // so it cannot travel with work an agent runs later. Say so rather than let
      // the operator believe the office can see it.
      if (image) ack += ` Note: the photo “${image.name}” stays with this conversation — I didn't attach it to the task, so describe anything in it the office will need.`
      return finish({
        mode: 'delegate',
        routing: { trigger: decision.trigger, reason: decision.reason, workMode: route.workMode, destructive: decision.destructive, approvalType: decision.approvalType ?? null, isFollowUp: route.isFollowUp },
        taskId,
        // The ACK is Arturita's — she is the one confirming the hand-off — so SHE is
        // the author. Who the work went TO rides separately (`assignedTo`), and the
        // clients render it as an "→ assigned to X" chip rather than as the speaker.
        agent: arturitaIdentity,
        assignedTo: { id: target.id, name: target.name },
        reply: { text: ack, provider: 'arturita' },
      })
    }

    // ── GC-1 / Option C — executor path: picked agent OR Arturita w/ connectors ──
    //
    // `decideConverseMode` has already had its say and returned `answer`, so this is
    // conversational rather than a build/destructive request — those took the delegate
    // branch above and are still gated by A2 exactly as before. Deliberate ordering:
    // routing is decided BEFORE the recipient is considered, so picking an agent can
    // never turn a destructive intent into a direct execution. Picking changes WHO
    // answers, never WHETHER the approval gate applies.
    //
    // Everything that makes this the chosen agent rather than Arturita — system prompt,
    // per-agent memory, org-chart position, knowledge, connector tools — is derived by
    // `executeAgentTask` from the agent row alone, so there is no executor change here
    // and no second code path to keep in sync.
    //
    // CONSEQUENCE, stated plainly: this means CONNECTORS CAN FIRE FROM THE CHAT BOX.
    // That is intended, and the defences are the executor's own, unchanged and unforked:
    // the CONN-7 authorization gate, the operator step-up, and the server-computed
    // params digest that binds an approval to the exact params. This route adds no
    // bypass — it supplies an agent id and an input string, which is strictly less than
    // `POST /api/agents/:agentId/chat` already accepted. What it DOES add is telling the
    // operator when something parked at that gate, so a gated turn does not read as the
    // agent having gone quiet.
    if (addressedToSpecialist || useArturitaExecutor) {
      const taskId = randomUUID()
      await db.insert(schema.tasks).values({
        id: taskId, agentId: target.id, orgId,
        title: (message || 'Command Center message').slice(0, 120),
        input: message,
        status: 'pending',
        // WHY `execute` AND NOT `ask` — the load-bearing choice on this branch.
        //
        // `ask` looks like the obvious fit (a chat turn is a question) and it is the
        // SAFER-looking option, but it routes to `answerAskTask`, the lean path that is
        // documented as "no RAG/Drive/memory context, no delegation or tool side-effects".
        // No tools means no connectors — so a picked agent would answer with its prompt
        // and its memory but could not actually DO anything, and the picker would ship as
        // a personality switcher rather than a way to reach a specialist. It would also
        // make the CONN-7 tests below vacuously green: a gate that is never reached
        // always passes.
        //
        // `execute` is therefore deliberate, and its consequence is stated plainly:
        // CONNECTORS FIRE FROM THE CHAT BOX. What keeps that safe is not this route:
        //   • destructive / build intents never arrive here at all — `decideConverseMode`
        //     sent them to the delegate branch above, which parks a pending task behind
        //     the A2 approval gate;
        //   • every connector call still passes the CONN-7 authorization gate, the
        //     operator step-up, and the server-computed params digest;
        //   • connector RESULTS are fenced under a per-run nonce and the synthesis turn
        //     is terminal, so returned text cannot call another connector or steer
        //     delegation.
        // This route adds no bypass to any of those; it supplies an agent id and a string.
        workMode: 'execute',
        inboxState: 'none',
        createdAt: new Date(),
      } as any)

      // History is admitted FENCED where a turn came from an agent (untrusted — it may
      // quote a GitHub issue or an email). An unmarked transcript passes through
      // unchanged, so a client that never sets the marker behaves as it did before.
      const conversationHistory = admitHistory(converseHistoryIn)

      // An attached DOCUMENT rides along: its text is already extracted, and
      // `withAttachmentContext` is the same delimiter the Arturita branch uses.
      // A PHOTO cannot: `executeAgentTask` takes a string input, so there is nowhere
      // for an image content block to go. Rather than silently drop it — the exact
      // failure MOB-7b exists to prevent — say so in the input, so the agent tells the
      // operator instead of answering as if it had seen the picture.
      const agentInput = withAttachmentContext(
        message || 'Please read the attached document.',
        attachment,
      ) + (image
        ? `\n\n[The operator attached a photo ("${image.name}"). You CANNOT see it — an agent turn has no image channel. Say so plainly and ask them to describe it, or to ask Arturita directly, who can look at photos.]`
        : '')

      let result: Awaited<ReturnType<typeof executeAgentTask>>
      try {
        result = await executeAgentTask({
          agentId: target.id, taskId, input: agentInput, conversationHistory,
        })
      } catch (e: any) {
        // The executor throws on a genuine run failure (it has already marked the task
        // `failed` and written a system notice). Answer honestly in the thread rather
        // than 500-ing at a chat box.
        const converseMode = addressedToSpecialist ? 'agent' as const : 'answer' as const
        const converseIdentity = addressedToSpecialist ? identity : arturitaIdentity
        const speaker = addressedToSpecialist ? target.name : agent.name
        return finish({
          mode: converseMode, agent: converseIdentity, taskId, degraded: true,
          routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
          reply: { text: `${speaker} couldn't finish that turn: ${String(e?.message ?? e).slice(0, 300)}`, provider: 'agent_error' },
          error: e?.message ?? 'agent run failed',
        })
      }

      const note = pendingApprovalNote(result.pendingApprovals ?? 0)
      const converseMode = addressedToSpecialist ? 'agent' as const : 'answer' as const
      const converseIdentity = addressedToSpecialist ? identity : arturitaIdentity
      return finish({
        mode: converseMode,
        agent: converseIdentity,
        taskId,
        routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
        reply: { text: result.output, provider: result.provider ?? 'agent', model: null },
        // Surfaced so the chat can show "an action is waiting" inline. The approval
        // itself already reached the Inbox and push; this is the CHAT's copy of that
        // fact, because the chat is the surface the operator is looking at.
        pendingApprovals: result.pendingApprovals ?? 0,
        pendingApprovalNote: note,
        budgetWarning: result.budgetWarning ?? null,
      })
    }

    // ── Answer: one conversational LLM turn via the F1 fallback chain ───────────
    const contextBlock = await buildContextBlock(orgId, agent.name)
    const system = buildConverseSystemPrompt({
      agentName: agent.name, orgName: org?.name ?? null,
      orgMission: org?.mission ?? null, orgCulture: org?.culture ?? null,
      persona: agent.persona ?? null, personality: agent.personality ?? null,
      contextBlock,
    })
    // GC-1: a turn written by a picked AGENT re-enters fenced as untrusted — it may
    // quote a GitHub issue, a Jira comment or an email. An unmarked transcript (every
    // pre-GC-1 client, and every thread where the picker was never touched) passes
    // through byte-for-byte, so this is a no-op on the default path.
    const history = admitHistory(converseHistoryIn)
    // The attached document rides on THIS turn only — delimited, after the
    // operator's question. It is never added to `history`, so it doesn't re-enter
    // the prompt (and re-bill) on every later turn of the thread.
    const userText = withAttachmentContext(
      message || (image ? 'Please look at the attached photo.' : 'Please read the attached document.'),
      attachment,
    )
    // A photo turns the content into ordered PARTS (text + image block); without
    // one the content stays a plain string, so a text-only turn builds exactly
    // the request it built before this story.
    const userContent = image
      ? buildImageContent(userText, { name: image.name, mediaType: image.mediaType, data: image.data })
      : userText
    const messages = [...history, { role: 'user' as const, content: userContent }]

    // J-prod: hand the built prompt back so the client streams tokens locally
    // (browser→Ollama). No LLM call here, no secrets in the payload.
    //
    // A photo turn CANNOT defer: the local engine the browser streams from is
    // whatever Ollama model the operator runs, which this endpoint can't inspect
    // and which is text-only by default — precisely the silent-drop this story
    // exists to prevent. So an image turn is answered server-side, where the
    // chain is pruned to hops that can actually see. Deferring is a latency
    // optimisation; being right outranks it.
    if (b.deferAnswer && !image) {
      return {
        mode: 'answer',
        agent: identity,
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
    const resolveConverseCreds = (prov: string) => {
      const creds = resolveLlmCreds(deployCfg, prov)
      if (prov === 'ollama' && !creds.baseURL) return { ...creds, baseURL: serverOllamaBaseUrl() }
      return creds
    }
    const usable = usableServerLlmChain({
      entries: parseLlmChain(deployCfg),
      keyAvailable,
      guaranteed: { provider, model },
      serverOllama: serverOllamaEnabled(),
    })
    // MOB-7b — an image turn runs ONLY on hops that can see. The default chain is
    // free-first (local Ollama → groq), all text-only, ahead of the guaranteed
    // Claude hop; without this prune the photo would reach a blind model, which
    // errors at best and invents an answer at worst.
    const chain = image ? visionChain(usable) : usable
    if (image && chain.length === 0) {
      // No configured model can see. The operator gets told, in the thread, with
      // the fix — the same shape as NO_LLM_MESSAGE. Silently dropping the image
      // and answering from the text alone is the one thing we must not do.
      return finish({
        mode: 'answer',
        agent: identity,
        routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
        degraded: true,
        reply: { text: NO_VISION_MESSAGE, provider: 'text_only' },
        error: 'no vision-capable model configured',
        code: 'no_vision_model',
      })
    }
    const capUsd = parseCapUsd(org?.deployConfig as any, agent.id)
    // Price the TEXT of each message — `messageText` skips image parts, whose
    // base64 would otherwise be counted as characters and wildly overstate the
    // turn. The image's real cost is added as a flat allowance instead.
    const inputTokens = estimateInputTokens([system, ...messages.map(messageText)])
      + (image ? IMAGE_TOKEN_ALLOWANCE : 0)

    try {
      const fb = await streamLLMWithFallback({
        base: { system, messages, onToken: () => { /* buffered; the client reveals it */ } },
        chain,
        // Handles plaintext AND encrypted (custom-model) keys + per-provider base URL.
        resolveCreds: resolveConverseCreds,
        inputTokens,
        capUsd,
      })
      return finish({
        mode: 'answer',
        agent: identity,
        routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
        reply: { text: fb.result.output, provider: fb.used.provider, model: fb.used.model },
      })
    } catch (e: any) {
      // Failover exhausted / no key configured → honest, non-fatal reply.
      return finish({
        mode: 'answer',
        agent: identity,
        routing: { trigger: decision.trigger, reason: decision.reason, destructive: false },
        degraded: true,
        reply: { text: NO_LLM_MESSAGE, provider: 'text_only' },
        error: e?.message ?? 'llm unavailable',
      })
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
