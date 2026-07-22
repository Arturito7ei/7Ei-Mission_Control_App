// MCC-1 — chat-thread logic tests (node --test, no jest/vitest — house rule).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeThread, awaitingReply, threadPreview, chatSendError, authorLabel, type ChatMsg } from './chat.logic.ts'

const m = (id: string, role: string, content: string, t: number): ChatMsg =>
  ({ id, role, content, createdAt: new Date(2026, 0, 1, 0, 0, t).toISOString() })

test('[MCC-1] mergeThread dedupes by id — server copy wins over the optimistic one', () => {
  const optimistic = m('x', 'user', 'draft copy', 1)
  const server = { ...m('x', 'user', 'server copy', 1), taskId: 't1' }
  const out = mergeThread([optimistic], [server])
  assert.equal(out.length, 1)
  assert.equal(out[0].content, 'server copy')
  assert.equal(out[0].taskId, 't1')
})

test('[MCC-1] mergeThread orders by time then id, across overlapping poll windows', () => {
  const a = [m('a', 'user', 'one', 1), m('b', 'assistant', 'two', 2)]
  const b = [m('b', 'assistant', 'two', 2), m('c', 'user', 'three', 3)]
  assert.deepEqual(mergeThread(a, b).map(x => x.id), ['a', 'b', 'c'])
  // same-second messages keep a stable id order (no flicker between polls)
  const t1 = mergeThread([m('z', 'user', 'zz', 5)], [m('y', 'assistant', 'yy', 5)])
  assert.deepEqual(t1.map(x => x.id), ['y', 'z'])
})

test('[MCC-1] same-second Q/A pair renders question before answer regardless of ids', () => {
  // The server stores createdAt at second precision; ids are random UUIDs. An
  // id tie-break alone would put 'aa-answer' first — the taskId+role rule bites.
  const q = { ...m('zz-question', 'user', 'Q', 7), taskId: 'task-1' }
  const ans = { ...m('aa-answer', 'assistant', 'A', 7), taskId: 'task-1' }
  assert.deepEqual(mergeThread([q], [ans]).map(x => x.id), ['zz-question', 'aa-answer'])
  assert.deepEqual(mergeThread([ans], [q]).map(x => x.id), ['zz-question', 'aa-answer'])
})

test('[MCC-1] awaitingReply is true only when the user spoke last', () => {
  assert.equal(awaitingReply([]), false)
  assert.equal(awaitingReply([m('a', 'user', 'hi', 1)]), true)
  assert.equal(awaitingReply([m('a', 'user', 'hi', 1), m('b', 'assistant', 'yo', 2)]), false)
})

test('[MCC-1] threadPreview squeezes whitespace and truncates with an ellipsis', () => {
  assert.equal(threadPreview([m('a', 'user', '  hello\n\n  world ', 1)]), 'hello world')
  const long = threadPreview([m('a', 'user', 'x'.repeat(200), 1)], 10)
  assert.equal(long.length, 10)
  assert.ok(long.endsWith('…'))
  assert.equal(threadPreview([]), '')
})

test('[MCC-2] authorLabel: "You" only when the author IS the viewer, fails toward "Member"', () => {
  const mine = { ...m('a', 'user', 'hi', 1), authorUser: 'user_me' }
  const theirs = { ...m('b', 'user', 'yo', 2), authorUser: 'user_other' }
  const legacy = m('c', 'user', 'old row', 3) // no author (pre-MCC-2 / webhook)
  assert.equal(authorLabel(mine, 'user_me'), 'You')
  assert.equal(authorLabel(theirs, 'user_me'), 'Member')
  assert.equal(authorLabel(legacy, 'user_me'), 'Member')
  assert.equal(authorLabel(mine, null), 'Member') // no viewer known → never claim "You"
})

test('[MCC-1] chatSendError mirrors the server rules', () => {
  assert.ok(chatSendError('   '))
  assert.ok(chatSendError('x'.repeat(8001)))
  assert.equal(chatSendError('fine'), null)
})
