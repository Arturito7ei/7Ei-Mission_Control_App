/**
 * Phase 2.1 smoke — the LLM brain + shell tool loop.
 *
 * Boots the agent API + a fake OpenAI-compatible /v1/chat/completions on a real
 * port, assigns a natural-language task, runs the real adapter with
 * MC_EXECUTOR=llm, and asserts the adapter ran a brain→bash→brain loop:
 * the model emits a ```bash block, the adapter executes it (writes the file),
 * feeds the OBSERVATION back, and the model returns a final answer → task done.
 *
 *   npm run smoke:openclaw:llm
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const work = mkdtempSync(join(tmpdir(), 'mc-smoke-llm-'))
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
  const marker = `brain-${taskId.slice(0, 8)}`
  await db.insert(schema.organisations).values({ id: orgId, name: 'SmokeCo', ownerId: 'u1', createdAt: new Date() })
  await db.insert(schema.agents).values({
    id: agentId, orgId, name: 'Arturito · Open Claw', role: 'Ops',
    termsOfReference: 'Operate sovereignly; verify before done.',
    llmProvider: 'minimax', llmModel: 'MiniMax-Text-01', agentType: 'external',
    runtime: 'openclaw', apiTokenHash: hashToken(token), status: 'idle', createdAt: new Date(),
  } as any)
  await db.insert(schema.tasks).values({
    id: taskId, orgId, agentId, assignedTo: agentId, title: 'write marker',
    input: `The marker is ${marker}. Write it into ping.txt in your working directory, then confirm.`,
    status: 'assigned', priority: 'medium', kanbanColumn: 'in_progress', createdAt: new Date(),
  } as any)

  // Agent API + a fake OpenAI-compatible model on one app.
  const app = Fastify({ logger: false })
  let llmCalls = 0
  app.post('/v1/chat/completions', async (req) => {
    llmCalls++
    const msgs = ((req.body as any)?.messages ?? []) as Array<{ role: string; content: string }>
    const lastUser = [...msgs].reverse().find(m => m.role === 'user')?.content ?? ''
    // Step 1: emit a bash block. Step 2 (after OBSERVATION): final answer w/ marker.
    const content = lastUser.includes('OBSERVATION:')
      ? `Done — wrote ${marker} to ping.txt and verified it.`
      : '```bash\n' + `echo "${marker}" > ping.txt && cat ping.txt\n` + '```'
    return { choices: [{ message: { role: 'assistant', content } }] }
  })
  await app.register(agentApiRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as any).port
  const base = `http://127.0.0.1:${port}`

  const adapter = join(import.meta.dirname, '..', '..', 'adapters', 'openclaw', 'mc_adapter.py')
  await new Promise<void>((resolve) => {
    const child = spawn('python3', [adapter, '--once'], {
      env: {
        ...process.env, MC_BASE_URL: base, MC_AGENT_TOKEN: token,
        MC_EXECUTOR: 'llm', MC_ALLOW_SHELL: '1', MC_WORKDIR: work,
        MC_LLM_BASE_URL: `${base}/v1`, MC_LLM_API_KEY: 'fake', MC_LLM_MODEL: 'MiniMax-Text-01',
      },
    })
    child.stdout.on('data', d => process.stdout.write(d))
    child.stderr.on('data', d => process.stderr.write(d))
    child.on('close', () => resolve())
  })

  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  await app.close()

  if (llmCalls < 2) fail(`expected a brain→tool→brain loop (>=2 LLM calls), got ${llmCalls}`)
  if (!task || task.status !== 'done') fail(`task status = ${task?.status} (expected done)`)
  if (!task!.output?.includes(marker)) fail(`final answer missing marker: ${task!.output}`)
  if (!existsSync(join(work, 'ping.txt')) || !readFileSync(join(work, 'ping.txt'), 'utf8').includes(marker))
    fail('tool step did not write ping.txt')
  if (!agent?.lastHeartbeatAt) fail('agent heartbeat not recorded')

  console.log(`✓ SMOKE PASS — ${llmCalls} LLM calls (brain→bash→brain), task done, marker written + echoed in final answer`)
  cleanup()
  process.exit(0)
}

main().catch(e => fail(e?.message ?? String(e)))
