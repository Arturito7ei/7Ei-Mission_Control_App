// SEC (audit/perms-authz) — the config-rollback route is owner-gated.
//
// `POST /api/revisions/:id/rollback` restores a prior agent snapshot, and the
// restored field set includes `permissions` (capability caps) plus `role`,
// `status`, `llmProvider/llmModel`, `reportsTo` — every one an OWNER-gated field
// on the sibling write routes. The route carries no `:orgId`, so it ran behind
// only the surface-wide MEMBER membership gate: a plain member could pick any
// revision and revert it, defeating the owner gate on the permissions write this
// audit hardened (owner tightens caps → member rolls the tightening back to the
// prior allow-all snapshot). The fix enforces OWNER in-handler off `rev.orgId`.
//
// These drive the REAL handler against a REAL SQLite file.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'ag-rollback-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentRoutes } = await import('../routes/all')
const { eq } = await import('drizzle-orm')

const ORG = 'org-rb', OWNER = 'user-owner-rb', MEMBER = 'user-member-rb', AGENT = 'agent-rb'

let app: FastifyInstance

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentRoutes)
  return a
}

const permsOf = async (id: string) => (await db.query.agents.findFirst({ where: eq(schema.agents.id, id) }))!.permissions

// A revision whose `before` snapshot carries a LOOSER permissions state (allow-all)
// than the agent's current tightened caps — the exact shape an owner tightening
// produces, and the payload a member-driven rollback would use to escalate.
async function seedLooseRevision(): Promise<string> {
  const revId = randomUUID()
  await db.insert(schema.configRevisions).values({
    id: revId, orgId: ORG, entity: 'agent', entityId: AGENT,
    before: JSON.stringify({ permissions: JSON.stringify([]), role: 'Analyst' }),        // allow-all
    after: JSON.stringify({ permissions: JSON.stringify(['memory:write']), role: 'Analyst' }),
    actor: OWNER, createdAt: new Date(),
  } as any)
  return revId
}

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values([{ id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now }] as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
    { id: randomUUID(), orgId: ORG, userId: MEMBER, role: 'member', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values([
    // Agent currently tightened to a single cap; rollback would widen it to allow-all.
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', permissions: JSON.stringify(['memory:write']), createdAt: now },
  ] as any)
  app = appAs(OWNER)
  await app.ready()
})

after(async () => {
  await app?.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('[ROLLBACK-AUTHZ] a non-owner MEMBER cannot roll back an agent revision → 403, permissions unchanged', async () => {
  const revId = await seedLooseRevision()
  const before = await permsOf(AGENT)
  const member = appAs(MEMBER)
  await member.ready()
  const res = await member.inject({ method: 'POST', url: `/api/revisions/${revId}/rollback`, payload: {} })
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(await permsOf(AGENT), before, 'a refused rollback must not restore the looser (allow-all) caps')
  await member.close()
})

test('[ROLLBACK-AUTHZ] an OWNER can still roll back → 200, snapshot restored', async () => {
  const revId = await seedLooseRevision()
  const res = await app.inject({ method: 'POST', url: `/api/revisions/${revId}/rollback`, payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(res.json().restored.includes('permissions'), 'the owner rollback restores the permissions field')
  assert.equal(await permsOf(AGENT), JSON.stringify([]), 'owner rollback restored the allow-all snapshot')
})
