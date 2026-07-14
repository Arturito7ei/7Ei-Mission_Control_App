import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgentOverview, costTotals, countBy, dayKey, dayKeys, latestRun, runActivity, runSummary, successRate, toMs,
  type RunLite, type TaskLite,
} from '../services/agent-overview'

// A fixed clock so day bucketing is deterministic.
const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const day = (offset: number) => NOW - offset * 86_400_000

const run = (over: Partial<RunLite> = {}): RunLite => ({ id: 'r1', status: 'done', startedAt: new Date(NOW), ...over })
const task = (over: Partial<TaskLite> = {}): TaskLite => ({ id: 't1', title: 'T', status: 'done', priority: 'medium', createdAt: new Date(NOW), ...over })

describe('[AG2] toMs / dayKey / dayKeys', () => {
  it('normalises Date, ms, seconds and ISO strings', () => {
    assert.equal(toMs(new Date(NOW)), NOW)
    assert.equal(toMs(NOW), NOW)
    assert.equal(toMs(Math.floor(NOW / 1000)), NOW) // seconds are widened to ms
    assert.equal(toMs('2026-07-14T12:00:00.000Z'), NOW)
  })

  it('returns null for absent or unparseable values', () => {
    assert.equal(toMs(null), null)
    assert.equal(toMs(undefined), null)
    assert.equal(toMs('not a date'), null)
    assert.equal(toMs(new Date('nope')), null)
  })

  it('dayKeys returns `days` UTC keys ending today, oldest first', () => {
    const keys = dayKeys(NOW, 14)
    assert.equal(keys.length, 14)
    assert.equal(keys[13], '2026-07-14')
    assert.equal(keys[0], '2026-07-01')
    assert.equal(dayKey(NOW), '2026-07-14')
  })
})

describe('[AG2] runActivity', () => {
  it('buckets runs per day and splits succeeded vs failed', () => {
    const runs = [
      run({ id: 'a', status: 'done', startedAt: new Date(day(0)) }),
      run({ id: 'b', status: 'failed', startedAt: new Date(day(0)) }),
      run({ id: 'c', status: 'orphaned', startedAt: new Date(day(0)) }), // orphaned counts as failed
      run({ id: 'd', status: 'running', startedAt: new Date(day(1)) }),  // counted in total, neither bucket
      run({ id: 'e', status: 'done', startedAt: new Date(day(3)) }),
    ]
    const series = runActivity(runs, NOW, 14)
    const today = series.at(-1)!
    assert.deepEqual(today, { date: '2026-07-14', total: 3, succeeded: 1, failed: 2 })
    assert.deepEqual(series.at(-2), { date: '2026-07-13', total: 1, succeeded: 0, failed: 0 })
    assert.equal(series.find(d => d.date === '2026-07-11')!.total, 1)
  })

  it('always emits one entry per day, zero-filled, in chronological order', () => {
    const series = runActivity([], NOW, 14)
    assert.equal(series.length, 14)
    assert.ok(series.every(d => d.total === 0))
    assert.deepEqual(series.map(d => d.date), dayKeys(NOW, 14))
  })

  it('drops runs outside the window and runs with no start time', () => {
    const runs = [run({ startedAt: new Date(day(30)) }), run({ startedAt: null })]
    assert.equal(runActivity(runs, NOW, 14).reduce((s, d) => s + d.total, 0), 0)
  })
})

describe('[AG2] successRate', () => {
  it('is succeeded / settled, ignoring still-running runs', () => {
    const runs = [
      run({ status: 'done', startedAt: new Date(day(0)) }),
      run({ status: 'done', startedAt: new Date(day(0)) }),
      run({ status: 'failed', startedAt: new Date(day(0)) }),
      run({ status: 'running', startedAt: new Date(day(0)) }), // not settled → excluded
    ]
    const today = successRate(runs, NOW, 14).at(-1)!
    assert.equal(today.settled, 3)
    assert.equal(today.pct, 67)
  })

  it('reports null (no data) — not 0% — on a day with no settled run', () => {
    const today = successRate([run({ status: 'running', startedAt: new Date(day(0)) })], NOW, 14).at(-1)!
    assert.equal(today.pct, null)
    assert.equal(successRate([], NOW, 14).every(d => d.pct === null), true)
  })
})

describe('[AG2] countBy', () => {
  it('counts by key, descending by count then key', () => {
    const tasks = [task({ priority: 'high' }), task({ priority: 'low' }), task({ priority: 'high' })]
    assert.deepEqual(countBy(tasks, t => t.priority), [{ key: 'high', count: 2 }, { key: 'low', count: 1 }])
  })

  it('folds null/empty keys into the fallback', () => {
    assert.deepEqual(countBy([task({ priority: null }), task({ priority: '' })], t => t.priority, 'medium'), [{ key: 'medium', count: 2 }])
  })
})

describe('[AG2] costTotals', () => {
  it('sums the token split and the cost, and rounds money to 6dp', () => {
    const c = costTotals([
      task({ inputTokens: 100, outputTokens: 40, cachedTokens: 10, tokensUsed: 140, costUsd: 0.1 }),
      task({ inputTokens: 50, outputTokens: 5, cachedTokens: 0, tokensUsed: 55, costUsd: 0.2 }),
    ])
    assert.equal(c.inputTokens, 150)
    assert.equal(c.outputTokens, 45)
    assert.equal(c.cachedTokens, 10)
    assert.equal(c.totalTokens, 195)
    assert.equal(c.totalCostUsd, 0.3) // not 0.30000000000000004
    assert.equal(c.taskCount, 2)
    assert.equal(c.hasSplit, true)
  })

  it('keeps totals truthful for tasks that predate the split, and flags hasSplit=false', () => {
    const c = costTotals([task({ tokensUsed: 900, costUsd: 0.5 })]) // legacy row: no split columns
    assert.equal(c.totalTokens, 900)
    assert.equal(c.totalCostUsd, 0.5)
    assert.equal(c.inputTokens, 0)
    assert.equal(c.hasSplit, false)
  })

  it('is zero-safe for an agent that has never run', () => {
    assert.deepEqual(costTotals([]), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, totalCostUsd: 0, taskCount: 0, hasSplit: false })
  })
})

describe('[AG2] runSummary / latestRun', () => {
  it('summarises a run from its last non-empty log line', () => {
    assert.equal(runSummary(run({ logs: [{ t: 1, msg: 'started' }, { t: 2, msg: 'Verification passed.' }] })), 'Verification passed.')
  })

  it('parses logs stored as a JSON string, and falls back to the status', () => {
    assert.equal(runSummary(run({ logs: JSON.stringify([{ t: 1, msg: 'from json' }]) })), 'from json')
    assert.equal(runSummary(run({ status: 'failed', logs: [] })), 'Run failed.')
    assert.equal(runSummary(run({ status: 'running', logs: 'not json' })), 'Run running.')
  })

  it('truncates a long summary', () => {
    const s = runSummary(run({ logs: [{ t: 1, msg: 'x'.repeat(400) }] }))
    assert.equal(s.length, 240)
    assert.ok(s.endsWith('…'))
  })

  it('latestRun picks the newest by startedAt; null when there are none', () => {
    const runs = [run({ id: 'old', startedAt: new Date(day(3)) }), run({ id: 'new', startedAt: new Date(day(0)) }), run({ id: 'undated', startedAt: null })]
    assert.equal(latestRun(runs)?.id, 'new')
    assert.equal(latestRun([]), null)
  })
})

describe('[AG2] buildAgentOverview', () => {
  it('assembles the whole Dashboard payload', () => {
    const runs = [
      run({ id: 'r-new', status: 'done', taskId: 't-2', logs: [{ t: 1, msg: 'All green.' }], startedAt: new Date(day(0)), endedAt: new Date(day(0) + 60_000) }),
      run({ id: 'r-old', status: 'failed', startedAt: new Date(day(2)) }),
    ]
    const tasks = [
      task({ id: 't-1', title: 'First', status: 'done', priority: 'high', createdAt: new Date(day(5)), tokensUsed: 10, costUsd: 0.01, inputTokens: 8, outputTokens: 2 }),
      task({ id: 't-2', title: 'Second', status: 'in_progress', priority: 'high', createdAt: new Date(day(1)), tokensUsed: 20, costUsd: 0.02, inputTokens: 15, outputTokens: 5 }),
    ]
    const o = buildAgentOverview({ agentId: 'a-1', runs, tasks, now: NOW })

    assert.equal(o.agentId, 'a-1')
    assert.equal(o.days, 14)
    assert.equal(o.latestRun?.id, 'r-new')
    assert.equal(o.latestRun?.summary, 'All green.')
    assert.equal(o.latestRun?.taskId, 't-2')
    assert.equal(o.runActivity.length, 14)
    assert.equal(o.successRate.length, 14)
    assert.deepEqual(o.tasksByPriority, [{ key: 'high', count: 2 }])
    assert.deepEqual(o.tasksByStatus, [{ key: 'done', count: 1 }, { key: 'in_progress', count: 1 }])
    assert.equal(o.costs.totalTokens, 30)
    assert.equal(o.costs.inputTokens, 23)
    // Recent tasks are newest-first regardless of input order.
    assert.deepEqual(o.recentTasks.map(t => t.id), ['t-2', 't-1'])
  })

  it('is safe for a brand-new agent with no runs and no tasks', () => {
    const o = buildAgentOverview({ agentId: 'a-new', runs: [], tasks: [], now: NOW })
    assert.equal(o.latestRun, null)
    assert.deepEqual(o.recentTasks, [])
    assert.deepEqual(o.tasksByPriority, [])
    assert.equal(o.costs.totalCostUsd, 0)
    assert.equal(o.runActivity.length, 14)
  })

  it('honours the recentLimit', () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task({ id: `t-${i}`, createdAt: new Date(day(i)) }))
    assert.equal(buildAgentOverview({ agentId: 'a', runs: [], tasks, now: NOW }).recentTasks.length, 6)
    assert.equal(buildAgentOverview({ agentId: 'a', runs: [], tasks, now: NOW, recentLimit: 3 }).recentTasks.length, 3)
  })
})
