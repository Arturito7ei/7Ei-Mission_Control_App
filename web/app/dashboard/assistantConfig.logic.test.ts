// Arturita J2 — pure Config-panel logic tests. Node 22 runner + type-stripping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRESETS, entryLabel, entryKey, moveEntry, removeAt, appendEntry, toggleMode,
  type Entry, type LlmEntry,
} from './assistantConfig.logic.ts'

test('[J2] presets are free-first (first entry of each layer is local)', () => {
  assert.equal(PRESETS.llm[0].mode, 'local')
  assert.equal(PRESETS.stt[0].mode, 'local')
  assert.equal(PRESETS.tts[0].mode, 'local')
  assert.equal((PRESETS.llm[0] as LlmEntry).provider, 'ollama')
})

test('[J2] entryLabel renders provider/model or engine·detail', () => {
  assert.equal(entryLabel('llm', { provider: 'ollama', model: 'llama3.2:3b', mode: 'local' }), 'ollama · llama3.2:3b')
  assert.equal(entryLabel('stt', { engine: 'whisper_cpp', model: 'small', mode: 'local' }), 'whisper_cpp · small')
  assert.equal(entryLabel('tts', { engine: 'speech_synth', mode: 'local' }), 'speech_synth')
})

test('[J2] moveEntry swaps neighbours and no-ops at the ends', () => {
  const a: number[] = [1, 2, 3]
  assert.deepEqual(moveEntry(a, 0, 1), [2, 1, 3])
  assert.deepEqual(moveEntry(a, 2, 1), [1, 2, 3])   // last down → no-op
  assert.deepEqual(moveEntry(a, 0, -1), [1, 2, 3])  // first up → no-op
  assert.deepEqual(a, [1, 2, 3])                    // original untouched (immutable)
})

test('[J2] removeAt drops the index immutably', () => {
  const a = ['x', 'y', 'z']
  assert.deepEqual(removeAt(a, 1), ['x', 'z'])
  assert.deepEqual(removeAt(a, 9), ['x', 'y', 'z'])
  assert.deepEqual(a, ['x', 'y', 'z'])
})

test('[J2] appendEntry adds new, dedups identical (label+mode)', () => {
  const arr: Entry[] = [{ provider: 'ollama', model: 'llama3.2:3b', mode: 'local' }]
  const added = appendEntry('llm', arr, { provider: 'groq', model: 'x', mode: 'provider' })
  assert.equal(added.length, 2)
  const dup = appendEntry('llm', added, { provider: 'ollama', model: 'llama3.2:3b', mode: 'local' })
  assert.equal(dup.length, 2)   // identical → not added
})

test('[J2] toggleMode flips local⇄provider immutably', () => {
  const e: Entry = { provider: 'ollama', model: 'x', mode: 'local' }
  const t = toggleMode(e)
  assert.equal(t.mode, 'provider')
  assert.equal(e.mode, 'local')
  assert.equal(toggleMode(t).mode, 'local')
})

test('[J2] entryKey distinguishes by label + mode', () => {
  assert.notEqual(
    entryKey('llm', { provider: 'ollama', model: 'a', mode: 'local' }),
    entryKey('llm', { provider: 'ollama', model: 'a', mode: 'provider' }),
  )
})
