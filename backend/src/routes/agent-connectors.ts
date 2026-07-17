import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { encrypt, decrypt, resolveSecretsForAgent, AGENT_RESOLVABLE_SCOPES } from '../services/secrets'
import { inArray } from 'drizzle-orm'
import { requireOrgRole } from '../middleware/rbac'
import {
  AGENT_CONNECTORS, getAgentConnector, validateConnectorConfig,
  toPublicConnector, connectorEnvKeys, primarySecretKey,
  connectorSecretEntries, connectorAccountLabel, isAtlassianHost,
  isValidTrustLevel, TRUST_LEVELS,
} from '../services/agent-connectors'
import { authorizeConnectorAction } from '../services/connector-authz'
import {
  buildAgentAuthUrl, createOauthState, scopesForServices, hasAnyService,
  normalizeServices, ensureFreshAgentGoogleToken, deleteAgentGoogleToken,
} from '../services/agent-google-auth'
import { allowedRedirectOrigin } from '../services/oauth-redirect'

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

/** Resolve the effective env bag for an agent EXACTLY as `GET /api/agent/secrets`
 *  does: fetch the org's company + agent scoped rows, decrypt, then layer company
 *  then agent overrides. This is what the runtime actually receives — so a live
 *  `test` uses the same credential the agent would, incl. a company default when the
 *  connector inherits the org connection (useOrgConnection). Never returned to a
 *  client. */
async function resolveAgentEnv(orgId: string, agentId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.secrets).where(and(
    eq(schema.secrets.orgId, orgId),
    inArray(schema.secrets.scope, [...AGENT_RESOLVABLE_SCOPES]),
  ))
  const decrypted = rows
    .map(s => { try { return { scope: s.scope, scopeId: s.scopeId, key: s.key, value: decrypt(s.valueEncrypted) } } catch { return null } })
    .filter(Boolean) as { scope: string; scopeId: string | null; key: string; value: string }[]
  return resolveSecretsForAgent(decrypted, agentId)
}

/** A live, SSRF-safe connectivity check for the token/basic connectors. Only ever
 *  dials a KNOWN provider host (api.github.com hardcoded; Jira must be
 *  `*.atlassian.net` — a self-hosted Jira is not dialed) using the agent's RESOLVED
 *  credential. Returns a clean {ok, detail?, error?} — the credential is NEVER
 *  echoed. `mcp` stays a stub (CONN-1: no arbitrary-URL dial from the backend). */
async function providerTest(
  cid: string, env: Record<string, string>,
): Promise<{ ok: boolean; detail?: string; error?: string; skipped?: boolean }> {
  const signal = AbortSignal.timeout(8000)
  if (cid === 'github') {
    const token = env.GITHUB_TOKEN
    if (!token) return { ok: false, error: 'No GitHub token configured' }
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': '7ei-mc', Accept: 'application/json' },
      redirect: 'manual', signal, // defense-in-depth: a provider 3xx can't chain elsewhere
    })
    if (!r.ok) return { ok: false, error: `GitHub returned ${r.status}` }
    const j = await r.json().catch(() => ({})) as any
    return { ok: true, detail: String(j.login ?? j.name ?? 'GitHub') }
  }
  if (cid === 'jira') {
    const base = env.JIRA_BASE_URL, email = env.JIRA_EMAIL, token = env.JIRA_API_TOKEN
    if (!base || !email || !token) return { ok: false, error: 'Incomplete Jira credentials' }
    if (!isAtlassianHost(base)) return { ok: true, skipped: true, detail: `${email} (live check skipped — non-Atlassian host)` }
    const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
    const r = await fetch(`${base.replace(/\/+$/, '')}/rest/api/3/myself`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      redirect: 'manual', signal, // defense-in-depth: a provider 3xx can't chain elsewhere
    })
    if (!r.ok) return { ok: false, error: `Jira returned ${r.status}` }
    const j = await r.json().catch(() => ({})) as any
    return { ok: true, detail: String(j.displayName ?? j.emailAddress ?? email) }
  }
  return { ok: true } // mcp stub
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
        ...(row ? toPublicConnector(row) : { status: 'not_configured', config: null, accountLabel: null, useOrgConnection: false, trustLevel: 'approval_required', lastTestedAt: null, lastError: null }),
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
    if (!row) return { connector: { ...base, status: 'not_configured', config: null, accountLabel: null, useOrgConnection: false, trustLevel: 'approval_required', lastTestedAt: null, lastError: null } }
    return { connector: { ...base, ...toPublicConnector(row) } }
  })

  // Configure (create or replace): validate the NON-SECRET config, encrypt any
  // credential into an agent-scoped secret, upsert the row. Returns the MASKED row.
  app.post('/api/orgs/:orgId/agents/:agentId/connectors/:cid', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })

    // OAuth connectors (Google) are connected via the dedicated start/callback flow,
    // never by POSTing a credential here — reject so no half-connected row (config
    // without tokens) can be created out-of-band. See the /oauth/start route.
    if (meta.authType === 'oauth') {
      return reply.code(400).send({ error: `Connect ${meta.name} via the OAuth flow (/connectors/${cid}/oauth/start), not this endpoint.` })
    }

    const body = (req.body ?? {}) as any
    const valid = validateConnectorConfig(cid, body.config)
    if (valid.ok !== true) return reply.code(400).send({ error: valid.error })

    const existing = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })

    const useOrgConnection = body.useOrgConnection === true
    const providedSecret = typeof body.secret === 'string' && body.secret.trim() ? body.secret.trim() : undefined

    // A required credential must be supplied on the FIRST configure, unless the
    // connector inherits the org connection (then the company-scope secret flows).
    if (meta.secretRequired && !useOrgConnection && !providedSecret && !existing?.secretRef) {
      return reply.code(400).send({ error: `${meta.name} requires a credential` })
    }

    // Write the connector's agent-scoped env entries — the EXACT keys the runtime
    // injects (GITHUB_TOKEN; JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN;
    // CONNECTOR_MCP_SECRET). Non-secret entries (Jira base/email) always refresh from
    // config; the sensitive credential only when a new secret is supplied. The
    // plaintext is encrypted at agent scope and never touches the row.
    let secretRef: string | null = existing?.secretRef ?? null
    if (useOrgConnection) {
      // Inheriting the org connection: drop any agent-scoped credential we may hold.
      for (const k of connectorEnvKeys(cid)) await delAgentSecret(orgId, agentId, k)
      secretRef = null
    } else if (meta.hasSecret) {
      const entries = connectorSecretEntries(cid, valid.config as any, providedSecret)
      for (const [k, v] of Object.entries(entries)) await setAgentSecret(orgId, agentId, k, v)
      if (providedSecret) secretRef = primarySecretKey(cid)
    }

    // A masked label derived from the non-secret config (never a credential).
    const accountLabel = connectorAccountLabel(cid, valid.config as any)
    const now = new Date()
    const patch = {
      status: 'configured',
      config: valid.config,
      accountLabel,
      useOrgConnection,
      secretRef, // already resolved above (new credential, preserved, or cleared on inherit)
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
    if (meta.authType === 'oauth') {
      return reply.code(400).send({ error: `${meta.name} is managed through the OAuth flow — reconnect to change its scopes.` })
    }
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const existing = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    if (!existing) return reply.code(404).send({ error: 'Connector not configured' })
    const valid = validateConnectorConfig(cid, ((req.body ?? {}) as any).config)
    if (valid.ok !== true) return reply.code(400).send({ error: valid.error })
    const accountLabel = connectorAccountLabel(cid, valid.config as any) ?? existing.accountLabel
    // Re-sync the NON-SECRET env entries (e.g. Jira base/email) so a changed base URL
    // reaches the runtime — the stored credential is untouched (no `secret` here).
    if (!existing.useOrgConnection) {
      const entries = connectorSecretEntries(cid, valid.config as any, undefined)
      for (const [k, v] of Object.entries(entries)) await setAgentSecret(orgId, agentId, k, v)
    }
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

    // github/jira do a REAL, SSRF-safe provider check (known hosts only) using the
    // agent's RESOLVED credential; mcp + the CONN-6 comms connectors stay STUBS (no
    // arbitrary-URL / provider dial — execution is CONN-8). Any network/credential
    // failure records a clean, credential-free lastError.
    let result: { ok: boolean; detail?: string; error?: string }
    if (cid === 'mcp' || cid === 'telegram' || cid === 'whatsapp' || cid === 'google_chat') {
      result = { ok: true, detail: row.accountLabel ?? meta.name }
    } else if (cid === 'google') {
      // Google: prove the stored (encrypted, agent-scoped) token still refreshes and
      // authenticates — never echoes the token. A missing/expired-no-refresh token
      // reports cleanly so the operator knows to reconnect.
      try {
        const tok = await ensureFreshAgentGoogleToken(orgId, agentId)
        result = tok
          ? { ok: true, detail: tok.accountEmail ?? row.accountLabel ?? 'Google connected' }
          : { ok: false, error: 'Google token expired — reconnect' }
      } catch {
        result = { ok: false, error: 'Google unreachable' }
      }
    } else {
      try {
        result = await providerTest(cid, await resolveAgentEnv(orgId, agentId))
      } catch {
        result = { ok: false, error: `${meta.name} unreachable` }
      }
    }

    const now = new Date()
    await db.update(schema.agentConnectors)
      .set({ lastTestedAt: now, lastError: result.ok ? null : (result.error ?? 'test failed'), status: result.ok ? 'configured' : 'error', updatedAt: now })
      .where(eq(schema.agentConnectors.id, row.id))
    return { ok: result.ok, detail: result.detail ?? row.accountLabel ?? meta.name, ...(result.ok ? {} : { error: result.error }), testedAt: now.toISOString() }
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
      // Purge EVERY agent-scoped env key this connector may have written (the
      // credential AND any non-secret env like Jira base/email), not just secretRef.
      for (const k of connectorEnvKeys(cid)) await delAgentSecret(orgId, agentId, k)
    }
    // Google (OAuth): the tokens live in the ENCRYPTED agent_oauth_tokens table, not
    // the env bag — best-effort revoke them at Google and purge the row. Runs even if
    // the connector row was already gone, so a stale token can't be orphaned.
    if (cid === 'google') {
      try { await deleteAgentGoogleToken(orgId, agentId) } catch { /* purge is best-effort; row already deleted */ }
    }
    reply.code(204)
  })

  // ─── Trust level (owner-gated) — CONN-7 containment ───────────────────────────
  //
  // Set the per-agent per-connector TRUST for a CONFIGURED connector:
  //   'approval_required' (default) — every WRITE/DESTRUCTIVE action routes through
  //                                   the approval + step-up flow.
  //   'auto_write'                  — WRITE actions are auto-approved for this pair;
  //                                   DESTRUCTIVE actions STILL require approval.
  // Owner-only (the enforcer is the backend); the value is an ENUM, never a secret.
  app.put('/api/orgs/:orgId/agents/:agentId/connectors/:cid/trust', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const trustLevel = ((req.body ?? {}) as any).trustLevel
    if (!isValidTrustLevel(trustLevel)) {
      return reply.code(400).send({ error: `trustLevel must be one of: ${TRUST_LEVELS.join(', ')}` })
    }
    const existing = await db.query.agentConnectors.findFirst({
      where: and(eq(schema.agentConnectors.orgId, orgId), eq(schema.agentConnectors.agentId, agentId), eq(schema.agentConnectors.connectorId, cid)),
    })
    if (!existing) return reply.code(404).send({ error: 'Connector not configured' })
    await db.update(schema.agentConnectors)
      .set({ trustLevel, updatedAt: new Date() })
      .where(eq(schema.agentConnectors.id, existing.id))
    const row = await db.query.agentConnectors.findFirst({ where: eq(schema.agentConnectors.id, existing.id) })
    return { connector: { connectorId: meta.id, name: meta.name, category: meta.category, authType: meta.authType, ...toPublicConnector(row!) } }
  })

  // ─── Authorize a connector action (owner-gated) — CONN-7 enforcement chokepoint ─
  //
  // The policy CONN-8's execution bridge MUST consult before running a connector
  // action. Returns { decision: allow | needs_approval | deny, reason, classification
  // } and, when needs_approval, the pending approval_requests id (filed as a dangerous
  // `connector_action` type → shows in the Inbox + requires step-up to approve). This
  // route exercises the SAME `authorizeConnectorAction` service CONN-8 calls directly;
  // it does NOT execute anything. Owner-gated + tenant-scoped like every sibling.
  app.post('/api/orgs/:orgId/agents/:agentId/connectors/:cid/authorize', owner, async (req, reply) => {
    const { orgId, agentId, cid } = req.params as any
    const meta = getAgentConnector(cid)
    if (!meta) return reply.code(404).send({ error: 'Unknown connector' })
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    const b = (req.body ?? {}) as any
    const action = typeof b.action === 'string' ? b.action : ''
    const result = await authorizeConnectorAction({
      orgId, agentId, connectorId: cid, action,
      target: typeof b.target === 'string' ? b.target : null,
    })
    return result
  })

  // ─── Google OAuth start (owner-gated) — CONN-5 ────────────────────────────────
  //
  // Begin the per-agent Google flow: pick the services (calendar/gmail/drive), mint a
  // SINGLE-USE, expiring, PKCE-bearing state row bound to THIS (org, agent), and return
  // the Google consent URL. The browser navigates there; Google redirects to the PUBLIC
  // callback (routes/agent-auth-google.ts) with ?code&state. No token is minted here.
  app.post('/api/orgs/:orgId/agents/:agentId/connectors/google/oauth/start', owner, async (req, reply) => {
    const { orgId, agentId } = req.params as any
    if (!(await agentInOrg(orgId, agentId))) return reply.code(404).send({ error: 'Agent not found' })
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.PUBLIC_URL) {
      return reply.code(503).send({ error: 'Google OAuth is not configured on this deployment' })
    }
    const services = normalizeServices((req.body as any)?.services)
    // Default to all three when the client sends nothing; require at least one so a
    // grant is never identity-only (useless).
    const chosen = hasAnyService(services) ? services : normalizeServices({ calendar: true, gmail: true, drive: true })
    const scopes = scopesForServices(chosen)
    const origin = allowedRedirectOrigin(null)
    const { id, challenge } = await createOauthState({
      orgId, agentId, connectorId: 'google', provider: 'google', scopes, redirectOrigin: origin,
    })
    const url = buildAgentAuthUrl({ state: id, scopes, challenge })
    return { url }
  })
}
