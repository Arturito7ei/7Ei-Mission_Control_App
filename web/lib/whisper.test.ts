import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isWhisperEngine, whisperEndpoint, parseWhisperResponse, pickRecorderMimeType, WHISPER_DEFAULT_URL,
} from './whisper.ts'

test('isWhisperEngine recognizes the local whisper engine ids (case-insensitive)', () => {
  for (const e of ['whisper_cpp', 'faster_whisper', 'whisper', 'WHISPER_CPP']) assert.equal(isWhisperEngine(e), true)
  for (const e of ['web_speech', 'groq', '', null, undefined]) assert.equal(isWhisperEngine(e as any), false)
})

test('whisperEndpoint defaults to /inference and supports the OpenAI path', () => {
  assert.equal(whisperEndpoint('http://localhost:8790'), 'http://localhost:8790/inference')
  assert.equal(whisperEndpoint('http://localhost:8790/'), 'http://localhost:8790/inference') // trailing slash trimmed
  assert.equal(whisperEndpoint('http://localhost:8790', 'openai'), 'http://localhost:8790/v1/audio/transcriptions')
  assert.equal(whisperEndpoint(''), `${WHISPER_DEFAULT_URL}/inference`)
})

test('parseWhisperResponse handles { text }, plain string, segment arrays, and junk', () => {
  assert.equal(parseWhisperResponse({ text: '  hello there ' }), 'hello there')
  assert.equal(parseWhisperResponse('  raw  '), 'raw')
  assert.equal(parseWhisperResponse({ transcription: [{ text: 'a' }, { text: 'b' }] }), 'a b')
  assert.equal(parseWhisperResponse({ segments: ['x', { text: 'y' }] }), 'x y')
  assert.equal(parseWhisperResponse(null), '')
  assert.equal(parseWhisperResponse({ nope: 1 }), '')
})

test('pickRecorderMimeType prefers opus/webm and falls back to browser default', () => {
  assert.equal(pickRecorderMimeType(m => m === 'audio/webm;codecs=opus'), 'audio/webm;codecs=opus')
  assert.equal(pickRecorderMimeType(m => m === 'audio/mp4'), 'audio/mp4')       // Safari-ish
  assert.equal(pickRecorderMimeType(() => false), '')                            // none explicitly supported
})
