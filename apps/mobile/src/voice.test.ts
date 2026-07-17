// MOB-7a — the phone's voice logic, and the two tripwires that keep it honest.
//
// The tripwires pin the two values this client CANNOT choose for itself:
//   * WAKE_WORD — the word the label promises must be the word the system listens
//     for (web/app/dashboard/cockpit/voicePanel.logic.ts).
//   * RECORDING_MIME — the type we declare must be one the transcribe route
//     accepts (backend/src/services/stt-provider.ts), or every clip 415s.
//
// Both source modules are import-free, so they load under `node --test
// --experimental-strip-types` with only apps/mobile's lockfile installed — which
// is what Mobile CI has. (A test importing a web/backend module with real deps
// passes locally and silently drops the whole file in CI.)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WAKE_WORD as WEB_WAKE_WORD } from '../../../web/app/dashboard/cockpit/voicePanel.logic.ts'
import { ACCEPTED_AUDIO_MIMES } from '../../../backend/src/services/stt-provider.ts'
import {
  RECORDING_MIME,
  WAKE_WORD,
  WAKE_WORD_DEV_BUILD_NOTE,
  canPushToTalk,
  captureLabel,
  describeTranscribeFailure,
  replyProvenance,
  resolveCaptureEngine,
  sttErrorCode,
  talkButtonLabel,
  wakeWordAvailable,
} from './voice.ts'

test('[MOB-7a] the wake word is the web’s, so both clients listen for one word', () => {
  assert.equal(WAKE_WORD, WEB_WAKE_WORD)
})

test('[MOB-7a] the recorded mime is one the backend transcribe route accepts', () => {
  // The 415 branch is the one failure the operator could do nothing about: the
  // phone would record fine and every clip would bounce. Pin it to the server list.
  assert.ok(
    ACCEPTED_AUDIO_MIMES.includes(RECORDING_MIME),
    `the phone records "${RECORDING_MIME}", which the backend does not accept: ${ACCEPTED_AUDIO_MIMES.join(', ')}`,
  )
})

// ─── Capture engine resolution ───────────────────────────────────────────────

test('[MOB-7a] a host that can record and a configured backend gives hosted capture', () => {
  assert.equal(resolveCaptureEngine({ recorderAvailable: true, sttConfigured: true }), 'hosted')
})

test('[MOB-7a] no recorder means no capture, however configured the backend is', () => {
  assert.equal(resolveCaptureEngine({ recorderAvailable: false, sttConfigured: true }), 'none')
  assert.equal(resolveCaptureEngine({ recorderAvailable: false, sttConfigured: false }), 'none')
})

test('[MOB-7a] a recorder with no backend key is "unconfigured", not "none"', () => {
  // The distinction is the whole point: this one the operator can fix, so it must
  // not collapse into the same dead grey as an unsupported host.
  assert.equal(resolveCaptureEngine({ recorderAvailable: true, sttConfigured: false }), 'unconfigured')
})

test('[MOB-7a] push-to-talk is live only on the hosted path', () => {
  assert.equal(canPushToTalk('hosted'), true)
  assert.equal(canPushToTalk('unconfigured'), false)
  assert.equal(canPushToTalk('none'), false)
})

test('[MOB-7a] the capture chip never claims on-device transcription', () => {
  // A "Local Whisper" chip on a phone would misstate where the operator's audio
  // goes. It leaves the handset for the org's backend, and the chip says so.
  assert.equal(captureLabel('hosted'), 'hosted Whisper')
  assert.doesNotMatch(captureLabel('hosted'), /local|on-device/i)
})

test('[MOB-7a] an unconfigured backend labels itself, and "none" falls back to the web’s wording', () => {
  assert.equal(captureLabel('unconfigured'), 'voice not configured')
  // '' is what reactorChips turns into the web's own "voice off · type".
  assert.equal(captureLabel('none'), '')
})

test('[MOB-7a] the talk button mirrors the web’s three labels', () => {
  assert.equal(talkButtonLabel({ listening: false, transcribing: false }), '🎙 Push to talk')
  assert.equal(talkButtonLabel({ listening: true, transcribing: false }), '■ Stop')
  assert.equal(talkButtonLabel({ listening: false, transcribing: true }), '◐ Transcribing…')
  // Transcribing wins — the recorder has already stopped by then.
  assert.equal(talkButtonLabel({ listening: true, transcribing: true }), '◐ Transcribing…')
})

// ─── Failure messages ────────────────────────────────────────────────────────

test('[MOB-7a] a 503 names the fix and latches the chip to unconfigured', () => {
  const r = describeTranscribeFailure('not_configured')
  assert.equal(r.unconfigured, true)
  assert.match(r.notice.text, /OPENAI_API_KEY/)
  assert.match(r.notice.text, /type below/i)
})

test('[MOB-7a] no other failure latches the chip to unconfigured', () => {
  // Latching on a timeout would tell the operator to go set a key that is already
  // set — sending them to fix the wrong thing.
  for (const code of ['timeout', 'too_large', 'empty_audio', 'unsupported_type', 'weird', null]) {
    assert.equal(describeTranscribeFailure(code).unconfigured, false, `"${code}" must not latch`)
  }
})

test('[MOB-7a] every failure still points at typing, and none is a dead end', () => {
  for (const code of ['not_configured', 'timeout', 'too_large', 'empty_audio', 'unsupported_type', null]) {
    const { notice } = describeTranscribeFailure(code)
    assert.ok(notice.text.length > 0, `"${code}" produced no message`)
    assert.match(notice.text, /type|tell us/i, `"${code}" leaves the operator with no way forward`)
  }
})

test('[MOB-7a] a silent clip is info, not a warning', () => {
  // Saying nothing is a normal thing to do; it should not read as a fault.
  assert.equal(describeTranscribeFailure('empty_audio').notice.tone, 'info')
  assert.equal(describeTranscribeFailure('not_configured').notice.tone, 'warn')
})

// ─── Error-code extraction ───────────────────────────────────────────────────

test('[MOB-7a] the backend code is read from the error, by code not by prose', () => {
  assert.equal(sttErrorCode('HTTP 503: not_configured'), 'not_configured')
  assert.equal(sttErrorCode('HTTP 504: timeout'), 'timeout')
  assert.equal(sttErrorCode('HTTP 413: too_large'), 'too_large')
  assert.equal(sttErrorCode('HTTP 400: empty_audio'), 'empty_audio')
})

test('[MOB-7a] a code-less 503/504/413 is still diagnosed from its status', () => {
  // api() folds the body's `error` prose into the message and drops `code`, so the
  // status is all that survives for the case the operator can actually fix.
  assert.equal(sttErrorCode('HTTP 503: Speech-to-text is not configured'), 'not_configured')
  assert.equal(sttErrorCode('HTTP 504: upstream took too long'), 'timeout')
  assert.equal(sttErrorCode('HTTP 413: Clip too large — the limit is 20 MB'), 'too_large')
})

test('[MOB-7a] an unrecognised error yields no code and gets the generic notice', () => {
  assert.equal(sttErrorCode('Network error — could not reach the backend'), null)
  assert.equal(sttErrorCode(''), null)
  assert.equal(sttErrorCode(null), null)
  assert.equal(describeTranscribeFailure(sttErrorCode('Network error')).unconfigured, false)
})

// ─── Provenance ──────────────────────────────────────────────────────────────

test('[MOB-7a] a local runtime named by the backend is claimed as local', () => {
  assert.deepEqual(replyProvenance({ provider: 'ollama', model: 'llama3.2:3b' }), { model: 'llama3.2:3b' })
  assert.deepEqual(replyProvenance({ provider: 'local', model: 'mistral' }), { model: 'mistral' })
  assert.deepEqual(replyProvenance({ provider: 'OLLAMA', model: 'llama3.2:3b' }), { model: 'llama3.2:3b' })
})

test('[MOB-7a] a cloud provider is never dressed up as local', () => {
  // The chip tells the operator where their words went. "local" is the one wrong
  // answer that actually matters, so anything not named local is cloud.
  for (const provider of ['anthropic', 'openai', 'gemini', 'text_only', '', null, 'unknown']) {
    assert.equal(replyProvenance({ provider, model: 'some-model' }), null, `"${provider}" must not read as local`)
  }
})

test('[MOB-7a] a local provider with no model names nothing', () => {
  // provenanceChip would render "local · " — a chip with a hole in it.
  assert.equal(replyProvenance({ provider: 'ollama', model: '' }), null)
  assert.equal(replyProvenance({ provider: 'ollama' }), null)
  assert.equal(replyProvenance(null), null)
  assert.equal(replyProvenance(undefined), null)
})

// ─── Wake word ───────────────────────────────────────────────────────────────

test('[MOB-7a] wake word is never live in Expo Go, and is earned only by a dev build', () => {
  assert.equal(wakeWordAvailable({ devBuild: false }), false)
  assert.equal(wakeWordAvailable({ devBuild: true }), true)
})

test('[MOB-7a] the wake-word note names the word, the reason, and the way forward', () => {
  assert.match(WAKE_WORD_DEV_BUILD_NOTE, new RegExp(WAKE_WORD))
  assert.match(WAKE_WORD_DEV_BUILD_NOTE, /dev build/i)
  assert.match(WAKE_WORD_DEV_BUILD_NOTE, /push to talk/i)
})
