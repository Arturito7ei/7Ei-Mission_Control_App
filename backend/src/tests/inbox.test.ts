import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildInbox, inboxKind } from '../services/inbox.ts'

const T = (id: string, status: string, inboxState: string | null = null, createdAt = 0) =>
  ({ id, title: id, status, inboxState, agentId: 'a1', priority: 'medium', createdAt })

describe('[MCA-PC A3] inboxKind', () => {
  it('blocked status → blocked', () => assert.equal(inboxKind(T('x', 'blocked')), 'blocked'))
  it('failed status → failed', () => assert.equal(inboxKind(T('x', 'failed')), 'failed'))
  it('awaiting_review inboxState → review', () => assert.equal(inboxKind(T('x', 'done', 'awaiting_review')), 'review'))
  it('needs_attention inboxState → attention', () => assert.equal(inboxKind(T('x', 'in_progress', 'needs_attention')), 'attention'))
  it('normal task → null', () => assert.equal(inboxKind(T('x', 'in_progress')), null))
})

describe('[MCA-PC A3] buildInbox', () => {
  it('includes only attention-worthy tasks', () => {
    const items = buildInbox([T('a', 'done'), T('b', 'blocked'), T('c', 'failed')])
    assert.deepEqual(items.map(i => i.taskId).sort(), ['b', 'c'])
  })
  it('ranks blocked before review, then by recency', () => {
    const items = buildInbox([
      T('rev1', 'done', 'awaiting_review', 100),
      T('blk', 'blocked', null, 50),
      T('rev2', 'done', 'awaiting_review', 200),
    ])
    assert.deepEqual(items.map(i => i.taskId), ['blk', 'rev2', 'rev1'])
  })
  it('excludes dismissed tasks', () => {
    const items = buildInbox([T('a', 'blocked'), T('b', 'failed')], new Set(['a']))
    assert.deepEqual(items.map(i => i.taskId), ['b'])
  })
})

describe('[MCA-84 V2] inbox retry rows', () => {
  it('flags failed tasks retryable, others not', () => {
    const items = buildInbox([T('blk', 'blocked'), T('fail', 'failed')])
    const byId = new Map(items.map(i => [i.taskId, i]))
    assert.equal(byId.get('fail')!.retryable, true)
    assert.equal(byId.get('blk')!.retryable, false)
  })
  it('carries truncated output as the inline error on a failed row', () => {
    const long = 'x'.repeat(500)
    const [item] = buildInbox([{ id: 'f', title: 'f', status: 'failed', inboxState: null, agentId: 'a1', priority: 'medium', output: '  boom: exit 1  ', createdAt: 0 }])
    assert.equal(item.error, 'boom: exit 1')
    const [big] = buildInbox([{ id: 'g', title: 'g', status: 'failed', inboxState: null, agentId: 'a1', priority: 'medium', output: long, createdAt: 0 }])
    assert.equal(big.error!.length, 240)
  })
  it('no error text when output is empty or task is not failed', () => {
    const [failNoOut] = buildInbox([{ id: 'f', title: 'f', status: 'failed', inboxState: null, agentId: 'a1', priority: 'medium', output: null, createdAt: 0 }])
    assert.equal(failNoOut.error, null)
    const [blk] = buildInbox([{ id: 'b', title: 'b', status: 'blocked', inboxState: null, agentId: 'a1', priority: 'medium', output: 'ignored', createdAt: 0 }])
    assert.equal(blk.error, null)
  })
})
