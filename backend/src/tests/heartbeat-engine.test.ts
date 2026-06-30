import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nextWake, dueForWake, findOrphanedTaskIds, ORPHAN_STALE_MS } from '../services/heartbeat-engine.ts'

describe('[MCA-PC C1] nextWake', () => {
  it('adds cadence seconds', () => assert.equal(nextWake(1000, 60), 1000 + 60_000))
})

describe('[MCA-PC C1] dueForWake', () => {
  const now = 1_000_000
  it('false without a cadence', () => assert.equal(dueForWake({ id: 'a', status: 'idle' }, now), false))
  it('true when due and idle', () => assert.equal(dueForWake({ id: 'a', status: 'idle', heartbeatEverySec: 60, nextWakeAt: now - 1 }, now), true))
  it('true when nextWakeAt is null', () => assert.equal(dueForWake({ id: 'a', status: 'idle', heartbeatEverySec: 60, nextWakeAt: null }, now), true))
  it('false when not yet due', () => assert.equal(dueForWake({ id: 'a', status: 'idle', heartbeatEverySec: 60, nextWakeAt: now + 10_000 }, now), false))
  it('false when active (coalescing)', () => assert.equal(dueForWake({ id: 'a', status: 'active', heartbeatEverySec: 60, nextWakeAt: now - 1 }, now), false))
  it('false when paused/terminated', () => {
    assert.equal(dueForWake({ id: 'a', status: 'paused', heartbeatEverySec: 60, nextWakeAt: 0 }, now), false)
    assert.equal(dueForWake({ id: 'a', status: 'terminated', heartbeatEverySec: 60, nextWakeAt: 0 }, now), false)
  })
})

describe('[MCA-PC C1] findOrphanedTaskIds', () => {
  const now = 10 * ORPHAN_STALE_MS
  it('flags stale in_progress tasks', () => {
    const ids = findOrphanedTaskIds([
      { id: 'old', status: 'in_progress', createdAt: now - ORPHAN_STALE_MS - 1 },
      { id: 'fresh', status: 'in_progress', createdAt: now - 1000 },
      { id: 'done', status: 'done', createdAt: 0 },
    ], now)
    assert.deepEqual(ids, ['old'])
  })
})
