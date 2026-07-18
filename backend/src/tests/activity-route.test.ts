// ACT-1 — the unified activity feed (`GET /api/orgs/:orgId/activity`).
//
// Four things must hold, and each is driven through the REAL route against a REAL
// SQLite file rather than asserted against the projector in isolation:
//
//  1. TENANCY. Another org's approvals, runs, tasks, connector executions and audit
//     rows never appear — for an owner or a member.
//  2. NEVER WIDEN. `connector_execution` and `audit_event` are owner-only at their
//     existing routes, so a MEMBER must not see them here, must not be able to ask for
//     them by `?kind=`, and must not have them advertised in `availableKinds`.
//  3. ALLOW-LIST. A deliberately HOSTILE row — an approval whose payload carries a
//     token/secret/params, a decision note, a task with raw input/output, a run with
//     logs and sessionState — must project to the safe fields only. The assertion is
//     made against the SERIALIZED response body, so a leak anywhere in the tree (a
//     nested object, an unexpected column) fails it, not just a leak at the top level.
//  4. BOUNDED + ORDERED. The limit is capped, the merge is newest-first across ALL
//     sources, and paging by cursor visits every event exactly once (no duplicate, no
//     skipped row at a page boundary — the failure mode a ts-only cursor would have).
//
// DATABASE_URL is pointed at a temp file BEFORE db/client loads (it reads env at import).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'activity-route-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { activityRoutes } = await import('../routes/activity')
const { registerJsonBodyParser } = await import('../middleware/body-parser')
const {
  ACTIVITY_KINDS, ACTIVITY_OUTCOMES, OWNER_ONLY_KINDS, FEED_MAX_LIMIT,
  compareActivity, isAfterCursor,
} = await import('../services/activity')

const ORG = 'org-act', OTHER_ORG = 'org-rival'
const OWNER = 'user-owner', MEMBER = 'user-member', OUTSIDER = 'user-outsider'
const AGENT = 'agent-vera', AGENT2 = 'agent-nia', OTHER_AGENT = 'agent-spy'

// The strings a leak would be made of. Every one is seeded into a column the feed must
// NOT read; none may appear anywhere in a response body.
const LEAK = {
  token: 'ghp_TOTALLYSECRETTOKEN',
  secret: 'SUPERSECRETVALUE',
  params: 'RAWPARAMSPAYLOAD',
  note: 'REVIEWERPRIVATENOTE',
  taskInput: 'RAWPROMPTINPUT',
  taskOutput: 'RAWMODELOUTPUT',
  runLogs: 'RAWRUNLOGLINE',
  sessionState: 'RAWSESSIONSTATE',
  auditMeta: 'RAWAUDITMETADATA',
}

let ownerApp: FastifyInstance
let memberApp: FastifyInstance
let outsiderApp: FastifyInstance

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  registerJsonBodyParser(a)
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(activityRoutes)
  return a
}

const url = (org = ORG, qs = '') => `/api/orgs/${org}/activity${qs}`

async function feed(app: FastifyInstance, qs = '', org = ORG) {
  const res = await app.inject({ method: 'GET', url: url(org, qs) })
  assert.equal(res.statusCode, 200, res.body)
  return { body: res.body, json: res.json() as any }
}

before(async () => {
  await setupDatabase()
  const now = new Date()

  await db.insert(schema.organisations).values([
    { id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now },
    { id: OTHER_ORG, name: 'Rivals', ownerId: 'someone-else', createdAt: now },
  ] as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
    { id: randomUUID(), orgId: ORG, userId: MEMBER, role: 'member', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', createdAt: now },
    { id: AGENT2, orgId: ORG, name: 'Nia', role: 'Ops', skills: [], runtime: 'internal', createdAt: now },
    { id: OTHER_AGENT, orgId: OTHER_ORG, name: 'Spy', role: 'Ops', skills: [], runtime: 'internal', createdAt: now },
  ] as any)

  // ── The HOSTILE approval: every sensitive column populated. ────────────────
  await db.insert(schema.approvalRequests).values([
    {
      id: 'ap-pending', orgId: ORG, type: 'connector_action',
      summary: 'Delete branch main on 7ei/app', status: 'pending',
      payload: {
        action: { argv: ['rm', '-rf', '/'], cwd: '/secret' },
        token: LEAK.token, secret: LEAK.secret, params: LEAK.params,
        nested: { deeper: { token: LEAK.token } },
        requiresStepUp: true, warnings: ['destructive'],
      },
      requestedByAgentId: AGENT, decidedBy: null, decidedAt: null, decisionNote: null,
      createdAt: new Date(5000),
    },
    {
      id: 'ap-decided', orgId: ORG, type: 'email_send',
      summary: 'Send quarterly update', status: 'approved',
      payload: { token: LEAK.token, secret: LEAK.secret },
      requestedByAgentId: AGENT2, decidedBy: OWNER, decidedAt: new Date(9000),
      decisionNote: LEAK.note, createdAt: new Date(1000),
    },
    // Another org's approval — must never surface.
    {
      id: 'ap-rival', orgId: OTHER_ORG, type: 'wallet_tx',
      summary: 'RIVALORGAPPROVAL', status: 'pending',
      payload: null, requestedByAgentId: OTHER_AGENT, decidedBy: null, decidedAt: null,
      decisionNote: null, createdAt: new Date(9999),
    },
  ] as any)

  // ── Tasks, with raw input/output seeded. ──────────────────────────────────
  await db.insert(schema.tasks).values([
    {
      id: 'task-1', orgId: ORG, agentId: AGENT, title: 'Reconcile the ledger',
      status: 'done', input: LEAK.taskInput, output: LEAK.taskOutput, createdAt: new Date(2000),
    },
    {
      id: 'task-2', orgId: ORG, agentId: AGENT2, title: 'Draft the board note',
      status: 'failed', input: LEAK.taskInput, output: LEAK.taskOutput, createdAt: new Date(6000),
    },
    // FIVE events sharing a single millisecond, in ONE source. Two purposes, both
    // established by mutation rather than assumed:
    //   - without ANY tied rows the cursor's id tiebreak is untestable (a ts-only
    //     cursor pages correctly by luck), and
    //   - with only two, the tie SLACK is untestable: `limit + 1` happens to be enough.
    //     Five is more than a slack-less fetch budget can hold at limit=1, so removing
    //     FEED_TIE_SLACK strands the tail of this burst and the paging test fails.
    ...['a', 'b', 'c', 'd', 'e'].map((s) => ({
      id: `task-tie-${s}`, orgId: ORG, agentId: AGENT, title: `Simultaneous ${s}`,
      status: 'done', input: null, output: null, createdAt: new Date(2500),
    })),
    {
      id: 'task-rival', orgId: OTHER_ORG, agentId: OTHER_AGENT, title: 'RIVALORGTASK',
      status: 'done', input: null, output: null, createdAt: new Date(9999),
    },
  ] as any)

  // ── Agent runs, with logs + sessionState seeded. ──────────────────────────
  await db.insert(schema.agentRuns).values([
    {
      id: 'run-1', orgId: ORG, agentId: AGENT, taskId: 'task-1', status: 'done',
      sessionState: LEAK.sessionState, logs: JSON.stringify([{ t: 1, msg: LEAK.runLogs }]),
      tokensUsed: 10, costUsd: 0.01, startedAt: new Date(3000), endedAt: new Date(4000),
    },
    {
      id: 'run-rival', orgId: OTHER_ORG, agentId: OTHER_AGENT, taskId: null, status: 'done',
      sessionState: null, logs: null, tokensUsed: 0, costUsd: 0,
      startedAt: new Date(9999), endedAt: new Date(9999),
    },
  ] as any)

  // ── Connector executions (OWNER-ONLY source). ─────────────────────────────
  await db.insert(schema.connectorExecutions).values([
    {
      id: 'cx-1', orgId: ORG, agentId: AGENT, connectorId: 'github', action: 'delete_ref',
      classification: 'destructive', approvalId: 'ap-pending', status: 'failed',
      error: 'provider refused', createdAt: new Date(7000),
    },
    {
      id: 'cx-rival', orgId: OTHER_ORG, agentId: OTHER_AGENT, connectorId: 'github',
      action: 'RIVALORGEXEC', classification: 'read', approvalId: null, status: 'succeeded',
      error: null, createdAt: new Date(9999),
    },
  ] as any)

  // ── Audit rows (OWNER-ONLY source), with metadata seeded. ─────────────────
  await db.insert(schema.auditLogs).values([
    {
      id: 'aud-1', orgId: ORG, userId: OWNER, action: 'approval.decide',
      method: 'POST', path: '/api/approvals/:id/decide', statusCode: 200, durationMs: 12,
      metadata: { body: { note: LEAK.auditMeta }, token: LEAK.token }, createdAt: new Date(8000),
    },
    {
      id: 'aud-rival', orgId: OTHER_ORG, userId: 'someone-else', action: 'RIVALORGAUDIT',
      method: 'POST', path: '/api/secrets', statusCode: 201, durationMs: 3,
      metadata: null, createdAt: new Date(9999),
    },
  ] as any)

  ownerApp = appAs(OWNER); await ownerApp.ready()
  memberApp = appAs(MEMBER); await memberApp.ready()
  outsiderApp = appAs(OUTSIDER); await outsiderApp.ready()
})

after(async () => {
  await ownerApp?.close(); await memberApp?.close(); await outsiderApp?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── 1. Tenancy ────────────────────────────────────────────────────────────────

test('[ACT-1] the feed is scoped to the org — no rival-org row appears, in any source', async () => {
  const { body, json } = await feed(ownerApp, '?limit=100')
  assert.ok(json.events.length > 0, 'feed came back empty — the rest of this test would be vacuous')
  for (const marker of ['RIVALORGAPPROVAL', 'RIVALORGTASK', 'RIVALORGEXEC', 'RIVALORGAUDIT', OTHER_AGENT, OTHER_ORG]) {
    assert.ok(!body.includes(marker), `cross-tenant leak: "${marker}" reached an owner of ${ORG}`)
  }
})

test('[ACT-1] an owner of org A reading org B is REFUSED by the route itself, not just by the scope gate', async () => {
  // Driven WITHOUT the surface-wide membership preHandler mounted, so this proves the
  // route's own defence-in-depth check. Before that check existed this returned 200 with
  // org B's approvals, tasks and runs in the body.
  const res = await ownerApp.inject({ method: 'GET', url: url(OTHER_ORG) })
  assert.equal(res.statusCode, 403, res.body)
  assert.ok(!res.body.includes('RIVALORGAPPROVAL'), 'a non-member saw org data')
})

test('[ACT-1] an outsider with no membership anywhere is refused', async () => {
  const res = await outsiderApp.inject({ method: 'GET', url: url(ORG) })
  assert.equal(res.statusCode, 403, res.body)
})

test('[ACT-1] an unauthenticated caller is refused before any query runs', async () => {
  const anon = Fastify({ logger: false })
  anon.register(activityRoutes)
  await anon.ready()
  const res = await anon.inject({ method: 'GET', url: url(ORG) })
  assert.equal(res.statusCode, 401, res.body)
  await anon.close()
})

// ─── 2. Never widen ────────────────────────────────────────────────────────────

test('[ACT-1] a MEMBER sees runs/tasks/approvals but NOT the owner-only sources', async () => {
  const { body, json } = await feed(memberApp, '?limit=100')
  assert.equal(json.isOwner, false)
  const kinds = new Set(json.events.map((e: any) => e.kind))
  assert.ok(kinds.has('task'), 'a member should still see tasks')
  assert.ok(kinds.has('approval_filed'), 'a member should still see approvals')
  for (const owned of OWNER_ONLY_KINDS) {
    assert.ok(!kinds.has(owned), `a member saw an owner-only kind: ${owned}`)
  }
  // and the underlying rows are not reachable by any other spelling
  assert.ok(!body.includes('delete_ref'), 'a member saw connector-execution data')
  assert.ok(!body.includes('approval.decide'), 'a member saw audit data')
})

test('[ACT-1] a MEMBER cannot summon an owner-only kind by asking for it explicitly', async () => {
  const { body, json } = await feed(memberApp, '?kind=connector_execution,audit_event&limit=100')
  assert.deepEqual(json.events, [], 'the ?kind= filter became a privilege-escalation path')
  assert.ok(!body.includes('delete_ref') && !body.includes('approval.decide'))
})

test('[ACT-1] availableKinds advertises only what THIS caller may actually read', async () => {
  const asOwner = (await feed(ownerApp)).json
  const asMember = (await feed(memberApp)).json
  assert.deepEqual([...asOwner.availableKinds].sort(), [...ACTIVITY_KINDS].sort())
  assert.deepEqual(
    [...asMember.availableKinds].sort(),
    [...ACTIVITY_KINDS].filter((k) => !OWNER_ONLY_KINDS.includes(k)).sort(),
  )
})

test('[ACT-1] an OWNER does see both owner-only sources (the member assertions are not vacuous)', async () => {
  const { json } = await feed(ownerApp, '?limit=100')
  const kinds = new Set(json.events.map((e: any) => e.kind))
  for (const owned of OWNER_ONLY_KINDS) {
    assert.ok(kinds.has(owned), `owner did not see ${owned} — the member test proves nothing`)
  }
})

// ─── 3. Allow-list ─────────────────────────────────────────────────────────────

test('[ACT-1] the hostile row projects to safe fields ONLY — nothing sensitive in the body', async () => {
  const { body, json } = await feed(ownerApp, '?limit=100')
  assert.ok(json.events.length >= 6, 'expected every seeded source to contribute')
  for (const [name, marker] of Object.entries(LEAK)) {
    assert.ok(!body.includes(marker), `allow-list breach: ${name} ("${marker}") reached the client`)
  }
  // The specific columns, named, so a future change that starts emitting one is obvious.
  for (const forbidden of ['payload', 'decisionNote', 'decidedBy', 'sessionState', 'logs', 'metadata', 'input', 'output', 'approvalId', 'orgId']) {
    assert.ok(!body.includes('"' + forbidden + '"'), `the response carries a "${forbidden}" key`)
  }
})

test('[ACT-1] every event carries exactly the allow-listed keys — no extra column rides along', async () => {
  const { json } = await feed(ownerApp, '?limit=100')
  const allowed = ['id', 'kind', 'at', 'title', 'outcome', 'agentId', 'agentName', 'target', 'error'].sort()
  for (const e of json.events) {
    assert.deepEqual(Object.keys(e).sort(), allowed, `unexpected shape on a ${e.kind} row`)
    assert.ok((ACTIVITY_KINDS as readonly string[]).includes(e.kind), `unknown kind ${e.kind}`)
    assert.ok((ACTIVITY_OUTCOMES as readonly string[]).includes(e.outcome), `unknown outcome ${e.outcome}`)
  }
})

test('[ACT-1] a gated connector run reports THAT it was gated, never WHICH approval', async () => {
  const { json } = await feed(ownerApp, '?kind=connector_execution&limit=100')
  const cx = json.events.find((e: any) => e.target === 'github')
  assert.ok(cx, 'the connector execution did not surface')
  assert.ok(cx.title.includes('approved'), 'the gated marker is missing')
  assert.ok(!JSON.stringify(cx).includes('ap-pending'), 'the approval id leaked into the feed')
})

// ─── 4. Bounded + ordered ──────────────────────────────────────────────────────

test('[ACT-1] the limit is capped even when the caller asks for more', async () => {
  const { json } = await feed(ownerApp, '?limit=999999')
  assert.equal(json.limit, FEED_MAX_LIMIT)
  assert.ok(json.events.length <= FEED_MAX_LIMIT)
})

test('[ACT-1] a junk limit falls back to the default rather than NaN-ing the query', async () => {
  const { json } = await feed(ownerApp, '?limit=abc')
  assert.ok(json.limit > 0 && json.limit <= FEED_MAX_LIMIT, `limit was ${json.limit}`)
  assert.ok(json.events.length > 0)
})

test('[ACT-1] the merge is newest-first ACROSS sources, not merely within each', async () => {
  const { json } = await feed(ownerApp, '?limit=100')
  const ats = json.events.map((e: any) => e.at)
  for (let i = 1; i < ats.length; i++) {
    assert.ok(ats[i - 1] >= ats[i], `feed is out of order at index ${i}: ${ats[i - 1]} then ${ats[i]}`)
  }
  // Interleaving is the point: the top rows must not all come from one table.
  const topKinds = new Set(json.events.slice(0, 4).map((e: any) => e.kind))
  assert.ok(topKinds.size > 1, 'the top of the feed came from a single source — sources are not merging')
})

test('[ACT-1] paging by cursor visits every event EXACTLY once — no duplicate, no skip', async () => {
  const all = (await feed(ownerApp, '?limit=100')).json.events.map((e: any) => e.id)
  assert.ok(all.length >= 6, 'need several events for paging to mean anything')

  const paged: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 20; guard++) {
    const qs: string = '?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    const { json }: any = await feed(ownerApp, qs)
    assert.ok(json.events.length <= 2, 'a page exceeded its limit')
    paged.push(...json.events.map((e: any) => e.id))
    cursor = json.nextCursor
    if (!cursor) break
  }
  assert.equal(paged.length, new Set(paged).size, 'a row was returned on two different pages')
  assert.deepEqual(paged, all, 'paging did not reproduce the unpaged feed exactly')
})

test('[ACT-1] two events sharing a millisecond both survive paging (the tiebreak bites)', async () => {
  // Paged at limit=1 so the boundary is guaranteed to fall BETWEEN the tied pair.
  const seen: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 40; guard++) {
    const qs: string = '?limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    const { json }: any = await feed(ownerApp, qs)
    seen.push(...json.events.map((e: any) => e.id))
    cursor = json.nextCursor
    if (!cursor) break
  }
  for (const s of ['a', 'b', 'c', 'd', 'e']) {
    assert.ok(seen.includes(`task:task-tie-${s}`), `tied event ${s} was skipped at a page boundary`)
  }
  assert.equal(seen.length, new Set(seen).size, 'a tied event was returned twice')
})

test('[ACT-1] nextCursor is null on the last page — no phantom "Load more"', async () => {
  const { json } = await feed(ownerApp, '?limit=100')
  assert.equal(json.nextCursor, null, 'a full read still offered another page')
})

test('[ACT-1] a malformed cursor is ignored rather than emptying the feed', async () => {
  const { json } = await feed(ownerApp, '?cursor=not-a-cursor')
  assert.ok(json.events.length > 0, 'a junk cursor silently blanked the feed')
})

// ─── The comparator, pinned directly ───────────────────────────────────────────
//
// The route-level paging tests exercise the comparator only INDIRECTLY, and the SQL
// layer now applies its own `(at desc, id desc)` ordering — which is enough to make
// those tests pass even if the JS tiebreak were deleted. That would be a latent bug:
// the JS tiebreak is what orders ties ACROSS sources, where SQL has no say. So it is
// pinned here, on its own.

test('[ACT-1] compareActivity breaks a timestamp tie by id, descending and TOTAL', () => {
  const ev = (id: string, at: number) => ({ id, at } as any)
  assert.ok(compareActivity(ev('b', 5), ev('a', 5)) < 0, 'tie must order by id descending')
  assert.ok(compareActivity(ev('a', 5), ev('b', 5)) > 0)
  assert.equal(compareActivity(ev('a', 5), ev('a', 5)), 0)
  // Newer still wins over the tiebreak.
  assert.ok(compareActivity(ev('a', 9), ev('z', 5)) < 0)
  // A cross-SOURCE tie — the case SQL can never order, because the prefix is a JS-side
  // construct. Sorted descending, 'task:x' precedes 'apf:x'.
  const mixed = [ev('apf:x', 7), ev('task:x', 7), ev('cx:x', 7)].sort(compareActivity)
  assert.deepEqual(mixed.map((e: any) => e.id), ['task:x', 'cx:x', 'apf:x'])
})

test('[ACT-1] isAfterCursor mirrors compareActivity exactly — same tie rule', () => {
  const ev = (id: string, at: number) => ({ id, at } as any)
  assert.equal(isAfterCursor(ev('a', 5), { at: 5, id: 'b' }), true, 'a lower id at the same ms is a later page')
  assert.equal(isAfterCursor(ev('b', 5), { at: 5, id: 'a' }), false)
  assert.equal(isAfterCursor(ev('x', 5), { at: 5, id: 'x' }), false, 'the cursor row itself must not repeat')
  assert.equal(isAfterCursor(ev('z', 4), { at: 5, id: 'a' }), true, 'older always sorts later')
  // The two functions must agree on every pair, or paging drifts from ordering.
  const rows = [ev('a', 5), ev('b', 5), ev('c', 4), ev('d', 6)]
  for (const c of rows) {
    for (const e of rows) {
      assert.equal(
        isAfterCursor(e, { at: c.at, id: c.id }),
        compareActivity(c, e) < 0,
        `disagreement between the comparator and the cursor for ${e.id} vs ${c.id}`,
      )
    }
  }
})

// ─── Filters ───────────────────────────────────────────────────────────────────

test('[ACT-1] the kind filter narrows to exactly that kind', async () => {
  const { json } = await feed(ownerApp, '?kind=task&limit=100')
  assert.ok(json.events.length > 0)
  assert.ok(json.events.every((e: any) => e.kind === 'task'))
})

test('[ACT-1] an unknown kind degrades to the unfiltered feed instead of erroring', async () => {
  const { json } = await feed(ownerApp, '?kind=nonsense_kind&limit=100')
  assert.ok(json.events.length > 0, 'an old client asking for a retired kind got nothing')
})

test('[ACT-1] the agent filter narrows by agent — and excludes audit rows, which have no agent', async () => {
  const { json } = await feed(ownerApp, `?agentId=${AGENT2}&limit=100`)
  assert.ok(json.events.length > 0)
  for (const e of json.events) {
    assert.equal(e.agentId, AGENT2, `a ${e.kind} row for another agent survived the filter`)
    assert.notEqual(e.kind, 'audit_event', 'an agent-less audit row matched an agent filter')
  }
})

test('[ACT-1] agent names are resolved so the phone need not show a raw uuid', async () => {
  const { json } = await feed(ownerApp, `?agentId=${AGENT}&limit=100`)
  assert.ok(json.events.length > 0)
  assert.ok(json.events.every((e: any) => e.agentName === 'Vera'), 'agentName was not resolved')
})

test('[ACT-1] a decided approval yields BOTH a filing and a decision row, ordered by their own timestamps', async () => {
  const { json } = await feed(ownerApp, '?kind=approval_filed,approval_decided&limit=100')
  const filed = json.events.find((e: any) => e.id === 'apf:ap-decided')
  const decided = json.events.find((e: any) => e.id === 'apd:ap-decided')
  assert.ok(filed && decided, 'a decided approval should appear as both a filing and a decision')
  assert.equal(filed.at, 1000, 'the filing must sort by createdAt')
  assert.equal(decided.at, 9000, 'the decision must sort by decidedAt')
  // The filing is history once decided; the decision carries the verdict.
  assert.equal(filed.outcome, 'info')
  assert.equal(decided.outcome, 'ok')
})

test('[ACT-1] a still-pending approval reads as pending', async () => {
  const { json } = await feed(ownerApp, '?kind=approval_filed&limit=100')
  const pending = json.events.find((e: any) => e.id === 'apf:ap-pending')
  assert.ok(pending)
  assert.equal(pending.outcome, 'pending')
  assert.equal(pending.target, 'connector_action')
})
