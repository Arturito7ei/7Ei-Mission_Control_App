import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionNeed, routeForConnectivity, buildQueuedAction, planReplay,
  defaultArturitaWatchdogs,
} from '../services/arturita-resilience'

// ─── Action needs ────────────────────────────────────────────────────────────

test('[F2] actionNeed maps kinds; unknown defaults to cloud (safe direction)', () => {
  assert.equal(actionNeed('answer'), 'local')
  assert.equal(actionNeed('summarize'), 'local')
  assert.equal(actionNeed('gmail_send'), 'cloud')
  assert.equal(actionNeed('wallet_read'), 'cloud')
  assert.equal(actionNeed('file_op'), 'host')
  assert.equal(actionNeed('machine_exec'), 'host')
  assert.equal(actionNeed('who_knows'), 'cloud') // safe default: queue rather than run blind
})

// ─── Connectivity routing ────────────────────────────────────────────────────

test('[F2] local actions always run (offline conversational)', () => {
  const d = routeForConnectivity({ actionKind: 'answer', connectivity: { online: false, hostUp: false } })
  assert.equal(d.disposition, 'run')
})

test('[F2] cloud actions queue offline, run online', () => {
  const offline = routeForConnectivity({ actionKind: 'gmail_send', connectivity: { online: false, hostUp: true } })
  assert.equal(offline.disposition, 'queue')
  assert.match(offline.spoken, /queued/i)

  const online = routeForConnectivity({ actionKind: 'gmail_send', connectivity: { online: true, hostUp: true } })
  assert.equal(online.disposition, 'run')
})

test('[F2] host actions fail closed when the host is down', () => {
  const down = routeForConnectivity({ actionKind: 'file_op', connectivity: { online: true, hostUp: false } })
  assert.equal(down.disposition, 'refuse')
  assert.match(down.spoken, /host is offline/i)

  const up = routeForConnectivity({ actionKind: 'file_op', connectivity: { online: true, hostUp: true } })
  assert.equal(up.disposition, 'run')
})

// ─── Idempotent replay ───────────────────────────────────────────────────────

test('[F2] planReplay runs each queued action once, skipping applied + dup nonces', () => {
  const q = [
    buildQueuedAction({ nonce: 'n1', kind: 'gmail_send', now: 1 }),
    buildQueuedAction({ nonce: 'n2', kind: 'gmail_send', now: 2 }),
    buildQueuedAction({ nonce: 'n1', kind: 'gmail_send', now: 3 }), // dup within batch
    buildQueuedAction({ nonce: 'n3', kind: 'calendar_read', now: 4 }),
  ]
  const plan = planReplay({ queued: q, appliedNonces: ['n3'] }) // n3 already applied
  assert.deepEqual(plan.toRun.map(a => a.nonce), ['n1', 'n2'])
  assert.deepEqual(plan.skippedDuplicate.map(a => a.nonce).sort(), ['n1', 'n3'])
})

test('[F2] planReplay with nothing applied runs all unique in order', () => {
  const q = [
    buildQueuedAction({ nonce: 'a', kind: 'x', now: 1 }),
    buildQueuedAction({ nonce: 'b', kind: 'y', now: 2 }),
  ]
  const plan = planReplay({ queued: q, appliedNonces: [] })
  assert.equal(plan.toRun.length, 2)
  assert.equal(plan.skippedDuplicate.length, 0)
})

// ─── Watchdog attach ─────────────────────────────────────────────────────────

test('[F2] defaultArturitaWatchdogs builds valid runtime/cost/no_activity specs', () => {
  const specs = defaultArturitaWatchdogs()
  assert.deepEqual(specs.map(s => s.kind), ['runtime', 'cost', 'no_activity'])
  // all thresholds positive + well-formed (parseWatchdogSpec would throw otherwise)
  for (const s of specs) assert.ok(Number(s.threshold) > 0)

  const custom = defaultArturitaWatchdogs({ runtimeMin: 30, costUsd: 2.5, noActivityMin: 5 })
  assert.equal(custom[0].threshold, '30')
  assert.equal(custom[1].threshold, '2.5')
  assert.equal(custom[2].threshold, '5')
})
