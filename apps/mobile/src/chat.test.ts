// MCC-1 — the chat logic's parity pin. The phone's chat.ts is a hand-copy of
// web/lib/chat.logic.ts (Metro can't bundle across packages), so this drives
// BOTH with the same inputs and requires the same outputs — the same discipline
// as inboxSegments.test.ts. The day one side changes alone, this fails.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as phone from './chat.ts'
import * as web from '../../../web/lib/chat.logic.ts'

const m = (id: string, role: string, content: string, t: number) =>
  ({ id, role, content, createdAt: new Date(2026, 0, 1, 0, 0, t).toISOString() })

test('[MCC-1] mergeThread agrees with the web on dedupe, order and overlap', () => {
  const cases: [any[], any[]][] = [
    [[], []],
    [[m('a', 'user', 'one', 1)], []],
    [[m('x', 'user', 'draft', 1)], [{ ...m('x', 'user', 'server', 1), taskId: 't' }]],
    [[m('a', 'user', '1', 1), m('b', 'assistant', '2', 2)], [m('b', 'assistant', '2', 2), m('c', 'user', '3', 3)]],
    [[m('z', 'user', 'z', 5)], [m('y', 'assistant', 'y', 5)]],
    // same-second Q/A pair sharing a taskId — the question must sort first even
    // though its id is lexicographically later (audit MCC-1 #1)
    [[{ ...m('zz-q', 'user', 'Q', 7), taskId: 't1' }], [{ ...m('aa-a', 'assistant', 'A', 7), taskId: 't1' }]],
  ]
  for (const [a, b] of cases) {
    assert.deepEqual(phone.mergeThread(a as any, b as any), web.mergeThread(a as any, b as any))
  }
})

test('[MCC-1] awaitingReply / threadPreview / chatSendError agree with the web', () => {
  const threads: any[][] = [
    [],
    [m('a', 'user', 'hi', 1)],
    [m('a', 'user', 'hi', 1), m('b', 'assistant', '  spaced   out\n\nreply ', 2)],
    [m('a', 'user', 'x'.repeat(300), 1)],
  ]
  for (const t of threads) {
    assert.equal(phone.awaitingReply(t as any), web.awaitingReply(t as any))
    assert.equal(phone.threadPreview(t as any), web.threadPreview(t as any))
    assert.equal(phone.threadPreview(t as any, 10), web.threadPreview(t as any, 10))
  }
  for (const c of ['', '   ', 'fine', 'x'.repeat(8000), 'x'.repeat(8001)]) {
    assert.equal(phone.chatSendError(c), web.chatSendError(c))
  }
  assert.equal(phone.MAX_CHAT_CONTENT, web.MAX_CHAT_CONTENT)
})
