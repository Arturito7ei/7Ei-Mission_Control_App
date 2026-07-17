// Epic CONN / CONN-7 — the connector CONTAINMENT / trust + approval layer.
//
// This suite is the security net for the policy CONN-8 will consult before running a
// connector action. It proves, against REAL handlers on a REAL SQLite file through the
// REAL owner gate + the REAL approval/step-up decide route:
//   1. the pure taxonomy classifies read/write/destructive and fails CLOSED on unknown;
//   2. the pure decision: read→allow, write-not-trusted→needs_approval, write-trusted→
//      allow, destructive→needs_approval EVEN when trusted, missing cap→deny, not
//      configured→deny;
//   3. `authorizeConnectorAction` files a dangerous `connector_action` approval when it
//      needs approval — and that approval requires STEP-UP to approve (no bypass);
//   4. the trust toggle is OWNER-only (member→403) and the value is never a secret;
//   5. tenant scoping holds; the migration/classification stays green.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'conn7-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'conn7-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const {
  classifyConnectorAction, decideConnectorAuthorization, authorizeConnectorAction,
  connectorCapability, hasConnectorCapability, CONNECTOR_ACTION_TAXONOMY,
} = await import('../services/connector-authz')
const { isValidTrustLevel, normalizeTrustLevel, PUBLIC_CONNECTOR_FIELDS, SECRET_CONNECTOR_FIELDS } =
  await import('../services/agent-connectors')
const { isDangerousType, requiresStepUp } = await import('../services/dangerous-approvals')
const { decideApproval } = await import('../services/approvals')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org7', OWNER = 'owner7', MEMBER = 'member7'
const AGENT = 'agent7'            // has connector:* capability
const AGENT_NOCAP = 'agent7-nocap' // has caps that EXCLUDE connectors
const OTHER_ORG = 'org7-other', OTHER_OWNER = 'owner7-other', OTHER_AGENT = 'agent7-other'

let app: FastifyInstance
function appAs(userId: string) {
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentConnectorRoutes)
  return a
}
const url = (orgId: string, agentId: string, tail = '') => `/api/orgs/${orgId}/agents/${agentId}/connectors${tail}`

async function configureGithub(agentId = AGENT) {
  // Configure github with a credential so it is "configured" for authorization tests.
  return app.inject({ method: 'POST', url: url(ORG, agentId, '/github'), payload: { config: { username: 'octo' }, secret: 'ghp_SENTINEL_conn7' } })
}

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([
    { id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now },
    { id: OTHER_ORG, name: 'Rivals', ownerId: OTHER_OWNER, createdAt: now },
  ] as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
    { id: randomUUID(), orgId: ORG, userId: MEMBER, role: 'member', createdAt: now },
    { id: randomUUID(), orgId: OTHER_ORG, userId: OTHER_OWNER, role: 'owner', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), createdAt: now },
    { id: AGENT_NOCAP, orgId: ORG, name: 'Locked', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['memory:write']), createdAt: now },
    { id: OTHER_AGENT, orgId: OTHER_ORG, name: 'Spy', role: 'Analyst', skills: [], runtime: 'internal', createdAt: now },
  ] as any)
  app = appAs(OWNER)
  await app.ready()
  await configureGithub()
})

after(async () => {
  await app?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── 1. The pure taxonomy / classification ────────────────────────────────────

test('[CONN7-TAX] github read/write/destructive classify as expected', () => {
  assert.equal(classifyConnectorAction('github', 'get_issue'), 'read')
  assert.equal(classifyConnectorAction('github', 'issue.create'), 'write')
  assert.equal(classifyConnectorAction('github', 'push'), 'write')
  assert.equal(classifyConnectorAction('github', 'delete_repo'), 'destructive')
  assert.equal(classifyConnectorAction('github', 'branch.delete'), 'destructive')
})

test('[CONN7-TAX] gmail send=write, read=read, delete=destructive; comms send=write', () => {
  assert.equal(classifyConnectorAction('google', 'read'), 'read')
  assert.equal(classifyConnectorAction('google', 'send'), 'write')
  assert.equal(classifyConnectorAction('google', 'delete_file'), 'destructive')
  assert.equal(classifyConnectorAction('telegram', 'send_message'), 'write')
  assert.equal(classifyConnectorAction('whatsapp', 'send'), 'write')
  assert.equal(classifyConnectorAction('google_chat', 'post'), 'write')
})

test('[CONN7-TAX] mcp tool calls are WRITE by default (unknown tool = err on approval)', () => {
  assert.equal(classifyConnectorAction('mcp', 'some_random_tool'), 'write')
  // …but a destructive-looking mcp tool is bumped to destructive by the keyword guard.
  assert.equal(classifyConnectorAction('mcp', 'delete_everything'), 'destructive')
})

test('[CONN7-TAX] FAIL-CLOSED: an unrecognized action on a known provider is UNKNOWN', () => {
  // github defaults to 'unknown' (NOT write) so trust cannot auto-approve a verb we
  // don't recognize — but a write/read keyword still lands it sensibly.
  assert.equal(classifyConnectorAction('github', 'frobnicate_the_repo'), 'unknown')
  assert.equal(classifyConnectorAction('jira', 'wormhole'), 'unknown')
  // An unknown CONNECTOR is unknown, and a blank action is unknown.
  assert.equal(classifyConnectorAction('nope', 'read'), 'unknown')
  assert.equal(classifyConnectorAction('github', ''), 'unknown')
})

test('[CONN7-TAX] destructive keyword overrides even when not explicitly listed', () => {
  assert.equal(classifyConnectorAction('jira', 'purge_project'), 'destructive')
  assert.equal(classifyConnectorAction('google', 'wipe_mailbox'), 'destructive')
})

test('[CONN7-TAX] AUDIT: destructive verb survives camelCase / no-separator spelling', () => {
  // Regression for the audit finding: the separator-only guard missed camelCase and
  // concatenated destructive verbs, so on a defaultClass='write' connector (mcp/comms)
  // a trusted `auto_write` pair auto-APPROVED a destructive action. Every spelling of a
  // destructive verb must classify 'destructive' (→ always needs approval, even trusted).
  for (const a of ['deleteFile', 'dropTable', 'purgeAll', 'wipeDatabase', 'revokeAccess',
    'deleteAllRecords', 'forceDelete', 'hardDelete', 'bulkDrop']) {
    assert.equal(classifyConnectorAction('mcp', a), 'destructive', `mcp '${a}' must be destructive`)
  }
  assert.equal(classifyConnectorAction('telegram', 'deleteMessage'), 'destructive')
  assert.equal(classifyConnectorAction('whatsapp', 'deleteMessage'), 'destructive')
  assert.equal(classifyConnectorAction('google_chat', 'deleteMessage'), 'destructive')
  // …and a trusted connector STILL cannot auto-approve it (the whole point).
  assert.equal(decideConnectorAuthorization({
    hasCapability: true, connectorConfigured: true,
    classification: classifyConnectorAction('mcp', 'deleteFile'), trustLevel: 'auto_write',
  }).decision, 'needs_approval')
  // Benign tokens that merely CONTAIN a verb are NOT swept up (token-level, not substring).
  assert.equal(classifyConnectorAction('github', 'get_deleted_items'), 'read')
  assert.equal(classifyConnectorAction('mcp', 'undelete'), 'write')
  assert.equal(classifyConnectorAction('mcp', 'dropdown_options'), 'write')
})

test('[CONN7-TAX] AUDIT+: casing / plural / spacing / benign-substring edge cases', () => {
  // All-caps, PascalCase, plural, and odd spacing must all still surface the verb.
  for (const a of ['DELETE', 'DeleteFile', 'PurgeAll', 'deletes', 'drops',
    'delete  file', 'delete.all.records', 'force-delete', 'DROP TABLE', 'WipeDisk']) {
    assert.equal(classifyConnectorAction('mcp', a), 'destructive', `mcp '${a}' must be destructive`)
  }
  // More benign words that CONTAIN a destructive substring but are not the verb token.
  for (const a of ['backdrop', 'eavesdrop', 'redeliver', 'removable_media_list', 'address_get']) {
    assert.notEqual(classifyConnectorAction('mcp', a), 'destructive', `mcp '${a}' must NOT be destructive`)
  }
  // A normal WRITE (send) on a comms connector stays WRITE, so auto_write CAN allow it.
  assert.equal(classifyConnectorAction('telegram', 'send_message'), 'write')
  assert.equal(decideConnectorAuthorization({
    hasCapability: true, connectorConfigured: true,
    classification: classifyConnectorAction('telegram', 'send_message'), trustLevel: 'auto_write',
  }).decision, 'allow')
})

test('[CONN7-AUTHZ] AUDIT: a camelCase destructive action on a TRUSTED mcp still needs approval (end-to-end)', async () => {
  // Configure mcp for AGENT and trust it (auto_write), then a camelCase destructive
  // action must STILL file an approval — proving the fix holds through the real service.
  await app.inject({ method: 'POST', url: url(ORG, AGENT, '/mcp'), payload: { config: { name: 'srv', transport: 'http', url: 'https://mcp.example.com' } } })
  const t = await app.inject({ method: 'PUT', url: url(ORG, AGENT, '/mcp/trust'), payload: { trustLevel: 'auto_write' } })
  assert.equal(t.statusCode, 200, t.body)
  const r = await authorizeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'deleteEverything' })
  assert.equal(r.classification, 'destructive')
  assert.equal(r.decision, 'needs_approval')
  assert.ok(r.approvalId, 'a trusted mcp destructive action must still file an approval')
})

test('[CONN7-CAP] connector capability grammar + wildcard matching', () => {
  assert.equal(connectorCapability('github'), 'connector:github')
  assert.equal(hasConnectorCapability(['connector:github'], 'github'), true)
  assert.equal(hasConnectorCapability(['connector:*'], 'github'), true)
  assert.equal(hasConnectorCapability(['*'], 'github'), true)
  assert.equal(hasConnectorCapability([], 'github'), true) // empty = allow-all (legacy default)
  assert.equal(hasConnectorCapability(['memory:write'], 'github'), false)
  assert.equal(hasConnectorCapability(['connector:jira'], 'github'), false)
})

// ─── 2. The pure decision ──────────────────────────────────────────────────────

test('[CONN7-DEC] read→allow; write-not-trusted→needs_approval; write-trusted→allow', () => {
  const base = { hasCapability: true, connectorConfigured: true } as const
  assert.equal(decideConnectorAuthorization({ ...base, classification: 'read', trustLevel: 'approval_required' }).decision, 'allow')
  assert.equal(decideConnectorAuthorization({ ...base, classification: 'write', trustLevel: 'approval_required' }).decision, 'needs_approval')
  assert.equal(decideConnectorAuthorization({ ...base, classification: 'write', trustLevel: 'auto_write' }).decision, 'allow')
})

test('[CONN7-DEC] destructive→needs_approval EVEN when trusted; unknown→needs_approval', () => {
  const base = { hasCapability: true, connectorConfigured: true } as const
  assert.equal(decideConnectorAuthorization({ ...base, classification: 'destructive', trustLevel: 'auto_write' }).decision, 'needs_approval')
  assert.equal(decideConnectorAuthorization({ ...base, classification: 'unknown', trustLevel: 'auto_write' }).decision, 'needs_approval')
})

test('[CONN7-DEC] missing capability→deny; not configured→deny (fail-closed, before classification)', () => {
  assert.equal(decideConnectorAuthorization({ hasCapability: false, connectorConfigured: true, classification: 'read', trustLevel: 'auto_write' }).decision, 'deny')
  assert.equal(decideConnectorAuthorization({ hasCapability: true, connectorConfigured: false, classification: 'read', trustLevel: 'auto_write' }).decision, 'deny')
})

// ─── 3. authorizeConnectorAction end-to-end (IO + the approval it files) ───────

test('[CONN7-AUTHZ] a READ on a configured, capable agent → allow, no approval filed', async () => {
  const r = await authorizeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'get_issue' })
  assert.equal(r.decision, 'allow')
  assert.equal(r.approvalId, undefined)
})

test('[CONN7-AUTHZ] a WRITE (not trusted) → needs_approval + a pending connector_action approval', async () => {
  const r = await authorizeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', target: 'org/repo#1' })
  assert.equal(r.decision, 'needs_approval')
  assert.ok(r.approvalId, 'a needs_approval must file an approval')
  const ap = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, r.approvalId!) })
  assert.ok(ap, 'the approval row must exist')
  assert.equal(ap!.type, 'connector_action')
  assert.equal(ap!.status, 'pending')
  assert.equal(ap!.orgId, ORG)
  // Dangerous type → the payload carries requiresStepUp and a machine-rendered summary.
  assert.equal((ap!.payload as any)?.requiresStepUp, true)
  assert.ok(String(ap!.summary).includes('issue.create'))
  // No credential leaks into the card.
  assert.equal(JSON.stringify(ap).includes('ghp_SENTINEL_conn7'), false)
})

test('[CONN7-AUTHZ] a WRITE on a TRUSTED connector → allow, no approval', async () => {
  // Flip trust to auto_write via the owner route, then a write auto-approves.
  const t = await app.inject({ method: 'PUT', url: url(ORG, AGENT, '/github/trust'), payload: { trustLevel: 'auto_write' } })
  assert.equal(t.statusCode, 200, t.body)
  const r = await authorizeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'push' })
  assert.equal(r.decision, 'allow')
  assert.equal(r.approvalId, undefined)
  // …but a DESTRUCTIVE action STILL needs approval even though trusted.
  const d = await authorizeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'delete_repo' })
  assert.equal(d.decision, 'needs_approval')
  assert.ok(d.approvalId)
  // reset trust for later tests
  await app.inject({ method: 'PUT', url: url(ORG, AGENT, '/github/trust'), payload: { trustLevel: 'approval_required' } })
})

test('[CONN7-AUTHZ] missing connector: capability → deny', async () => {
  // AGENT_NOCAP has 'memory:write' only. Configure github for it first (as owner).
  await configureGithub(AGENT_NOCAP)
  const r = await authorizeConnectorAction({ orgId: ORG, agentId: AGENT_NOCAP, connectorId: 'github', action: 'get_issue' })
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /capability/)
})

test('[CONN7-AUTHZ] connector not configured → deny', async () => {
  // AGENT has capability but jira is not configured for it.
  const r = await authorizeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'get_issue' })
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /not configured/)
})

test('[CONN7-AUTHZ] unknown connector / cross-tenant agent → deny (fail-closed)', async () => {
  assert.equal((await authorizeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'bogus', action: 'read' })).decision, 'deny')
  assert.equal((await authorizeConnectorAction({ orgId: ORG, agentId: OTHER_AGENT, connectorId: 'github', action: 'read' })).decision, 'deny')
})

// ─── 4. No bypass of the step-up gate (the whole point of routing through approvals) ─

test('[CONN7-STEPUP] approving a connector_action WITHOUT a fresh session is refused', async () => {
  // The decide route (routes/tasks.ts) enforces step-up for dangerous types. Prove the
  // gate binds for connector_action at the pure-decision layer the route uses.
  assert.equal(isDangerousType('connector_action'), true)
  assert.equal(requiresStepUp('connector_action'), true)
  // Approve without step-up → refused; reject WITHOUT step-up passes (you can always decline).
  const noStepUp = decideApproval({ decision: 'approved', actor: 'human', requireStepUp: true, stepUpSatisfied: false })
  assert.equal(noStepUp.ok, false)
  assert.match(String((noStepUp as any).error), /step-up/)
  const withStepUp = decideApproval({ decision: 'approved', actor: 'human', requireStepUp: true, stepUpSatisfied: true })
  assert.equal(withStepUp.ok, true)
  const reject = decideApproval({ decision: 'rejected', actor: 'human', requireStepUp: true, stepUpSatisfied: false })
  assert.equal(reject.ok, true)
})

// ─── 5. Trust toggle: owner-only, tenant-scoped, enum-only ─────────────────────

test('[CONN7-TRUST] a MEMBER cannot set trust → 403, value unchanged', async () => {
  const member = appAs(MEMBER); await member.ready()
  const res = await member.inject({ method: 'PUT', url: url(ORG, AGENT, '/github/trust'), payload: { trustLevel: 'auto_write' } })
  assert.equal(res.statusCode, 403, res.body)
  const row = await db.query.agentConnectors.findFirst({ where: and(eq(schema.agentConnectors.orgId, ORG), eq(schema.agentConnectors.agentId, AGENT), eq(schema.agentConnectors.connectorId, 'github')) })
  assert.equal(row!.trustLevel, 'approval_required', 'a refused trust write must not land')
  await member.close()
})

test('[CONN7-TRUST] owner setting an invalid trust value → 400', async () => {
  const res = await app.inject({ method: 'PUT', url: url(ORG, AGENT, '/github/trust'), payload: { trustLevel: 'yolo' } })
  assert.equal(res.statusCode, 400, res.body)
})

test('[CONN7-TRUST] trust on an unconfigured connector → 404', async () => {
  const res = await app.inject({ method: 'PUT', url: url(ORG, AGENT, '/jira/trust'), payload: { trustLevel: 'auto_write' } })
  assert.equal(res.statusCode, 404, res.body)
})

test('[CONN7-TRUST] cross-tenant trust write → 404, nothing changed', async () => {
  const res = await app.inject({ method: 'PUT', url: url(ORG, OTHER_AGENT, '/github/trust'), payload: { trustLevel: 'auto_write' } })
  assert.equal(res.statusCode, 404, res.body)
})

test('[CONN7-TRUST] trustLevel is a returnable ENUM (public), secretRef stays secret', () => {
  assert.ok((PUBLIC_CONNECTOR_FIELDS as readonly string[]).includes('trustLevel'), 'trustLevel must be public (an enum)')
  assert.ok(!(SECRET_CONNECTOR_FIELDS as readonly string[]).includes('trustLevel'))
  assert.equal(isValidTrustLevel('approval_required'), true)
  assert.equal(isValidTrustLevel('auto_write'), true)
  assert.equal(isValidTrustLevel('anything'), false)
  assert.equal(normalizeTrustLevel(undefined), 'approval_required') // fail-safe to the stricter level
  assert.equal(normalizeTrustLevel('auto_write'), 'auto_write')
})

// ─── 6. The authorize ROUTE (owner-gated) mirrors the service ──────────────────

test('[CONN7-ROUTE] the authorize route returns the decision + files the same approval', async () => {
  const res = await app.inject({ method: 'POST', url: url(ORG, AGENT, '/github/authorize'), payload: { action: 'issue.comment' } })
  assert.equal(res.statusCode, 200, res.body)
  const body = JSON.parse(res.body)
  assert.equal(body.decision, 'needs_approval')
  assert.equal(body.classification, 'write')
  assert.ok(body.approvalId)
})

test('[CONN7-ROUTE] a MEMBER cannot call the authorize route → 403', async () => {
  const member = appAs(MEMBER); await member.ready()
  const res = await member.inject({ method: 'POST', url: url(ORG, AGENT, '/github/authorize'), payload: { action: 'issue.comment' } })
  assert.equal(res.statusCode, 403, res.body)
  await member.close()
})

test('[CONN7-TAX] every AVAILABLE backend connector has a taxonomy entry', async () => {
  const { AGENT_CONNECTORS } = await import('../services/agent-connectors')
  for (const meta of AGENT_CONNECTORS) {
    assert.ok(CONNECTOR_ACTION_TAXONOMY[meta.id], `connector '${meta.id}' must have an action taxonomy (fail-closed policy needs it)`)
  }
})
