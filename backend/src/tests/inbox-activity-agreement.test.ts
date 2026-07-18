// FIX-1 — THE CROSS-SURFACE INVARIANT: the Activity feed and the Inbox may not
// contradict each other about what awaits the operator.
//
// WHY THIS FILE EXISTS. FIX-1 was found by a human looking at the deployed dashboard:
// the Inbox read "Nothing needs a decision right now" while Activity, one click away,
// badged SIX rows "Awaiting decision". 2800 tests were green throughout, and none of
// them could have caught it — every existing tripwire pins one MODULE against another
// (web vocabulary vs phone vocabulary vs backend constants). Module-against-module
// cannot see a claim that is internally consistent and externally false.
//
// This is a CLAIM-AGAINST-REALITY assertion instead. It seeds one row of EVERY
// `tasks.status` and EVERY `approval_requests.status`, drives the REAL activity route
// and the REAL inbox route over a REAL database, applies the ACTUAL label function the
// two clients ship, and asserts SET EQUALITY between:
//
//     { rows the feed badges "Awaiting decision" }   ==   { rows the Inbox will decide }
//
// It fails if EITHER half drifts — a new task status that normalises to `pending`, a new
// approval status the Inbox stops listing, a label map that hands the phrase out again.
// It would have failed on day one of the bug.
//
// THE RULE THIS ENCODES, stated generally because the next instance will not be about
// approvals: ANY PHRASE THAT PROMISES THE OPERATOR AN ACTION MUST BE PINNED TO THE SET
// OF ROWS THE ACTION SURFACE WILL ACTUALLY ACCEPT. A badge is a promise; the surface
// that honours it is the source of truth; the two are one assertion apart.
//
// The label function is IMPORTED from web/lib, not re-implemented here. Re-implementing
// it would make this exactly the module-against-module test that missed the bug — the
// copy would agree with itself while the shipped UI said something else.
//
// DATABASE_URL is pointed at a temp file BEFORE db/client loads (it reads env at import).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'inbox-activity-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { activityRoutes } = await import('../routes/activity')
const { taskRoutes } = await import('../routes/tasks')
const { registerJsonBodyParser } = await import('../middleware/body-parser')

// The SHIPPED label function, imported from the web workspace. It is deliberately
// import-free (asserted by apps/mobile/src/activityKinds.test.ts), so this resolves
// without dragging web's node_modules into the backend test run.
const { outcomeLabel, AWAITING_DECISION } = await import('../../../web/lib/activityKinds.ts')

const ORG = 'org-agree', OWNER = 'user-owner', AGENT = 'agent-a'

/** EVERY status the tasks table can hold. Taken from `taskOutcome`'s switch plus the
 *  schema default, and INCLUDING an unknown one — a status nobody mapped must not fall
 *  through into a promise to the operator. */
const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'blocked', 'some_new_status']
/** EVERY inboxState that makes a task attention-worthy, per `inboxKind`. */
const INBOX_STATES = ['awaiting_review', 'needs_attention']
/** EVERY status the approval_requests table can hold, per `approvalOutcome`. */
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'revision_requested']
/** EVERY status agent_runs / connector_executions can hold, per their outcome maps.
 *  These kinds cannot promise a decision TODAY — which is exactly why they are seeded.
 *  The invariant is only as strong as the rows it runs over: a promise attached to a
 *  kind with no row in the fixture would be invisible, and the check would pass while
 *  the UI lied. (Found by mutation: adding a promise to `agent_run` did NOT fail this
 *  file until these rows existed.) */
const RUN_STATUSES = ['running', 'done', 'failed', 'orphaned', 'cancelled']
const CONNECTOR_STATUSES = ['running', 'succeeded', 'failed']
/** A 2xx and a 4xx audit row — `auditOutcome` maps by status code, not a status word. */
const AUDIT_CODES = [200, 403, 500]

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  registerJsonBodyParser(a)
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(activityRoutes)
  a.register(taskRoutes)
  return a
}

let app: FastifyInstance
/** approval id → the status it was seeded with, so a failure can name the culprit. */
const approvalStatusById = new Map<string, string>()
const taskStatusById = new Map<string, string>()

before(async () => {
  await setupDatabase()
  const now = new Date()

  await db.insert(schema.organisations).values([
    { id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now },
  ] as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values([
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', createdAt: now },
  ] as any)

  // One task per status, plus one per attention-worthy inboxState. Timestamps are
  // spread so ordering is deterministic; the invariant is about SETS, not order.
  let t = 0
  const tasks: any[] = []
  for (const status of TASK_STATUSES) {
    const id = `task-${status}`
    taskStatusById.set(id, status)
    tasks.push({ id, orgId: ORG, agentId: AGENT, title: `task ${status}`, status,
      createdAt: new Date(now.getTime() - (t++) * 1000) })
  }
  for (const state of INBOX_STATES) {
    const id = `task-${state}`
    taskStatusById.set(id, `in_progress/${state}`)
    tasks.push({ id, orgId: ORG, agentId: AGENT, title: `task ${state}`, status: 'in_progress',
      inboxState: state, createdAt: new Date(now.getTime() - (t++) * 1000) })
  }
  await db.insert(schema.tasks).values(tasks)

  // One approval per status. `decidedAt` is set for the decided ones so the feed's
  // approval_decided projector has a timestamp to sort on.
  const approvals = APPROVAL_STATUSES.map((status, i) => {
    const id = `appr-${status}`
    approvalStatusById.set(id, status)
    return {
      id, orgId: ORG, type: 'machine_exec', summary: `approval ${status}`, status,
      requestedByAgentId: AGENT,
      createdAt: new Date(now.getTime() - (100 + i) * 1000),
      decidedAt: status === 'pending' ? null : new Date(now.getTime() - (50 + i) * 1000),
    }
  })
  await db.insert(schema.approvalRequests).values(approvals as any)

  // One row of every REMAINING kind, so a promise attached to ANY kind is caught.
  await db.insert(schema.agentRuns).values(RUN_STATUSES.map((status, i) => ({
    id: `run-${status}`, orgId: ORG, agentId: AGENT, status,
    startedAt: new Date(now.getTime() - (200 + i) * 1000),
  })) as any)
  await db.insert(schema.connectorExecutions).values(CONNECTOR_STATUSES.map((status, i) => ({
    id: `conn-${status}`, orgId: ORG, agentId: AGENT, connectorId: 'github',
    action: 'issues.create', classification: 'write', status,
    createdAt: new Date(now.getTime() - (300 + i) * 1000),
  })) as any)
  await db.insert(schema.auditLogs).values(AUDIT_CODES.map((code, i) => ({
    id: `audit-${code}`, orgId: ORG, userId: OWNER, action: 'post.orgs',
    method: 'POST', path: `/api/orgs/${ORG}/arturita/converse`, statusCode: code,
    createdAt: new Date(now.getTime() - (400 + i) * 1000),
  })) as any)

  app = appAs(OWNER)
  await app.ready()
})

after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }) })

/** Every feed row, paging until exhausted — the invariant is about the WHOLE feed, not
 *  the first page. */
async function allFeedRows(): Promise<any[]> {
  const out: any[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 20; guard++) {
    const qs = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/activity${qs}` })
    assert.equal(res.statusCode, 200, res.body)
    const j = res.json() as any
    out.push(...(j.events ?? []))
    cursor = j.nextCursor ?? null
    if (!cursor) return out
  }
  throw new Error('feed did not terminate — paging guard tripped')
}

async function inboxBody(): Promise<any> {
  const res = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/inbox` })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

/** The feed's promise: rows the SHIPPED label function badges with the operator's
 *  phrase, reduced to the underlying record id (feed ids are prefixed, e.g. `apf:`). */
function feedPromises(events: any[]): Set<string> {
  const s = new Set<string>()
  for (const e of events) {
    if (outcomeLabel(e.kind, e.outcome) === AWAITING_DECISION) {
      s.add(String(e.id).replace(/^[a-z]+:/, ''))
    }
  }
  return s
}

test('[FIX-1] the feed’s "Awaiting decision" set EQUALS the Inbox’s decidable set', async () => {
  const events = await allFeedRows()
  const inbox = await inboxBody()

  const promised = feedPromises(events)
  const decidable = new Set<string>((inbox.approvals ?? []).map((a: any) => String(a.id)))

  // Not vacuous: something must actually be awaiting a decision, or two empty sets
  // would "agree" and this whole file would prove nothing. This is the exact shape of
  // vacuity that let the original bug ship.
  assert.ok(promised.size > 0, 'no feed row awaits the operator — the check is vacuous')
  assert.ok(decidable.size > 0, 'the Inbox offers nothing to decide — the check is vacuous')

  assert.deepEqual(
    [...promised].sort(), [...decidable].sort(),
    'THE CONTRADICTION IS BACK. The Activity feed promises the operator a decision on ' +
    'rows the Inbox will not offer, or vice versa. Feed says: ' +
    [...promised].map(id => `${id}(${approvalStatusById.get(id) ?? taskStatusById.get(id) ?? '?'})`).join(', ') +
    ' — Inbox says: ' + [...decidable].join(', '),
  )
})

test('[FIX-1] a QUEUED task appears in the feed but promises the operator nothing', async () => {
  // The specific live symptom, pinned end-to-end: the row IS in the feed (it is real
  // activity and must stay visible), it just no longer claims to want a decision.
  const events = await allFeedRows()
  const queued = events.find(e => e.kind === 'task' && e.id === 'task:task-pending')
  assert.ok(queued, 'the queued task vanished from the feed — it is real activity')
  assert.equal(queued.outcome, 'pending', 'the underlying outcome is unchanged — only the WORD changed')
  assert.notEqual(outcomeLabel(queued.kind, queued.outcome), AWAITING_DECISION)

  const inbox = await inboxBody()
  const inInbox = (inbox.inbox ?? []).some((i: any) => i.taskId === 'task-pending')
  assert.equal(inInbox, false,
    'a QUEUED task is structurally incapable of entering the Inbox (inboxKind returns null) — ' +
    'if this ever becomes true, the feed must start promising a decision on it too')
})

test('[FIX-1] every task status is represented, and NONE of them promises a decision', async () => {
  // The generalisation: whatever statuses exist, a TASK never earns the operator's
  // phrase. A new status that normalises to `pending` would fail here.
  const events = await allFeedRows()
  const seen = new Set(events.filter(e => e.kind === 'task').map(e => String(e.id)))
  for (const id of taskStatusById.keys()) {
    assert.ok(seen.has(`task:${id}`), `task ${id} (${taskStatusById.get(id)}) is missing from the feed`)
  }
  for (const e of events) {
    if (e.kind !== 'task') continue
    assert.notEqual(
      outcomeLabel(e.kind, e.outcome), AWAITING_DECISION,
      `task ${e.id} (status ${taskStatusById.get(String(e.id).replace(/^task:/, ''))}) ` +
      'promises the operator a decision the Inbox will never offer',
    )
  }
})

test('[FIX-1] a filed approval promises a decision for EXACTLY the pending one', async () => {
  // The other half: the fix must not have solved the contradiction by muting the real
  // obligation. `revision_requested` is correctly excluded — it awaits the AGENT.
  const events = await allFeedRows()
  const filed = events.filter(e => e.kind === 'approval_filed')
  assert.equal(filed.length, APPROVAL_STATUSES.length, 'not every approval was projected')

  const promising = filed
    .filter(e => outcomeLabel(e.kind, e.outcome) === AWAITING_DECISION)
    .map(e => String(e.id).replace(/^apf:/, ''))
  assert.deepEqual(promising, ['appr-pending'],
    'the set of approvals promising a decision drifted from {pending}')
})

test('[FIX-1] the invariant is enforced over the WHOLE feed, not just page one', async () => {
  // Guards the harness itself: if paging silently stopped early, the set comparison
  // above would compare a truncated feed and could agree by accident.
  const events = await allFeedRows()
  const kinds = new Set(events.map(e => e.kind))
  assert.ok(kinds.has('task'), 'no task rows reached the comparison')
  assert.ok(kinds.has('approval_filed'), 'no approval_filed rows reached the comparison')
  // EVERY kind must reach the comparison, or a promise attached to a missing kind
  // would be invisible and this file would pass while the UI lied.
  for (const k of ['task', 'approval_filed', 'approval_decided', 'agent_run', 'connector_execution', 'audit_event']) {
    assert.ok(kinds.has(k), `no ${k} rows reached the comparison — the invariant does not cover that kind`)
  }
  const seeded = TASK_STATUSES.length + INBOX_STATES.length + APPROVAL_STATUSES.length
    + RUN_STATUSES.length + CONNECTOR_STATUSES.length + AUDIT_CODES.length
  assert.ok(
    events.length >= seeded,
    `feed returned only ${events.length} rows for ${seeded} seeded — paging is truncating`,
  )
})

test('[FIX-1] NO kind other than approval_filed promises a decision, over real rows', () => {
  // The generalisation stated as a property rather than a list. Every seeded row of
  // every kind is checked; only a filed, still-pending approval may make the promise.
  return allFeedRows().then(events => {
    for (const e of events) {
      if (outcomeLabel(e.kind, e.outcome) !== AWAITING_DECISION) continue
      assert.equal(e.kind, 'approval_filed',
        `a ${e.kind} row (${e.id}, outcome ${e.outcome}) promises the operator a decision — ` +
        'the Inbox decides approvals only, so this row is a promise nothing will honour')
    }
  })
})
