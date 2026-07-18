// Epic CONN / CONN-8b-3 — the custom-MCP connector EXECUTOR (the riskiest adapter).
//
// The MCP server URL is USER-CONFIGURED, so this suite is heavier on egress/SSRF than the
// fixed-host executors. It proves, against a REAL SQLite file through the REAL connector-config
// + approval/step-up decide routes, with a MOCKED transport (never a real network call):
//   1. taxonomy alignment (tools.list = read) + registration;
//   2. an opaque MCP tool invoke → WRITE → needs_approval EVEN under auto_write, UNLESS the
//      exact tool name is on the per-connector allow-list; a destructive-named tool ALWAYS
//      needs approval; an allow-listed tool under auto_write executes once; approve+step-up
//      redeems and executes exactly once; replay is rejected (single-use);
//   3. the params-digest binding still holds (approved params ARE executed params);
//   4. SSRF / EGRESS: literal private IPs (127/10/169.254 metadata), http://, embedded
//      userinfo, and stdio transport are all REFUSED before any connection; a server redirect
//      is not treated as success; the private-range blocker, the URL-shape guard, and the
//      DNS-pinning guarded lookup (incl. a rebinding answer) are unit-tested directly;
//   5. the bearer credential never appears in a result, an error, or the ledger.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'conn8b3-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
process.env.SECRETS_ENC_KEY = 'conn8b3-test-key'
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentConnectorRoutes } = await import('../routes/agent-connectors')
const { taskRoutes } = await import('../routes/tasks')
const { executeConnectorAction, getExecutor } = await import('../services/connector-execution')
const {
  mcpExecutor, isBlockedAddress, validateMcpUrlShape, makeGuardedLookup,
  isMcpToolAutoApproved, mcpEscalateAllowToApproval, createMcpHttpsClient,
} = await import('../services/connector-mcp')
const { classifyConnectorAction } = await import('../services/connector-authz')
const { mintSession } = await import('../services/arturita-session')
const { eq, and } = await import('drizzle-orm')

const ORG = 'org8b3', OWNER = 'owner8b3'
const AGENT = 'agent8b3' // connector:* + mcp configured (http)
const MCP_URL = 'https://mcp.sevenei.example/rpc'
const MCP_SECRET = 'mcp_SENTINEL_conn8b3_bearer_token' // the credential that must NEVER surface

let owner: FastifyInstance
const cu = (agentId: string, tail = '') => `/api/orgs/${ORG}/agents/${agentId}/connectors${tail}`

function jsonRes(status: number, obj: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(obj)
  return { status, ok: status >= 200 && status < 300, headers, json: async () => obj, text: async () => body }
}
function makeHttp(responder?: (url: string, init: any) => any) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const client = async (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (responder) return responder(url, init)
    return jsonRes(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } })
  }
  return { client, calls }
}

async function setTrust(connectorId: string, trustLevel: string) {
  const r = await owner.inject({ method: 'PUT', url: cu(AGENT, `/${connectorId}/trust`), payload: { trustLevel } })
  assert.equal(r.statusCode, 200, r.body)
}
async function setMcpConfig(config: Record<string, unknown>, secret?: string) {
  const r = await owner.inject({ method: 'POST', url: cu(AGENT, '/mcp'), payload: { config, ...(secret ? { secret } : {}) } })
  assert.ok(r.statusCode === 200 || r.statusCode === 201, `mcp config: ${r.body}`)
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

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([{ id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now }] as any)
  await db.insert(schema.orgMembers).values([{ id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now }] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['connector:*']), createdAt: now },
  ] as any)

  owner = Fastify({ logger: false })
  owner.addHook('onRequest', async (req) => { (req as any).auth = { userId: OWNER }; (req as any).userId = OWNER })
  await owner.register(agentConnectorRoutes)
  await owner.register(taskRoutes)
  await owner.ready()

  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL }, MCP_SECRET)
})

after(async () => {
  await owner?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── 1. Registration + taxonomy alignment ─────────────────────────────────────

test('[CONN8B3-REG] the mcp executor is registered and open-ended', () => {
  assert.ok(getExecutor('mcp'), 'mcp must have a registered executor')
  assert.equal(typeof mcpExecutor.invoke, 'function', 'mcp is an open-ended executor')
  assert.equal(typeof mcpExecutor.escalateAllowToApproval, 'function')
  assert.equal(typeof mcpExecutor.defaultHttpClient, 'function')
})

test('[CONN8B3-TAX] the only fixed mcp action (tools.list) matches the CONN-7 taxonomy', () => {
  for (const [action, spec] of Object.entries(mcpExecutor.actions)) {
    assert.equal(classifyConnectorAction('mcp', action), spec.class, `mcp '${action}' class must match taxonomy`)
  }
  assert.equal(mcpExecutor.actions['tools.list'].class, 'read')
})

// ─── 2. Opaque-tool escalation (the key containment) ───────────────────────────

test('[CONN8B3-ESCALATE] an opaque tool invoke is WRITE → needs_approval EVEN under auto_write (not allow-listed)', async () => {
  await setTrust('mcp', 'auto_write')
  const h = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'run_report', params: { q: 'x' } }, { httpClient: h.client })
  assert.equal(r.status, 'pending_approval', JSON.stringify(r))
  assert.equal(r.classification, 'write')
  assert.equal(h.calls.length, 0, 'an opaque tool must NOT auto-execute under auto_write')
  await setTrust('mcp', 'approval_required')
})

test('[CONN8B3-DESTRUCTIVE] a destructive-named tool ALWAYS needs approval, even under auto_write', async () => {
  await setTrust('mcp', 'auto_write')
  const h = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'delete_dataset', params: {} }, { httpClient: h.client })
  assert.equal(r.status, 'pending_approval', JSON.stringify(r))
  assert.equal(r.classification, 'destructive')
  assert.equal(h.calls.length, 0)
  await setTrust('mcp', 'approval_required')
})

test('[CONN8B3-ALLOWLIST] an allow-listed tool under auto_write executes once against the mocked MCP client', async () => {
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL, autoApproveTools: ['run_report'] })
  await setTrust('mcp', 'auto_write')
  const h = makeHttp((_u) => jsonRes(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'done' }] } }))
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'run_report', params: { q: 'x' } }, { httpClient: h.client })
  assert.equal(r.status, 'executed', JSON.stringify(r))
  assert.equal(h.calls.length, 1, 'an allow-listed tool auto-executes exactly once')
  assert.equal(h.calls[0].method, 'POST')
  assert.ok(h.calls[0].url.startsWith(MCP_URL), 'dials the configured MCP url')
  const sent = JSON.parse(h.calls[0].body!)
  assert.equal(sent.method, 'tools/call')
  assert.equal(sent.params.name, 'run_report', 'the action IS the tool name')
  assert.deepEqual(sent.params.arguments, { q: 'x' }, 'params ARE the tool args')
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${MCP_SECRET}`, 'the configured bearer is used as auth')
  // a NON-allow-listed tool on the same auto_write connector still escalates
  const other = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'wipe_index', params: {} }, { httpClient: makeHttp().client })
  assert.equal(other.status, 'pending_approval', 'a non-allow-listed tool still needs approval')
  await setTrust('mcp', 'approval_required')
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL }) // reset (clears allow-list)
})

test('[CONN8B3-GATED] a WRITE (not trusted) files an approval; approve+step-up redeems once; replay rejected', async () => {
  await setTrust('mcp', 'approval_required')
  const h = makeHttp((_u) => jsonRes(200, { jsonrpc: '2.0', id: 1, result: { ok: true } }))
  const params = { target: 'Q3', mode: 'summary' }
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'generate', params }, { httpClient: h.client })
  assert.equal(pend.status, 'pending_approval')
  assert.equal(h.calls.length, 0, 'a needs_approval invoke must NOT execute')
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  const done = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'generate', params, approvalId }, { httpClient: h.client })
  assert.equal(done.status, 'executed', JSON.stringify(done))
  assert.equal(h.calls.length, 1)
  const replay = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'generate', params, approvalId }, { httpClient: h.client })
  assert.equal(replay.status, 'rejected', 'single-use: a replay must be rejected')
  assert.equal(h.calls.length, 1, 'replay must not make a second call')
})

test('[CONN8B3-DIGEST] the params-digest binding holds — approved params ARE the executed params', async () => {
  await setTrust('mcp', 'approval_required')
  const h = makeHttp()
  const pend = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'generate', params: { to: 'bob' } }, { httpClient: h.client })
  assert.equal(pend.status, 'pending_approval')
  const approvalId = (pend as any).approvalId
  const token = await mintFreshSession()
  assert.equal((await decide(approvalId, 'approved', token)).statusCode, 200)
  // Redeem with DIFFERENT params → rejected (the approved digest no longer matches).
  const tampered = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'generate', params: { to: 'eve' }, approvalId }, { httpClient: h.client })
  assert.equal(tampered.status, 'rejected', JSON.stringify(tampered))
  assert.match((tampered as any).reason, /params/)
  assert.equal(h.calls.length, 0, 'a params-mismatch redemption never dials the server')
})

test('[CONN8B3-READ] tools.list is a free read that dials tools/list (no approval)', async () => {
  await setTrust('mcp', 'approval_required')
  const h = makeHttp((_u) => jsonRes(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'run_report' }] } }))
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'tools.list', params: {} }, { httpClient: h.client })
  assert.equal(r.status, 'executed', JSON.stringify(r))
  assert.equal(JSON.parse(h.calls[0].body!).method, 'tools/list')
})

// ─── 3. stdio transport is fail-closed ─────────────────────────────────────────

test('[CONN8B3-STDIO] a stdio-transport MCP connector fails closed — not supported, no call', async () => {
  await setMcpConfig({ name: 'Local', transport: 'stdio', command: 'npx some-mcp' })
  await setTrust('mcp', 'auto_write')
  // Allow-list it so escalation is not what stops it — the transport guard is.
  await setMcpConfig({ name: 'Local', transport: 'stdio', command: 'npx some-mcp', autoApproveTools: ['anything'] })
  const h = makeHttp()
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'anything', params: {} }, { httpClient: h.client })
  assert.equal(r.status, 'error', JSON.stringify(r))
  assert.match((r as any).reason, /stdio/)
  assert.equal(h.calls.length, 0, 'stdio must never dial anything')
  await setTrust('mcp', 'approval_required')
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL }, MCP_SECRET) // restore http
})

// ─── 4. SSRF / egress — the crux ───────────────────────────────────────────────

test('[CONN8B3-SSRF-UNIT] the private/internal address blocker covers every required range', () => {
  for (const blocked of [
    '127.0.0.1', '127.5.5.5', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.0.1', '169.254.169.254', // cloud metadata
    '0.0.0.0', '100.64.0.1', '255.255.255.255', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', // IPv4-mapped loopback (dotted + hex)
    // N1: the other three IPv4-in-IPv6 embeddings must ALSO decode/block (not just ::ffff:).
    '::7f00:1', '::a00:1',              // IPv4-compatible ::/96 → 127.0.0.1 / 10.0.0.1
    '::0.0.0.1', '::c0a8:1',            // compatible dotted + hex → blocked (0.0.0.1 / 192.168.0.1)
    '64:ff9b::a00:1', '64:ff9b::7f00:1', // NAT64 64:ff9b::/96 → 10.0.0.1 / 127.0.0.1
    '2002:7f00:1::', '2002:a00:1::',   // 6to4 2002::/16 → 127.0.0.1 / 10.0.0.1
    'not-an-ip', '',
  ]) {
    assert.equal(isBlockedAddress(blocked), true, `'${blocked}' must be blocked`)
  }
  // Legit PUBLIC addresses (incl. a real IPv6 literal) must NOT be over-blocked.
  for (const ok of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isBlockedAddress(ok), false, `'${ok}' (public) must be allowed`)
  }
})

test('[CONN8B3-SSRF-SHAPE] the url-shape guard rejects http / userinfo / literal private IPs', () => {
  assert.equal(validateMcpUrlShape('https://mcp.example.com/rpc').ok, true)
  for (const bad of [
    'http://mcp.example.com/rpc',                 // not https
    'https://user:pass@mcp.example.com/rpc',      // embedded userinfo
    'https://127.0.0.1/rpc',                      // loopback literal
    'https://10.0.0.5/rpc',                       // private literal
    'https://169.254.169.254/latest/meta-data',   // cloud metadata literal
    'https://[::1]/rpc',                          // ipv6 loopback literal
    // N1: the other IPv4-in-IPv6 embeddings as literal hosts must be refused at the shape guard.
    'https://[::7f00:1]/rpc',                     // IPv4-compatible → 127.0.0.1
    'https://[64:ff9b::a00:1]/rpc',               // NAT64 → 10.0.0.1
    'https://[2002:7f00:1::]/rpc',                // 6to4 → 127.0.0.1
    'ftp://mcp.example.com',                      // wrong scheme
    'not a url', '',
  ]) {
    assert.equal(validateMcpUrlShape(bad).ok, false, `'${bad}' must be refused`)
  }
  // …but a legit PUBLIC IPv6 literal host is accepted (no over-block).
  assert.equal(validateMcpUrlShape('https://[2001:4860:4860::8888]/rpc').ok, true)
})

test('[CONN8B3-SSRF-CONFIG] a stored MCP url on a private literal / http / userinfo is refused before any call', async () => {
  await setTrust('mcp', 'auto_write')
  for (const badUrl of [
    'https://127.0.0.1/rpc',
    'https://169.254.169.254/latest/meta-data/iam',
    'https://10.1.2.3/rpc',
    'http://mcp.example.com/rpc',
    'https://sneaky@169.254.169.254/rpc',
    'https://[::7f00:1]/rpc',        // N1: IPv4-compatible ::/96 loopback
    'https://[64:ff9b::a00:1]/rpc',  // N1: NAT64 → 10.0.0.1
    'https://[2002:7f00:1::]/rpc',   // N1: 6to4 → 127.0.0.1
  ]) {
    await setMcpConfig({ name: 'X', transport: 'http', url: badUrl, autoApproveTools: ['probe'] })
    const h = makeHttp()
    const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'probe', params: {} }, { httpClient: h.client })
    assert.equal(r.status, 'error', `url '${badUrl}' must be refused`)
    assert.equal(h.calls.length, 0, `no call for a blocked url '${badUrl}'`)
  }
  await setTrust('mcp', 'approval_required')
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL }, MCP_SECRET) // restore
})

test('[CONN8B3-SSRF-REBIND] the DNS-pinning guarded lookup refuses a host that resolves to a private IP', async () => {
  // A resolver that answers with a private IP (DNS rebinding / internal-pointing name).
  const rebindResolver = ((_host: string, _opts: any, cb: any) => cb(null, [{ address: '10.0.0.7', family: 4 }])) as any
  const guarded = makeGuardedLookup(rebindResolver)
  await new Promise<void>((resolve) => {
    guarded('evil.rebind.example', { all: false }, (err: any, addr: any) => {
      assert.ok(err, 'a private-resolving host must be refused')
      assert.match(String(err.message), /private|internal|blocked/i)
      assert.equal(addr, undefined)
      resolve()
    })
  })
  // A MIXED answer (one public, one private) must ALSO be refused — no cherry-picking.
  const mixed = ((_h: string, _o: any, cb: any) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])) as any
  await new Promise<void>((resolve) => {
    makeGuardedLookup(mixed)('mixed.example', { all: false }, (err: any) => {
      assert.ok(err, 'a mixed public+private answer must be refused')
      resolve()
    })
  })
  // A purely public answer is allowed and pins the validated address.
  const publicResolver = ((_h: string, _o: any, cb: any) => cb(null, [{ address: '93.184.216.34', family: 4 }])) as any
  await new Promise<void>((resolve) => {
    makeGuardedLookup(publicResolver)('good.example', { all: false }, (err: any, addr: any, fam: any) => {
      assert.equal(err, null)
      assert.equal(addr, '93.184.216.34')
      assert.equal(fam, 4)
      resolve()
    })
  })
})

test('[CONN8B3-SSRF-PIN] the real node:https client refuses to connect when the host resolves private (no connection)', async () => {
  // Exercise createMcpHttpsClient's real node:https path with an injected resolver that
  // returns a private IP — the guarded lookup rejects at connect, so NO socket to a real
  // host is ever opened. The invalid TLD guarantees no accidental real DNS/network use.
  const client = createMcpHttpsClient(((_h: string, _o: any, cb: any) => cb(null, [{ address: '10.9.8.7', family: 4 }])) as any)
  await assert.rejects(
    client('https://totally-fake-mcp.invalid/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    /private|internal|blocked|failed/i,
  )
})

test('[CONN8B3-SSRF-REDIRECT] a server redirect is not treated as success', async () => {
  await setTrust('mcp', 'auto_write')
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL, autoApproveTools: ['probe'] }, MCP_SECRET)
  // The mock returns a 302 pointing at an internal host — mcpJsonRpc treats a non-2xx as an
  // error and NEVER follows it (the real transport also blocks the internal target at connect).
  const h = makeHttp((_u) => ({ status: 302, ok: false, headers: { location: 'https://169.254.169.254/' }, json: async () => null, text: async () => '' }))
  const r = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'probe', params: {} }, { httpClient: h.client })
  assert.equal(r.status, 'error', JSON.stringify(r))
  assert.equal(h.calls.length, 1, 'the redirect response is received but not followed')
  await setTrust('mcp', 'approval_required')
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL }, MCP_SECRET)
})

// ─── 5. The bearer credential never leaks ──────────────────────────────────────

test('[CONN8B3-SECRET] the MCP bearer never appears in a result, an error, or the ledger', async () => {
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL, autoApproveTools: ['echo'] }, MCP_SECRET)
  await setTrust('mcp', 'auto_write')
  // (a) a server that ECHOES the bearer in a 2xx body → result must be redacted.
  const echo = makeHttp((_u) => jsonRes(200, { jsonrpc: '2.0', id: 1, result: { leaked: `token ${MCP_SECRET}` } }))
  const ok = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'echo', params: {} }, { httpClient: echo.client })
  assert.equal(ok.status, 'executed', JSON.stringify(ok))
  assert.equal(JSON.stringify(ok).includes(MCP_SECRET), false, 'the bearer must not be in the result')
  // (b) a server ERROR that echoes the bearer → error must be redacted too.
  const errh = makeHttp((_u) => jsonRes(400, { error: { message: `bad ${MCP_SECRET}` } }))
  const err = await executeConnectorAction({ orgId: ORG, agentId: AGENT, connectorId: 'mcp', action: 'echo', params: {} }, { httpClient: errh.client })
  assert.equal(err.status, 'error', JSON.stringify(err))
  assert.equal(String((err as any).reason).includes(MCP_SECRET), false, 'the bearer must not be in the error')
  // (c) the ledger never persists the bearer.
  const rows = await db.select().from(schema.connectorExecutions).where(and(eq(schema.connectorExecutions.orgId, ORG), eq(schema.connectorExecutions.agentId, AGENT)))
  assert.equal(JSON.stringify(rows).includes(MCP_SECRET), false, 'the ledger must not contain the bearer')
  await setTrust('mcp', 'approval_required')
  await setMcpConfig({ name: 'Sevenei MCP', transport: 'http', url: MCP_URL }, MCP_SECRET)
})

// ─── 6. Pure escalation helpers ────────────────────────────────────────────────

test('[CONN8B3-ESC-UNIT] escalation + allow-list helpers are correct and fail-closed', () => {
  assert.equal(isMcpToolAutoApproved('a', { autoApproveTools: ['a', 'b'] }), true)
  assert.equal(isMcpToolAutoApproved('c', { autoApproveTools: ['a', 'b'] }), false)
  assert.equal(isMcpToolAutoApproved('a', {}), false)          // absent list → nothing auto
  assert.equal(isMcpToolAutoApproved('a', null), false)
  assert.equal(isMcpToolAutoApproved('a', { autoApproveTools: 'a' as any }), false) // malformed → fail closed
  // tools.list is exempt (framework meta-read); everything else escalates unless allow-listed.
  assert.equal(mcpEscalateAllowToApproval('tools.list', null), false)
  assert.equal(mcpEscalateAllowToApproval('anything', null), true)
  assert.equal(mcpEscalateAllowToApproval('anything', { autoApproveTools: ['anything'] }), false)
})
