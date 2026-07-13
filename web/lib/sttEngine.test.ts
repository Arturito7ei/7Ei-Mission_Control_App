import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSttEngine, sttEngineLabel } from './sttEngine.ts'

const CHAIN = [{ engine: 'whisper_cpp', mode: 'local' }, { engine: 'web_speech', mode: 'provider' }]

test('resolveSttEngine picks whisper when the bridge is reachable (chain primary)', () => {
  assert.equal(resolveSttEngine({ sttChain: CHAIN, whisperReachable: true, webSpeechAvailable: true }), 'whisper')
})

// The shipped DEFAULT_STT_CHAIN (backend arturita-pipeline: whisper_cpp → web_speech)
// resolves to local whisper AUTOMATICALLY on the operator's Mac (bridge running at
// 127.0.0.1:8790 → whisperReachable), so the operator never flips the engine manually.
test('resolveSttEngine: shipped whisper-first default → whisper on the operator Mac', () => {
  const SHIPPED_DEFAULT = [{ engine: 'whisper_cpp', mode: 'local' }, { engine: 'web_speech', mode: 'provider' }]
  assert.equal(resolveSttEngine({ sttChain: SHIPPED_DEFAULT, whisperReachable: true, webSpeechAvailable: true }), 'whisper')
  // Only when the bridge is unreachable does it fall back to the browser engine.
  assert.equal(resolveSttEngine({ sttChain: SHIPPED_DEFAULT, whisperReachable: false, webSpeechAvailable: true }), 'web_speech')
})

test('resolveSttEngine falls to web_speech when whisper is down but web speech works', () => {
  assert.equal(resolveSttEngine({ sttChain: CHAIN, whisperReachable: false, webSpeechAvailable: true }), 'web_speech')
})

test('resolveSttEngine returns none when neither engine is usable (→ typing only)', () => {
  // e.g. Brave with no local whisper: web speech is blocked, bridge not running.
  assert.equal(resolveSttEngine({ sttChain: CHAIN, whisperReachable: false, webSpeechAvailable: false }), 'none')
})

test('resolveSttEngine honours chain ORDER — web_speech first still uses it when whisper is also up', () => {
  const webFirst = [{ engine: 'web_speech', mode: 'provider' }, { engine: 'whisper_cpp', mode: 'local' }]
  assert.equal(resolveSttEngine({ sttChain: webFirst, whisperReachable: true, webSpeechAvailable: true }), 'web_speech')
})

test('resolveSttEngine falls through to a reachable engine not named in the chain', () => {
  assert.equal(resolveSttEngine({ sttChain: [], whisperReachable: true, webSpeechAvailable: false }), 'whisper')
  assert.equal(resolveSttEngine({ sttChain: [], whisperReachable: false, webSpeechAvailable: true }), 'web_speech')
})

test('sttEngineLabel is colorblind-safe (icon + text) for each choice', () => {
  assert.match(sttEngineLabel('whisper'), /Whisper/)
  assert.match(sttEngineLabel('web_speech'), /Browser/)
  assert.match(sttEngineLabel('none'), /Type/)
})
