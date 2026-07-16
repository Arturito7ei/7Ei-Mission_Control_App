// MOB-6d — tripwires for the Activity feed.
//
// The valuable ones here are the CONTRACT tests: this file imports the backend's
// real timeline service and feeds our reader a payload built by the same code
// that serves it. A copy of the shape hand-written into a fixture would pass
// forever while the wire drifted underneath it; `buildHeartbeatTimeline` is the
// producer, so if a field is renamed or the window changes, these fail.
//
// Zero-dep, matching the workspace convention: node --test --experimental-strip-types.
// The backend module is pure (no fastify, no db) so it loads outside Metro.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TIMELINE_WINDOW_MS,
  buildHeartbeatTimeline,
  mergeActivity,
} from '../../../backend/src/services/timeline.ts'
import {
  ACTIVITY_LIMIT,
  ACTIVITY_WINDOW_MS,
  activityCount,
  activityFeed,
  formatDuration,
  formatWhen,
  formatWindow,
  type TimelineLite,
} from './activity.ts'

const NOW = 1_700_000_000_000
const min = (n: number) => n * 60_000

/** Build a real timeline the way the route does: agents + merged run/task activity. */
function realTimeline(): TimelineLite {
  const agents = [
    { id: 'a1', name: 'Arturita', avatarEmoji: '🤖', status: 'active', heartbeat: 'green' },
    { id: 'a2', name: 'Scribe', avatarEmoji: '📝', status: 'idle', heartbeat: 'amber' },
  ]
  // NOTE the cost lives on the RUN row, not on the task it points at —
  // `runActivity` reads `run.costUsd`. See the run/task cost test below.
  const runs = [
    { id: 'r1', orgId: 'o1', agentId: 'a1', taskId: 't1', status: 'succeeded', summary: 'ok',
      startedAt: new Date(NOW - min(30)), endedAt: new Date(NOW - min(28)),
      costUsd: 0.02, tokensUsed: 900 },
    { id: 'r2', orgId: 'o1', agentId: 'a2', taskId: null, status: 'running', summary: '',
      startedAt: new Date(NOW - min(5)), endedAt: null, costUsd: 0, tokensUsed: 0 },
  ]
  const tasks = [
    { id: 't1', orgId: 'o1', agentId: 'a1', title: 'Indexed the vault', status: 'done',
      createdAt: new Date(NOW - min(30)), completedAt: new Date(NOW - min(28)),
      durationMs: min(2), costUsd: 0.02, tokensUsed: 900, lockedAt: null },
    // A task with no run of its own — mergeActivity projects this one itself.
    { id: 't2', orgId: 'o1', agentId: 'a1', title: 'Summarised inbox', status: 'done',
      createdAt: new Date(NOW - min(90)), completedAt: new Date(NOW - min(88)),
      durationMs: min(2), costUsd: 0.05, tokensUsed: 1200, lockedAt: null },
  ]
  const acts = mergeActivity(runs as any, tasks as any, NOW)
  return buildHeartbeatTimeline(agents as any, acts, NOW) as unknown as TimelineLite
}

test('[MOB-6d] the feed reads a timeline the backend actually built', () => {
  const feed = activityFeed(realTimeline())
  // Three blocks: r1 (a1), r2 (a2, ongoing), and t2 projected from its own timing.
  assert.equal(feed.length, 3)
  // Every event carries its lane's actor — the fact flattening would otherwise lose.
  for (const e of feed) assert.ok(e.agentName, 'event lost its agent')
  assert.deepEqual(
    feed.map((e) => e.agentName),
    ['Scribe', 'Arturita', 'Arturita'],
  )
})

test('[MOB-6d] newest first — the feed reverses the chart’s left-to-right', () => {
  const feed = activityFeed(realTimeline())
  const starts = feed.map((e) => e.startMs)
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'feed is not newest-first')
  assert.equal(feed[0].ongoing, true, 'the running block should be the newest')
})

test('[MOB-6d] an ongoing block keeps its null end rather than a fake one', () => {
  const running = activityFeed(realTimeline()).find((e) => e.ongoing)!
  assert.equal(running.endMs, null)
  // …and it is measured against now, not left blank.
  assert.equal(formatDuration(running.startMs, running.endMs, NOW), '5m')
})

test('[MOB-6d] cost and tokens survive the flattening', () => {
  const feed = activityFeed(realTimeline())
  const indexed = feed.find((e) => e.title === 'Indexed the vault')!
  assert.equal(indexed.costUsd, 0.02)
  assert.equal(indexed.tokensUsed, 900)
  // A task-projected block takes its cost from the TASK instead (t2 has no run).
  const summarised = feed.find((e) => e.title === 'Summarised inbox')!
  assert.equal(summarised.costUsd, 0.05)
})

test('[MOB-6d] a run block’s cost comes from the RUN row, not its task', () => {
  // The trap this pins, and the reason ActivityScreen hides a zero rather than
  // printing "$0.0000": a run whose row never recorded a cost yields a 0 block
  // EVEN IF the task it points at cost real money. That 0 means "not recorded
  // here", not "free" — and the two must never render the same.
  const runs = [{ id: 'r9', orgId: 'o1', agentId: 'a1', taskId: 't9', status: 'succeeded',
    summary: '', startedAt: new Date(NOW - min(10)), endedAt: new Date(NOW - min(9)) }]
  const tasks = [{ id: 't9', orgId: 'o1', agentId: 'a1', title: 'Pricey', status: 'done',
    createdAt: new Date(NOW - min(10)), completedAt: new Date(NOW - min(9)),
    durationMs: min(1), costUsd: 9.99, tokensUsed: 5000, lockedAt: null }]
  const tl = buildHeartbeatTimeline(
    [{ id: 'a1', name: 'Arturita', avatarEmoji: '🤖', status: 'active', heartbeat: 'green' }] as any,
    mergeActivity(runs as any, tasks as any, NOW),
    NOW,
  ) as unknown as TimelineLite
  const [only] = activityFeed(tl)
  assert.equal(only.title, 'Pricey', 'the run borrows its title from the task…')
  assert.equal(only.costUsd, 0, '…but NOT its cost')
})

test('[MOB-6d] the window matches the backend’s — the feed cannot claim more than it has', () => {
  // If the backend ever widens its window, our label must move with it.
  assert.equal(ACTIVITY_WINDOW_MS, TIMELINE_WINDOW_MS)
  assert.equal(formatWindow(TIMELINE_WINDOW_MS), 'last 24h')
})

test('[MOB-6d] keys are unique and stable', () => {
  const feed = activityFeed(realTimeline())
  const keys = feed.map((e) => e.key)
  assert.equal(new Set(keys).size, keys.length, 'duplicate list keys')
  // Stable across builds of the same data.
  assert.deepEqual(activityFeed(realTimeline()).map((e) => e.key), keys)
})

test('[MOB-6d] ties break deterministically', () => {
  // Two blocks starting in the same millisecond must not swap between renders.
  const tl: TimelineLite = {
    now: NOW, windowStart: NOW - ACTIVITY_WINDOW_MS, windowEnd: NOW, windowMs: ACTIVITY_WINDOW_MS,
    lanes: [
      { agentId: 'b', name: 'B', avatarEmoji: '🅱️', heartbeat: 'green', status: 'active', runCount: 1, totalCost: 0, activeMs: 0,
        blocks: [{ runId: 'x', taskId: null, title: 'B job', status: 'done', startMs: NOW - 1000, endMs: NOW, ongoing: false, costUsd: 0, tokensUsed: 0 }] },
      { agentId: 'a', name: 'A', avatarEmoji: '🅰️', heartbeat: 'green', status: 'active', runCount: 1, totalCost: 0, activeMs: 0,
        blocks: [{ runId: 'x', taskId: null, title: 'A job', status: 'done', startMs: NOW - 1000, endMs: NOW, ongoing: false, costUsd: 0, tokensUsed: 0 }] },
    ],
  }
  assert.deepEqual(activityFeed(tl).map((e) => e.title), ['A job', 'B job'])
})

test('[MOB-6d] the feed is capped, and the true count is still reportable', () => {
  const blocks = Array.from({ length: 150 }, (_, i) => ({
    runId: `r${i}`, taskId: null, title: `job ${i}`, status: 'done',
    startMs: NOW - i * 1000, endMs: NOW - i * 1000 + 500, ongoing: false, costUsd: 0, tokensUsed: 0,
  }))
  const tl: TimelineLite = {
    now: NOW, windowStart: NOW - ACTIVITY_WINDOW_MS, windowEnd: NOW, windowMs: ACTIVITY_WINDOW_MS,
    lanes: [{ agentId: 'a1', name: 'Arturita', avatarEmoji: '🤖', heartbeat: 'green', status: 'active',
      blocks, runCount: blocks.length, totalCost: 0, activeMs: 0 }],
  }
  assert.equal(activityFeed(tl).length, ACTIVITY_LIMIT)
  // The screen needs the real total to say "showing 100 of 150" honestly.
  assert.equal(activityCount(tl), 150)
})

test('[MOB-6d] an empty or absent timeline is empty, not a crash', () => {
  assert.deepEqual(activityFeed(null), [])
  assert.deepEqual(activityFeed(undefined), [])
  assert.equal(activityCount(null), 0)
  const empty: TimelineLite = { now: NOW, windowStart: NOW - 1, windowEnd: NOW, windowMs: 1, lanes: [] }
  assert.deepEqual(activityFeed(empty), [])
})

test('[MOB-6d] relative time reads as a feed', () => {
  assert.equal(formatWhen(NOW, NOW), 'just now')
  assert.equal(formatWhen(NOW - 10_000, NOW), 'just now')
  assert.equal(formatWhen(NOW - min(3), NOW), '3m ago')
  assert.equal(formatWhen(NOW - min(120), NOW), '2h ago')
  assert.equal(formatWhen(NOW - min(60 * 30), NOW), '1d ago')
  // A clock skew that puts an event in the future must not render "-2m ago".
  assert.equal(formatWhen(NOW + min(2), NOW), 'just now')
})

test('[MOB-6d] durations scale from ms to hours', () => {
  assert.equal(formatDuration(NOW - 400, NOW, NOW), '400ms')
  assert.equal(formatDuration(NOW - 1400, NOW, NOW), '1.4s')
  assert.equal(formatDuration(NOW - min(12), NOW, NOW), '12m')
  assert.equal(formatDuration(NOW - min(120), NOW, NOW), '2h')
})
