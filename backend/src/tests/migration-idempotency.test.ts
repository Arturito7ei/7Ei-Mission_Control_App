// CCS-04 — migration idempotency on an EXISTING (already-migrated) database.
//
// `setupDatabase()` is THE migration convention (backend/CLAUDE.md): a list of
// `CREATE TABLE IF NOT EXISTS` plus idempotent `ALTER TABLE … ADD COLUMN` statements,
// each wrapped in try/catch so "duplicate column name" on a re-run is swallowed. The
// full suite proves it boots a FRESH DB. This proves the OTHER half of the invariant —
// the property the fresh-boot never exercises: running it AGAIN over a populated,
// already-migrated DB is a clean no-op. It must not throw, must not drop or duplicate
// rows, and must not disturb the values already sitting in the ALTER-added columns
// (no backfill, no reset-to-default, no data loss).
//
// Real DB (in-memory libsql), the real setupDatabase(), real seeded rows.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'migration-idempotency-key'

let db: any, schema: any, setupDatabase: () => Promise<void>

before(async () => {
  ;({ db, schema } = await import('../db/client'))
  ;({ setupDatabase } = await import('../db/setup'))
})

test('[CCS-04] setupDatabase re-run over an existing DB is idempotent: no throw, no data loss, ALTER-added columns preserved', async () => {
  // 1. First run: create + migrate a fresh (in-memory) DB.
  await setupDatabase()

  // 2. Seed rows that populate columns which were added by idempotent ALTERs —
  //    organisations.mission; agents.trust_mode / avatar_url / primary_model;
  //    tasks.input_tokens — the exact surface a careless re-run could clobber
  //    (drop, reset to its column DEFAULT, or backfill over).
  const ORG = 'ccs04-org'
  const AGENT = 'ccs04-agent'
  const TASK = 'ccs04-task'
  await db.insert(schema.organisations).values({
    id: ORG, name: 'Idem Co', ownerId: 'op-1', mission: 'ship carefully', createdAt: new Date(),
  } as any)
  await db.insert(schema.agents).values({
    id: AGENT, orgId: ORG, name: 'Migradey', role: 'Engineer',
    llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514',
    skills: [], status: 'idle', agentType: 'standard',
    trustMode: 'low_trust_review', avatarUrl: 'data:image/webp;base64,AAAA', primaryModel: 'claude-opus-4',
    createdAt: new Date(),
  } as any)
  await db.insert(schema.tasks).values({
    id: TASK, orgId: ORG, agentId: AGENT, title: 'Do it', status: 'pending', inputTokens: 4242, createdAt: new Date(),
  } as any)

  const orgCount0 = (await db.select().from(schema.organisations)).length
  const agentCount0 = (await db.select().from(schema.agents)).length
  const taskCount0 = (await db.select().from(schema.tasks)).length

  // 3. Re-run the migration over the now-existing, populated DB — twice, to be sure.
  //    This is the "already-migrated DB" path that the suite's fresh boot never hits.
  //    Neither call may throw (every ALTER re-issue must be swallowed as a no-op).
  await assert.doesNotReject(setupDatabase(), 'a second run over an existing DB must not throw')
  await assert.doesNotReject(setupDatabase(), 'a third run is still a clean no-op')

  // 4. No data loss and no duplication — the counts are identical to before the re-run.
  assert.equal((await db.select().from(schema.organisations)).length, orgCount0, 'org rows unchanged')
  assert.equal((await db.select().from(schema.agents)).length, agentCount0, 'agent rows unchanged')
  assert.equal((await db.select().from(schema.tasks)).length, taskCount0, 'task rows unchanged')

  // 5. Existing rows are intact — spot-check a couple of the ALTER-added columns to
  //    prove the re-run neither reset a column to its DEFAULT nor backfilled over data.
  const org = (await db.select().from(schema.organisations)).find((o: any) => o.id === ORG)
  const agent = (await db.select().from(schema.agents)).find((a: any) => a.id === AGENT)
  const task = (await db.select().from(schema.tasks)).find((t: any) => t.id === TASK)
  assert.equal(org.mission, 'ship carefully', 'organisations.mission (ALTER-added) preserved')
  assert.equal(agent.trustMode, 'low_trust_review', 'agents.trust_mode (ALTER-added, has a default) preserved — NOT reset to its default')
  assert.equal(agent.avatarUrl, 'data:image/webp;base64,AAAA', 'agents.avatar_url (ALTER-added) preserved')
  assert.equal(agent.primaryModel, 'claude-opus-4', 'agents.primary_model (ALTER-added) preserved')
  assert.equal(task.inputTokens, 4242, 'tasks.input_tokens (ALTER-added) preserved')
})
