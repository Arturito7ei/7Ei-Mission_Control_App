import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTranscript, hasWakeWord, stripWakeWord, shouldProcessCapture,
  gateTranscript, orderVoiceProviders, nextVoiceProvider,
  matchWakeWord, levenshtein, WAKE_VARIANTS,
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

// ─── Fuzzy wake word (STT mishears her name) ─────────────────────────────────

test('[wake] levenshtein basic distances', () => {
  assert.equal(levenshtein('arturita', 'arturita'), 0)
  assert.equal(levenshtein('arturita', 'arturito'), 1)   // last char
  assert.equal(levenshtein('arturita', 'arturia'), 1)    // dropped 't'
  assert.equal(levenshtein('', 'abc'), 3)
})

test('[wake] hasWakeWord tolerates common Whisper mishears of "Arturita"', () => {
  // Each of these should reliably trigger wake-word mode.
  for (const v of ['Arturator', 'Arturito', 'Arturia', 'Arturater', 'Arthurita', 'arturi']) {
    assert.equal(hasWakeWord(`${v}, open the cockpit`), true, `variant "${v}" should match`)
  }
})

test('[wake] hasWakeWord tolerates the name split across tokens ("art of eta")', () => {
  assert.equal(hasWakeWord('art of eta what is on my calendar'), true)
  assert.equal(hasWakeWord('art of eta'), true)
})

test('[wake] hasWakeWord still rejects unrelated leading speech', () => {
  assert.equal(hasWakeWord('hey there'), false)
  assert.equal(hasWakeWord('open the cockpit'), false)
  assert.equal(hasWakeWord('are we there yet'), false)
  // The name present but NOT leading must not trigger (back-compat invariant).
  assert.equal(hasWakeWord('tell Arturita later'), false)
  assert.equal(hasWakeWord('please tell arturita to wait'), false)
})

test('[wake] exact + case-insensitive still work (no regression)', () => {
  assert.equal(hasWakeWord('Arturita, what is on my calendar'), true)
  assert.equal(hasWakeWord('arturita move the files'), true)
  assert.equal(hasWakeWord('Arturita'), true)
  assert.equal(WAKE_WORD, 'arturita')
})

test('[wake] matchWakeWord reports how many tokens the name spanned', () => {
  assert.deepEqual(matchWakeWord('Arturita move it'), { matched: true, tokensConsumed: 1 })
  assert.deepEqual(matchWakeWord('art of eta move it'), { matched: true, tokensConsumed: 3 })
  assert.deepEqual(matchWakeWord('move it'), { matched: false, tokensConsumed: 0 })
  assert.deepEqual(matchWakeWord(''), { matched: false, tokensConsumed: 0 })
})

test('[wake] stripWakeWord removes a fuzzy/split leading name, keeps the command', () => {
  assert.equal(stripWakeWord('Arturator, move the files'), 'move the files')
  assert.equal(stripWakeWord('Arturito delete downloads'), 'delete downloads')
  assert.equal(stripWakeWord('art of eta open the cockpit'), 'open the cockpit')
  assert.equal(stripWakeWord('Arturita, move the files'), 'move the files') // exact still works
  assert.equal(stripWakeWord('move the files'), 'move the files')           // no-op
})

test('[wake] every allowlisted variant matches as a leading wake word', () => {
  for (const v of WAKE_VARIANTS) {
    assert.equal(hasWakeWord(`${v} do the thing`), true, `allowlist entry "${v}" should match`)
  }
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
