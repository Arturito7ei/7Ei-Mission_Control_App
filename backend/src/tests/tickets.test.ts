import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLabels, normalizeAttachmentKind, buildTimeline } from '../services/tickets'

test('parseLabels tolerates junk', () => {
  assert.deepEqual(parseLabels('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseLabels(null), [])
  assert.deepEqual(parseLabels('{"x":1}'), [])
  assert.deepEqual(parseLabels('[1,"a"]'), ['a'])
})

test('normalizeAttachmentKind clamps to known kinds', () => {
  assert.equal(normalizeAttachmentKind('work_product'), 'work_product')
  assert.equal(normalizeAttachmentKind('file'), 'file')
  assert.equal(normalizeAttachmentKind('weird'), 'link')
  assert.equal(normalizeAttachmentKind(null), 'link')
})

test('buildTimeline merges + sorts events ascending', () => {
  const tl = buildTimeline({
    task: { createdAt: 100, completedAt: 500, status: 'done' },
    comments: [{ body: 'hi', authorAgentId: 'a1', createdAt: 300 }],
    runs: [{ id: 'r1', status: 'done', startedAt: 200, endedAt: 400, agentId: 'a1' }],
    attachments: [{ name: 'report.md', kind: 'work_product', url: 'vault/x.md', createdAt: 350 }],
  })
  assert.deepEqual(tl.map(i => i.kind), ['created', 'run_started', 'comment', 'attach_work_product', 'run_done', 'completed'])
  assert.deepEqual(tl.map(i => i.at), [100, 200, 300, 350, 400, 500])
  assert.equal(tl.find(i => i.kind === 'comment')!.by, 'a1')
})

test('buildTimeline handles empty input', () => {
  assert.deepEqual(buildTimeline({}), [])
})
