import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { encrypt } from '../services/secrets'
import { requireOrgRole } from '../middleware/rbac'
import {
  AGENT_CONNECTORS, getAgentConnector, validateConnectorConfig,
  connectorSecretKey, toPublicConnector,
} from '../services/agent-connectors'

// ─── Per-agent connectors (Epic CONN / CONN-1) ───────────────────────────────
//
// OWNER-gated, org-scoped-path CRUD for an agent's connectors — the same shape as
// the sibling agent-write routes (permissions/trust/model-profile/config): every
// verb is `requireOrgRole('owner')` on `/api/orgs/:orgId/agents/:agentId/...`, so
// the gate actually binds (the tail-first path would make it a no-op — the R-4
// trap), and every handler re-checks the agent belongs to `:orgId` (404 otherwise)
// so an owner of org A can't reach an agent in org B.
//
// NON-SECRET config lands in the `agent_connectors` row; the credential (if any) is
// encrypted into a `secrets` row at `agent` scope (scopeId = agentId) and referenced
// by `secretRef`. Reads return `toPublicConnector()` — an allow-list projection that
// NEVER carries `secretRef` or any decrypted value. CONN-1 ships one config-only
// connector (custom MCP); GitHub/Jira/Telegram/OAuth are later stages.

// Agent-scoped secret helpers (mirror the org connectors' helpers, but scope='agent').
const agentSecWhere = (orgId: string, agentId: string, key: string) =>
  and(
    eq(schema.secrets.orgId, orgId),
    eq(schema.secrets.scope, 'agent'),
    eq(schema.secrets.scopeId, agentId),
    eq(schema.secrets.key, key),
  )

async function setAgentSecret(orgId: string, agentId: string, key: string, val: string): Promise<void> {
  const r = await db.query.secrets.findFirst({ where: agentSecWhere(orgId, agentId, key) })
  const enc = encrypt(val)
  if (r) await db.update(schema.secrets).set({ valueEncrypted: enc }).where(eq(schema.secrets.id, r.id))
  else await db.insert(schema.secrets).values({ id: randomUUID(), orgId, scope: 'agent', scopeId: agentId, key, valueEncrypted: enc, createdAt: new Date() })
}

async function delAgentSecret(orgId: string, agentId: string, key: string): Promise<void> {
  await db.delete(schema.secrets).where(agentSecWhere(orgId, agentId, key))
}

/** Resolve the agent, enforcing it belongs to the org in the path. Returns null on
 *  a missing agent OR a cross-tenant mismatch — the caller 404s on either. */
async function agentInOrg(orgId: string, agentId: string) {
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  if (!agent || agent.orgId !== orgId) return null
  return agent
}

export async function agentConnectorRoutes(app: FastifyInstance) {
  const owner = { preHandler: requireOrgRole('owner') }

  // List: the catalog × this agent's state, MASKED. A configured connector merges
  // its row's public projection over the catalog meta; an un-configured one shows
  // status 'not_configured' and no config.
  app.get('/api/orgs/:orgId/agents/:agentId/connectors', owner, async (req, reply) => {
    const { orgId, agentId } = req.params as any
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const rows = await db.select().from(schema.agentConnectors)
      .where(and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId)))
    const byId = new Map(rows.map(r => [r.connectorId, r]))
    const connectors = AGENT_CONNECTORS.map(meta => {
      const row = byId.get(meta.id)
      return {
        connectorId: meta.id, name: meta.name, category: meta.category,
        authType: meta.authType, icon: meta.icon, docsUrl: meta.docsUrl,
        ...(row ? toPublicConnector(row) : { status: 'not_configured', config: null, accountLabel: null, useOrgConnection: false, lastTestedAt: null, lastError: null }),
      }
    })
    return { connectors }
  })

  // One connector: status + non-secret config, MASKED.
  app.get('/api/orgs/:orgId/agents/:agentId/connectors/:cid', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const row = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    const base = { connectorId: meta.id, name: meta.name, category: meta.category, authType: meta.authType, icon: meta.icon, docsUrl: meta.docsUrl }
    if (!row) return { connector: { ...base, status: 'not_configured', config: null, accountLabel: null, useOrgConnection: false, lastTestedAt: null, lastError: null } }
    return { connector: { ...base, ...toPublicConnector(row) } }
  })

  // Configure (create or replace): validate the NON-SECRET config, encrypt any
  // credential into an agent-scoped secret, upsert the row. Returns the MASKED row.
  app.post('/api/orgs/:orgId/agents/:agentId/connectors/:cid', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })

    const body = (req.body ?? {}) as any
    const valid = validateConnectorConfig(cid, body.config)
    if (valid.ok !== true) return reply.code(400).send({ error: valid.error })

    const useOrgConnection = body.useOrgConnection === true
    // An optional credential — only accepted for connectors that carry one, and only
    // when NOT inheriting the org connection. It is encrypted at agent scope; the
    // plaintext never touches the row.
    let secretRef: string | null = null
    if (meta.hasSecret && !useOrgConnection && typeof body.secret === 'string' && body.secret.trim()) {
      secretRef = connectorSecretKey(cid)
      await setAgentSecret(orgId, agentId, secretRef, body.secret.trim())
    }

    const existing = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    // A masked label derived from the non-secret config (never a credential).
    const accountLabel = typeof (valid.config as any).name === 'string' ? String((valid.config as any).name) : null
    const now = new Date()
    const patch = {
      status: 'configured',
      config: valid.config,
      accountLabel,
      useOrgConnection,
      // Preserve an existing secretRef when this POST didn't carry a new secret.
      secretRef: secretRef ?? (existing?.secretRef ?? null),
      lastError: null,
      updatedAt: now,
    }
    if (existing) {
      await db.update(schema.agentConnectors).set(patch).where(eq(schema.agentConnectors.id, existing.id))
    } else {
      await db.insert(schema.agentConnectors).values({ id: randomUUID(), orgId, agentId, connectorId: cid, lastTestedAt: null, createdAt: now, ...patch })
    }
    const row = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    reply.code(existing ? 200 : 201)
    return { connector: { connectorId: meta.id, name: meta.name, category: meta.category, authType: meta.authType, ...toPublicConnector(row!) } }
  })

  // Update NON-SECRET config only — the stored credential is untouched.
  app.put('/api/orgs/:orgId/agents/:agentId/connectors/:cid/config', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const existing = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    if (!existing) return reply.code(404).send({ error: 'Connector not configured' })
    const valid = validateConnectorConfig(cid, ((req.body ?? {}) as any).config)
    if (valid.ok !== true) return reply.code(400).send({ error: valid.error })
    const accountLabel = typeof (valid.config as any).name === 'string' ? String((valid.config as any).name) : existing.accountLabel
    await db.update(schema.agentConnectors)
      .set({ config: valid.config, accountLabel, updatedAt: new Date() })
      .where(eq(schema.agentConnectors.id, existing.id))
    const row = await db.query.agentConnectors.findFirst({ where: eq(schema.agentConnectors.id, existing.id) })
    return { connector: { connectorId: meta.id, name: meta.name, category: meta.category, authType: meta.authType, ...toPublicConnector(row!) } }
  })

  // Test: a basic connectivity check. For custom MCP, CONN-1 does NOT dial the
  // arbitrary user-supplied server from the backend (SSRF surface — real per-connector
  // tests land in a later stage); it confirms the connector is configured and records
  // the attempt. Returns a clean, credential-free result.
  app.post('/api/orgs/:orgId/agents/:agentId/connectors/:cid/test', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const row = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    if (!row) return reply.code(400).send({ ok: false, error: 'not configured' })
    const now = new Date()
    await db.update(schema.agentConnectors)
      .set({ lastTestedAt: now, lastError: null, status: 'configured', updatedAt: now })
      .where(eq(schema.agentConnectors.id, row.id))
    return { ok: true, detail: row.accountLabel ?? meta.name, testedAt: now.toISOString() }
  })

  // Disconnect: remove the row AND its agent-scoped secret.
  app.delete('/api/orgs/:orgId/agents/:agentId/connectors/:cid', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const row = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    if (row) {
      await db.delete(schema.agentConnectors).where(eq(schema.agentConnectors.id, row.id))
      if (row.secretRef) await delAgentSecret(orgId, agentId, row.secretRef)
    }
    reply.code(204)
  })
}
