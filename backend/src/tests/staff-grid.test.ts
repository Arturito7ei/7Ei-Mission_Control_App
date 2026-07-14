import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStaffCards, lastActive, staffHandle, staffState, todaySpend, type StaffAgent, type StaffTask } from '../services/staff-grid'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000)

const agent = (over: Partial<StaffAgent> = {}): StaffAgent => ({ id: 'a1', name: 'Arturito', role: 'Chief of Staff', status: 'idle', ...over })
const task = (over: Partial<StaffTask> = {}): StaffTask => ({ agentId: 'a1', status: 'done', ...over })

describe('[AG7] staffHandle', () => {
  it('uses the contact channel when it is a real email', () => {
    assert.equal(staffHandle({ name: 'Arturito', contactChannel: 'arturito@7ei.ai' }), 'arturito@7ei.ai')
  })

  it('derives an @handle rather than inventing an email that cannot receive mail', () => {
    assert.equal(staffHandle({ name: 'Arturito', contactChannel: null }), '@arturito')
    assert.equal(staffHandle({ name: '7 Dev Bot', contactChannel: '' }), '@7-dev-bot')
    assert.equal(staffHandle({ name: 'Arturito', contactChannel: '12345678' }), '@arturito') // a telegram chat id is not an email
  })

  it('is safe for a name with no usable characters', () => {
    assert.equal(staffHandle({ name: '???', contactChannel: null }), '@agent')
  })
})

describe('[AG7] staffState — colour is never the only signal, so every state carries a label', () => {
  it('is running when the agent is active or has a task in progress', () => {
    assert.deepEqual(staffState(agent({ status: 'active' }), []), { state: 'running', stateLabel: 'Running' })
    assert.deepEqual(staffState(agent(), [task({ status: 'in_progress' })]), { state: 'running', stateLabel: 'Running' })
  })

  it('is ok when idle with nothing wrong', () => {
    assert.deepEqual(staffState(agent(), [task({ status: 'done' })]), { state: 'ok', stateLabel: 'Idle' })
  })

  it('is attention when paused, terminated, stale, or holding a blocked/failed task', () => {
    assert.equal(staffState(agent({ status: 'paused' }), []).state, 'attention')
    assert.equal(staffState(agent({ status: 'terminated' }), []).state, 'attention')
    assert.equal(staffState(agent({ heartbeatStatus: 'stale' }), []).state, 'attention')
    assert.equal(staffState(agent(), [task({ status: 'blocked' })]).state, 'attention')
    assert.equal(staffState(agent(), [task({ status: 'failed' })]).state, 'attention')
  })

  it('lets attention beat running — a busy agent with a blocked task still needs a human', () => {
    const s = staffState(agent({ status: 'active' }), [task({ status: 'in_progress' }), task({ status: 'blocked' })])
    assert.equal(s.state, 'attention')
    assert.equal(s.stateLabel, 'Needs attention')
  })
})

describe('[AG7] todaySpend', () => {
  it('counts only today (UTC), by completion time', () => {
    const r = todaySpend([
      task({ completedAt: hoursAgo(2), costUsd: 0.5, tokensUsed: 100 }),
      task({ completedAt: hoursAgo(1), costUsd: 0.25, tokensUsed: 50 }),
      task({ completedAt: new Date(NOW - 3 * 86_400_000), costUsd: 9, tokensUsed: 9000 }), // 3 days ago
    ], NOW)
    assert.equal(r.costTodayUsd, 0.75)
    assert.equal(r.tokensToday, 150)
  })

  it('falls back to createdAt for a task that has not completed', () => {
    const r = todaySpend([task({ status: 'in_progress', createdAt: hoursAgo(3), costUsd: 0.1, tokensUsed: 10 })], NOW)
    assert.equal(r.costTodayUsd, 0.1)
    assert.equal(r.tokensToday, 10)
  })

  it('is zero for an agent with no work today, and drops float noise', () => {
    assert.deepEqual(todaySpend([], NOW), { costTodayUsd: 0, tokensToday: 0 })
    assert.equal(todaySpend([task({ completedAt: hoursAgo(1), costUsd: 0.1 }), task({ completedAt: hoursAgo(1), costUsd: 0.2 })], NOW).costTodayUsd, 0.3)
  })
})

describe('[AG7] lastActive', () => {
  it('is the most recent of the heartbeat and the last finished task', () => {
    const hb = hoursAgo(5)
    const done = hoursAgo(2)
    assert.equal(lastActive(agent({ lastHeartbeatAt: hb }), [task({ completedAt: done })]), done.getTime())
    assert.equal(lastActive(agent({ lastHeartbeatAt: hoursAgo(1) }), [task({ completedAt: hoursAgo(9) })]), hoursAgo(1).getTime())
  })

  it('is null for an agent that has never done anything', () => {
    assert.equal(lastActive(agent(), []), null)
  })
})

describe('[AG7] buildStaffCards', () => {
  const agents = [agent({ id: 'a1', name: 'Arturito', contactChannel: 'arturito@7ei.ai' }), agent({ id: 'a2', name: '7Dev', status: 'active' })]
  const tasks: StaffTask[] = [
    task({ agentId: 'a1', status: 'assigned' }),
    task({ agentId: 'a1', status: 'done', completedAt: hoursAgo(1), costUsd: 0.4, tokensUsed: 400 }),
    task({ agentId: 'a2', status: 'in_progress' }),
  ]

  it('builds one card per agent with its own tasks only', () => {
    const cards = buildStaffCards({ agents, tasks, now: NOW })
    assert.equal(cards.length, 2)

    const a1 = cards.find(c => c.id === 'a1')!
    assert.equal(a1.handle, 'arturito@7ei.ai')
    assert.equal(a1.activeTasks, 1)           // the assigned one; done doesn't count
    assert.equal(a1.costTodayUsd, 0.4)
    assert.equal(a1.state, 'ok')

    const a2 = cards.find(c => c.id === 'a2')!
    assert.equal(a2.handle, '@7dev')
    assert.equal(a2.activeTasks, 1)           // in_progress
    assert.equal(a2.state, 'running')
    assert.equal(a2.costTodayUsd, 0)          // no completed work today
  })

  it('gives a brand-new agent an honest empty card rather than failing', () => {
    const [card] = buildStaffCards({ agents: [agent({ id: 'new', name: 'Fresh' })], tasks: [], now: NOW })
    assert.deepEqual(
      { activeTasks: card.activeTasks, costTodayUsd: card.costTodayUsd, lastActiveAt: card.lastActiveAt, state: card.state },
      { activeTasks: 0, costTodayUsd: 0, lastActiveAt: null, state: 'ok' },
    )
  })

  it('carries the uploaded avatar through, with the emoji as the fallback', () => {
    const [withPic] = buildStaffCards({ agents: [agent({ avatarUrl: 'data:image/webp;base64,AAA', avatarEmoji: '🤖' })], tasks: [], now: NOW })
    assert.equal(withPic.avatarUrl, 'data:image/webp;base64,AAA')
    assert.equal(withPic.avatarEmoji, '🤖')

    const [noPic] = buildStaffCards({ agents: [agent({ avatarEmoji: '🦎' })], tasks: [], now: NOW })
    assert.equal(noPic.avatarUrl, null)
    assert.equal(noPic.avatarEmoji, '🦎')
  })
})
