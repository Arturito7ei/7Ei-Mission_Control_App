// Arturita J1 — pure Assistant-tab logic tests. Node 22 built-in runner +
// type-stripping (see web/package.json `test`), no test-runner dep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  orbVisual, resolveVoiceState, toConverseRequest, toArturitaMessage,
  revealNext, isRevealComplete, revealStepFor, routingBadge,
  type Message, type ConverseResponse,
} from './assistant.logic.ts'

// ─── Orb state machine ───────────────────────────────────────────────────────

test('[J1] every voice state has a colorblind-safe orb descriptor (icon + label + motion)', () => {
  for (const s of ['idle', 'listening', 'thinking', 'speaking'] as const) {
    const v = orbVisual(s)
    assert.equal(v.state, s)
    assert.ok(v.icon.length > 0, `${s} has an icon`)
    assert.ok(v.label.length > 0, `${s} has a label`)
    assert.ok(v.motion.length > 0, `${s} has a motion`)
    assert.match(v.colorVar, /^var\(--/)
  }
})

test('[J1] orb states are visually distinct (no two share icon+motion — not color-only)', () => {
  const keys = (['idle', 'listening', 'thinking', 'speaking'] as const).map(s => {
    const v = orbVisual(s); return `${v.icon}|${v.motion}`
  })
  assert.equal(new Set(keys).size, 4)
})

test('[J1] unknown state falls back to idle', () => {
  // @ts-expect-error — exercise the fallback
  assert.equal(orbVisual('nope').state, 'idle')
})

test('[J1] resolveVoiceState precedence: speaking > thinking > listening > idle', () => {
  assert.equal(resolveVoiceState({ speaking: true, thinking: true, listening: true }), 'speaking')
  assert.equal(resolveVoiceState({ thinking: true, listening: true }), 'thinking')
  assert.equal(resolveVoiceState({ listening: true }), 'listening')
  assert.equal(resolveVoiceState({}), 'idle')
})

// ─── Request builder ─────────────────────────────────────────────────────────

test('[J1] toConverseRequest trims, carries the flag/thread, maps + caps history', () => {
  const history: Message[] = Array.from({ length: 14 }, (_, i) => ({
    id: String(i), role: i % 2 === 0 ? 'user' : 'arturita', text: `m${i}`,
  }))
  const req = toConverseRequest({ message: '  hello  ', explicitDelegate: true, existingThreadId: 't1', history, historyLimit: 6 })
  assert.equal(req.message, 'hello')
  assert.equal(req.explicitDelegate, true)
  assert.equal(req.existingThreadId, 't1')
  assert.equal(req.history.length, 6)
  // arturita → assistant role mapping
  assert.ok(req.history.every(h => h.role === 'user' || h.role === 'assistant'))
})

test('[J1] toConverseRequest drops empty-text turns from history', () => {
  const history: Message[] = [
    { id: '1', role: 'user', text: 'real' },
    { id: '2', role: 'arturita', text: '   ' },
  ]
  const req = toConverseRequest({ message: 'x', history })
  assert.equal(req.history.length, 1)
  assert.equal(req.history[0].content, 'real')
})

// ─── Response → message ──────────────────────────────────────────────────────

test('[J1] toArturitaMessage carries mode + routing + taskId and starts streaming', () => {
  const resp: ConverseResponse = {
    mode: 'delegate', taskId: 'task-9',
    routing: { trigger: 'build_order', reason: 'build order', destructive: false, workMode: 'execute' },
    reply: { text: 'On it.' },
  }
  const m = toArturitaMessage({ id: 'a1', resp })
  assert.equal(m.role, 'arturita')
  assert.equal(m.text, 'On it.')
  assert.equal(m.mode, 'delegate')
  assert.equal(m.taskId, 'task-9')
  assert.equal(m.streaming, true)
})

test('[J1] toArturitaMessage never throws on an empty reply', () => {
  const m = toArturitaMessage({ id: 'a2', resp: {} })
  assert.ok(m.text.length > 0)
  assert.equal(m.mode, 'answer')
})

// ─── Streaming reveal ────────────────────────────────────────────────────────

test('[J1] revealNext advances by step and clamps to total', () => {
  assert.equal(revealNext(0, 10, 3), 3)
  assert.equal(revealNext(8, 10, 3), 10)
  assert.equal(revealNext(0, 10, 0), 0)     // no step → no movement
  assert.equal(revealNext(-5, 10, 3), 3)    // negative shown floored at 0
})

test('[J1] isRevealComplete true once shown reaches total', () => {
  assert.equal(isRevealComplete(9, 10), false)
  assert.equal(isRevealComplete(10, 10), true)
  assert.equal(isRevealComplete(11, 10), true)
})

test('[J1] revealStepFor scales with length and is always >= 2', () => {
  assert.ok(revealStepFor(10) >= 2)
  assert.ok(revealStepFor(4000) > revealStepFor(40))
})

// ─── Routing badge ───────────────────────────────────────────────────────────

test('[J1] routingBadge distinguishes answer / delegate / approval (icon + label)', () => {
  assert.equal(routingBadge({ mode: 'answer' }).tone, 'answer')
  assert.equal(routingBadge({ mode: 'delegate', routing: { trigger: 'x', reason: 'y' } }).tone, 'delegate')
  assert.equal(routingBadge({ mode: 'delegate', routing: { trigger: 'x', reason: 'y', destructive: true } }).tone, 'approval')
  for (const m of [{ mode: 'answer' as const }, { mode: 'delegate' as const, routing: { trigger: 'x', reason: 'y' } }]) {
    const b = routingBadge(m)
    assert.ok(b.icon.length > 0 && b.label.length > 0)
  }
})
