// MOB-6b — the Task Log's formatting rules, pinned.
//
// Unlike navModel/attach/status, there is no web module to import here: the web
// renders these decisions inline in page.tsx's JSX. That makes them EASIER to
// drift, not harder — nothing would notice if the phone rounded cost to 2dp. So
// the values are asserted literally against what the web's JSX does today, and
// the comment on each test names the web expression it mirrors.
//
// Zero-dep: `npm test` → node --test --experimental-strip-types.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NONE,
  TASK_LOG_LIMIT,
  TITLE_MAX,
  agentLabel,
  approvalsLabel,
  formatCost,
  formatTokens,
  taskLogRows,
  taskTitle,
} from './taskLog.ts'

test('the log is capped at the web’s 100 rows', () => {
  // web: tasks.slice(0, 100)
  assert.equal(TASK_LOG_LIMIT, 100)
  const many = Array.from({ length: 250 }, (_, i) => i)
  assert.equal(taskLogRows(many).length, 100)
  assert.deepEqual(taskLogRows(many).at(-1), 99)
  // Under the cap, nothing is dropped and the order is the backend's.
  assert.deepEqual(taskLogRows([1, 2, 3]), [1, 2, 3])
  assert.deepEqual(taskLogRows([]), [])
})

test('a long title is cut at 60 with an ellipsis, a short one is untouched', () => {
  // web: {t.title.slice(0, 60)}{t.title.length > 60 ? '…' : ''}
  assert.equal(TITLE_MAX, 60)
  const exactly60 = 'x'.repeat(60)
  assert.equal(taskTitle(exactly60), exactly60, 'a title AT the limit must not gain an ellipsis')
  assert.equal(taskTitle('x'.repeat(61)), `${'x'.repeat(60)}…`)
  assert.equal(taskTitle('short'), 'short')
  assert.equal(taskTitle(''), '')
})

test('cost is 5dp, and an unrecorded cost is a dash — never a fake $0', () => {
  // web: t.costUsd != null ? `$${t.costUsd.toFixed(5)}` : '—'
  assert.equal(formatCost(0.012345678), '$0.01235')
  assert.equal(formatCost(1), '$1.00000')
  // A real zero is a real number and must still read as one — only null is a dash.
  assert.equal(formatCost(0), '$0.00000')
  assert.equal(formatCost(null), NONE)
  assert.equal(formatCost(undefined), NONE)
})

test('tokens are grouped, and unrecorded tokens are a dash — never a fake 0', () => {
  // web: t.tokensUsed?.toLocaleString() ?? '—'
  assert.equal(formatTokens(12345), (12345).toLocaleString())
  assert.equal(formatTokens(0), (0).toLocaleString())
  assert.equal(formatTokens(null), NONE)
  assert.equal(formatTokens(undefined), NONE)
})

test('the agent cell is emoji + name, and an unknown agent is a dash', () => {
  // web: {a?.avatarEmoji} {a?.name ?? '—'}
  assert.equal(agentLabel({ id: 'a', name: 'Arturita', avatarEmoji: '🤖' }), '🤖 Arturita')
  // A task whose agent is not in the roster (deleted, or another org's) must not
  // render a dangling emoji or the string "undefined".
  assert.equal(agentLabel(undefined), NONE)
  assert.equal(agentLabel({ id: 'a', name: 'Nameless', avatarEmoji: null }), 'Nameless')
})

test('the approvals affordance says what is waiting, matching the web’s wording', () => {
  // web: pendingApprovals > 0 ? `⏳ ${n} approval(s) pending — review →` : '✓ No approvals pending — open Inbox →'
  assert.equal(approvalsLabel(0), '✓ No approvals pending — open Inbox →')
  assert.equal(approvalsLabel(1), '⏳ 1 approval pending — review →')
  assert.equal(approvalsLabel(3), '⏳ 3 approvals pending — review →')
})
