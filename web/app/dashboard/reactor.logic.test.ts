// Arturita J7 — pure Command Center reactor logic tests. Node 22 built-in runner
// + type-stripping (see web/package.json `test`), no test-runner dep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reactorVisual, provenanceChip, reactorChips, REACTOR_HEADLINE,
} from './reactor.logic.ts'

// ─── Reactor state machine ───────────────────────────────────────────────────

test('[J7] every voice state has a colorblind-safe reactor descriptor (icon + label + motion)', () => {
  for (const s of ['idle', 'listening', 'thinking', 'speaking'] as const) {
    const v = reactorVisual(s)
    assert.equal(v.state, s)
    assert.ok(v.icon.length > 0, `${s} has an icon`)
    assert.ok(v.label.length > 0, `${s} has a label`)
    assert.ok(v.caption.length > 0, `${s} has a caption`)
    assert.ok(v.motion.length > 0, `${s} has a motion`)
    assert.match(v.accentVar, /^var\(--/)
    assert.ok(v.intensity >= 0 && v.intensity <= 1, `${s} intensity in [0,1]`)
    assert.ok(v.spinSec > 0, `${s} has a positive spin period`)
  }
})

test('[J7] reactor states are visually distinct (no two share icon+motion — not colour-only)', () => {
  const keys = (['idle', 'listening', 'thinking', 'speaking'] as const).map(s => {
    const v = reactorVisual(s); return `${v.icon}|${v.motion}`
  })
  assert.equal(new Set(keys).size, 4)
})

test('[J7] captions are distinct per state and each has a distinct label', () => {
  const states = ['idle', 'listening', 'thinking', 'speaking'] as const
  assert.equal(new Set(states.map(s => reactorVisual(s).caption)).size, 4)
  assert.equal(new Set(states.map(s => reactorVisual(s).label)).size, 4)
})

test('[J7] thinking spins fastest, idle slowest (lower spinSec = faster inner rotation)', () => {
  const spin = (s: 'idle' | 'listening' | 'thinking' | 'speaking') => reactorVisual(s).spinSec
  assert.ok(spin('thinking') < spin('speaking'))
  assert.ok(spin('thinking') < spin('listening'))
  assert.ok(spin('idle') > spin('listening'), 'idle drifts slowest')
})

test('[J7] listening is the most intense; idle the least (drives glow/ripple)', () => {
  const i = (s: 'idle' | 'listening' | 'thinking' | 'speaking') => reactorVisual(s).intensity
  assert.equal(Math.max(i('idle'), i('listening'), i('thinking'), i('speaking')), i('listening'))
  assert.equal(Math.min(i('idle'), i('listening'), i('thinking'), i('speaking')), i('idle'))
})

test('[J7] unknown state falls back to idle', () => {
  // @ts-expect-error — exercise the fallback
  assert.equal(reactorVisual('nope').state, 'idle')
})

test('[J7] the headline mirrors the reference HUD line', () => {
  assert.equal(REACTOR_HEADLINE, 'SYSTEM COGNITION')
})

// ─── Provenance chip ─────────────────────────────────────────────────────────

test('[J7] provenanceChip names the local model when running on-device (🔒)', () => {
  const c = provenanceChip({ local: { model: 'llama3.2:3b' } })
  assert.equal(c.tone, 'local')
  assert.equal(c.icon, '🔒')
  assert.match(c.label, /llama3\.2:3b/)
})

test('[J7] provenanceChip names the hosted model when Fly Ollama answers (🖥)', () => {
  const c = provenanceChip({ hosted: { model: 'llama3.2:3b' } })
  assert.equal(c.tone, 'hosted')
  assert.equal(c.icon, '🖥')
  assert.match(c.label, /llama3\.2:3b/)
})

test('[J7] provenanceChip falls back to a cloud chip when no local or hosted model (☁)', () => {
  for (const local of [null, undefined, { model: '   ' }]) {
    const c = provenanceChip({ local: local as any })
    assert.equal(c.tone, 'cloud')
    assert.equal(c.icon, '☁')
    assert.ok(c.label.length > 0)
  }
})

// ─── Status chips row ────────────────────────────────────────────────────────

test('[J7] reactorChips is icon+label for every chip (colorblind-safe) and reflects the pipeline', () => {
  const chips = reactorChips({
    provenance: provenanceChip({ local: { model: 'llama3.2:3b' } }),
    captureLabel: 'Whisper (local)',
    voiceReplies: true,
  })
  assert.ok(chips.length >= 3)
  for (const c of chips) { assert.ok(c.icon.length > 0); assert.ok(c.label.length > 0); assert.ok(c.key.length > 0) }
  assert.ok(chips.some(c => /llama3\.2:3b/.test(c.label)), 'carries the model provenance')
  assert.ok(chips.some(c => /Whisper/.test(c.label)), 'carries the capture engine')
  assert.ok(chips.some(c => c.icon === '🔊'), 'spoken replies chip when on')
})

test('[J7] reactorChips shows muted-replies + type-fallback chips when voice is off/unavailable', () => {
  const chips = reactorChips({
    provenance: provenanceChip({ local: null }),
    captureLabel: '',
    voiceReplies: false,
  })
  assert.ok(chips.some(c => c.icon === '🔈'), 'muted replies chip')
  assert.ok(chips.some(c => /type/.test(c.label)), 'steers to typing when capture unavailable')
})
