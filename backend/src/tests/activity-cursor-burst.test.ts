// AUDIT-ACT1 H-1 regression: a burst of same-millisecond rows in ONE source must not
// strand its own tail, nor starve every strictly-older event in the org.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'tieburst-'))
process.env.DATABASE_URL = `file:${join(tmp, 'b.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { activityRoutes } = await import('../routes/activity')
const { registerJsonBodyParser } = await import('../middleware/body-parser')

const ORG = 'o1', OWNER = 'u1'
let app: FastifyInstance
const BURST = Number(process.env.BURST ?? '200')

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([{ id: ORG, name: 'O', ownerId: OWNER, createdAt: now }] as any)
  await db.insert(schema.orgMembers).values([{ id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now }] as any)
  await db.insert(schema.agents).values([{ id: 'ag', orgId: ORG, name: 'A', role: 'R', skills: [], runtime: 'internal', createdAt: now }] as any)

  const rows: any[] = []
  for (let i = 0; i < BURST; i++) {
    rows.push({ id: `burst-${String(i).padStart(4, '0')}`, orgId: ORG, agentId: 'ag',
      title: `burst ${i}`, status: 'done', createdAt: new Date(5000) })
  }
  for (let i = 0; i < 5; i++) {
    rows.push({ id: `older-${i}`, orgId: ORG, agentId: 'ag', title: `older ${i}`,
      status: 'done', createdAt: new Date(4000 - i) })
  }
  await db.insert(schema.tasks).values(rows as any)

  app = Fastify({ logger: false })
  registerJsonBodyParser(app)
  app.addHook('onRequest', async (req: any) => { req.auth = { userId: OWNER }; req.userId = OWNER })
  app.register(activityRoutes)
  await app.ready()
})

async function get(qs: string) {
  const r = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/activity${qs}` })
  assert.equal(r.statusCode, 200, r.body)
  return r.json() as any
}

test(`AUDIT-ACT1 H-1: ${BURST} same-ms rows in one source — no skip, no starvation`, async () => {
  for (const limit of [1, 5, 10, 40]) {
    const seen: string[] = []
    let cursor: string | null = null, guard = 0
    do {
      const j = await get(`?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      for (const e of j.events) seen.push(e.id)
      cursor = j.nextCursor
    } while (cursor && ++guard < 5000)

    const dupes = seen.filter((id, i) => seen.indexOf(id) !== i)
    assert.deepEqual(dupes, [], `limit=${limit} DUPLICATES: ${dupes.slice(0, 5)}`)
    const missingBurst = Array.from({ length: BURST }, (_, i) => `task:burst-${String(i).padStart(4, '0')}`)
      .filter((id) => !seen.includes(id))
    assert.deepEqual(missingBurst, [], `limit=${limit} SKIPPED ${missingBurst.length} burst rows`)
    const missingOlder = Array.from({ length: 5 }, (_, i) => `task:older-${i}`).filter((id) => !seen.includes(id))
    assert.deepEqual(missingOlder, [], `limit=${limit} STARVED older rows: ${missingOlder}`)
    assert.equal(seen.length, BURST + 5, `limit=${limit} saw ${seen.length}/${BURST + 5}`)
  }
})
