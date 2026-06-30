/**
 * End-to-end smoke test for the external-agent loop (MCA-EXT Phase 2).
 *
 * Boots an in-process backend on a real port with a throwaway sqlite DB,
 * onboards an external agent, assigns it a shell task, runs the actual
 * adapters/openclaw/mc_adapter.py with --once, and asserts the task reaches
 * `done` with a fresh heartbeat. No Clerk, no network, no external services.
 *
 *   npm run smoke:openclaw
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const work = mkdtempSync(join(tmpdir(), 'mc-smoke-'))
process.env.DATABASE_URL = `file:${join(work, 'smoke.db')}`

const fail = (m: string) => { console.error('✗ SMOKE FAIL:', m); cleanup(); process.exit(1) }
function cleanup() { try { rmSync(work, { recursive: true, force: true }) } catch {} }

const main = async () => {
  // Import AFTER DATABASE_URL is set so the singleton client uses the temp DB.
  const Fastify = (await import('fastify')).default
  const { setupDatabase } = await import('../src/db/setup.ts')
  const { db, schema } = await import('../src/db/client.ts')
  const { agentApiRoutes } = await import('../src/routes/agent-api.ts')
  const { generateAgentToken, hashToken } = await import('../src/middleware/agent-token.ts')
  const { eq } = await import('drizzle-orm')

  await setupDatabase()

  // ── seed: org, external agent (known token), assigned shell task ──
  const orgId = randomUUID(), agentId = randomUUID(), taskId = randomUUID()
  const { token } = generateAgentToken()
  await db.insert(schema.organisations).values({ id: orgId, name: 'SmokeCo', ownerId: 'u1', createdAt: new Date() })
  await db.insert(schema.agents).values({
    id: agentId, orgId, name: 'Arturito · Open Claw', role: 'Ops',
    llmProvider: 'minimax', llmModel: 'minimax', agentType: 'external',
    runtime: 'openclaw', apiTokenHash: hashToken(token), status: 'idle', createdAt: new Date(),
  } as any)
  const marker = `pong-${taskId.slice(0, 8)}`
  await db.insert(schema.tasks).values({
    id: taskId, orgId, agentId, assignedTo: agentId,
    title: 'smoke ping', input: `echo "${marker}" > ping.txt && echo "${marker}"`,
    status: 'assigned', priority: 'medium', kanbanColumn: 'in_progress', createdAt: new Date(),
  } as any)

  // ── boot the agent API on a real port ──
  const app = Fastify({ logger: false })
  await app.register(agentApiRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const base = `http://127.0.0.1:${port}`

  // ── run the real Python adapter once ──
  const adapter = join(import.meta.dirname, '..', '..', 'adapters', 'openclaw', 'mc_adapter.py')
  if (!existsSync(adapter)) { await app.close(); fail(`adapter not found at ${adapter}`) }
  // async spawn so this process's event loop keeps serving the Fastify server
  await new Promise<void>((resolve) => {
    const child = spawn('python3', [adapter, '--once'], {
      env: { ...process.env, MC_BASE_URL: base, MC_AGENT_TOKEN: token, MC_ALLOW_SHELL: '1', MC_WORKDIR: work },
    })
    child.stdout.on('data', d => process.stdout.write(d))
    child.stderr.on('data', d => process.stderr.write(d))
    child.on('close', () => resolve())
  })

  // ── assert ──
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  await app.close()

  if (!task || task.status !== 'done') fail(`task status = ${task?.status} (expected done)`)
  if (!task!.output?.includes(marker)) fail(`task output missing marker: ${task!.output}`)
  if (!existsSync(join(work, 'ping.txt')) || !readFileSync(join(work, 'ping.txt'), 'utf8').includes(marker))
    fail('adapter did not write ping.txt in workdir')
  if (!agent?.lastHeartbeatAt) fail('agent heartbeat not recorded')

  console.log(`✓ SMOKE PASS — task ${task!.status}, marker echoed, ping.txt written, heartbeat ${agent!.heartbeatStatus}`)
  cleanup()
  process.exit(0)
}

main().catch(e => fail(e?.message ?? String(e)))
