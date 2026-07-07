import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWatchdogSpec, describeWatchdog, evaluateWatchdog, watchdogTransition,
  WATCHDOG_KINDS, WATCHABLE_STATUSES, type WatchdogContext,
} from '../services/watchdogs'

const now = new Date('2026-07-07T12:00:00Z').getTime()
const minsAgo = (m: number) => now - m * 60_000
const ctx = (p: Partial<WatchdogContext> = {}): WatchdogContext =>
  ({ status: 'in_progress', runningRunStartedMs: null, costUsd: null, lastActivityMs: null, ...p })

// ─── parseWatchdogSpec ───────────────────────────────────────────────────────

test('[MCA-83] parse rejects unknown kinds', () => {
  assert.throws(() => parseWatchdogSpec({ kind: 'nope', threshold: '1' }), /unknown watchdog kind/)
})

test('[MCA-83] parse normalizes numeric thresholds (runtime/idle whole minutes, cost keeps cents)', () => {
  assert.deepEqual(parseWatchdogSpec({ kind: 'runtime', threshold: '30.7' }), { kind: 'runtime', threshold: '31' })
  assert.deepEqual(parseWatchdogSpec({ kind: 'no_activity', threshold: 45 }), { kind: 'no_activity', threshold: '45' })
  assert.deepEqual(parseWatchdogSpec({ kind: 'cost', threshold: '0.50' }), { kind: 'cost', threshold: '0.5' })
})

test('[MCA-83] parse rejects non-positive numeric thresholds', () => {
  for (const k of ['runtime', 'cost', 'no_activity']) {
    assert.throws(() => parseWatchdogSpec({ kind: k, threshold: '0' }), /positive/)
    assert.throws(() => parseWatchdogSpec({ kind: k, threshold: 'abc' }), /positive/)
    assert.throws(() => parseWatchdogSpec({ kind: k, threshold: '-5' }), /positive/)
  }
})

test('[MCA-83] parse validates the status target against the allowlist, lowercased', () => {
  assert.deepEqual(parseWatchdogSpec({ kind: 'status', threshold: 'BLOCKED' }), { kind: 'status', threshold: 'blocked' })
  assert.throws(() => parseWatchdogSpec({ kind: 'status', threshold: 'pending' }), /status watchdog must target/)
  for (const s of WATCHABLE_STATUSES) assert.equal(parseWatchdogSpec({ kind: 'status', threshold: s }).threshold, s)
})

test('[MCA-83] describe covers every kind', () => {
  for (const kind of WATCHDOG_KINDS) {
    const label = describeWatchdog({ kind, threshold: kind === 'status' ? 'blocked' : '30' })
    assert.ok(label.length > 0, kind)
  }
  assert.equal(describeWatchdog({ kind: 'cost', threshold: '0.5' }), 'Cost over $0.5')
})

// ─── evaluateWatchdog: runtime ───────────────────────────────────────────────

test('[MCA-83] runtime triggers only while a run is in flight past the limit', () => {
  const spec = { kind: 'runtime' as const, threshold: '30' }
  // No running run → never triggers (a finished run isn't a long run).
  assert.equal(evaluateWatchdog(spec, ctx({ runningRunStartedMs: null }), now).triggered, false)
  // Running 45m > 30m → trigger.
  const hot = evaluateWatchdog(spec, ctx({ runningRunStartedMs: minsAgo(45) }), now)
  assert.equal(hot.triggered, true)
  assert.match(hot.message, /45m.*limit 30m/)
  // Running 10m < 30m → ok.
  assert.equal(evaluateWatchdog(spec, ctx({ runningRunStartedMs: minsAgo(10) }), now).triggered, false)
})

// ─── evaluateWatchdog: cost ──────────────────────────────────────────────────

test('[MCA-83] cost triggers when own cost exceeds the cap', () => {
  const spec = { kind: 'cost' as const, threshold: '0.5' }
  assert.equal(evaluateWatchdog(spec, ctx({ costUsd: null }), now).triggered, false)
  assert.equal(evaluateWatchdog(spec, ctx({ costUsd: 0.4 }), now).triggered, false)
  const over = evaluateWatchdog(spec, ctx({ costUsd: 0.82 }), now)
  assert.equal(over.triggered, true)
  assert.match(over.message, /\$0\.8200 exceeds \$0\.5/)
})

// ─── evaluateWatchdog: no_activity ───────────────────────────────────────────

test('[MCA-83] no_activity triggers on stalls but never on a done task', () => {
  const spec = { kind: 'no_activity' as const, threshold: '45' }
  assert.equal(evaluateWatchdog(spec, ctx({ lastActivityMs: minsAgo(60) }), now).triggered, true)
  assert.equal(evaluateWatchdog(spec, ctx({ lastActivityMs: minsAgo(10) }), now).triggered, false)
  // Finished work is meant to be idle.
  assert.equal(evaluateWatchdog(spec, ctx({ status: 'done', lastActivityMs: minsAgo(600) }), now).triggered, false)
  assert.equal(evaluateWatchdog(spec, ctx({ lastActivityMs: null }), now).triggered, false)
})

// ─── evaluateWatchdog: status ────────────────────────────────────────────────

test('[MCA-83] status triggers on an exact match', () => {
  const spec = { kind: 'status' as const, threshold: 'blocked' }
  assert.equal(evaluateWatchdog(spec, ctx({ status: 'blocked' }), now).triggered, true)
  assert.equal(evaluateWatchdog(spec, ctx({ status: 'in_progress' }), now).triggered, false)
})

// ─── watchdogTransition (edge-triggered) ─────────────────────────────────────

test('[MCA-83] transition posts only on a flip, not every over-threshold tick', () => {
  const trig = { triggered: true, message: 'run has been active 45m (limit 30m)' }
  const clear = { triggered: false, message: '' }
  // ok → triggered: post the alert.
  const a = watchdogTransition('ok', trig, 'Runtime over 30m')
  assert.deepEqual({ post: a.post, newState: a.newState }, { post: true, newState: 'triggered' })
  assert.match(a.notice!, /⚠ Watchdog triggered/)
  // triggered → triggered: silent (the anti-spam guarantee).
  assert.deepEqual(watchdogTransition('triggered', trig, 'Runtime over 30m'), { post: false, newState: 'triggered', notice: null })
  // triggered → ok: post the cleared note, naming the check.
  const c = watchdogTransition('triggered', clear, 'Runtime over 30m')
  assert.equal(c.post, true); assert.equal(c.newState, 'ok')
  assert.match(c.notice!, /✓ Watchdog cleared — Runtime over 30m/)
  // ok → ok (incl. null prev state defaulting to ok): silent.
  assert.deepEqual(watchdogTransition('ok', clear, 'x'), { post: false, newState: 'ok', notice: null })
  assert.deepEqual(watchdogTransition(null, clear, 'x'), { post: false, newState: 'ok', notice: null })
})
