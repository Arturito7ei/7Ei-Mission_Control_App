// Epic CONN / CONN-8a — the connector EXECUTION FRAMEWORK + GitHub executor.
//
// The security net for the highest-consequence stage of the epic: an agent making a
// REAL external call with a REAL credential. Proven here, against a REAL SQLite file
// through the REAL connector-config + approval/step-up decide routes, with a MOCKED
// GitHub transport (never a real network call):
//   1. fail-closed authorization — no capability / legacy allow-all / not configured /
//      unsupported connector → NOT executed;
//   2. WRITE not trusted → NOT executed, a connector_action approval is filed, step-up
//      is required to approve it;
//   3. a gated action executed WITHOUT an approved+stepped-up approval → rejected;
//      approved+stepped-up → executes EXACTLY once, replay rejected (single-use);
//   4. auto_write WRITE executes; DESTRUCTIVE under auto_write still needs approval;
//   5. the credential is used for the call but NEVER appears in a result, an error, or
//      the ledger (sentinel); SSRF is closed (host fixed, params can't inject a host);
//   6. tenant/agent scoping holds; the executor's classes match the CONN-7 taxonomy.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'conn8a-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'conn8a-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const { taskRoutes } = await import('../routes/tasks')
const { agentApiRoutes } = await import('../routes/agent-api')
const {
  executeConnectorAction, hasExplicitConnectorCapability, mustEscalateUnknownWrite,
  redactSecrets, getExecutor,
} = await import('../services/connector-execution')
const { githubExecutor } = await import('../services/connector-github')
const { classifyConnectorAction } = await import('../services/connector-authz')
const { renderActionSummary } = await import('../services/dangerous-approvals')
const { mintSession } = await import('../services/arturita-session')
const { hashToken: hashAgentToken } = await import('../middleware/agent-token')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org8', OWNER = 'owner8', MEMBER = 'member8'
const AGENT = 'agent8'                 // connector:* + github configured (the workhorse)
const AGENT2 = 'agent8-two'            // a SECOND capable+configured agent (cross-agent redemption)
const AGENT_NOCAP = 'agent8-nocap'     // caps EXCLUDE connectors; github configured
const AGENT_EMPTY = 'agent8-empty'     // EMPTY permissions (legacy allow-all); github configured
const OTHER_ORG = 'org8-other', OTHER_OWNER = 'owner8-other', OTHER_AGENT = 'agent8-other'
const SENTINEL = 'ghp_SENTINEL_conn8a' // the GitHub PAT — must NEVER surface in a result/log
const AGENT_TOKEN = 'mca_conn8a_token_for_route_wiring'
const NOCAP_TOKEN = 'mca_conn8a_token_nocap'

let owner: FastifyInstance   // owner-authed: configure/trust + decide
let route: FastifyInstance   // the real agent-facing execute route (agentAuth)

const cu = (agentId: string, tail = '') => `/api/orgs/${ORG}/agents/${agentId}/connectors${tail}`

// ── a mock GitHub transport — records every call, canned/overridable responses ──
function jsonRes(status: number, obj: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(obj)
  return { status, ok: status >= 200 && status < 300, headers, json: async () => obj, text: async () => body }
}
function makeHttp(responder?: (url: string, init: any) => any) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const client = async (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (responder) return responder(url, init)
    if (init.method === 'GET') return jsonRes(200, { id: 1, full_name: 'octo/hello', number: 7 })
    if (init.method === 'POST') return jsonRes(201, { id: 100, number: 7, html_url: 'https://github.com/octo/hello/issues/7' })
    if (init.method === 'DELETE') return { status: 204, ok: true, headers: {}, json: async () => null, text: async () => '' }
    return jsonRes(200, {})
  }
  return { client, calls }
}

async function configureGithub(agentId: string) {
  const r = await owner.inject({ method: 'POST', url: cu(agentId, '/github'), payload: { config: { username: 'octo' }, secret: SENTINEL } })
  assert.ok(r.statusCode === 200 || r.statusCode === 201, r.body)
}
async function setTrust(agentId: string, trustLevel: string) {
  const r = await owner.inject({ method: 'PUT', url: cu(agentId, '/github/trust'), payload: { trustLevel } })
  assert.equal(r.statusCode, 200, r.body)
}
async function mintFreshSession(): Promise<string> {
  const { token, record } = mintSession({ source: 'desk' })
  await db.insert(schema.arturitaSessions).values({
    id: randomUUID(), orgId: ORG, tokenHash: record.tokenHash, source: 'desk',
    createdAt: record.createdAt, expiresAt: record.expiresAt, lastStepupAt: record.lastStepupAt, revokedAt: null,
  } as any)
  return token
}
async function decide(approvalId: string, decision: string, sessionToken?: string) {
  return owner.inject({
    method: 'POST', url: `/api/approvals/${approvalId}/decide`,
    headers: sessionToken ? { 'x-arturita-session': sessionToken } : {},
    payload: { decision },
  })
}
async function ledgerFor(approvalId: string) {
  return db.query.connectorExecutions.findFirst({ where: eq(schema.connectorExecutions.approvalId, approvalId) })
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
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), apiTokenHash: hashAgentToken(AGENT_TOKEN), createdAt: now },
    { id: AGENT2, orgId: ORG, name: 'Nia', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), createdAt: now },
    { id: AGENT_NOCAP, orgId: ORG, name: 'Locked', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['memory:write']), apiTokenHash: hashAgentToken(NOCAP_TOKEN), createdAt: now },
    { id: AGENT_EMPTY, orgId: ORG, name: 'Legacy', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify([]), createdAt: now },
    { id: OTHER_AGENT, orgId: OTHER_ORG, name: 'Spy', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), createdAt: now },
  ] as any)

  owner = Fastify({ logger: false })
  owner.addHook('onRequest', async (req) => { (req as any).auth = { userId: OWNER }; (req as any).userId = OWNER })
  await owner.register(agentConnectorRoutes)
  await owner.register(taskRoutes)
  await owner.ready()

  route = Fastify({ logger: false })
  await route.register(agentApiRoutes)
  await route.ready()

  await configureGithub(AGENT)
  await configureGithub(AGENT2)
  await configureGithub(AGENT_NOCAP)
  await configureGithub(AGENT_EMPTY)
})

after(async () => {
  await owner?.close(); await route?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── 1. Pure tightening + taxonomy alignment ───────────────────────────────────

test('[CONN8A-CAP] execution requires an EXPLICIT connector cap — legacy allow-all grants nothing', () => {
  assert.equal(hasExplicitConnectorCapability([], 'github'), false)            // the tightening
  assert.equal(hasExplicitConnectorCapability(null, 'github'), false)
  assert.equal(hasExplicitConnectorCapability(['*'], 'github'), true)
  assert.equal(hasExplicitConnectorCapability(['connector:*'], 'github'), true)
  assert.equal(hasExplicitConnectorCapability(['connector:github'], 'github'), true)
  assert.equal(hasExplicitConnectorCapability(['connector:jira'], 'github'), false)
  assert.equal(hasExplicitConnectorCapability(['memory:write'], 'github'), false)
})

test('[CONN8A-TAX] every GitHub executor action class matches the CONN-7 taxonomy', () => {
  for (const [action, spec] of Object.entries(githubExecutor.actions)) {
    assert.equal(classifyConnectorAction('github', action), spec.class, `github '${action}' class must match taxonomy`)
  }
})

test('[CONN8A-MCP] carry-forward ii: an opaque unknown WRITE escalates even under auto_write', () => {
  // github (fixed surface) knows its writes → NOT escalated.
  assert.equal(mustEscalateUnknownWrite(githubExecutor, 'write', 'issue.create'), false)
  // a fake open-ended executor (the MCP shape) that can't vouch for a tool → escalate.
  const openEnded = { connectorId: 'mcp', actions: {}, knowsAction: () => false } as any
  assert.equal(mustEscalateUnknownWrite(openEnded, 'write', 'some_random_tool'), true)
  // a READ is never escalated by this rule (it's already allowed).
  assert.equal(mustEscalateUnknownWrite(openEnded, 'read', 'whatever'), false)
})

test('[CONN8A-REDACT] redactSecrets deep-replaces any credential value it finds', () => {
  const out = redactSecrets({ a: `x ${SENTINEL} y`, b: [{ c: SENTINEL }] }, [SENTINEL])
  assert.equal(JSON.stringify(out).includes(SENTINEL), false)
})

test('[CONN8A-N1] the DESTRUCTIVE banner is RECOMPUTED, not trusted from the payload classification', () => {
  // A self-filing agent that lies (classification:'read' on a repo.delete) must NOT be
  // able to suppress the red banner — renderConnectorAction recomputes from the verb.
  const lied = renderActionSummary('connector_action', { connectorId: 'github', action: 'repo.delete', classification: 'read' })
  assert.equal(lied.ok, true)
  assert.match(String(lied.summary), /^DESTRUCTIVE /, 'a repo.delete must render DESTRUCTIVE regardless of payload classification')
  assert.ok((lied.warnings ?? []).some(w => /Destructive/.test(w)))
  // …and a genuine write still renders without the destructive banner.
  const write = renderActionSummary('connector_action', { connectorId: 'github', action: 'issue.create', classification: 'destructive' })
  assert.equal(/^DESTRUCTIVE /.test(String(write.summary)), false, 'a write mislabeled destructive must not show the banner')
})

// ─── 2. deny / rejected — nothing executes, no network ────────────────────────

test('[CONN8A-DENY] no connector capability → denied, not executed', async () => {
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT_NOCAP, connectorId: 'github', action: 'repo.get', params: { owner: 'octo', repo: 'hello' } }, { httpClient: client })
  assert.equal(r.status, 'denied')
  assert.equal(calls.length, 0, 'no provider call on a deny')
})

test('[CONN8A-DENY] legacy allow-all (empty permissions) → denied for execution (carry-forward i)', async () => {
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT_EMPTY, connectorId: 'github', action: 'repo.get', params: { owner: 'octo', repo: 'hello' } }, { httpClient: client })
  assert.equal(r.status, 'denied')
  assert.match((r as any).reason, /explicit connector capability/)
  assert.equal(calls.length, 0)
})

test('[CONN8A-DENY] capable agent but connector not configured → denied', async () => {
  // AGENT has connector:* but jira is not configured — and jira also has no executor.
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'jira', action: 'get_issue' }, { httpClient: client })
  assert.equal(r.status, 'denied')
  assert.equal(calls.length, 0)
})

test('[CONN8A-DENY] cross-tenant agent → denied (scoping)', async () => {
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: OTHER_AGENT, connectorId: 'github', action: 'repo.get', params: { owner: 'octo', repo: 'hello' } }, { httpClient: client })
  assert.equal(r.status, 'denied')
  assert.equal(calls.length, 0)
})

test('[CONN8A-NOEXEC] a configured connector with NO executor → rejected, fail-closed', async () => {
  // Configure mcp for AGENT (it has connector:*), then execute → no executor exists in 8a.
  const c = await owner.inject({ method: 'POST', url: cu(AGENT, '/mcp'), payload: { config: { name: 'srv', transport: 'http', url: 'https://mcp.example.com' } } })
  assert.ok(c.statusCode === 200 || c.statusCode === 201, c.body)
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'do_thing' }, { httpClient: client })
  assert.equal(r.status, 'rejected')
  assert.match((r as any).reason, /no executor/)
  assert.equal(calls.length, 0)
  assert.equal(getExecutor('mcp'), undefined)
})

// ─── 3. READ executes with a mocked client ────────────────────────────────────

test('[CONN8A-READ] a READ executes against the mocked GitHub client (host fixed to api.github.com)', async () => {
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'repo.get', params: { owner: 'octo', repo: 'hello' } }, { httpClient: client })
  assert.equal(r.status, 'executed', JSON.stringify(r))
  assert.equal((r as any).data.full_name, 'octo/hello')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.startsWith('https://api.github.com/'), `SSRF: host must be api.github.com, got ${calls[0].url}`)
  assert.equal(calls[0].headers.Authorization, `Bearer ${SENTINEL}`, 'the credential IS used for the call')
})

// ─── 4. WRITE not trusted → needs approval, not executed ──────────────────────

test('[CONN8A-WRITE] WRITE (not trusted) → pending_approval, NOT executed, approval filed with step-up', async () => {
  await setTrust(AGENT, 'approval_required')
  const { client, calls } = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Bug' }, target: 'octo/hello' }, { httpClient: client })
  assert.equal(r.status, 'pending_approval')
  assert.equal(calls.length, 0, 'a needs_approval action must NOT execute')
  const ap = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, (r as any).approvalId) })
  assert.ok(ap && ap.type === 'connector_action' && ap.status === 'pending')
  assert.equal((ap!.payload as any)?.requiresStepUp, true)
  assert.equal(JSON.stringify(ap).includes(SENTINEL), false, 'no credential in the approval card')
})

// ─── 5. The gated-execution lifecycle: no un-approved run, single-use redeem ───

test('[CONN8A-GATE] a gated action WITHOUT an approved approval → rejected (bogus + still-pending)', async () => {
  const { client, calls } = makeHttp()
  // (a) a made-up approvalId
  const bogus = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'X' }, approvalId: randomUUID() }, { httpClient: client })
  assert.equal(bogus.status, 'rejected')
  // (b) a real but still-PENDING approval
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Y' } }, { httpClient: client })
  assert.equal(pend.status, 'pending_approval')
  const redeemPending = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Y' }, approvalId: (pend as any).approvalId }, { httpClient: client })
  assert.equal(redeemPending.status, 'rejected')
  assert.match((redeemPending as any).reason, /not in the approved state/)
  assert.equal(calls.length, 0, 'nothing executed on any un-approved redemption')
})

test('[CONN8A-STEPUP] approving a connector_action WITHOUT step-up is refused (approval stays pending)', async () => {
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Z' } })
  const approvalId = (pend as any).approvalId
  const res = await decide(approvalId, 'approved') // no session header
  assert.equal(res.statusCode, 403, res.body)
  const ap = await db.query.approvalRequests.findFirst({ where: eq(schema.approvalRequests.id, approvalId) })
  assert.equal(ap!.status, 'pending', 'a refused step-up must not approve the action')
})

test('[CONN8A-ONCE] approved+stepped-up → executes EXACTLY once; replay rejected (single-use)', async () => {
  // File the approval.
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Ship it' } })
  assert.equal(pend.status, 'pending_approval')
  const approvalId = (pend as any).approvalId
  // Approve WITH a fresh step-up session (the real decide route).
  const token = await mintFreshSession()
  const dec = await decide(approvalId, 'approved', token)
  assert.equal(dec.statusCode, 200, dec.body)

  // Redeem → executes once.
  const { client, calls } = makeHttp()
  const first = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Ship it' }, approvalId }, { httpClient: client })
  assert.equal(first.status, 'executed', JSON.stringify(first))
  assert.equal(calls.length, 1, 'the approved action executes exactly once')
  const led = await ledgerFor(approvalId)
  assert.equal(led!.status, 'succeeded')

  // Replay the SAME approval → rejected, no second call.
  const replay = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Ship it' }, approvalId }, { httpClient: client })
  assert.equal(replay.status, 'rejected')
  assert.match((replay as any).reason, /already been executed/)
  assert.equal(calls.length, 1, 'replay must not make a second provider call')
})

test('[CONN8A-BIND] an approval cannot be redeemed for a DIFFERENT action or by a DIFFERENT agent', async () => {
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Bound' } })
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  const { client, calls } = makeHttp()
  // wrong action verb bound to this approval
  const wrongAction = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.comment', params: { owner: 'octo', repo: 'hello', number: 1, body: 'hi' }, approvalId }, { httpClient: client })
  assert.equal(wrongAction.status, 'rejected')
  assert.match((wrongAction as any).reason, /does not match/)
  assert.equal(calls.length, 0)
})

test('[CONN8A-N4a] a DIFFERENT agent cannot redeem an approval bound to another agent', async () => {
  // File + approve an approval bound to AGENT, then AGENT2 (also capable + configured)
  // tries to redeem it — the pa.agentId !== agentId guard rejects it, nothing runs.
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Mine' } })
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  const { client, calls } = makeHttp()
  const other = await executeConnectorAction({ orgId: ORG, agentId: AGENT2, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Mine' }, approvalId }, { httpClient: client })
  assert.equal(other.status, 'rejected')
  assert.match((other as any).reason, /does not match/)
  assert.equal(calls.length, 0, 'no cross-agent execution')
  // The rightful owner can still redeem it exactly once afterwards.
  const mine = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Mine' }, approvalId }, { httpClient: client })
  assert.equal(mine.status, 'executed')
})

test('[CONN8A-N4b] a concurrent double-redeem executes exactly once (UNIQUE claim)', async () => {
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Race' } })
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  const { client, calls } = makeHttp()
  const redeem = () => executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Race' }, approvalId }, { httpClient: client })
  const [a, b] = await Promise.all([redeem(), redeem()])
  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, ['executed', 'rejected'], `exactly one must win, got ${JSON.stringify(statuses)}`)
  assert.equal(calls.length, 1, 'the UNIQUE(approval_id) claim allows only one provider call')
})

// ─── 6. Trust: auto_write WRITE executes; DESTRUCTIVE still needs approval ─────

test('[CONN8A-TRUST] auto_write WRITE executes directly; DESTRUCTIVE under auto_write still needs approval', async () => {
  await setTrust(AGENT, 'auto_write')
  // WRITE auto-approves → executes, no approval filed.
  const wh = makeHttp()
  const w = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Auto' } }, { httpClient: wh.client })
  assert.equal(w.status, 'executed', JSON.stringify(w))
  assert.equal(wh.calls.length, 1)
  // DESTRUCTIVE still needs approval even when trusted → NOT executed.
  const dh = makeHttp()
  const d = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'repo.delete', params: { owner: 'octo', repo: 'hello' } }, { httpClient: dh.client })
  assert.equal(d.status, 'pending_approval')
  assert.equal(d.classification, 'destructive')
  assert.equal(dh.calls.length, 0, 'a destructive action never auto-executes')
  await setTrust(AGENT, 'approval_required')
})

// ─── 7. Credential never leaks (sentinel) + SSRF ──────────────────────────────

test('[CONN8A-SECRET] the credential is used but never appears in a result, an error, or the ledger', async () => {
  await setTrust(AGENT, 'auto_write')
  // (a) a provider that ECHOES the token in a 2xx body — the result must be redacted.
  const echo = makeHttp(() => jsonRes(201, { id: 9, leaked: `token is ${SENTINEL}` }))
  const ok = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Echo' } }, { httpClient: echo.client })
  assert.equal(ok.status, 'executed')
  assert.equal(JSON.stringify(ok).includes(SENTINEL), false, 'no credential in the executed result')
  assert.equal(echo.calls[0].headers.Authorization, `Bearer ${SENTINEL}`, 'the token WAS used for the call')
  // (b) a provider ERROR that echoes the token — the error must be redacted too.
  const errh = makeHttp(() => jsonRes(422, { message: `bad ${SENTINEL}` }))
  const err = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Err' } }, { httpClient: errh.client })
  assert.equal(err.status, 'error')
  assert.equal(String((err as any).reason).includes(SENTINEL), false, 'no credential in the error')
  // (c) the ledger never persists the credential.
  const rows = await db.select().from(schema.connectorExecutions).where(and(eq(schema.connectorExecutions.orgId, ORG), eq(schema.connectorExecutions.agentId, AGENT)))
  assert.equal(rows.some(r => JSON.stringify(r).includes(SENTINEL)), false, 'no credential in the execution ledger')
  await setTrust(AGENT, 'approval_required')
})

test('[CONN8A-SSRF] params cannot inject a non-GitHub host — an invalid owner is refused before any call', async () => {
  await setTrust(AGENT, 'approval_required')
  const { client, calls } = makeHttp()
  // repo.get is a READ (allowed), but the owner fails validation → error, no call made.
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'repo.get', params: { owner: 'evil.com/x', repo: 'y' } }, { httpClient: client })
  assert.equal(r.status, 'error')
  assert.match((r as any).reason, /owner/)
  assert.equal(calls.length, 0, 'no request is ever dialed for an invalid segment')
})

// ─── 8. The secured agent-facing route (wiring + scope, no network) ───────────

test('[CONN8A-ROUTE] the agent execute route is agent-scoped: no cap → 403, WRITE → 202 (files approval)', async () => {
  // No bearer → 401.
  const anon = await route.inject({ method: 'POST', url: '/api/agent/connectors/github/execute', payload: { action: 'repo.get' } })
  assert.equal(anon.statusCode, 401, anon.body)
  // No connector capability → 403 (denied), no network.
  const noCap = await route.inject({
    method: 'POST', url: '/api/agent/connectors/github/execute',
    headers: { authorization: `Bearer ${NOCAP_TOKEN}` },
    payload: { action: 'repo.get', params: { owner: 'octo', repo: 'hello' } },
  })
  assert.equal(noCap.statusCode, 403, noCap.body)
  // AGENT (connector:*) requesting a WRITE → 202 pending_approval (no network).
  const w = await route.inject({
    method: 'POST', url: '/api/agent/connectors/github/execute',
    headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    payload: { action: 'issue.create', params: { owner: 'octo', repo: 'hello', title: 'Via route' } },
  })
  assert.equal(w.statusCode, 202, w.body)
  const body = JSON.parse(w.body)
  assert.equal(body.status, 'pending_approval')
  assert.ok(body.approvalId)
  assert.equal(w.body.includes(SENTINEL), false)
})
