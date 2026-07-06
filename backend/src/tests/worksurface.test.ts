import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readyQueue, nextUp, rollupCost } from '../services/worksurface'

const t = (iso: string) => new Date(iso)

test('[MCA-83] nextUp picks highest priority among unblocked, unstarted tasks', () => {
  const tasks = [
    { id: 'lo', title: 'low', priority: 'low', status: 'pending', createdAt: t('2026-07-01') },
    { id: 'hi', title: 'high', priority: 'high', status: 'pending', createdAt: t('2026-07-02') },
    { id: 'md', title: 'med', priority: 'medium', status: 'pending', createdAt: t('2026-07-01') },
  ]
  assert.equal(nextUp(tasks)!.id, 'hi')
})

test('[MCA-83] ties break by oldest createdAt', () => {
  const tasks = [
    { id: 'new', priority: 'high', status: 'pending', createdAt: t('2026-07-05') },
    { id: 'old', priority: 'high', status: 'pending', createdAt: t('2026-07-01') },
  ]
  assert.deepEqual(readyQueue(tasks).map(x => x.id), ['old', 'new'])
})

test('[MCA-83] a task with an unresolved blocker is not ready', () => {
  const tasks = [
    { id: 'dep', status: 'in_progress', priority: 'high' },
    { id: 'work', status: 'pending', priority: 'high', blockedBy: JSON.stringify(['dep']) },
  ]
  assert.equal(nextUp(tasks), null)
})

test('[MCA-83] a task becomes ready once every blocker is done', () => {
  const tasks = [
    { id: 'dep', status: 'done', priority: 'high' },
    { id: 'work', status: 'pending', priority: 'high', blockedBy: JSON.stringify(['dep']), createdAt: t('2026-07-01') },
  ]
  const up = nextUp(tasks)
  assert.equal(up!.id, 'work')
  assert.equal(up!.blockedCleared, 1)
})

test('[MCA-83] a blocker id missing from the set counts as still blocking', () => {
  // Conservative: never claim readiness we cannot prove.
  const tasks = [{ id: 'work', status: 'pending', priority: 'high', blockedBy: JSON.stringify(['ghost']) }]
  assert.equal(nextUp(tasks), null)
})

test('[MCA-83] in-progress / done / failed / blocked tasks are not "next up"', () => {
  const tasks = [
    { id: 'running', status: 'in_progress' },
    { id: 'finished', status: 'done' },
    { id: 'broke', status: 'failed' },
    { id: 'parked', status: 'blocked' },
    { id: 'ready', status: 'pending', createdAt: t('2026-07-01') },
  ]
  assert.equal(nextUp(tasks)!.id, 'ready')
})

test('[MCA-83] kanbanColumn todo counts as unstarted even without pending status', () => {
  const tasks = [{ id: 'q', kanbanColumn: 'todo', status: 'queued' as any, createdAt: t('2026-07-01') }]
  assert.equal(nextUp(tasks)!.id, 'q')
})

test('[MCA-83] nextUp returns null when nothing is ready', () => {
  assert.equal(nextUp([]), null)
  assert.equal(nextUp([{ id: 'x', status: 'done' }]), null)
})

test('[MCA-83] rollupCost sums own + subtask cost and tokens', () => {
  const r = rollupCost(
    { costUsd: 0.01, tokensUsed: 100 },
    [{ costUsd: 0.02, tokensUsed: 200 }, { costUsd: 0.03, tokensUsed: 300 }],
  )
  assert.equal(r.ownCost, 0.01)
  assert.ok(Math.abs(r.subtaskCost - 0.05) < 1e-9)
  assert.ok(Math.abs(r.totalCost - 0.06) < 1e-9)
  assert.equal(r.ownTokens, 100)
  assert.equal(r.subtaskTokens, 500)
  assert.equal(r.totalTokens, 600)
  assert.equal(r.subtaskCount, 2)
})

test('[MCA-83] rollupCost tolerates null/absent cost fields', () => {
  const r = rollupCost(null, [{ costUsd: null }, {}])
  assert.equal(r.totalCost, 0)
  assert.equal(r.totalTokens, 0)
  assert.equal(r.subtaskCount, 2)
})
