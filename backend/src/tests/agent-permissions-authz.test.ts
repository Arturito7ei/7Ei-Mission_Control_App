// SEC — the per-agent permissions WRITE path is owner-gated + validated.
//
// The hole: `PATCH /api/agents/:agentId/permissions` was member-gated (the
// surface-wide agentId→org membership hook) and unvalidated, so any org MEMBER
// could rewrite ANY agent's capability caps to an arbitrary string array — while
// every sibling agent-write route (config/trust/model-profile/skills) is
// `requireOrgRole('owner')` + validated. The fix re-paths it to the org-scoped
// owner-gated form and validates the caps; the legacy `PATCH /api/agents/:id`
// can no longer be a side door around that gate either.
//
// These drive the REAL handlers against a REAL SQLite file through the REAL owner
// gate, then read the row back — plus unit tests for the pure validator.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'ag-perms-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentRoutes } = await import('../routes/all')
const {
  validatePermissions, isValidCapability, MAX_AGENT_CAPS, MAX_CAP_LEN,
} = await import('../services/agent-permissions')
const { eq } = await import('drizzle-orm')

const ORG = 'org-perms', OWNER = 'user-owner', MEMBER = 'user-member', AGENT = 'agent-perms'
const OTHER_ORG = 'org-other', OTHER_OWNER = 'user-other-owner', OTHER_AGENT = 'agent-other'

let app: FastifyInstance

function appAs(userId: string) {
  const a = Fastify({ logger: false })
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentRoutes)
  return a
}

const agentRow = async (id: string) => db.query.agents.findFirst({ where: eq(schema.agents.id, id) })
const perms = async (id: string) => (await agentRow(id))!.permissions

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
    { id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: [], runtime: 'internal', createdAt: now },
    { id: OTHER_AGENT, orgId: OTHER_ORG, name: 'Spy', role: 'Analyst', skills: [], runtime: 'internal', createdAt: now },
  ] as any)
  app = appAs(OWNER)
  await app.ready()
})

after(async () => {
  await app?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── Pure validator ──────────────────────────────────────────────────────────

test('[PERMS-VAL] null/undefined → allow-all (empty array)', () => {
  assert.deepEqual(validatePermissions(undefined), { ok: true, caps: [] })
  assert.deepEqual(validatePermissions(null), { ok: true, caps: [] })
})

test('[PERMS-VAL] an empty array is preserved verbatim (allow-all)', () => {
  assert.deepEqual(validatePermissions([]), { ok: true, caps: [] })
})

test('[PERMS-VAL] known vocabulary is accepted (ns:action, ns:*, bare, *)', () => {
  const ok = ['memory:write', 'memory:read', 'memory:*', 'attachment:write', 'connector:github', 'connector:*', 'machine_exec', '*']
  for (const c of ok) assert.equal(isValidCapability(c), true, c)
  assert.deepEqual(validatePermissions(ok).ok, true)
})

test('[PERMS-VAL] duplicates are collapsed; blanks are dropped', () => {
  const r = validatePermissions(['memory:write', ' memory:write ', '', '   ', '*'])
  assert.deepEqual(r, { ok: true, caps: ['memory:write', '*'] })
})

test('[PERMS-VAL] an unknown namespace or bare word is rejected', () => {
  for (const bad of ['danger:zone', 'rm -rf /', 'billing:charge', 'memory', 'exec']) {
    assert.equal(isValidCapability(bad), false, bad)
    assert.equal((validatePermissions([bad]) as any).ok, false, bad)
  }
})

test('[PERMS-VAL] a multi-colon cap is rejected (exactly one segment)', () => {
  assert.equal(isValidCapability('memory:write:extra'), false)
})

test('[PERMS-VAL] a non-array / non-string / oversized / overlong input is rejected', () => {
  assert.equal((validatePermissions('memory:write') as any).ok, false)
  assert.equal((validatePermissions({}) as any).ok, false)
  assert.equal((validatePermissions([123]) as any).ok, false)
  assert.equal((validatePermissions([`connector:${'x'.repeat(MAX_CAP_LEN)}`]) as any).ok, false)
  assert.equal((validatePermissions(Array.from({ length: MAX_AGENT_CAPS + 1 }, () => '*')) as any).ok, false)
})

// ─── Route: owner gate ───────────────────────────────────────────────────────

test('[PERMS-AUTHZ] a non-owner MEMBER cannot write permissions → 403, row unchanged', async () => {
  const member = appAs(MEMBER)
  await member.ready()
  const before = await perms(AGENT)
  const res = await member.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/permissions`,
    payload: { permissions: ['*'] },
  })
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(await perms(AGENT), before, 'the refused write must not have landed')
  await member.close()
})

test('[PERMS-AUTHZ] an OWNER can write valid permissions → 200, persisted + audited', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/permissions`,
    payload: { permissions: ['memory:write', 'memory:write', 'attachment:write'] },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().permissions, ['memory:write', 'attachment:write'])
  assert.equal(await perms(AGENT), JSON.stringify(['memory:write', 'attachment:write']))
  const revs = await db.select().from(schema.configRevisions).where(eq(schema.configRevisions.entityId, AGENT))
  assert.ok(revs.length > 0, 'a permissions change must be auditable')
})

test('[PERMS-AUTHZ] an owner writing an INVALID capability → 400, unchanged', async () => {
  const before = await perms(AGENT)
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/permissions`,
    payload: { permissions: ['memory:write', 'danger:zone'] },
  })
  assert.equal(res.statusCode, 400, res.body)
  assert.match(res.json().error, /unknown capability/i)
  assert.equal(await perms(AGENT), before, 'a rejected write must not partially apply')
})

test('[PERMS-AUTHZ] clearing to an empty list preserves allow-all semantics', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/permissions`,
    payload: { permissions: [] },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().permissions, [])
  assert.equal(await perms(AGENT), JSON.stringify([]), 'stored [] — isCapabilityAllowed treats it as allow-all')
})

// ─── Route: tenant scoping ───────────────────────────────────────────────────

test('[PERMS-AUTHZ] an owner cannot target an agent in ANOTHER org → 404, unchanged', async () => {
  const before = await perms(OTHER_AGENT)
  // OWNER is an owner of ORG, not OTHER_ORG: pairing ORG's path with the foreign
  // agent id must not write. (And the foreign owner is not a member of ORG.)
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${OTHER_AGENT}/permissions`,
    payload: { permissions: ['*'] },
  })
  assert.equal(res.statusCode, 404, res.body)
  assert.equal(await perms(OTHER_AGENT), before, 'a cross-tenant write must not land')
})

// ─── Legacy PATCH side door ──────────────────────────────────────────────────

test('[PERMS-AUTHZ] the legacy PATCH /api/agents/:id cannot write permissions', async () => {
  // Seed a known cap set via the owner route, then try to overwrite it through the
  // unvalidated legacy PATCH. The `permissions` key must be dropped; other fields
  // still apply, proving the route works but the side door is closed.
  await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/permissions`,
    payload: { permissions: ['memory:write'] },
  })
  const res = await app.inject({
    method: 'PATCH', url: `/api/agents/${AGENT}`,
    payload: { permissions: ['*'], role: 'Senior Analyst' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(await perms(AGENT), JSON.stringify(['memory:write']), 'permissions must be untouched by the legacy route')
  assert.equal((await agentRow(AGENT))!.role, 'Senior Analyst', 'other fields still apply')
})
