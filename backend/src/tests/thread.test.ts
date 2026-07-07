import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideWake, hasActiveRun, isWakeableStatus, threadHistory, buildWakeInput } from '../services/thread'

const t0 = new Date('2026-07-07T10:00:00Z')
const t1 = new Date('2026-07-07T10:05:00Z')
const t2 = new Date('2026-07-07T10:10:00Z')

test('[MCA-83] isWakeableStatus covers idle/terminal states, not in_progress or the unknown', () => {
  for (const s of ['pending', 'assigned', 'blocked', 'failed', 'done']) {
    assert.equal(isWakeableStatus(s), true, s)
  }
  // in_progress is excluded: an internal agent mid-run has no run row to prove it,
  // so treating it as wakeable would double-fire.
  assert.equal(isWakeableStatus('in_progress'), false)
  assert.equal(isWakeableStatus('archived'), false)
  assert.equal(isWakeableStatus(null), false)
  assert.equal(isWakeableStatus(undefined), false)
})

test('[MCA-83] an in_progress task is not woken by default (agent is working)', () => {
  const d = decideWake({ status: 'in_progress', hasAgent: true, activeRun: false, authorIsUser: true })
  assert.deepEqual(d, { wake: false, reason: 'status-not-wakeable:in_progress' })
})

test('[MCA-83] hasActiveRun is true only when a run is running', () => {
  assert.equal(hasActiveRun([{ status: 'done' }, { status: 'failed' }]), false)
  assert.equal(hasActiveRun([{ status: 'done' }, { status: 'running' }]), true)
  assert.equal(hasActiveRun([]), false)
  assert.equal(hasActiveRun(null), false)
})

test('[MCA-83] a user comment on an idle failed task wakes the agent', () => {
  const d = decideWake({ status: 'failed', hasAgent: true, activeRun: false, authorIsUser: true })
  assert.equal(d.wake, true)
  assert.equal(d.reason, 'status:failed')
})

test('[MCA-83] done reopens on comment (Paperclip parity)', () => {
  assert.equal(decideWake({ status: 'done', hasAgent: true, activeRun: false, authorIsUser: true }).wake, true)
})

test('[MCA-83] never wake while a run is in flight — even if forced', () => {
  assert.deepEqual(
    decideWake({ status: 'in_progress', hasAgent: true, activeRun: true, authorIsUser: true }),
    { wake: false, reason: 'already-running' },
  )
  assert.deepEqual(
    decideWake({ status: 'failed', hasAgent: true, activeRun: true, authorIsUser: true, requested: true }),
    { wake: false, reason: 'already-running' },
  )
})

test('[MCA-83] no agent, non-user author, and opt-out never wake', () => {
  assert.equal(decideWake({ status: 'failed', hasAgent: false, activeRun: false, authorIsUser: true }).reason, 'no-agent')
  assert.equal(decideWake({ status: 'failed', hasAgent: true, activeRun: false, authorIsUser: false }).reason, 'author-not-user')
  assert.equal(decideWake({ status: 'failed', hasAgent: true, activeRun: false, authorIsUser: true, requested: false }).reason, 'suppressed')
})

test('[MCA-83] requested:true forces a wake on an otherwise non-wakeable status', () => {
  const d = decideWake({ status: 'archived', hasAgent: true, activeRun: false, authorIsUser: true, requested: true })
  assert.deepEqual(d, { wake: true, reason: 'requested' })
  // …but the default decision on that status is not to wake.
  assert.equal(decideWake({ status: 'archived', hasAgent: true, activeRun: false, authorIsUser: true }).wake, false)
})

test('[MCA-83] threadHistory maps roles, orders oldest-first, tags system notices', () => {
  const h = threadHistory([
    { authorAgentId: 'a1', body: 'On it.', createdAt: t1 },
    { authorUser: 'u1', body: 'Please retry.', createdAt: t0 },
    { kind: 'system_notice', body: 'Run failed: timeout', createdAt: t2 },
    { authorUser: 'u1', body: '   ', createdAt: t2 }, // blank dropped
  ] as any)
  assert.deepEqual(h, [
    { role: 'user', content: 'Please retry.' },
    { role: 'assistant', content: 'On it.' },
    { role: 'user', content: '[system] Run failed: timeout' },
  ])
})

test('[MCA-83] threadHistory caps count and truncates long bodies', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ authorUser: 'u', body: `m${i}`, createdAt: new Date(t0.getTime() + i * 1000) }))
  const h = threadHistory(many as any, { max: 5 })
  assert.equal(h.length, 5)
  assert.equal(h[0].content, 'm25')
  const long = threadHistory([{ authorUser: 'u', body: 'x'.repeat(5000), createdAt: t0 }] as any, { maxLen: 100 })
  assert.equal(long[0].content.length, 100)
})

test('[MCA-83] buildWakeInput frames the comment as a follow-up', () => {
  const s = buildWakeInput('Ship the report', '  Add Q3 numbers  ')
  assert.match(s, /New comment on task "Ship the report"/)
  assert.match(s, /Add Q3 numbers/)
  assert.match(s, /continue the task/)
})
