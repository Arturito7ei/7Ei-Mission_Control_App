import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, and, or, gte, isNull, desc, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { executeAgentTask } from '../services/agent-executor'
import { streamLLM } from '../services/llm-router'
import { generateAgentToken } from '../middleware/agent-token'
import { isExternalAgent, heartbeatFreshness } from '../services/agent-runtime'
import { buildOrgChart } from '../services/orgchart'
import { buildHirePrompt, parseHireProposal, isExternalRuntime } from '../services/hiring'
import { nextUp } from '../services/worksurface'
import { mergeActivity, buildHeartbeatTimeline, TIMELINE_WINDOW_MS } from '../services/timeline'
import { unreadTaskIds } from '../services/receipts'
import { validateRoster, parseCapUsd, CHEAP_OUTPUT_RATE } from '../services/preflight'
import { parseTrustMode, parseBoundary, serializeBoundary, TRUST_MODES } from '../services/review'
import { secureRegistration } from '../services/code-executor'
import { validatePermissions } from '../services/agent-permissions'
import { resolveModelProfile, buildModelProfilePatch, flattenModelOptions, parseReasoningEffort } from '../services/model-profile'
import { parseLlmChain } from '../services/arturita-pipeline'
import { parseCustomModels } from '../services/custom-model'
import { requireOrgRole, enforceOrgRole } from '../middleware/rbac'
import { agentNotDeleted } from '../services/agent-deletion'

// ─── AGENT TEMPLATES ────────────────────────────────────────────────────────

export const AGENT_TEMPLATES = {
  arturito: { name: 'Arturito', role: 'Chief of Staff & Master Orchestrator', avatarEmoji: '🎯', personality: 'Direct, strategic, Swiss-German efficiency. Routes tasks to the right agent, maintains oversight of all operations.', agentType: 'standard' },
  head_dev: { name: 'Dev', role: 'Head of Development', avatarEmoji: '💻', personality: 'Technical, precise, opinionated on architecture. Rejects shortcuts.', agentType: 'standard' },
  head_marketing: { name: 'Maya', role: 'Head of Marketing', avatarEmoji: '📣', personality: 'Creative, data-driven, narrative-focused. Balances brand with growth.', agentType: 'standard' },
  head_ops: { name: 'Ops', role: 'Head of Operations', avatarEmoji: '⚙️', personality: 'Systems thinker, process-oriented, eliminates friction.', agentType: 'standard' },
  head_finance: { name: 'CFO', role: 'Head of Finance', avatarEmoji: '📊', personality: 'Conservative, rigorous, model-driven. Questions every assumption.', agentType: 'standard' },
  head_rd: { name: 'R&D', role: 'Head of Research & Development', avatarEmoji: '🔬', personality: 'First-principles thinker. Explores the edges of what is possible.', agentType: 'standard' },
  advisor: { name: 'Advisor', role: 'Silver Board Advisor', avatarEmoji: '🎖️', personality: 'Speaks with the voice and wisdom of the assigned persona.', agentType: 'advisor' },
}

// ─── AGENTS ──────────────────────────────────────────────────────────────────

// GC-0b — the COMPLETE set of `agents` columns the LEGACY member-gated
// `PATCH /api/agents/:agentId` may write. See the long rationale at that route for
// why this is an allow-list and what is deliberately excluded (tenant/identity
// columns, the `apiTokenHash` credential, and the entire owner-gated config /
// permissions / trust / model-profile vocabulary).
//
// Not `.strict()`, matching `ProjectPatchSchema` and `GoalPatchSchema`: unknown keys
// are STRIPPED rather than rejected, so a client that round-trips a whole agent object
// still succeeds — it just cannot move the row, escalate its trust, or set its token.
const AgentPatchSchema = z.object({
  personality: z.string().max(4000).nullable().optional(),
  cv: z.string().max(20_000).nullable().optional(),
  termsOfReference: z.string().max(20_000).nullable().optional(),
  persona: z.string().max(4000).nullable().optional(),
  expertise: z.string().max(4000).nullable().optional(),
  advisorPersona: z.string().max(200).nullable().optional(),
  agentType: z.enum(['standard', 'advisor']).optional(),
  // Accepted as an array or a pre-serialised JSON string (the legacy client sends
  // both shapes); validated same-org and re-serialised by the handler.
  advisorIds: z.union([z.array(z.string()), z.string()]).nullable().optional(),
  departmentId: z.string().nullable().optional(),
  status: z.string().max(50).optional(),
})

export async function agentRoutes(app: FastifyInstance) {
  const AgentSchema = z.object({
    name: z.string().min(1).max(100), role: z.string().min(1).max(200),
    departmentId: z.string().optional(), personality: z.string().optional(),
    cv: z.string().optional(), termsOfReference: z.string().optional(),
    llmProvider: z.string().default('anthropic'), llmModel: z.string().default('claude-sonnet-4-20250514'),
    avatarEmoji: z.string().default('🤖'), agentType: z.enum(['standard', 'advisor']).default('standard'),
    advisorPersona: z.string().optional(),
  })

  app.get('/api/agent-templates', async () => ({ templates: AGENT_TEMPLATES }))
  app.get('/api/orgs/:orgId/agents', async (req) => {
    const { orgId } = req.params as any
    // AAD-1 — the roster read path: soft-deleted agents are excluded.
    return { agents: await db.select().from(schema.agents).where(and(eq(schema.agents.orgId, orgId), agentNotDeleted)) }
  })
  app.post('/api/orgs/:orgId/agents', async (req, reply) => {
    const { orgId } = req.params as any
    const body = AgentSchema.parse(req.body)
    const agent = { id: randomUUID(), orgId, departmentId: body.departmentId ?? null, name: body.name, role: body.role, personality: body.personality ?? null, cv: body.cv ?? null, termsOfReference: body.termsOfReference ?? null, llmProvider: body.llmProvider, llmModel: body.llmModel, skills: [] as string[], status: 'idle', avatarEmoji: body.avatarEmoji, agentType: body.agentType, advisorPersona: body.advisorPersona ?? null, memoryLongTerm: null, createdAt: new Date() }
    await db.insert(schema.agents).values(agent)
    reply.code(201); return { agent }
  })
  app.get('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent) return reply.code(404).send({ error: 'Not found' })
    return { agent }
  })
  app.patch('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as any
    // GC-0b — this route was a DENY-LIST (it deleted exactly one key, `permissions`)
    // and a deny-list is how it got here: every column NOT named stayed writable.
    // Two live escalations followed from that.
    //
    //   1. CROSS-ORG MOVE. `orgId` is a column, so a member of org A could re-home an
    //      agent into org B. The gate cannot catch it: `resolveRequestOrg` derives this
    //      route's org FROM THE AGENT ROW and reads it BEFORE this handler mutates that
    //      row, so it authorises the pre-image of a write that rewrites the pre-image.
    //
    //   2. TRUST ESCALATION INTO THE CONNECTOR GATE. `trustMode` is owner-gated on
    //      `PUT /api/orgs/:orgId/agents/:agentId/trust`, but a plain MEMBER could set
    //      `{"trustMode":"autonomous"}` here. Trust level is what CONN-7 consults to
    //      decide whether a connector write needs human approval, so this was a
    //      member-reachable bypass of the connector execution gate — not a config nit.
    //
    // THE RULE: this legacy route may write ONLY fields that are (a) not tenant or
    // identity columns, (b) not credentials, and (c) NOT OWNER-GATED ON A SIBLING
    // ROUTE. (c) is what keeps the two surfaces from disagreeing: if a field needs an
    // owner on the dedicated PUT, a member must not reach it through the back door.
    // Concretely that excludes the whole owner-gated vocabulary —
    //   • name/title/role/jobDescription/avatarEmoji/reportsTo/runtime/llmProvider/
    //     llmModel/primaryModel  → `PUT …/agents/:agentId/config` (CONFIG_FIELDS,
    //     services/agent-config.ts — which also cycle-checks `reportsTo`)
    //   • permissions                        → `PUT …/agents/:agentId/permissions`
    //   • trustMode / trustBoundary          → `PUT …/agents/:agentId/trust`
    //   • cheapModel/cheapModelEnabled/reasoningEffort → `PUT …/model-profile`
    // and these, which are nobody's config field:
    //   • orgId / id / createdAt   — tenant + identity + immutable provenance
    //   • apiTokenHash             — THE AGENT CREDENTIAL. A writable token hash lets a
    //                                member mint themselves a working agent token.
    //   • externalEndpoint         — a push callback URL, i.e. an egress target
    //   • avatarUrl                — has a capped, type-checked upload route; a raw
    //                                data URI here would bypass both
    //   • lastHeartbeatAt/heartbeatStatus/nextWakeAt — runtime-owned liveness
    //
    // BEHAVIOUR NOTE: the frozen legacy Expo app (`app/app/agents/edit.tsx`) posted
    // name/role/llmModel/avatarEmoji through here. Those are owner-gated config, so
    // that screen was a member editing owner-only fields — the escalation itself, not
    // a feature to preserve. `web/` and `apps/mobile/` already route config through the
    // owner-gated PUT and are unaffected.
    //
    // ⚠️ `departmentId` and `advisorIds` are org-scoped references. `advisorIds` IS
    // validated same-org below (pre-existing, kept). `departmentId` is not — the same
    // dangling-reference gap the goals fix flagged; it can dangle, it cannot move the
    // agent's tenancy, which is what the gate depends on. Follow-up, not widened here.
    const parsed = AgentPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid agent' })
    const body: any = parsed.data
    // Validate advisorIds if provided (single query instead of N+1)
    if (body.advisorIds) {
      const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      // GC-0b (audit nit) — `JSON.parse` here was uncaught, so malformed JSON in the
      // string form threw and 500'd. That shape is not hypothetical: `AgentPatchSchema`
      // above explicitly blesses `advisorIds` as `array | string`, so a string that is
      // not valid JSON is a shape the contract INVITES and must answer with a 400.
      // Non-array JSON (`"5"`, `"{}"`) is refused for the same reason — `ids.length`
      // would otherwise be `undefined` and the same-org check below would silently
      // not run.
      let ids: unknown
      if (typeof body.advisorIds === 'string') {
        try { ids = JSON.parse(body.advisorIds) }
        catch { return reply.code(400).send({ error: 'advisorIds must be a JSON array' }) }
      } else ids = body.advisorIds
      if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
        return reply.code(400).send({ error: 'advisorIds must be a JSON array' })
      }
      if (ids.length > 0) {
        const found = await db.select({ id: schema.agents.id }).from(schema.agents)
          .where(and(inArray(schema.agents.id, ids), eq(schema.agents.orgId, agent.orgId)))
        if (found.length !== ids.length) {
          const foundIds = new Set(found.map(f => f.id))
          const invalid = ids.find((id: string) => !foundIds.has(id))
          return reply.code(400).send({ error: `Invalid advisorId: ${invalid}` })
        }
      }
      body.advisorIds = JSON.stringify(ids)
    }
    const _before = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    // A body consisting ENTIRELY of now-refused fields parses to `{}`, and drizzle
    // throws "No values to set" on an empty update. That is a 500 for what is really
    // a no-op, so skip the write — the same guard the sibling allow-listed routes use.
    if (Object.keys(body).length > 0) {
      await db.update(schema.agents).set(body).where(eq(schema.agents.id, agentId))
    }
    const _after = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    // MCA-GOV2 S4.1: snapshot the change for audit + rollback.
    if (_before) await db.insert(schema.configRevisions).values({ id: randomUUID(), orgId: _before.orgId, entity: 'agent', entityId: agentId, before: JSON.stringify(_before), after: JSON.stringify(_after), actor: (req as any).userId ?? 'human', createdAt: new Date() })
    return { agent: _after }
  })

  // MCA-GOV2 S4.2 — per-agent permissions (capabilities). null/empty = allow all.
  //
  // Owner-gated + validated, exactly like the sibling agent-write routes (config,
  // trust, model-profile, skills): re-writing an agent's capability caps is a
  // safety-critical control, so it requires the org OWNER — not just any member —
  // and the caps are validated against the known capability vocabulary
  // (services/agent-permissions.ts) so an arbitrary/oversized string can't be
  // persisted as a cap. Org-scoped path so `requireOrgRole('owner')` can read
  // `:orgId`; on the old non-org path it would silently no-op (the R-4 trap).
  // Allow-all semantics are unchanged: an empty/absent list still stores `[]`,
  // which `isCapabilityAllowed` treats as allow-all. Every change is snapshotted.
  app.put('/api/orgs/:orgId/agents/:agentId/permissions', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const before = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    // Tenant scoping: the agent must belong to the org in the path, or an owner of
    // org A could target an agent in org B by pairing A's `:orgId` with B's id.
    if (!before || before.orgId !== orgId) return reply.code(404).send({ error: 'Agent not found' })
    const parsed = validatePermissions(((req.body ?? {}) as any).permissions)
    if (parsed.ok !== true) return reply.code(400).send({ error: parsed.error })
    const caps = parsed.caps
    await db.update(schema.agents).set({ permissions: JSON.stringify(caps) }).where(eq(schema.agents.id, agentId))
    await db.insert(schema.configRevisions).values({ id: randomUUID(), orgId, entity: 'agent', entityId: agentId, before: JSON.stringify(before), after: JSON.stringify({ ...before, permissions: JSON.stringify(caps) }), actor: (req as any).userId ?? (req as any).auth?.userId ?? 'human', createdAt: new Date() })
    return { ok: true, permissions: caps }
  })

  // ─── Epic P / P1 — low-trust review mode (per-agent trust + boundary) ─────
  // Owner-gated: flipping an agent into a contained trust level (or widening its
  // boundary) is a safety-critical control, so it requires the org OWNER role,
  // not just any member. Every change is snapshotted to config_revisions.
  app.get('/api/orgs/:orgId/agents/:agentId/trust', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent || agent.orgId !== orgId) return reply.code(404).send({ error: 'Agent not found' })
    return {
      agentId,
      trustMode: parseTrustMode((agent as any).trustMode),
      boundary: parseBoundary((agent as any).trustBoundary),
    }
  })
  app.put('/api/orgs/:orgId/agents/:agentId/trust', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const b = (req.body ?? {}) as any
    if (b.trustMode != null && !(TRUST_MODES as readonly string[]).includes(String(b.trustMode))) {
      return reply.code(400).send({ error: `trustMode must be one of ${TRUST_MODES.join(' | ')}` })
    }
    const before = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!before || before.orgId !== orgId) return reply.code(404).send({ error: 'Agent not found' })
    const patch: Record<string, any> = {}
    if (b.trustMode != null) patch.trustMode = parseTrustMode(b.trustMode)
    if (b.boundary != null) patch.trustBoundary = serializeBoundary(parseBoundary(b.boundary))
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nothing to update (trustMode and/or boundary required)' })
    await db.update(schema.agents).set(patch).where(eq(schema.agents.id, agentId))
    const after = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    await db.insert(schema.configRevisions).values({ id: randomUUID(), orgId, entity: 'agent', entityId: agentId, before: JSON.stringify(before), after: JSON.stringify(after), actor: (req as any).userId ?? (req as any).auth?.userId ?? 'human', createdAt: new Date() })
    return { agentId, trustMode: parseTrustMode((after as any).trustMode), boundary: parseBoundary((after as any).trustBoundary) }
  })

  // ─── Epic P / P2 — model profiles (per-agent primary/cheap + reasoning effort) ─
  // Owner-gated, same as trust: a model swap changes spend + capability, so it's
  // an owner control. Every change is snapshotted to config_revisions. The routing
  // decision (cheap vs primary) is pure in services/model-profile.ts and wired
  // into the executor; these routes only read/write the profile fields.
  app.get('/api/orgs/:orgId/agents/:agentId/model-profile', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent || agent.orgId !== orgId) return reply.code(404).send({ error: 'Agent not found' })
    const a = agent as any
    return {
      agentId,
      profile: {
        primaryModel: a.primaryModel ?? null,
        cheapModel: a.cheapModel ?? null,
        cheapModelEnabled: !!a.cheapModelEnabled,
        reasoningEffort: parseReasoningEffort(a.reasoningEffort),
      },
      // `resolved` shows the effective primary (falls back to llmModel) so the UI
      // can display what actually runs even when no explicit override is set.
      resolved: resolveModelProfile(a),
    }
  })
  app.put('/api/orgs/:orgId/agents/:agentId/model-profile', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    const { orgId, agentId } = req.params as any
    const before = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!before || before.orgId !== orgId) return reply.code(404).send({ error: 'Agent not found' })
    const patch = buildModelProfilePatch((req.body ?? {}) as any)
    if (patch.ok !== true) return reply.code(400).send({ error: patch.error })
    if (Object.keys(patch.set).length === 0) return reply.code(400).send({ error: 'nothing to update (primaryModel / cheapModel / cheapModelEnabled / reasoningEffort)' })
    await db.update(schema.agents).set(patch.set as any).where(eq(schema.agents.id, agentId))
    const after = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    await db.insert(schema.configRevisions).values({ id: randomUUID(), orgId, entity: 'agent', entityId: agentId, before: JSON.stringify(before), after: JSON.stringify(after), actor: (req as any).userId ?? (req as any).auth?.userId ?? 'human', createdAt: new Date() })
    const a = after as any
    return {
      agentId,
      profile: {
        primaryModel: a.primaryModel ?? null,
        cheapModel: a.cheapModel ?? null,
        cheapModelEnabled: !!a.cheapModelEnabled,
        reasoningEffort: parseReasoningEffort(a.reasoningEffort),
      },
      resolved: resolveModelProfile(a),
    }
  })
  // Selectable model list for the config UI: the built-in catalogue + every
  // operator-defined model, from BOTH doors — Arturita's LLM chain (S8
  // `arturita_llm_chain`) and the agent catalogue (`custom_models`). A model
  // added at either door is selectable at both. Read-only; org-scoped (Clerk).
  app.get('/api/orgs/:orgId/available-models', async (req) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })
    const cfg = org?.deployConfig as any
    const custom = [
      ...parseLlmChain(cfg).filter((e: any) => e.custom),
      ...parseCustomModels(cfg),
    ]
    // Same slug+model registered at both doors → one option, not two.
    const seen = new Set<string>()
    const unique = custom.filter((e: any) => {
      const k = `${e.provider}::${e.model}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    return { models: flattenModelOptions(unique.map((e: any) => ({ provider: e.provider, model: e.model, label: e.label }))) }
  })

  // MCA-GOV2 S4.1 — execution policies (action → requires approval).
  app.get('/api/orgs/:orgId/policies', async (req) => {
    const { orgId } = req.params as any
    return { policies: await db.select().from(schema.executionPolicies).where(eq(schema.executionPolicies.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/policies', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.action) return reply.code(400).send({ error: 'action required' })
    const row = { id: randomUUID(), orgId, action: String(b.action), requiresApproval: b.requiresApproval === false ? 0 : 1, createdAt: new Date() }
    await db.insert(schema.executionPolicies).values(row); reply.code(201); return { policy: row }
  })
  app.delete('/api/policies/:id', async (req, reply) => {
    await db.delete(schema.executionPolicies).where(eq(schema.executionPolicies.id, (req.params as any).id)); reply.code(204)
  })

  // MCA-GOV2 S4.1 — config revisions + rollback (restore a prior agent snapshot).
  app.get('/api/orgs/:orgId/revisions', async (req) => {
    const { orgId } = req.params as any
    const revisions = await db.select().from(schema.configRevisions).where(eq(schema.configRevisions.orgId, orgId)).orderBy(desc(schema.configRevisions.createdAt)).limit(100)
    return { revisions }
  })
  app.post('/api/revisions/:id/rollback', async (req, reply) => {
    const { id } = req.params as any
    const rev = await db.query.configRevisions.findFirst({ where: eq(schema.configRevisions.id, id) })
    if (!rev || !rev.before) return reply.code(404).send({ error: 'Revision not found' })
    // SEC (audit/perms-authz) — a rollback RESTORES owner-controlled agent config:
    // `permissions` (capability caps), plus `role`, `status`, `llmProvider/llmModel`,
    // `reportsTo` — the very fields the sibling write routes (permissions / trust /
    // model-profile / config) gate to the org OWNER. Left member-gated, this route is
    // a side door around all of them: a member could revert an owner's tightening —
    // e.g. restore an agent's caps to a prior allow-all snapshot — with no owner role.
    // The path carries no `:orgId`, so a `requireOrgRole` preHandler would silently
    // no-op (the R-4 trap); derive the org from the revision row and enforce OWNER
    // in-handler, matching how multi-org transfer/clone guard their data-derived org.
    const gate = await enforceOrgRole({ userId: (req as any).auth?.userId, orgId: rev.orgId, minRole: 'owner' })
    if (!gate.ok) return reply.code(gate.code).send({ error: gate.error })
    let before: any; try { before = JSON.parse(rev.before) } catch { return reply.code(400).send({ error: 'corrupt snapshot' }) }
    if (rev.entity === 'agent') {
      const patch: any = {}
      for (const k of ['name', 'role', 'title', 'jobDescription', 'personality', 'permissions', 'reportsTo', 'status', 'llmProvider', 'llmModel', 'avatarEmoji', 'termsOfReference']) if (k in before) patch[k] = before[k]
      await db.update(schema.agents).set(patch).where(eq(schema.agents.id, rev.entityId))
      return { ok: true, entity: 'agent', entityId: rev.entityId, restored: Object.keys(patch) }
    }
    return reply.code(400).send({ error: `rollback not supported for entity ${rev.entity}` })
  })

  // MCA-GOV2 S4.4 — plugin job queue (enqueue + list).
  app.post('/api/orgs/:orgId/plugin-jobs', async (req, reply) => {
    const { orgId } = req.params as any
    const b = (req.body ?? {}) as any
    if (!b.type) return reply.code(400).send({ error: 'type required' })
    const row = { id: randomUUID(), orgId, pluginId: b.pluginId ?? null, type: String(b.type), payload: b.payload ? JSON.stringify(b.payload) : null, status: 'queued', result: null, createdAt: new Date(), updatedAt: null }
    await db.insert(schema.pluginJobs).values(row); reply.code(201); return { job: row }
  })
  app.get('/api/orgs/:orgId/plugin-jobs', async (req) => {
    const { orgId } = req.params as any
    return { jobs: await db.select().from(schema.pluginJobs).where(eq(schema.pluginJobs.orgId, orgId)).orderBy(desc(schema.pluginJobs.createdAt)).limit(100) }
  })

  app.patch('/api/agents/:agentId/status', async (req) => {
    const { agentId } = req.params as any
    const { status } = req.body as any
    await db.update(schema.agents).set({ status }).where(eq(schema.agents.id, agentId))
    return { ok: true }
  })
  // Governance controls (MCA-PC B2): pause / resume / terminate an agent.
  for (const [verb, status] of [['pause', 'paused'], ['resume', 'idle'], ['terminate', 'terminated']] as const) {
    app.post(`/api/agents/:agentId/${verb}`, async (req) => {
      await db.update(schema.agents).set({ status }).where(eq(schema.agents.id, (req.params as any).agentId))
      return { ok: true, status }
    })
  }
  // AAD-1 — the legacy member-reachable HARD delete is RETIRED. It was a member-level
  // `db.delete` that orphaned the agent's OAuth refresh tokens + agent-scoped secrets and
  // wrote its audit row with orgId:NULL (invisible in the org feed). Deletion now goes
  // through the owner-gated, org-scoped SOFT delete with explicit credential revocation:
  //   DELETE /api/orgs/:orgId/agents/:agentId   (routes/agent-detail.ts)
  // No client ever called this path (verified: no web/mobile/cli caller); it is refused
  // with a 410 rather than removed, so a direct API caller gets a clear signal instead of
  // a generic 404, and the route table stays stable for boot.test. A non-member still
  // hits 403 at the membership gate before reaching here.
  app.delete('/api/agents/:agentId', async (_req, reply) => {
    return reply.code(410).send({ error: 'Gone. Use DELETE /api/orgs/:orgId/agents/:agentId (owner-gated).' })
  })
  app.get('/api/agents/:agentId/messages', async (req) => {
    const { agentId } = req.params as any
    return { messages: await db.select().from(schema.messages).where(eq(schema.messages.agentId, agentId)) }
  })
  app.post('/api/agents/:agentId/skills', async (req) => {
    const { agentId } = req.params as any
    const { skillId } = req.body as any
    const [agent, skill] = await Promise.all([
      db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) }),
      db.query.skills.findFirst({ where: eq(schema.skills.id, skillId) }),
    ])
    if (!agent || !skill) throw new Error('Agent or skill not found')
    const current = (agent.skills as string[]) ?? []
    if (!current.includes(skill.name)) await db.update(schema.agents).set({ skills: [...current, skill.name] }).where(eq(schema.agents.id, agentId))
    return { ok: true }
  })
  app.post('/api/agents/:agentId/chat', async (req, reply) => {
    const { agentId } = req.params as any
    const { input, history } = req.body as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent) return reply.code(404).send({ error: 'Not found' })
    const taskId = randomUUID()
    await db.insert(schema.tasks).values({ id: taskId, agentId, orgId: agent.orgId, title: input.slice(0, 100), input, status: 'pending', priority: 'medium', createdAt: new Date() })
    await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'user', content: input, createdAt: new Date() })
    const result = await executeAgentTask({ agentId, taskId, input, conversationHistory: history ?? [] })
    await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'assistant', content: result.output, createdAt: new Date() })
    return { output: result.output, taskId, tokensUsed: result.tokensUsed, costUsd: result.costUsd, budgetWarning: result.budgetWarning }
  })
  app.get('/api/agents/:agentId/stream', { websocket: true }, async (socket: any, req: any) => {
    socket.on('message', async (raw: Buffer) => {
      try {
        const { input, history } = JSON.parse(raw.toString())
        const { agentId } = req.params
        const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
        if (!agent) { socket.send(JSON.stringify({ type: 'error', data: 'Agent not found' })); return }
        const taskId = randomUUID()
        await db.insert(schema.tasks).values({ id: taskId, agentId, orgId: agent.orgId, title: input.slice(0, 100), input, status: 'pending', priority: 'medium', createdAt: new Date() })
        await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'user', content: input, createdAt: new Date() })
        socket.send(JSON.stringify({ type: 'start', taskId }))
        await executeAgentTask({
          agentId, taskId, input, conversationHistory: history ?? [],
          onToken: (token) => socket.send(JSON.stringify({ type: 'token', data: token })),
          onDone: async (result) => {
            await db.insert(schema.messages).values({ id: randomUUID(), agentId, taskId, role: 'assistant', content: result.output, createdAt: new Date() })
            socket.send(JSON.stringify({ type: 'done', taskId, tokensUsed: result.tokensUsed, costUsd: result.costUsd, budgetWarning: result.budgetWarning }))
          },
        })
      } catch (err: any) { socket.send(JSON.stringify({ type: 'error', data: err.message })) }
    })
  })
  app.get('/api/orgs/:orgId/agents/advisors', async (req) => {
    const { orgId } = req.params as any
    return { agents: await db.select().from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.agentType, 'advisor'), agentNotDeleted)) }
  })
  app.post('/api/orgs/:orgId/agents/propose', async (req, reply) => {
    const { orgId } = req.params as any
    const { role } = req.body as any
    if (!role) return reply.code(400).send({ error: 'role is required' })

    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })

    const prompt = [
      `You are proposing an agent profile for the role: ${role}`,
      org.mission ? `Organisation mission: ${org.mission}` : '',
      org.culture  ? `Culture: ${org.culture}` : '',
      '',
      'Return a JSON object with exactly these keys:',
      '{ "name": string, "role": string, "termsOfReference": string, "cv": string, "avatarEmoji": string }',
      'Return ONLY the JSON object. No preamble, no markdown.',
    ].filter(Boolean).join('\n')

    let fullOutput = ''
    await streamLLM({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      system: 'You are an expert org designer. Output valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      onToken: (t) => { fullOutput += t },
    })

    try {
      const json = JSON.parse(fullOutput.replace(/```json|```/g, '').trim())
      return { proposal: json }
    } catch {
      return reply.code(500).send({ error: 'LLM returned invalid JSON', raw: fullOutput })
    }
  })

  // ─── EXTERNAL / BRING-YOUR-OWN RUNTIME AGENTS (MCA-EXT) ──────────────────
  const ExternalAgentSchema = z.object({
    name: z.string().min(1).max(100),
    role: z.string().min(1).max(200),
    runtime: z.enum(['openclaw', 'cursor', 'claude_code', 'custom']),
    llmProvider: z.string().default('minimax'),
    llmModel: z.string().default('minimax'),
    termsOfReference: z.string().optional(),
    avatarEmoji: z.string().default('🤖'),
    externalEndpoint: z.string().url().optional(),
    contactChannel: z.string().optional(),  // telegram chat id / email for pings
    // CC3 — secure-by-default overrides (a code executor lands contained even
    // when these are omitted; explicit values always win).
    permissions: z.array(z.string()).optional(),
    trustMode: z.string().optional(),
    trustBoundary: z.object({ projects: z.array(z.string()).optional(), tasks: z.array(z.string()).optional(), agents: z.array(z.string()).optional() }).optional(),
    workspaceId: z.string().optional(),
    projectId: z.string().optional(),
  })

  // Onboard an external agent. Returns the agent token ONCE — only its hash is stored.
  app.post('/api/orgs/:orgId/agents/external', async (req, reply) => {
    const { orgId } = req.params as any
    const body = ExternalAgentSchema.parse(req.body)
    const { token, hash } = generateAgentToken()
    // CC3 — a code-executor runtime (claude_code) is registered CONTAINED:
    // low_trust_review + an explicit non-empty capability list + a boundary
    // seeded from the target workspace/project. Non-code runtimes keep legacy
    // allow-all/standard unless explicit values are supplied.
    const sec = secureRegistration({
      runtime: body.runtime, permissions: body.permissions, trustMode: body.trustMode,
      trustBoundary: body.trustBoundary as any, workspaceId: body.workspaceId, projectId: body.projectId,
    })
    const agent = {
      id: randomUUID(), orgId, departmentId: null, name: body.name, role: body.role,
      personality: null, cv: null, termsOfReference: body.termsOfReference ?? null,
      llmProvider: body.llmProvider, llmModel: body.llmModel, skills: [] as string[],
      status: 'idle', avatarEmoji: body.avatarEmoji, agentType: 'external',
      advisorPersona: null, memoryLongTerm: null, runtime: body.runtime,
      externalEndpoint: body.externalEndpoint ?? null, apiTokenHash: hash,
      heartbeatStatus: 'unknown', contactChannel: body.contactChannel ?? null,
      permissions: sec.permissions, trustMode: sec.trustMode, trustBoundary: sec.trustBoundary,
      createdAt: new Date(),
    }
    await db.insert(schema.agents).values(agent as any)
    reply.code(201)
    // Never echo the hash; the raw token is shown exactly once here.
    return { agent: { ...agent, apiTokenHash: undefined }, agentToken: token }
  })

  // Rotate an external agent's token (revokes the previous one).
  app.post('/api/agents/:agentId/rotate-token', async (req, reply) => {
    const { agentId } = req.params as any
    const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (!isExternalAgent(agent)) return reply.code(400).send({ error: 'Not an external agent' })
    const { token, hash } = generateAgentToken()
    await db.update(schema.agents).set({ apiTokenHash: hash }).where(eq(schema.agents.id, agentId))
    return { agentToken: token }
  })

  // Goal-driven hiring (MCA-PC A2): prompt → proposed profile; confirm → create + place.
  app.post('/api/orgs/:orgId/agents/hire', async (req, reply) => {
    const { orgId } = req.params as any
    const body = (req.body ?? {}) as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })

    // Confirm path → create the (possibly edited) proposed agent and place it.
    if (body.confirm && body.profile) {
      const p = parseHireProposal(JSON.stringify(body.profile))
      let reportsTo: string | null = null
      if (p.reportsTo) {
        const mgr = await db.query.agents.findFirst({ where: and(eq(schema.agents.id, p.reportsTo), eq(schema.agents.orgId, orgId)) })
        reportsTo = mgr ? mgr.id : null
      }
      const external = isExternalRuntime(p.runtime)
      const tok = external ? generateAgentToken() : null
      // CC3 — a hired code executor (claude_code) is contained by default too.
      const sec = secureRegistration({ runtime: p.runtime, projectId: body.projectId })
      const agent = {
        id: randomUUID(), orgId, departmentId: null, name: p.name, role: p.role,
        personality: null, cv: null, termsOfReference: p.termsOfReference || null,
        llmProvider: p.llmProvider, llmModel: p.llmModel, skills: p.skills,
        status: 'idle', avatarEmoji: p.avatarEmoji, agentType: external ? 'external' : 'standard',
        advisorPersona: null, memoryLongTerm: null, runtime: p.runtime,
        externalEndpoint: null, apiTokenHash: tok ? tok.hash : null,
        heartbeatStatus: external ? 'unknown' : null, contactChannel: null,
        permissions: sec.permissions, trustMode: sec.trustMode, trustBoundary: sec.trustBoundary,
        reportsTo, title: p.title, jobDescription: p.jobDescription, createdAt: new Date(),
      }
      await db.insert(schema.agents).values(agent as any)
      reply.code(201)
      return { agent: { ...agent, apiTokenHash: undefined }, agentToken: tok ? tok.token : undefined }
    }

    // Propose path → ask the LLM to design an agent from the prompt + org chart.
    if (!body.prompt) return reply.code(400).send({ error: 'prompt is required' })
    const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, title: schema.agents.title })
      .from(schema.agents).where(and(eq(schema.agents.orgId, orgId), agentNotDeleted))
    const { system, user } = buildHirePrompt(body.prompt, org, agents)
    let out = ''
    await streamLLM({ provider: 'anthropic', model: 'claude-sonnet-4-20250514', system, messages: [{ role: 'user', content: user }], maxTokens: 1024, onToken: (t) => { out += t } })
    const proposal = parseHireProposal(out)
    if (proposal.reportsTo && !agents.find(a => a.id === proposal.reportsTo)) proposal.reportsTo = null
    return { proposal }
  })

  // Cockpit payload: roster (with heartbeat freshness) + tasks + summary.
  // Shape matches the dashboard's STATE object (offline fallback ⇄ live mode).
  app.get('/api/orgs/:orgId/cockpit', async (req) => {
    const { orgId } = req.params as any
    const now = Date.now()
    const userId = (req as any).userId ?? 'anon'
    const agents = await db.select().from(schema.agents).where(and(eq(schema.agents.orgId, orgId), agentNotDeleted))
    const [rawTasks, reads] = await Promise.all([
      db.select().from(schema.tasks)
        .where(eq(schema.tasks.orgId, orgId)).orderBy(desc(schema.tasks.createdAt)).limit(200),
      // V2 board read receipts: the operator's seen-marks, to flag unread cards.
      db.select({ taskId: schema.taskReads.taskId, seenAt: schema.taskReads.seenAt }).from(schema.taskReads)
        .where(and(eq(schema.taskReads.orgId, orgId), eq(schema.taskReads.userId, userId))),
    ])
    const unread = unreadTaskIds(rawTasks as any, reads as any)
    const tasks = rawTasks.map(t => ({ ...t, unread: unread.has(t.id) }))
    const roster = agents.map(a => ({
      id: a.id, name: a.name, role: a.role, runtime: a.runtime,
      llmProvider: a.llmProvider, llmModel: a.llmModel, status: a.status,
      agentType: a.agentType, avatarEmoji: a.avatarEmoji,
      // The uploaded picture, so the fleet shows the SAME avatar the Staff grid
      // and the agent header show. Null → the emoji above is used.
      avatarUrl: a.avatarUrl,
      heartbeat: isExternalAgent(a) ? heartbeatFreshness(a.lastHeartbeatAt as any, now) : 'green',
      lastHeartbeatAt: a.lastHeartbeatAt,
    }))
    const inCol = (c: string) => tasks.filter(t => (t.kanbanColumn ?? 'todo') === c).length
    return {
      orgId, generatedAt: new Date().toISOString(), agents: roster, tasks,
      // W2: the single next task the office should pick up (unblocked, highest
      // priority, oldest first) — makes the board a queue, not just four buckets.
      nextUp: nextUp(tasks),
      summary: {
        agents: roster.length,
        external: roster.filter(r => r.agentType === 'external').length,
        tasks: tasks.length,
        todo: inCol('todo'), in_progress: inCol('in_progress'),
        blocked: inCol('blocked'), done: inCol('done'),
      },
    }
  })

  // Per-wake preflight cap + model config audit (MCA-84 V3). GET returns the
  // configured per-wake cap and, per agent, whether its model is priced (spend
  // trackable/cappable) and within the "cheap" output-rate threshold. Pure
  // projection in services/preflight.ts; this fetches org config + roster.
  app.get('/api/orgs/:orgId/preflight', async (req) => {
    const { orgId } = req.params as any
    const [org, agents] = await Promise.all([
      db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } }),
      db.select({ id: schema.agents.id, name: schema.agents.name, llmModel: schema.agents.llmModel, llmProvider: schema.agents.llmProvider })
        .from(schema.agents).where(and(eq(schema.agents.orgId, orgId), agentNotDeleted)),
    ])
    const { rows, warnCount } = validateRoster(agents as any)
    return {
      capUsd: parseCapUsd(org?.deployConfig as any),
      cheapThresholdUsdPerMTok: CHEAP_OUTPUT_RATE * 1_000_000,
      warnCount, agents: rows,
    }
  })

  // Set (or clear) the org-wide per-wake preflight cap. Stored in deployConfig
  // like the config-as-secret settings; null/≤0 clears it (no cap).
  app.put('/api/orgs/:orgId/preflight', async (req, reply) => {
    const { orgId } = req.params as any
    const { capUsd } = z.object({ capUsd: z.number().positive().nullable() }).parse(req.body)
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Org not found' })
    const config = (org.deployConfig ?? {}) as Record<string, string>
    if (capUsd == null) delete config.maxCostPerWakeUsd
    else config.maxCostPerWakeUsd = String(capUsd)
    await db.update(schema.organisations).set({ deployConfig: config }).where(eq(schema.organisations.id, orgId))
    return { capUsd: parseCapUsd(config) }
  })

  // Heartbeat 24h timeline (MCA-84 V1): per-agent lanes of activity blocks over
  // the last day, built from run telemetry (external) merged with task timing
  // (internal). Pure projection in services/timeline.ts; this just fetches.
  app.get('/api/orgs/:orgId/timeline', async (req) => {
    const { orgId } = req.params as any
    const now = Date.now()
    const windowStart = new Date(now - TIMELINE_WINDOW_MS)
    const agents = await db.select().from(schema.agents).where(and(eq(schema.agents.orgId, orgId), agentNotDeleted))
    const [runs, tasks] = await Promise.all([
      // Runs that touch the window: started within it, or still open (ongoing).
      db.select().from(schema.agentRuns).where(and(
        eq(schema.agentRuns.orgId, orgId),
        or(gte(schema.agentRuns.startedAt, windowStart), isNull(schema.agentRuns.endedAt)),
      )),
      db.select().from(schema.tasks).where(eq(schema.tasks.orgId, orgId))
        .orderBy(desc(schema.tasks.createdAt)).limit(300),
    ])
    const roster = agents.filter(a => a.status !== 'terminated').map(a => ({
      id: a.id, name: a.name, avatarEmoji: a.avatarEmoji, status: a.status,
      heartbeat: isExternalAgent(a) ? heartbeatFreshness(a.lastHeartbeatAt as any, now) : 'green',
      lastHeartbeatAt: a.lastHeartbeatAt, nextWakeAt: a.nextWakeAt, heartbeatEverySec: a.heartbeatEverySec,
    }))
    const activities = mergeActivity(runs as any, tasks as any, now)
    return { timeline: buildHeartbeatTimeline(roster, activities, now) }
  })

  // Org chart & hierarchy (MCA-PC A1): reporting tree built from agents.reportsTo.
  app.get('/api/orgs/:orgId/orgchart', async (req) => {
    const { orgId } = req.params as any
    // P2 — the canvas cards also render the uploaded avatar, the runtime/model
    // line and a truncated job description, so those columns ship with the tree.
    const rows = await db.select({
      id: schema.agents.id, name: schema.agents.name, role: schema.agents.role,
      title: schema.agents.title, reportsTo: schema.agents.reportsTo,
      avatarEmoji: schema.agents.avatarEmoji, avatarUrl: schema.agents.avatarUrl,
      status: schema.agents.status, runtime: schema.agents.runtime,
      llmModel: schema.agents.llmModel, jobDescription: schema.agents.jobDescription,
    }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), agentNotDeleted))
    // `agents` is the flat roster: the canvas derives its own tree (web/lib/orgLayout)
    // so layout and cycle-breaking are testable client-side. `tree` stays for callers
    // that want the nesting done for them.
    return { tree: buildOrgChart(rows), agents: rows, count: rows.length }
  })
}
