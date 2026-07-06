import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRecovery } from '../services/recovery'

const t0 = new Date('2026-07-06T10:00:00Z')
const t1 = new Date('2026-07-06T11:00:00Z')

test('[MCA-83] no card for a healthy or done task', () => {
  assert.equal(buildRecovery({ task: { status: 'in_progress' } }), null)
  assert.equal(buildRecovery({ task: { status: 'done' }, runs: [{ id: 'r1', status: 'failed', endedAt: t1 }] }), null)
  assert.equal(buildRecovery({ task: null }), null)
  assert.equal(buildRecovery({}), null)
})

test('[MCA-83] failed run → failed card with owner + source run + since', () => {
  const card = buildRecovery({
    task: { status: 'failed', agentId: 'a1', assignedTo: null },
    runs: [{ id: 'r1', status: 'failed', agentId: 'a1', endedAt: t1, startedAt: t0 }],
  })
  assert.ok(card)
  assert.equal(card!.reason, 'failed')
  assert.equal(card!.ownerAgentId, 'a1')
  assert.equal(card!.sourceRunId, 'r1')
  assert.equal(card!.sourceRunStatus, 'failed')
  assert.equal(card!.since, t1.getTime())
  assert.match(card!.nextAction, /retry|reassign/i)
})

test('[MCA-83] orphaned run → orphaned reason', () => {
  const card = buildRecovery({
    task: { status: 'failed', agentId: 'a1' },
    runs: [{ id: 'r1', status: 'orphaned', endedAt: t1 }],
  })
  assert.equal(card!.reason, 'orphaned')
  assert.equal(card!.sourceRunStatus, 'orphaned')
  assert.match(card!.nextAction, /silent|reassign/i)
})

test('[MCA-83] assignedTo overrides agentId as owner', () => {
  const card = buildRecovery({
    task: { status: 'failed', agentId: 'a1', assignedTo: 'a2' },
    runs: [{ id: 'r1', status: 'failed', agentId: 'a1', endedAt: t1 }],
  })
  assert.equal(card!.ownerAgentId, 'a2')
})

test('[MCA-83] blocked-by dependencies → blocked card with blockerCount', () => {
  const card = buildRecovery({
    task: { status: 'blocked', agentId: 'a1', blockedBy: JSON.stringify(['x', 'y']) },
    runs: [],
  })
  assert.equal(card!.reason, 'blocked')
  assert.equal(card!.blockerCount, 2)
  assert.equal(card!.sourceRunId, null)
})

test('[MCA-83] W2 reasoned blocker chips carry title + status, open first', () => {
  const card = buildRecovery({
    task: { status: 'blocked', agentId: 'a1', blockedBy: JSON.stringify(['x', 'y']) },
    blockerTasks: [
      { id: 'x', title: 'Ship API', status: 'done' },
      { id: 'y', title: 'Write schema', status: 'in_progress' },
    ],
  })
  assert.equal(card!.blockers.length, 2)
  // Open (not-done) blocker sorts first — it's the reason work can't proceed.
  assert.equal(card!.blockers[0].id, 'y')
  assert.equal(card!.blockers[0].title, 'Write schema')
  assert.equal(card!.blockers[0].done, false)
  assert.equal(card!.blockers[1].done, true)
})

test('[MCA-83] W2 unresolved blocker id falls back to a short id, status unknown', () => {
  const card = buildRecovery({
    task: { status: 'blocked', agentId: 'a1', blockedBy: JSON.stringify(['deadbeef-1234']) },
    blockerTasks: [],
  })
  assert.equal(card!.blockers.length, 1)
  assert.equal(card!.blockers[0].title, 'deadbeef')
  assert.equal(card!.blockers[0].status, 'unknown')
  assert.equal(card!.blockers[0].done, false)
})

test('[MCA-83] a failed run takes precedence over dependency blockers', () => {
  const card = buildRecovery({
    task: { status: 'failed', agentId: 'a1', blockedBy: JSON.stringify(['x']) },
    runs: [{ id: 'r1', status: 'failed', endedAt: t1 }],
  })
  assert.equal(card!.reason, 'failed')
  assert.equal(card!.blockerCount, 1)
})

test('[MCA-83] evidence prefers latest system_notice comment', () => {
  const card = buildRecovery({
    task: { status: 'failed', agentId: 'a1', output: 'stale output' },
    runs: [{ id: 'r1', status: 'failed', endedAt: t1, logs: JSON.stringify([{ t: 1, msg: 'log line' }]) }],
    comments: [
      { body: 'old notice', kind: 'system_notice', createdAt: t0 },
      { body: 'Run failed: boom', kind: 'system_notice', createdAt: t1 },
      { body: 'a human note', kind: 'user', createdAt: t1 },
    ],
  })
  assert.equal(card!.evidence, 'Run failed: boom')
})

test('[MCA-83] evidence falls back to task output, then last log line', () => {
  const fromOutput = buildRecovery({
    task: { status: 'failed', agentId: 'a1', output: 'the reason' },
    runs: [{ id: 'r1', status: 'failed', endedAt: t1 }],
  })
  assert.equal(fromOutput!.evidence, 'the reason')

  const fromLog = buildRecovery({
    task: { status: 'failed', agentId: 'a1' },
    runs: [{ id: 'r1', status: 'failed', endedAt: t1, logs: JSON.stringify([{ t: 1, msg: 'first' }, { t: 2, msg: 'last log' }]) }],
  })
  assert.equal(fromLog!.evidence, 'last log')
})

test('[MCA-83] most recent failed run is chosen as the source', () => {
  const card = buildRecovery({
    task: { status: 'failed', agentId: 'a1' },
    runs: [
      { id: 'old', status: 'failed', endedAt: t0 },
      { id: 'new', status: 'failed', endedAt: t1 },
    ],
  })
  assert.equal(card!.sourceRunId, 'new')
  assert.equal(card!.since, t1.getTime())
})

test('[MCA-83] malformed blockedBy JSON does not throw', () => {
  const card = buildRecovery({ task: { status: 'blocked', agentId: 'a1', blockedBy: 'not json' } })
  assert.equal(card!.reason, 'failed') // no blockers parsed, but task is in a failure state
  assert.equal(card!.blockerCount, 0)
})
