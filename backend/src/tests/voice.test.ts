import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTranscript, hasWakeWord, stripWakeWord, shouldProcessCapture,
  gateTranscript, orderVoiceProviders, nextVoiceProvider,
  AUDIO_RETENTION, WAKE_WORD, MIN_STT_CONFIDENCE, type VoiceProvider,
} from '../services/voice'

// ─── Retention invariant ─────────────────────────────────────────────────────

test('[B1] audio retention default is discard-after-transcription (PRD §7.8)', () => {
  assert.equal(AUDIO_RETENTION, 'discard_after_transcription')
})

// ─── Transcript normalization ────────────────────────────────────────────────

test('[B1] normalizeTranscript collapses whitespace + trims', () => {
  assert.equal(normalizeTranscript('  hello   world \n'), 'hello world')
  assert.equal(normalizeTranscript(null), '')
})

// ─── Wake word ───────────────────────────────────────────────────────────────

test('[B1] hasWakeWord matches a leading "Arturita"', () => {
  assert.equal(hasWakeWord('Arturita, what is on my calendar'), true)
  assert.equal(hasWakeWord('arturita move the files'), true)
  assert.equal(hasWakeWord('Arturita'), true)
  assert.equal(hasWakeWord('hey there'), false)
  assert.equal(hasWakeWord('tell Arturita later'), false) // not leading
  assert.equal(WAKE_WORD, 'arturita')
})

test('[B1] stripWakeWord removes the leading wake word + comma', () => {
  assert.equal(stripWakeWord('Arturita, move the files'), 'move the files')
  assert.equal(stripWakeWord('arturita delete downloads'), 'delete downloads')
  assert.equal(stripWakeWord('move the files'), 'move the files') // no-op
})

test('[B1] shouldProcessCapture: push-to-talk always; wake-word only if present', () => {
  assert.equal(shouldProcessCapture({ transcript: 'move it', mode: 'push_to_talk' }), true)
  assert.equal(shouldProcessCapture({ transcript: '   ', mode: 'push_to_talk' }), false)
  assert.equal(shouldProcessCapture({ transcript: 'move it', mode: 'wake_word' }), false)
  assert.equal(shouldProcessCapture({ transcript: 'Arturita move it', mode: 'wake_word' }), true)
})

// ─── Confidence gating ───────────────────────────────────────────────────────

test('[B1] gateTranscript: empty / low-confidence / accept', () => {
  assert.equal(gateTranscript({ transcript: '', confidence: 0.9 }), 'empty')
  assert.equal(gateTranscript({ transcript: 'delete it', confidence: MIN_STT_CONFIDENCE - 0.1 }), 'reprompt')
  assert.equal(gateTranscript({ transcript: 'delete it', confidence: 0.95 }), 'accept')
  assert.equal(gateTranscript({ transcript: 'delete it', confidence: null }), 'accept') // no score → accept
})

// ─── Provider fallback ordering ──────────────────────────────────────────────

const PROVIDERS: VoiceProvider[] = [
  { id: 'cloud-a', tier: 'cloud', local: false },
  { id: 'cloud-b', tier: 'alt', local: false },
  { id: 'local-whisper', tier: 'local', local: true },
  { id: 'text', tier: 'text_only', local: false },
]

test('[B1] orderVoiceProviders: cloud-first for normal contexts', () => {
  const ordered = orderVoiceProviders({ providers: PROVIDERS, sensitive: false })
  assert.deepEqual(ordered.map(p => p.id), ['cloud-a', 'cloud-b', 'local-whisper', 'text'])
})

test('[B1] orderVoiceProviders: LOCAL-ONLY for sensitive (wallet/secret) contexts', () => {
  const ordered = orderVoiceProviders({ providers: PROVIDERS, sensitive: true })
  // no cloud/alt providers; local + text-only only
  assert.deepEqual(ordered.map(p => p.id), ['local-whisper', 'text'])
  assert.ok(!ordered.some(p => !p.local && p.tier !== 'text_only'))
})

test('[B1] orderVoiceProviders drops unhealthy providers', () => {
  const withDown = PROVIDERS.map(p => p.id === 'cloud-a' ? { ...p, healthy: false } : p)
  const ordered = orderVoiceProviders({ providers: withDown, sensitive: false })
  assert.ok(!ordered.some(p => p.id === 'cloud-a'))
  assert.equal(ordered[0].id, 'cloud-b')
})

test('[B1] nextVoiceProvider walks the chain then returns null when exhausted', () => {
  const ordered = orderVoiceProviders({ providers: PROVIDERS, sensitive: false })
  assert.equal(nextVoiceProvider(ordered, null)!.id, 'cloud-a')       // first
  assert.equal(nextVoiceProvider(ordered, 'cloud-a')!.id, 'cloud-b')  // after failure
  assert.equal(nextVoiceProvider(ordered, 'local-whisper')!.id, 'text')
  assert.equal(nextVoiceProvider(ordered, 'text'), null)             // exhausted
})
