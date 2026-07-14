// Route-level tests for the AG write paths — the ones the operator hit as bugs.
//
// The unit tests cover the pure services and `cors.test.ts` covers the transport,
// but neither would have caught a handler that accepts the request and persists
// nothing. These drive the REAL handlers against a REAL SQLite file through the
// REAL owner gate, then read the row back. A save that does not survive a
// re-read is not a save.
//
// DATABASE_URL is pointed at a temp file BEFORE db/client is imported (it reads
// the env at module load), so this never touches the operator's dev.db or Turso.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

const tmp = mkdtempSync(join(tmpdir(), 'ag-routes-'))
process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`
delete process.env.DATABASE_AUTH_TOKEN

const { db, schema } = await import('../db/client')
const { setupDatabase } = await import('../db/setup')
const { agentDetailRoutes } = await import('../routes/agent-detail')
const { registerJsonBodyParser } = await import('../middleware/body-parser')
const { eq } = await import('drizzle-orm')

const ORG = 'org-ag', OWNER = 'user-owner', MEMBER = 'user-member', AGENT = 'agent-ag'

let app: FastifyInstance

/**
 * The app as the secured scope builds it: Clerk resolved to a userId on req.auth,
 * and the SAME body parser index.ts installs — a handler test that skips the
 * transport layer is exactly how the avatar Remove shipped broken twice.
 */
function appAs(userId: string) {
  const a = Fastify({ logger: false })
  registerJsonBodyParser(a)
  a.addHook('onRequest', async (req) => { (req as any).auth = { userId }; (req as any).userId = userId })
  a.register(agentDetailRoutes)
  return a
}

/** Exactly the headers `web/lib/api.ts` puts on every call, body or not. */
const BROWSER_HEADERS = { 'content-type': 'application/json' }

const agentRow = async () => db.query.agents.findFirst({ where: eq(schema.agents.id, AGENT) })

before(async () => {
  await setupDatabase()
  const now = new Date()
  await db.insert(schema.organisations).values({ id: ORG, name: 'Sevenei', ownerId: OWNER, createdAt: now } as any)
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), orgId: ORG, userId: OWNER, role: 'owner', createdAt: now },
    { id: randomUUID(), orgId: ORG, userId: MEMBER, role: 'member', createdAt: now },
  ] as any)
  await db.insert(schema.agents).values({
    id: AGENT, orgId: ORG, name: 'Vera', role: 'Analyst', skills: ['research'],
    avatarUrl: 'data:image/png;base64,SEED', runtime: 'internal', createdAt: now,
  } as any)
  await db.insert(schema.skills).values([
    { id: 's1', name: 'research', description: 'reads things', domain: 'analysis', content: '# research', createdAt: now },
    { id: 's2', name: 'writing', description: 'writes things', domain: 'comms', content: '# writing', createdAt: now },
  ] as any)
  app = appAs(OWNER)
  await app.ready()
})

after(async () => {
  await app?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ─── BUG 1 — Instructions save ───────────────────────────────────────────────

test('[AGFIX1] saving an instruction file persists it and reads back', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/files`,
    payload: { path: 'AGENTS.md', content: '# Vera\n\nYou analyse things.\n' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().file.stored, true)

  const read = await app.inject({ method: 'GET', url: `/api/orgs/${ORG}/agents/${AGENT}/files/content?path=AGENTS.md` })
  assert.equal(read.statusCode, 200)
  assert.equal(read.json().content, '# Vera\n\nYou analyse things.\n')
  assert.equal(read.json().stored, true)
})

test('[AGFIX1] saving the same file again updates it rather than duplicating', async () => {
  await app.inject({ method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/files`, payload: { path: 'AGENTS.md', content: 'v2' } })
  const rows = await db.select().from(schema.agentFiles).where(eq(schema.agentFiles.agentId, AGENT))
  assert.equal(rows.filter(r => r.path === 'AGENTS.md').length, 1)
  assert.equal(rows.find(r => r.path === 'AGENTS.md')!.content, 'v2')
})

test('[AGFIX1] a bad file name is a specific 400, not a mystery', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/files`,
    payload: { path: '../../etc/passwd', content: 'x' },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /bare \.md filename/i)
})

test('[AGFIX1] a non-owner cannot save an instruction file', async () => {
  const member = appAs(MEMBER)
  await member.ready()
  const res = await member.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/files`, payload: { path: 'AGENTS.md', content: 'nope' },
  })
  assert.equal(res.statusCode, 403)
  await member.close()
})

// ─── BUG 2 — avatar remove ───────────────────────────────────────────────────

test('[AGFIX2] removing the avatar clears avatar_url so the icon takes over', async () => {
  assert.ok((await agentRow())!.avatarUrl, 'fixture should start with a picture')

  const res = await app.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/agents/${AGENT}/avatar` })
  assert.equal(res.statusCode, 204, res.body)
  assert.equal((await agentRow())!.avatarUrl, null)
})

test('[AGFIX2] removing an avatar that is already gone is not an error', async () => {
  const res = await app.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/agents/${AGENT}/avatar` })
  assert.equal(res.statusCode, 204)
  assert.equal((await agentRow())!.avatarUrl, null)
})

// The Remove button 400'd in production while the test above passed, because the
// test sent no Content-Type and the browser sends one. `web/lib/api.ts` sets
// `Content-Type: application/json` on every request; a DELETE has no body; the
// stock Fastify JSON parser rejects that pair with FST_ERR_CTP_EMPTY_JSON_BODY
// before any handler runs. These drive the route the way the dashboard does.
test('[AGFIX4] Remove works with the browser\'s headers — CT:json and no body', async () => {
  await db.update(schema.agents).set({ avatarUrl: 'data:image/png;base64,SEED' }).where(eq(schema.agents.id, AGENT))

  const res = await app.inject({
    method: 'DELETE', url: `/api/orgs/${ORG}/agents/${AGENT}/avatar`, headers: BROWSER_HEADERS,
  })
  assert.equal(res.statusCode, 204, res.body)
  assert.equal((await agentRow())!.avatarUrl, null, 'the picture must be gone, so the icon takes over')
})

test('[AGFIX4] a bodiless PUT is judged by the validator, not refused by the parser', async () => {
  // The parser must hand `{}` to the handler. Whether an empty patch is then a
  // 400 is the validator's call — but the reason must come from the handler, and
  // never be the parser's FST_ERR_CTP_EMPTY_JSON_BODY.
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/config`, headers: BROWSER_HEADERS,
  })
  assert.notEqual(res.json().code, 'FST_ERR_CTP_EMPTY_JSON_BODY')
  assert.doesNotMatch(res.body, /Body cannot be empty/i)
})

test('[AGFIX4] genuinely broken JSON is still refused, and says so', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/config`, headers: BROWSER_HEADERS, payload: '{"name":',
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message ?? res.json().error, /invalid json/i)
})

test('[AGFIX2] a non-owner cannot remove the avatar', async () => {
  const member = appAs(MEMBER)
  await member.ready()
  const res = await member.inject({ method: 'DELETE', url: `/api/orgs/${ORG}/agents/${AGENT}/avatar` })
  assert.equal(res.statusCode, 403)
  await member.close()
})

// ─── Feature 3 — skills tick / untick ────────────────────────────────────────

test('[AG-SK] ticking a skill installs it and it survives a re-read', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/skills`, payload: { skills: ['research', 'writing'] },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().installed.map((s: any) => s.name), ['research', 'writing'])
  assert.equal(res.json().selectedCount, 2)
  assert.deepEqual((await agentRow())!.skills, ['research', 'writing'])
})

test('[AG-SK] unticking uninstalls it — the whole point of the tab', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/skills`, payload: { skills: ['writing'] },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().installed.map((s: any) => s.name), ['writing'])
  assert.deepEqual(res.json().other.map((s: any) => s.name), ['research'])
  assert.equal(res.json().selectedCount, 1)
  assert.deepEqual((await agentRow())!.skills, ['writing'])
})

test('[AG-SK] an orphaned skill does not block toggling the others', async () => {
  // The library row goes away underneath the agent — exactly what produced a 400
  // on EVERY toggle before, because the checkbox list resends the orphan.
  await db.update(schema.agents).set({ skills: ['writing', 'legacy-scraper'] }).where(eq(schema.agents.id, AGENT))

  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/skills`,
    payload: { skills: ['writing', 'legacy-scraper', 'research'] },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().orphaned, ['legacy-scraper'])
  assert.equal(res.json().selectedCount, 3)
  assert.deepEqual((await agentRow())!.skills.sort(), ['legacy-scraper', 'research', 'writing'])
})

test('[AG-SK] unticking an orphan is how you get rid of it', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/skills`, payload: { skills: ['research'] },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().orphaned, [])
  assert.deepEqual((await agentRow())!.skills, ['research'])
})

test('[AG-SK] a skill that was never in the library is still refused', async () => {
  const res = await app.inject({
    method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/skills`, payload: { skills: ['research', 'not-a-skill'] },
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /not-a-skill/)
  assert.deepEqual((await agentRow())!.skills, ['research'], 'a rejected selection must not partially apply')
})

test('[AG-SK] a non-owner cannot change the skills', async () => {
  const member = appAs(MEMBER)
  await member.ready()
  const res = await member.inject({ method: 'PUT', url: `/api/orgs/${ORG}/agents/${AGENT}/skills`, payload: { skills: [] } })
  assert.equal(res.statusCode, 403)
  assert.deepEqual((await agentRow())!.skills, ['research'], 'the refused write must not have landed')
  await member.close()
})

test('[AG-SK] every skills write leaves a config revision behind', async () => {
  const revs = await db.select().from(schema.configRevisions).where(eq(schema.configRevisions.entityId, AGENT))
  assert.ok(revs.length > 0, 'skills changes must be auditable like any other config change')
})
