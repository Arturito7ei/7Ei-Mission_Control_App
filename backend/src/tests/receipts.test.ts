import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { taskActivityAt, isUnread, unreadTaskIds } from '../services/receipts.ts'

describe('[MCA-84 V2] taskActivityAt', () => {
  it('takes the later of createdAt and completedAt', () => {
    assert.equal(taskActivityAt({ id: 't', createdAt: 100, completedAt: 500 }), 500)
    assert.equal(taskActivityAt({ id: 't', createdAt: 900, completedAt: 500 }), 900)
    assert.equal(taskActivityAt({ id: 't', createdAt: new Date(300), completedAt: null }), 300)
  })
})

describe('[MCA-84 V2] isUnread', () => {
  const task = { id: 't', createdAt: 100, completedAt: 500 }
  it('unread when never seen', () => assert.equal(isUnread(task, null), true))
  it('unread when activity is newer than the receipt', () => assert.equal(isUnread(task, 400), true))
  it('read when the receipt is at or after the latest activity', () => {
    assert.equal(isUnread(task, 500), false)
    assert.equal(isUnread(task, 900), false)
  })
})

describe('[MCA-84 V2] unreadTaskIds', () => {
  it('returns only tasks with new activity or no receipt', () => {
    const tasks = [
      { id: 'seen', createdAt: 100, completedAt: 200 },       // receipt after → read
      { id: 'stale', createdAt: 100, completedAt: 800 },      // receipt before → unread
      { id: 'fresh', createdAt: 100, completedAt: null },     // no receipt → unread
    ]
    const receipts = [
      { taskId: 'seen', seenAt: 300 },
      { taskId: 'stale', seenAt: 400 },
    ]
    const out = unreadTaskIds(tasks, receipts)
    assert.deepEqual([...out].sort(), ['fresh', 'stale'])
  })
})
