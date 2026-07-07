import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runActivity, taskActivity, mergeActivity, buildHeartbeatTimeline,
  TIMELINE_WINDOW_MS, MIN_BLOCK_PCT, type TLRun, type TLTask, type TLAgent,
} from '../services/timeline'

const NOW = Date.parse('2026-07-07T12:00:00Z')
const H = 60 * 60 * 1000
const ago = (h: number) => new Date(NOW - h * H)

// ─── runActivity ──────────────────────────────────────────────────────────────

test('[MCA-84] runActivity spans startedAt→endedAt for a finished run', () => {
  const run: TLRun = { id: 'r1', agentId: 'a1', taskId: 't1', status: 'done', startedAt: ago(3), endedAt: ago(2), costUsd: 0.5, tokensUsed: 100 }
  const a = runActivity(run, { id: 't1', agentId: 'a1', title: 'Ship it', status: 'done', createdAt: ago(4) }, NOW)
  assert.equal(a.startMs, NOW - 3 * H)
  assert.equal(a.endMs, NOW - 2 * H)
  assert.equal(a.ongoing, false)
  assert.equal(a.status, 'done')
  assert.equal(a.title, 'Ship it')
  assert.equal(a.costUsd, 0.5)
})

test('[MCA-84] a running run with no endedAt is ongoing, open to now', () => {
  const run: TLRun = { id: 'r1', agentId: 'a1', taskId: null, status: 'running', startedAt: ago(1) }
  const a = runActivity(run, undefined, NOW)
  assert.equal(a.ongoing, true)
  assert.equal(a.endMs, NOW)
  assert.equal(a.status, 'running')
  assert.equal(a.title, '[Heartbeat]')      // falls back when no task
})

// ─── taskActivity ─────────────────────────────────────────────────────────────

test('[MCA-84] done task spans [completedAt - durationMs, completedAt]', () => {
  const task: TLTask = { id: 't1', agentId: 'a1', title: 'Report', status: 'done', createdAt: ago(5), completedAt: ago(2), durationMs: 90_000 }
  const a = taskActivity(task, NOW)!
  assert.equal(a.endMs, NOW - 2 * H)
  assert.equal(a.startMs, NOW - 2 * H - 90_000)
  assert.equal(a.ongoing, false)
})

test('[MCA-84] in_progress task opens from lockedAt to now', () => {
  const task: TLTask = { id: 't1', agentId: 'a1', status: 'in_progress', createdAt: ago(5), lockedAt: ago(1) }
  const a = taskActivity(task, NOW)!
  assert.equal(a.startMs, NOW - 1 * H)
  assert.equal(a.endMs, NOW)
  assert.equal(a.ongoing, true)
  assert.equal(a.status, 'running')
})

test('[MCA-84] tasks that never ran produce no block', () => {
  for (const status of ['pending', 'todo', 'assigned', 'blocked']) {
    assert.equal(taskActivity({ id: 't', agentId: 'a1', status, createdAt: ago(1) }, NOW), null)
  }
})

// ─── mergeActivity ────────────────────────────────────────────────────────────

test('[MCA-84] a task with a run contributes no task-derived block (no double count)', () => {
  const runs: TLRun[] = [{ id: 'r1', agentId: 'a1', taskId: 't1', status: 'done', startedAt: ago(3), endedAt: ago(2) }]
  const tasks: TLTask[] = [{ id: 't1', agentId: 'a1', title: 'X', status: 'done', createdAt: ago(4), completedAt: ago(2), durationMs: 60_000 }]
  const acts = mergeActivity(runs, tasks, NOW)
  assert.equal(acts.length, 1)
  assert.equal(acts[0].source, 'run')
})

test('[MCA-84] internal task without a run is projected from its own timing', () => {
  const tasks: TLTask[] = [{ id: 't1', agentId: 'a1', title: 'X', status: 'done', createdAt: ago(4), completedAt: ago(1), durationMs: 60_000 }]
  const acts = mergeActivity([], tasks, NOW)
  assert.equal(acts.length, 1)
  assert.equal(acts[0].source, 'task')
})

// ─── buildHeartbeatTimeline ───────────────────────────────────────────────────

const agents: TLAgent[] = [
  { id: 'a1', name: 'Dev', avatarEmoji: '💻', status: 'active', heartbeat: 'green' },
  { id: 'a2', name: 'Ops', avatarEmoji: '⚙️', status: 'idle', heartbeat: 'stale' },
]

test('[MCA-84] one lane per agent, idle agents included with no blocks', () => {
  const acts = mergeActivity([{ id: 'r1', agentId: 'a1', taskId: 't1', status: 'done', startedAt: ago(3), endedAt: ago(2) }], [], NOW)
  const tl = buildHeartbeatTimeline(agents, acts, NOW)
  assert.equal(tl.lanes.length, 2)
  assert.equal(tl.lanes[0].blocks.length, 1)
  assert.equal(tl.lanes[1].blocks.length, 0)
  assert.equal(tl.lanes[1].heartbeat, 'stale')
})

test('[MCA-84] block sits at the correct percent across a 24h window', () => {
  // Run from 12h ago to 6h ago → starts at 50%, spans 25% of the day.
  const acts = mergeActivity([{ id: 'r1', agentId: 'a1', taskId: null, status: 'done', startedAt: ago(12), endedAt: ago(6) }], [], NOW)
  const b = buildHeartbeatTimeline(agents, acts, NOW).lanes[0].blocks[0]
  assert.ok(Math.abs(b.startPct - 50) < 0.01)
  assert.ok(Math.abs(b.widthPct - 25) < 0.01)
})

test('[MCA-84] a sub-window run still gets a minimum visible width', () => {
  const acts = mergeActivity([{ id: 'r1', agentId: 'a1', taskId: null, status: 'done', startedAt: ago(2), endedAt: new Date(NOW - 2 * H + 1000) }], [], NOW)
  const b = buildHeartbeatTimeline(agents, acts, NOW).lanes[0].blocks[0]
  assert.equal(b.widthPct, MIN_BLOCK_PCT)
})

test('[MCA-84] activity older than the window is excluded', () => {
  const acts = mergeActivity([{ id: 'r1', agentId: 'a1', taskId: null, status: 'done', startedAt: ago(30), endedAt: ago(26) }], [], NOW)
  assert.equal(buildHeartbeatTimeline(agents, acts, NOW).lanes[0].blocks.length, 0)
})

test('[MCA-84] a run that began before the window is clipped to the left edge', () => {
  // Started 30h ago, still running → clip to windowStart (0%), open to now.
  const acts = mergeActivity([{ id: 'r1', agentId: 'a1', taskId: null, status: 'running', startedAt: ago(30) }], [], NOW)
  const b = buildHeartbeatTimeline(agents, acts, NOW).lanes[0].blocks[0]
  assert.equal(b.startPct, 0)
  assert.ok(Math.abs(b.widthPct - 100) < 0.01)
  assert.equal(b.ongoing, true)
  assert.equal(b.endMs, null)
})

test('[MCA-84] ongoing run keeps its lane active-time and cost rolled up', () => {
  const runs: TLRun[] = [
    { id: 'r1', agentId: 'a1', taskId: null, status: 'done', startedAt: ago(4), endedAt: ago(3), costUsd: 0.2 },
    { id: 'r2', agentId: 'a1', taskId: null, status: 'running', startedAt: ago(1), costUsd: 0.1 },
  ]
  const lane = buildHeartbeatTimeline(agents, mergeActivity(runs, [], NOW), NOW).lanes[0]
  assert.equal(lane.runCount, 2)
  assert.ok(Math.abs(lane.totalCost - 0.3) < 1e-9)
  assert.equal(lane.activeMs, 2 * H)       // 1h finished + 1h ongoing
})

test('[MCA-84] window metadata is exposed for the axis', () => {
  const tl = buildHeartbeatTimeline(agents, [], NOW)
  assert.equal(tl.windowMs, TIMELINE_WINDOW_MS)
  assert.equal(tl.windowEnd, NOW)
  assert.equal(tl.windowStart, NOW - TIMELINE_WINDOW_MS)
})
