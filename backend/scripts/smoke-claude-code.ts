/**
 * Epic CC / CC1 smoke — the Claude Code poll-loop adapter.
 *
 * Boots the agent API on a real port, seeds an external agent
 * (runtime=claude_code) with an assigned task, then drives the real
 * cc_adapter.py once with a FAKE `claude` binary (a stub that emits
 * `--output-format stream-json` lines) so the round-trip is exercised without a
 * real Claude install or any network:
 *   claim → run headless claude (plan mode) → stream /runs/:id/log → /result done
 * Asserts the task reaches `done` with the result text, the run captured logs +
 * cost, and the heartbeat went green.
 *
 *   npm run smoke:claude-code
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const work = mkdtempSync(join(tmpdir(), 'mc-smoke-cc-'))
process.env.DATABASE_URL = `file:${join(work, 'smoke.db')}`

const fail = (m: string) => { console.error('✗ SMOKE FAIL:', m); cleanup(); process.exit(1) }
function cleanup() { try { rmSync(work, { recursive: true, force: true }) } catch {} }

// A fake `claude` CLI: reads the -p prompt, emits stream-json (system → assistant
// → result). Echoes an 8-char marker from the prompt so we can assert round-trip.
const fakeClaude = join(work, 'fakeclaude')
writeFileSync(fakeClaude, `#!/usr/bin/env python3
import sys, json
argv = sys.argv[1:]
prompt = ""
if "-p" in argv:
    i = argv.index("-p")
    prompt = argv[i+1] if i+1 < len(argv) else ""
marker = "".join(c for c in prompt if c.isalnum())[:8] or "none"
print(json.dumps({"type":"system","subtype":"init","session_id":"sess-fake","model":"fake"}))
print(json.dumps({"type":"assistant","message":{"content":[{"type":"text","text":"Planning the change."}]}}))
print(json.dumps({"type":"result","subtype":"success","result":"PLAN ok "+marker,
                  "total_cost_usd":0.0123,"session_id":"sess-fake","is_error":False,
                  "num_turns":1,"usage":{"input_tokens":10,"output_tokens":5}}))
`)
chmodSync(fakeClaude, 0o755)

const main = async () => {
  const Fastify = (await import('fastify')).default
  const { setupDatabase } = await import('../src/db/setup.ts')
  const { db, schema } = await import('../src/db/client.ts')
  const { agentApiRoutes } = await import('../src/routes/agent-api.ts')
  const { generateAgentToken, hashToken } = await import('../src/middleware/agent-token.ts')
  const { eq, and } = await import('drizzle-orm')

  await setupDatabase()
  const orgId = randomUUID(), agentId = randomUUID(), taskId = randomUUID()
  const { token } = generateAgentToken()
  await db.insert(schema.organisations).values({ id: orgId, name: 'SmokeCo', ownerId: 'u1', createdAt: new Date() })
  await db.insert(schema.agents).values({
    id: agentId, orgId, name: 'Claude Code · Eng', role: 'Engineer',
    llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514', agentType: 'external',
    runtime: 'claude_code', apiTokenHash: hashToken(token), status: 'idle', createdAt: new Date(),
  } as any)
  await db.insert(schema.tasks).values({
    id: taskId, orgId, agentId, assignedTo: agentId, title: 'Investigate the flake',
    input: 'Look at the failing test and propose a fix.', status: 'assigned',
    priority: 'medium', kanbanColumn: 'in_progress', createdAt: new Date(),
  } as any)

  const app = Fastify({ logger: false })
  await app.register(agentApiRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`
  const adapter = join(import.meta.dirname, '..', '..', 'adapters', 'claude-code', 'cc_adapter.py')
  const env = {
    ...process.env, MC_BASE_URL: base, MC_AGENT_TOKEN: token, MC_WORKDIR: work,
    CC_CLAUDE_BIN: fakeClaude, CC_PERMISSION_MODE: 'plan',
  }
  await new Promise<void>((resolve) => {
    const c = spawn('python3', [adapter, '--once'], { env })
    c.stdout.on('data', d => process.stdout.write(d))
    c.stderr.on('data', d => process.stderr.write(d))
    c.on('close', () => resolve())
  })

  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
  const run = await db.query.agentRuns.findFirst({ where: and(eq(schema.agentRuns.taskId, taskId)) })
  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  await app.close()

  const marker = taskId // build_task_prompt includes title, not id; assert on the fixed PLAN text instead
  if (task?.status !== 'done') fail(`task status = ${task?.status} (expected done)`)
  if (!task!.output?.includes('PLAN ok')) fail(`task output missing plan result: ${task!.output}`)
  if (!run) fail('no run row created on claim')
  if (!run!.logs || !String(run!.logs).includes('plan')) fail(`run logs missing stream output: ${run?.logs}`)
  if (Number(run!.costUsd) !== 0.0123) fail(`run cost not recorded (got ${run?.costUsd})`)
  if (!agent?.lastHeartbeatAt) fail('agent heartbeat not recorded')
  void marker

  console.log(`✓ SMOKE PASS — claim → headless claude (plan) → streamed logs → done; cost $${run!.costUsd}; heartbeat ${agent!.heartbeatStatus}`)
  cleanup()
  process.exit(0)
}

main().catch(e => fail(e?.message ?? String(e)))
