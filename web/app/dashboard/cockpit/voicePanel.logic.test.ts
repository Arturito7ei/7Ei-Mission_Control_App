// Arturita B2 — pure voice-panel logic tests. Run with the Node 22 built-in
// runner + type-stripping (see web/package.json `test`), no test-runner dep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTranscript, hasWakeWord, stripWakeWord, decideSubmit,
  pickPlayback, toFeedItem, type VoiceResponse,
} from './voicePanel.logic.ts'

test('[B2] normalizeTranscript collapses whitespace and trims', () => {
  assert.equal(normalizeTranscript('  hello   world \n'), 'hello world')
  assert.equal(normalizeTranscript(null), '')
})

test('[B2] hasWakeWord matches case- and punctuation-insensitively', () => {
  assert.equal(hasWakeWord('Arturita, deploy the build'), true)
  assert.equal(hasWakeWord('ARTURITA what time is it'), true)
  assert.equal(hasWakeWord('deploy the build'), false)
  // substring must not falsely match (word-boundary)
  assert.equal(hasWakeWord('arturitas are cool'), false)
})

test('[B2] stripWakeWord removes the wake word, leaves the command', () => {
  assert.equal(stripWakeWord('Arturita, deploy the build'), 'deploy the build')
  assert.equal(stripWakeWord('hey Arturita what is on my calendar'), 'hey what is on my calendar')
  assert.equal(stripWakeWord('Arturita'), '')
})

test('[B2] decideSubmit — push-to-talk submits any non-empty transcript verbatim', () => {
  const d = decideSubmit({ transcript: 'ship the release', wakeWordMode: false })
  assert.equal(d.submit, true)
  assert.equal(d.cleaned, 'ship the release')
})

test('[B2] decideSubmit — empty transcript never submits', () => {
  assert.equal(decideSubmit({ transcript: '   ', wakeWordMode: false }).submit, false)
  assert.equal(decideSubmit({ transcript: '', wakeWordMode: true }).submit, false)
})

test('[B2] decideSubmit — wake-word mode ignores utterances without the wake word', () => {
  const d = decideSubmit({ transcript: 'deploy the build', wakeWordMode: true })
  assert.equal(d.submit, false)
  assert.match(d.reason, /no "Arturita"/)
})

test('[B2] decideSubmit — wake-word mode strips the wake word before submitting', () => {
  const d = decideSubmit({ transcript: 'Arturita deploy the build', wakeWordMode: true })
  assert.equal(d.submit, true)
  assert.equal(d.cleaned, 'deploy the build')
})

test('[B2] decideSubmit — wake word only (no command) does not submit', () => {
  assert.equal(decideSubmit({ transcript: 'Arturita', wakeWordMode: true }).submit, false)
})

test('[B2] pickPlayback — provider audio → play the returned bytes', () => {
  const p = pickPlayback({ text: 'On it.', provider: 'chatterbox_nvidia', mime: 'audio/wav', audioBase64: 'QUJD' })
  assert.equal(p.kind, 'audio')
  assert.equal(p.audioSrc, 'data:audio/wav;base64,QUJD')
})

test('[B2] pickPlayback — no audio but text → speak locally (browser TTS)', () => {
  const p = pickPlayback({ text: 'Let me check that for you.', provider: 'text_only' })
  assert.equal(p.kind, 'speech')
  assert.equal(p.text, 'Let me check that for you.')
})

test('[B2] pickPlayback — empty reply → nothing to say', () => {
  assert.equal(pickPlayback({ text: '', provider: 'text_only' }).kind, 'none')
  assert.equal(pickPlayback(null).kind, 'none')
})

test('[B2] toFeedItem — ask command routes without approval', () => {
  const resp: VoiceResponse = {
    disposition: 'accept', taskId: 't1',
    route: { workMode: 'ask', reason: 'question', destructive: false, isFollowUp: false },
    reply: { text: 'Let me check that for you.', provider: 'text_only' },
  }
  const f = toFeedItem({ command: "what's on my calendar", resp, seq: 1 })
  assert.equal(f.workMode, 'ask')
  assert.equal(f.needsApproval, false)
  assert.equal(f.taskId, 't1')
})

test('[B2] toFeedItem — destructive execute command needs approval', () => {
  const resp: VoiceResponse = {
    disposition: 'accept', taskId: 't2',
    route: { workMode: 'execute', reason: 'work order', destructive: true, isFollowUp: false },
    reply: { text: "Got it — I'll prepare that and stop for your approval.", provider: 'text_only' },
  }
  const f = toFeedItem({ command: 'delete the old branch', resp, seq: 2 })
  assert.equal(f.workMode, 'execute')
  assert.equal(f.needsApproval, true)
})

test('[B2] toFeedItem — non-destructive execute does not need approval', () => {
  const resp: VoiceResponse = {
    disposition: 'accept', taskId: 't3',
    route: { workMode: 'execute', reason: 'work order', destructive: false, isFollowUp: false },
    reply: { text: 'On it.', provider: 'text_only' },
  }
  assert.equal(toFeedItem({ command: 'summarize the inbox', resp, seq: 3 }).needsApproval, false)
})

test('[B2] toFeedItem — low-confidence re-prompt surfaces as a reprompt row', () => {
  const resp: VoiceResponse = {
    disposition: 'reprompt', reprompt: true,
    reply: { text: "I didn't quite catch that — could you repeat it?", provider: 'text_only' },
  }
  const f = toFeedItem({ command: 'mumble', resp, seq: 4 })
  assert.equal(f.workMode, 'reprompt')
  assert.equal(f.needsApproval, false)
  assert.equal(f.taskId, null)
})
