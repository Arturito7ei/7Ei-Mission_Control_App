import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickSpeechVoice, classifyTtsError, describeTalkError, runSelfTest, overallSeverity,
  type VoiceLike,
} from './talkDiagnostics.ts'

// ─── pickSpeechVoice ─────────────────────────────────────────────────────────

test('pickSpeechVoice prefers an on-device voice in the requested language', () => {
  const voices: VoiceLike[] = [
    { name: 'Google US English', lang: 'en-US', localService: false },
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Amélie', lang: 'fr-FR', localService: true },
  ]
  assert.equal(pickSpeechVoice(voices, 'en-US')?.name, 'Samantha')
})

test('pickSpeechVoice falls back to a network voice when no local one exists', () => {
  const voices: VoiceLike[] = [{ name: 'Google US English', lang: 'en-US', localService: false }]
  assert.equal(pickSpeechVoice(voices, 'en-US')?.name, 'Google US English')
})

test('pickSpeechVoice honours the default flag within the preferred pool', () => {
  const voices: VoiceLike[] = [
    { name: 'Alex', lang: 'en-US', localService: true },
    { name: 'Fred', lang: 'en-US', localService: true, default: true },
  ]
  assert.equal(pickSpeechVoice(voices, 'en-US')?.name, 'Fred')
})

test('pickSpeechVoice returns null when no voices are loaded yet', () => {
  assert.equal(pickSpeechVoice([], 'en-US'), null)
  assert.equal(pickSpeechVoice(null, 'en-US'), null)
})

// ─── classifyTtsError ────────────────────────────────────────────────────────

test('classifyTtsError treats a network error as a non-fatal, hinted failure', () => {
  const s = classifyTtsError('network')
  assert.equal(s.failed, true)
  assert.equal(s.kind, 'network')
  assert.match(String(s.hint), /on-device|offline|connection/i)
})

test('classifyTtsError does NOT report benign interrupted/canceled codes', () => {
  for (const c of ['interrupted', 'canceled', 'cancelled', '']) {
    const s = classifyTtsError(c)
    assert.equal(s.failed, false, `code ${c} should be benign`)
    assert.equal(s.kind, null)
  }
})

test('classifyTtsError maps not-allowed to a blocked status with a click hint', () => {
  const s = classifyTtsError('not-allowed')
  assert.equal(s.kind, 'blocked')
  assert.match(String(s.hint), /click/i)
})

test('classifyTtsError maps an unknown code to a generic non-fatal failure', () => {
  const s = classifyTtsError('weird-new-code')
  assert.equal(s.failed, true)
  assert.equal(s.kind, 'unknown')
})

// ─── describeTalkError ───────────────────────────────────────────────────────

test('describeTalkError maps a transport "Network error" to a backend-unreachable message', () => {
  const d = describeTalkError(new Error('Network error — backend unreachable'), 'backend')
  assert.match(d.message, /backend/i)
  assert.ok(!/^Network error/.test(d.message)) // no longer the raw generic string
  assert.ok(d.hint)
})

test('describeTalkError surfaces the OLLAMA_ORIGINS hint for the local-ollama leg', () => {
  const d = describeTalkError(new Error('Failed to fetch'), 'local-ollama')
  assert.equal(d.leg, 'local-ollama')
  assert.match(String(d.hint), /OLLAMA_ORIGINS/)
})

test('describeTalkError maps 401/403 to a token hint and 5xx to a backend-error message', () => {
  assert.match(describeTalkError(new Error('HTTP 401: unauthorized'), 'backend').message, /token/i)
  assert.match(describeTalkError(new Error('HTTP 503: unavailable'), 'backend').message, /backend/i)
  assert.match(String(describeTalkError(new Error('HTTP 429: slow down'), 'backend').hint), /provider|chain|again/i)
})

// ─── runSelfTest / overallSeverity ───────────────────────────────────────────

const BASE = {
  backendOk: true, ollamaModels: ['llama3.2:3b'] as string[] | null, ollamaPrimaryModel: 'llama3.2:3b',
  ttsSupported: true, ttsLocalVoice: true, sttSupported: true,
}

test('runSelfTest is all-green when every leg is healthy', () => {
  const r = runSelfTest(BASE)
  assert.equal(overallSeverity(r), 'ok')
  assert.equal(r.length, 4)
  assert.ok(r.every(x => x.icon === '✓'))
})

test('runSelfTest fails the backend leg (never color-only) and reports overall fail', () => {
  const r = runSelfTest({ ...BASE, backendOk: false })
  const backend = r.find(x => x.leg === 'backend')!
  assert.equal(backend.severity, 'fail')
  assert.equal(backend.icon, '✕')       // icon carries the state, not color
  assert.ok(backend.hint)
  assert.equal(overallSeverity(r), 'fail')
})

test('runSelfTest warns (not fails) when local Ollama is unreachable — it is optional', () => {
  const r = runSelfTest({ ...BASE, ollamaModels: null })
  const ol = r.find(x => x.leg === 'local-ollama')!
  assert.equal(ol.severity, 'warn')
  assert.match(String(ol.hint), /OLLAMA_ORIGINS/)
  assert.equal(overallSeverity(r), 'warn')
})

test('runSelfTest warns when the configured primary model is not pulled', () => {
  const r = runSelfTest({ ...BASE, ollamaModels: ['qwen3:8b'], ollamaPrimaryModel: 'llama3.2:3b' })
  const ol = r.find(x => x.leg === 'local-ollama')!
  assert.equal(ol.severity, 'warn')
  assert.match(String(ol.hint), /ollama pull llama3\.2:3b/)
})

test('runSelfTest warns when TTS has no on-device voice (offline-fail risk)', () => {
  const r = runSelfTest({ ...BASE, ttsLocalVoice: false })
  const tts = r.find(x => x.leg === 'tts')!
  assert.equal(tts.severity, 'warn')
})
