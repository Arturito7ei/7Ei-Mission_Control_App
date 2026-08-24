import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickSpeechVoice, classifyTtsError, classifySttError, describeTalkError, runSelfTest, overallSeverity,
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

// ─── classifySttError (mic capture / SpeechRecognition) ──────────────────────

test('classifySttError treats a network error as unavailable + hinted (the Brave root cause), never a bare code', () => {
  const s = classifySttError('network')
  assert.equal(s.failed, true)
  assert.equal(s.kind, 'network')
  assert.equal(s.unavailable, true)               // stop steering to the mic
  assert.doesNotMatch(String(s.message), /^Speech error/i) // no more bare "Speech error: network"
  assert.match(String(s.hint), /Whisper|text box/i)
})

test('classifySttError names Brave specifically when told it is Brave', () => {
  const brave = classifySttError('network', { brave: true })
  assert.match(String(brave.message), /Brave/)
  const other = classifySttError('network', { brave: false })
  assert.doesNotMatch(String(other.message), /Brave/)
  assert.equal(other.unavailable, true)           // still unavailable, just not named Brave
})

test('classifySttError maps not-allowed / service-not-allowed to a permission status (not unavailable)', () => {
  for (const c of ['not-allowed', 'service-not-allowed']) {
    const s = classifySttError(c)
    assert.equal(s.kind, 'permission')
    assert.equal(s.unavailable, false)
    assert.match(String(s.message), /mic|microphone/i)
  }
})

test('classifySttError maps audio-capture to a no-mic status', () => {
  const s = classifySttError('audio-capture')
  assert.equal(s.kind, 'no-mic')
  assert.equal(s.failed, true)
})

test('classifySttError does NOT report benign no-speech / aborted / empty codes', () => {
  for (const c of ['no-speech', 'aborted', '', null, undefined]) {
    const s = classifySttError(c as any)
    assert.equal(s.failed, false, `code ${c} should be benign`)
    assert.equal(s.kind, null)
    assert.equal(s.unavailable, false)
  }
})

test('classifySttError maps an unknown code to a generic non-fatal, non-unavailable failure', () => {
  const s = classifySttError('weird-stt-code')
  assert.equal(s.failed, true)
  assert.equal(s.kind, 'unknown')
  assert.equal(s.unavailable, false)              // don't over-claim "unavailable" for unknowns
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
  const r = runSelfTest({ ...BASE, cloudLlmUsable: true })
  assert.equal(overallSeverity(r), 'ok')
  assert.equal(r.length, 5)               // answers + backend + ollama + tts + stt
  assert.ok(r.every(x => x.icon === '✓'))
})

test('runSelfTest FAILS the answers leg when neither local, hosted, nor cloud works', () => {
  const r = runSelfTest({ ...BASE, ollamaModels: null, cloudLlmUsable: false, serverAnswerUsable: false })
  const ans = r.find(x => x.leg === 'answers')!
  assert.equal(ans.severity, 'fail')
  assert.equal(ans.icon, '✕')
  assert.match(String(ans.hint), /Fly Ollama/)
  assert.match(String(ans.hint), /Groq or Gemini/)
  assert.equal(overallSeverity(r), 'fail')
})

test('runSelfTest answers leg is OK via hosted Ollama when local is down and cloud keys are empty (S3-B)', () => {
  const r = runSelfTest({
    ...BASE, ollamaModels: null, cloudLlmUsable: false,
    serverAnswerUsable: true,
    serverAnswerDetail: 'Hosted Ollama reachable via ollama (llama3.2:3b) on the backend.',
  })
  const ans = r.find(x => x.leg === 'answers')!
  assert.equal(ans.severity, 'ok')
  assert.match(ans.detail, /Hosted Ollama/)
})

test('runSelfTest answers leg is OK via cloud when local Ollama is down but a cloud key works', () => {
  const r = runSelfTest({ ...BASE, ollamaModels: null, cloudLlmUsable: true, cloudLlmDetail: 'Cloud LLM reachable via groq (llama-3.3-70b-versatile).' })
  const ans = r.find(x => x.leg === 'answers')!
  assert.equal(ans.severity, 'ok')
  assert.match(ans.detail, /groq/)
})

test('runSelfTest answers leg warns (not fails) when cloud was not probed and no local model', () => {
  const r = runSelfTest({ ...BASE, ollamaModels: null, cloudLlmUsable: null })
  const ans = r.find(x => x.leg === 'answers')!
  assert.equal(ans.severity, 'warn')
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

// ─── STT leg: local Whisper > browser Web Speech > typing ────────────────────

test('runSelfTest STT leg is OK via local Whisper (free voice, works in Brave)', () => {
  const r = runSelfTest({ ...BASE, whisperReachable: true, sttSupported: false })
  const stt = r.find(x => x.leg === 'stt')!
  assert.equal(stt.severity, 'ok')
  assert.match(stt.label, /Whisper/)
})

test('runSelfTest STT leg is OK via browser voice when Whisper is down but Web Speech works', () => {
  const r = runSelfTest({ ...BASE, whisperReachable: false, sttSupported: true, sttBlocked: false })
  const stt = r.find(x => x.leg === 'stt')!
  assert.equal(stt.severity, 'ok')
  assert.match(stt.label, /Browser/)
})

test('runSelfTest STT leg WARNS with the Whisper start command when Web Speech is blocked (Brave) and no bridge', () => {
  const r = runSelfTest({ ...BASE, whisperReachable: false, sttSupported: true, sttBlocked: true })
  const stt = r.find(x => x.leg === 'stt')!
  assert.equal(stt.severity, 'warn')
  assert.match(stt.detail, /Brave|network/i)
  assert.match(String(stt.hint), /arturita-stt|npm run stt/)
})

test('runSelfTest STT leg warns (with Whisper command) when nothing is available', () => {
  const r = runSelfTest({ ...BASE, whisperReachable: false, sttSupported: false })
  const stt = r.find(x => x.leg === 'stt')!
  assert.equal(stt.severity, 'warn')
  assert.match(String(stt.hint), /Whisper/)
})
