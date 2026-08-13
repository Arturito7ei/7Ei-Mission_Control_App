import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { requireOrgRole } from '../middleware/rbac'
import { upsertDocument } from '../services/vector-search'
import { toPublicOrg, ORG_PATCH_WRITABLE_FIELDS } from '../services/org-public'

// ─── ORGS ────────────────────────────────────────────────────────────────────

// GC-0b — the COMPLETE set of `organisations` columns the general member-gated
// `PATCH /api/orgs/:orgId` may write. See the rationale at that route. Deliberately
// absent, each with its own owner-gated home:
//   • `id` / `ownerId`     — identity, and `ownerId` is ROLE-DETERMINANT (enforceOrgRole
//                            grandfathers the org owner), so writing it is member→owner.
//   • `deployConfig`       — plaintext LLM API keys → `POST …/credentials` (owner)
//   • `telegramBotToken`   — bot credential → the comms routes (owner)
//   • `budgetMonthlyUsd`   — the spend cap → the budget routes (owner)
//   • `deployMode` / `cloudProvider` / `preferredLlm` — deployment posture, set at org
//                            creation and changed through the owner-gated surfaces.
//   • `createdAt`          — immutable provenance.
// Not `.strict()`, matching the other five: unknown keys are stripped, so a client that
// round-trips a whole org object still succeeds — it just cannot write a credential.
// Keys must stay in sync with ORG_PATCH_WRITABLE_FIELDS (org-public.test.ts tripwire).
export const ORG_PATCH_SCHEMA_FIELD_NAMES = [
  'name',
  'description',
  'logoUrl',
  'mission',
  'culture',
] as const satisfies ReadonlyArray<(typeof ORG_PATCH_WRITABLE_FIELDS)[number]>

const OrgPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  logoUrl: z.string().max(2000).nullable().optional(),
  mission: z.string().max(20_000).nullable().optional(),
  culture: z.string().max(20_000).nullable().optional(),
})

export async function orgRoutes(app: FastifyInstance) {
  const OrgSchema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    logoUrl: z.string().url().optional(),
    mission: z.string().optional(),
    culture: z.string().optional(),
    deployMode: z.enum(['cloud', 'local']).optional(),
    cloudProvider: z.enum(['aws', 'aws_ch', 'gcp', 'gcp_ch', 'azure', 'oracle']).optional(),
    // Legacy preset key (mobile onboarding) — widened to accept any catalogue value.
    preferredLlm: z.string().optional(),
    // Explicit model selection (web onboarding): provider + model id, with optional
    // per-org credentials for hosted OpenAI-compatible / custom providers.
    llmProvider: z.string().optional(),
    llmModel: z.string().optional(),
    llmApiKey: z.string().optional(),
    llmBaseUrl: z.string().optional(),
    firstAgentRole: z.string().optional(),
  })

  // Map the legacy preferredLlm preset to a concrete provider + model.
  const PRESET_LLM: Record<string, { provider: string; model: string }> = {
    gpt4o:  { provider: 'openai', model: 'gpt-4o' },
    gemini: { provider: 'google', model: 'gemini-2.0-flash' },
    claude: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  }
  function resolveLlm(body: z.infer<typeof OrgSchema>): { provider: string; model: string } {
    if (body.llmProvider && body.llmModel) return { provider: body.llmProvider, model: body.llmModel }
    return PRESET_LLM[body.preferredLlm ?? 'claude'] ?? PRESET_LLM.claude
  }

  app.get('/api/orgs', async (req, reply) => {
    // req.userId is set by the Clerk auth pre-handler (MCA-14).
    const userId = (req as any).userId
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' })
    // Explicit projection, not `select *`: this row carries `telegramBotToken`
    // and the `deployConfig` LLM-key blob. See services/org-public.ts.
    const rows = await db.select().from(schema.organisations).where(eq(schema.organisations.ownerId, userId))
    return { orgs: rows.map(toPublicOrg) }
  })
  app.post('/api/orgs', async (req, reply) => {
    // req.userId is set by the Clerk auth pre-handler (MCA-14). Never fall back to "anon".
    const userId = (req as any).userId
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' })
    const body = OrgSchema.parse(req.body)
    const llm = resolveLlm(body)
    // Persist per-org credentials for the chosen provider (consumed by the LLM router).
    const deployConfig: Record<string, string> = {}
    if (body.llmApiKey)  deployConfig[`${llm.provider}_api_key`]  = body.llmApiKey
    if (body.llmBaseUrl) deployConfig[`${llm.provider}_base_url`] = body.llmBaseUrl
    const org = { id: randomUUID(), name: body.name, description: body.description ?? null, logoUrl: body.logoUrl ?? null, ownerId: userId, createdAt: new Date(), mission: body.mission ?? null, culture: body.culture ?? null, deployMode: body.deployMode ?? null, cloudProvider: body.cloudProvider ?? null, preferredLlm: body.preferredLlm ?? null, deployConfig }
    await db.insert(schema.organisations).values(org)

    // 0. Create org membership for owner
    await db.insert(schema.orgMembers).values({
      id: randomUUID(), orgId: org.id, userId, role: 'owner', createdAt: new Date(),
    })

    // 1. Embed org knowledge into Pinecone (fire-and-forget)
    if (body.mission || body.culture) {
      const knowledgeText = [
        body.mission ? `Mission & Vision: ${body.mission}` : '',
        body.culture ? `Culture & Principles: ${body.culture}` : '',
      ].filter(Boolean).join('\n\n')
      upsertDocument({
        id: `${org.id}_onboarding`,
        orgId: org.id,
        text: knowledgeText,
        name: 'Onboarding — Mission & Culture',
        type: 'onboarding',
      }).catch(err => console.warn('Pinecone upsert failed (non-critical):', err))
    }

    // 2. Auto-create Arturito
    const arturitoId = randomUUID()
    const arturitoTOR = [
      `You are Arturito, Chief of Staff at ${body.name}.`,
      body.mission ? `Organisation mission: ${body.mission}` : '',
      body.culture ? `Culture: ${body.culture}` : '',
      'You orchestrate all agents, route tasks, and maintain strategic oversight.',
      'When asked to create agents, propose a full profile (name, role, TOR) using org context.',
    ].filter(Boolean).join('\n')

    await db.insert(schema.agents).values({
      id: arturitoId,
      orgId: org.id,
      departmentId: null,
      name: 'Arturito',
      role: 'Chief of Staff & Agent Orchestrator',
      personality: 'Direct, strategic. Routes tasks efficiently. Speaks in first person.',
      cv: null,
      termsOfReference: arturitoTOR,
      llmProvider: llm.provider,
      llmModel: llm.model,
      skills: [],
      status: 'idle',
      avatarEmoji: '🎯',
      agentType: 'standard',
      advisorPersona: null,
      memoryLongTerm: null,
      persona: 'You are Arturito, the AI Chief of Staff. You are professional, warm, and action-oriented. You speak clearly and concisely. You always have a plan.',
      expertise: 'Organization management, task delegation, strategic planning, team coordination, onboarding new agents',
      createdAt: new Date(),
    })

    // 3. First specialist agent (if selected)
    const FIRST_AGENT_TEMPLATES: Record<string, { name: string; role: string; emoji: string }> = {
      marketing:   { name: 'Maya', role: 'Head of Marketing',   emoji: '📣' },
      engineering: { name: 'Dev',  role: 'Head of Engineering', emoji: '💻' },
      finance:     { name: 'CFO',  role: 'Head of Finance',     emoji: '📊' },
      operations:  { name: 'Ops',  role: 'Head of Operations',  emoji: '⚙️' },
    }
    const firstRole = body.firstAgentRole
    if (firstRole && FIRST_AGENT_TEMPLATES[firstRole]) {
      const tmpl = FIRST_AGENT_TEMPLATES[firstRole]
      await db.insert(schema.agents).values({
        id: randomUUID(), orgId: org.id, departmentId: null,
        name: tmpl.name, role: tmpl.role,
        personality: null, cv: null,
        termsOfReference: `You are ${tmpl.name}, ${tmpl.role} at ${body.name}.`,
        llmProvider: llm.provider,
        llmModel: llm.model,
        skills: [], status: 'idle',
        avatarEmoji: tmpl.emoji, agentType: 'standard',
        advisorPersona: null, memoryLongTerm: null,
        createdAt: new Date(),
      })
    }

    // 4. Return org + arturitoId
    // `org.deployConfig` holds the plaintext `llmApiKey` this request just wrote.
    // Echoing it back would hand the key to every future reader of this response
    // (and its caches/logs) — project it away even though the caller sent it.
    reply.code(201)
    return { org: toPublicOrg(org), arturitoId }
  })
  app.get('/api/orgs/:orgId', async (req, reply) => {
    const { orgId } = req.params as any
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId) })
    if (!org) return reply.code(404).send({ error: 'Not found' })
    return { org: toPublicOrg(org) }
  })
  app.patch('/api/orgs/:orgId', async (req, reply) => {
    const { orgId } = req.params as any
    // GC-0b — the SIXTH instance of the class, found by sweeping for the SHAPE rather
    // than working the reported list. This route was a DENY-LIST: it stripped `ownerId`
    // and `id`, then spread everything else into `db.update().set()`.
    //
    // The tenant leg was already closed (the org comes from the `:orgId` PATH, so there
    // is no row-derived gate-ordering bug here, and `ownerId` was stripped). What the
    // deny-list left open was a CREDENTIAL-WRITE ESCALATION: every column it did not
    // name stayed writable by a plain MEMBER, and three of them are owner-gated
    // everywhere else in the codebase —
    //   • `deployConfig`     — holds the org's PLAINTEXT LLM API KEYS. Owner-gated on
    //     `POST …/credentials` (routes/credentials.ts) and the custom-model routes. A
    //     member could overwrite it: swap the key to redirect model spend, or wipe every
    //     provider config. It also skipped the `snapshot()` audit trail those routes write.
    //   • `telegramBotToken` — the org's bot credential (the same column the #294 leak
    //     stopped SHIPPING on the read side; this was the write side of that row).
    //   • `budgetMonthlyUsd` — the spend cap. A member could raise their own ceiling.
    //
    // So: an allow-list of the plain descriptive fields, and nothing else. Credentials,
    // budget and deployment settings keep their dedicated owner-gated routes; there is
    // no reason for this general edit route to be a second way in. The only client that
    // calls it (`web/app/dashboard/page.tsx`, the Settings tab) sends exactly
    // `{description, mission, culture}`, so this is a strict narrowing with no UI cost.
    const parsed = OrgPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid organisation' })
    const patch = parsed.data
    if (Object.keys(patch).length > 0) {
      await db.update(schema.organisations).set(patch).where(eq(schema.organisations.id, orgId))
    }
    return { ok: true }
  })
  app.delete('/api/orgs/:orgId', { preHandler: requireOrgRole('owner') }, async (req, reply) => {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, (req.params as any).orgId))
    reply.code(204)
  })
  app.get('/api/orgs/:orgId/departments', async (req) => {
    const { orgId } = req.params as any
    return { departments: await db.select().from(schema.departments).where(eq(schema.departments.orgId, orgId)) }
  })
  app.post('/api/orgs/:orgId/departments', async (req, reply) => {
    const { orgId } = req.params as any
    const { name } = req.body as any
    const dept = { id: randomUUID(), orgId, name, createdAt: new Date() }
    await db.insert(schema.departments).values(dept)
    reply.code(201); return { department: dept }
  })
  app.delete('/api/orgs/:orgId/departments/:deptId', async (req, reply) => {
    await db.delete(schema.departments).where(eq(schema.departments.id, (req.params as any).deptId))
    reply.code(204)
  })
}
