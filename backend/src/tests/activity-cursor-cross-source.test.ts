// AUDIT-ACT1 H-1, the CROSS-SOURCE half — added during review of the audit fix.
//
// `activity-cursor-burst.test.ts` proves the exact cursor against a burst in ONE source
// (tasks). That exercises `cursorBoundFor`'s `tuple` branch and nothing else. But the
// whole reason the tuple was believed inexpressible in SQL is the SOURCE PREFIX, and the
// prefix argument only does work in the OTHER branch: when the cursor points into source
// A and source B holds rows at the same millisecond, B's rows are included or excluded
// WHOLESALE by a static `prefix < cursor.id` comparison. A single-source burst never
// reaches that code path, so the fix could be wrong there and still ship green.
//
// So: seed a tie ACROSS several sources at one millisecond, page it at several limits,
// and require every row exactly once with nothing older starved. Descending feed-id
// order at equal `at` is task: > run: > cx: > aud: > apf: > apd:, so a page boundary
// lands INSIDE the tie at most limits — which is exactly the boundary being tested.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'xsrc-'))
process.env.DATABASE_URL = `file:${join(tmp, 'x.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { activityRoutes } = await import('../routes/activity')
const { registerJsonBodyParser } = await import('../middleware/body-parser')
const { cursorBoundFor, SOURCE_PREFIX, isAfterCursor, ACTIVITY_KINDS } = await import('../services/activity')

const ORG = 'o-x', OWNER = 'u-x', AGENT = 'ag-x'
const TIE_MS = 5000
const PER_SOURCE = 8

let app: FastifyInstance

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([{ id: ORG, name: 'O', ownerId: OWNER, createdAt: now }] as any)
  await db.insert(schema.orgMembers).values([{ id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now }] as any)
  await db.insert(schema.agents).values([{ id: AGENT, orgId: ORG, name: 'A', role: 'R', skills: [], runtime: 'internal', createdAt: now }] as any)

  const n = (i: number) => String(i).padStart(3, '0')

  // FOUR sources, all tied on the same millisecond. This is the shape a batched
  // `db.insert().values([...])` produces — one `new Date()` for the whole array — and
  // the shape an agent run that files approvals and touches connectors produces too.
  await db.insert(schema.tasks).values([
    ...Array.from({ length: PER_SOURCE }, (_, i) => ({
      id: `t-${n(i)}`, orgId: ORG, agentId: AGENT, title: `task ${i}`,
      status: 'done', createdAt: new Date(TIE_MS),
    })),
    // Strictly older rows: these are what "starvation" would silently eat.
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `t-old-${i}`, orgId: ORG, agentId: AGENT, title: `older task ${i}`,
      status: 'done', createdAt: new Date(1000 - i),
    })),
  ] as any)

  await db.insert(schema.agentRuns).values(
    Array.from({ length: PER_SOURCE }, (_, i) => ({
      id: `r-${n(i)}`, orgId: ORG, agentId: AGENT, taskId: null, status: 'done',
      startedAt: new Date(TIE_MS), endedAt: new Date(TIE_MS),
    })) as any,
  )

  await db.insert(schema.connectorExecutions).values(
    Array.from({ length: PER_SOURCE }, (_, i) => ({
      id: `c-${n(i)}`, orgId: ORG, agentId: AGENT, connectorId: 'github', action: `act-${i}`,
      classification: 'read', approvalId: null, status: 'succeeded', error: null,
      createdAt: new Date(TIE_MS),
    })) as any,
  )

  await db.insert(schema.approvalRequests).values(
    Array.from({ length: PER_SOURCE }, (_, i) => ({
      id: `a-${n(i)}`, orgId: ORG, type: 'email_send', summary: `approval ${i}`,
      status: 'pending', payload: null, requestedByAgentId: AGENT,
      decidedBy: null, decidedAt: null, decisionNote: null, createdAt: new Date(TIE_MS),
    })) as any,
  )

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  app.addHook('onRequest', async (req: any) => { req.auth = { userId: OWNER }; req.userId = OWNER })
  app.register(activityRoutes)
  await app.ready()
})

async function get(qs: string) {
  const r = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/activity${qs}` })
  return r
}

async function pageAll(limit: number): Promise<string[]> {
  const seen: string[] = []
  let cursor: string | null = null
  let guard = 0
  do {
    const r = await get(`?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    assert.equal(r.statusCode, 200, r.body)
    const j = r.json() as any
    assert.ok(j.events.length <= limit, `a page exceeded limit ${limit}`)
    for (const e of j.events) seen.push(e.id)
    cursor = j.nextCursor
  } while (cursor && ++guard < 3000)
  assert.ok(guard < 3000, 'paging did not terminate')
  return seen
}

// Expected total: 4 tied sources x PER_SOURCE, + 3 older tasks, + PER_SOURCE
// approval_FILED rows are the same approvals (no decided rows seeded).
const EXPECTED = PER_SOURCE * 4 + 3

test('[AUDIT-ACT1] a tie spanning FOUR sources pages exactly once, at every limit', async () => {
  const full = await pageAll(EXPECTED + 10)
  assert.equal(full.length, EXPECTED, `unpaged read saw ${full.length}/${EXPECTED}`)

  for (const limit of [1, 2, 3, 5, 7, 8, 9, 16, 31]) {
    const seen = await pageAll(limit)
    const dupes = seen.filter((id, i) => seen.indexOf(id) !== i)
    assert.deepEqual(dupes, [], `limit=${limit} returned duplicates: ${dupes.slice(0, 5)}`)
    assert.deepEqual(
      [...seen].sort(), [...full].sort(),
      `limit=${limit} did not reproduce the unpaged feed — a cross-source tie was skipped`,
    )
    // The strictly-older rows are the starvation canary: if the tie ate the budget they
    // are the first thing to disappear.
    for (let i = 0; i < 3; i++) {
      assert.ok(seen.includes(`task:t-old-${i}`), `limit=${limit} STARVED older row t-old-${i}`)
    }
  }
})

test('[AUDIT-ACT1] cursorBoundFor agrees with isAfterCursor for EVERY source at a tie', () => {
  // The SQL predicate and the JS filter must decide identically, or paging drifts from
  // ordering. Checked exhaustively against a cursor drawn from each source in turn.
  for (const cursorKind of ACTIVITY_KINDS) {
    const cursor = { at: TIE_MS, id: SOURCE_PREFIX[cursorKind] + 'm-500' }
    for (const rowKind of ACTIVITY_KINDS) {
      const bound = cursorBoundFor(rowKind, cursor)
      for (const rowId of ['m-000', 'm-500', 'm-999']) {
        const ev = { at: TIE_MS, id: SOURCE_PREFIX[rowKind] + rowId } as any
        const jsSays = isAfterCursor(ev, cursor)
        let sqlSays: boolean
        switch (bound.mode) {
          case 'none': sqlSays = true; break
          case 'lt': sqlSays = false; break            // at < cursorAt only; this row ties
          case 'lte': sqlSays = true; break            // whole tie included
          case 'tuple': sqlSays = rowId < bound.rowId; break
        }
        assert.equal(
          sqlSays, jsSays,
          `SQL/JS disagree: cursor in ${cursorKind}, row ${rowKind}:${rowId} — ` +
          `bound=${bound.mode}, sql=${sqlSays}, js=${jsSays}`,
        )
      }
    }
  }
})

// ─── AUDIT-ACT1 M-1 — a hostile cursor must not 500, and must never echo SQL ────────

test('[AUDIT-ACT1] an out-of-range or hostile cursor never 500s or leaks the statement', async () => {
  const hostile = [
    '9'.repeat(400) + '.task:x',                 // beyond Date's range — the reported 500
    '8640000000000001.task:x',                   // one past MAX_CURSOR_AT
    '1e400.task:x',                              // Infinity
    '-1.task:x',
    'NaN.task:x',
    '5000.',                                     // empty row id
    '5000.' + 'x'.repeat(5000),
    "5000.task:'; DROP TABLE tasks;--",
    '5000.%00task:x',
  ]
  for (const c of hostile) {
    const r = await get(`?cursor=${encodeURIComponent(c)}`)
    assert.ok(r.statusCode < 500, `cursor ${c.slice(0, 24)}… returned ${r.statusCode}`)
    const body = r.body.toLowerCase()
    for (const leak of ['select ', ' from ', 'where ', 'sqlite', 'bind', 'statement']) {
      assert.ok(!body.includes(leak), `the response echoed "${leak}" back to the caller for cursor ${c.slice(0, 24)}…`)
    }
  }
  // And the table is still there — the injection attempt changed nothing.
  const r = await get('?limit=100')
  assert.equal(r.statusCode, 200)
  assert.ok((r.json() as any).events.length > 0, 'the feed is empty after the hostile cursors')
})
