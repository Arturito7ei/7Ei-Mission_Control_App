/**
 * Smoke: the Memory tab's Obsidian vault connector, end-to-end.
 * Boots the backend in-process, seeds a company GITHUB_VAULT_TOKEN secret, and
 * hits /memory/tree + /memory/file — proving it reads the real vault repo.
 *   VAULT_TEST_TOKEN=$(gh auth token) npm run smoke:memory
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const work = mkdtempSync(join(tmpdir(), 'mc-mem-'))
process.env.DATABASE_URL = `file:${join(work, 'm.db')}`
const fail = (m: string) => { console.error('✗ SMOKE FAIL:', m); cleanup(); process.exit(1) }
function cleanup() { try { rmSync(work, { recursive: true, force: true }) } catch {} }

const main = async () => {
  const token = process.env.VAULT_TEST_TOKEN
  if (!token) fail('VAULT_TEST_TOKEN required (e.g. $(gh auth token))')
  const Fastify = (await import('fastify')).default
  const { setupDatabase } = await import('../src/db/setup.ts')
  const { db, schema } = await import('../src/db/client.ts')
  const { taskRoutes } = await import('../src/routes/all.ts')
  const { encrypt } = await import('../src/services/secrets.ts')

  await setupDatabase()
  const orgId = randomUUID()
  await db.insert(schema.organisations).values({ id: orgId, name: 'SmokeCo', ownerId: 'u1', createdAt: new Date() })
  await db.insert(schema.secrets).values({ id: randomUUID(), orgId, scope: 'company', scopeId: null, key: 'GITHUB_VAULT_TOKEN', valueEncrypted: encrypt(token!), createdAt: new Date() })

  const app = Fastify({ logger: false })
  await app.register(taskRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`

  const tree = await (await fetch(`${base}/api/orgs/${orgId}/memory/tree?path=vault`)).json() as any
  const names = (tree.entries ?? []).map((e: any) => e.name)
  const file = await (await fetch(`${base}/api/orgs/${orgId}/memory/file?path=vault/Protocols/MOC-Protocols.md`)).json() as any
  await app.close()

  if (!names.includes('Protocols') || !names.includes('Memory') || !names.includes('07-Agents'))
    fail('vault tree missing expected folders: ' + JSON.stringify(names))
  if (!/central shared index/i.test(file.markdown ?? '')) fail('MOC-Protocols.md content unexpected')

  console.log('✓ MEMORY CONNECTOR OK')
  console.log('  vault/ folders + notes:', names.join(', '))
  console.log('  read vault/Protocols/MOC-Protocols.md →', (file.markdown ?? '').length, 'bytes')
  cleanup(); process.exit(0)
}
main().catch(e => fail(e?.message ?? String(e)))
