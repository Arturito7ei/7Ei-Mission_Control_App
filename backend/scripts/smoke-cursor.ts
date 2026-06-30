/**
 * Phase 4 smoke — the Cursor file/rules-based adapter.
 *
 * Boots the agent API on a real port, seeds an external agent (runtime=cursor)
 * with an assigned task, then drives the real cursor_adapter.py twice:
 *   pass 1 → claims + writes a work order to the inbox (task → in_progress)
 *   (test simulates Cursor writing TASK-<id>.result.md)
 *   pass 2 → detects the result and posts /result (task → done)
 * Asserts the task reaches done with the result text and the order is archived.
 *
 *   npm run smoke:cursor
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const work = mkdtempSync(join(tmpdir(), 'mc-smoke-cursor-'))
const inbox = join(work, 'coordination', 'inbox')
process.env.DATABASE_URL = `file:${join(work, 'smoke.db')}`

const fail = (m: string) => { console.error('✗ SMOKE FAIL:', m); cleanup(); process.exit(1) }
function cleanup() { try { rmSync(work, { recursive: true, force: true }) } catch {} }

const main = async () => {
  const Fastify = (await import('fastify')).default
  const { setupDatabase } = await import('../src/db/setup.ts')
  const { db, schema } = await import('../src/db/client.ts')
  const { agentApiRoutes } = await import('../src/routes/agent-api.ts')
  const { generateAgentToken, hashToken } = await import('../src/middleware/agent-token.ts')
  const { eq } = await import('drizzle-orm')

  await setupDatabase()
  const orgId = randomUUID(), agentId = randomUUID(), taskId = randomUUID()
  const { token } = generateAgentToken()
  await db.insert(schema.organisations).values({ id: orgId, name: 'SmokeCo', ownerId: 'u1', createdAt: new Date() })
  await db.insert(schema.agents).values({
    id: agentId, orgId, name: 'Arturito · Cursor', role: 'Eng',
    llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514', agentType: 'external',
    runtime: 'cursor', apiTokenHash: hashToken(token), status: 'idle', createdAt: new Date(),
  } as any)
  await db.insert(schema.tasks).values({
    id: taskId, orgId, agentId, assignedTo: agentId, title: 'add a helper',
    input: 'Add a formatDate() helper and a test.', status: 'assigned',
    priority: 'medium', kanbanColumn: 'in_progress', createdAt: new Date(),
  } as any)

  const app = Fastify({ logger: false })
  await app.register(agentApiRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`
  const adapter = join(import.meta.dirname, '..', '..', 'adapters', 'cursor', 'cursor_adapter.py')
  const env = { ...process.env, MC_BASE_URL: base, MC_AGENT_TOKEN: token, MC_INBOX: inbox }
  const runAdapter = () => new Promise<void>((resolve) => {
    const c = spawn('python3', [adapter, '--once'], { env })
    c.stdout.on('data', d => process.stdout.write(d))
    c.stderr.on('data', d => process.stderr.write(d))
    c.on('close', () => resolve())
  })

  // pass 1 → work order
  await runAdapter()
  const orderPath = join(inbox, `TASK-${taskId}.md`)
  if (!existsSync(orderPath)) { await app.close(); fail('pass 1 did not write a work order') }
  let t1 = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
  if (t1?.status !== 'in_progress') { await app.close(); fail(`after pass 1 status=${t1?.status} (expected in_progress)`) }

  // simulate Cursor completing the work
  const marker = `cursor-${taskId.slice(0, 8)}`
  writeFileSync(join(inbox, `TASK-${taskId}.result.md`), `Added formatDate() + test. ${marker}`)

  // pass 2 → detect result, post done
  await runAdapter()
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  await app.close()

  if (task?.status !== 'done') fail(`task status = ${task?.status} (expected done)`)
  if (!task!.output?.includes(marker)) fail(`task output missing result marker: ${task!.output}`)
  if (existsSync(orderPath)) fail('work order was not archived after completion')
  const archived = existsSync(join(inbox, 'done')) ? readdirSync(join(inbox, 'done')) : []
  if (!archived.some(f => f.includes(taskId))) fail('order/result not moved to inbox/done/')
  if (!agent?.lastHeartbeatAt) fail('agent heartbeat not recorded')

  console.log(`✓ SMOKE PASS — work order → result → done; archived ${archived.length} file(s); heartbeat ${agent!.heartbeatStatus}`)
  cleanup()
  process.exit(0)
}

main().catch(e => fail(e?.message ?? String(e)))
