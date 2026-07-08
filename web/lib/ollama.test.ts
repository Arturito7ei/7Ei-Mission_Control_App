// Arturita J-prod — pure Ollama-client logic tests. Node 22 runner + type-stripping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOllamaMessages, parseOllamaChatLine, DEFAULT_OLLAMA_URL, type ChatMsg } from './ollama.ts'

test('[Jp] buildOllamaMessages prepends the system prompt', () => {
  const msgs: ChatMsg[] = [{ role: 'user', content: 'hi' }]
  const out = buildOllamaMessages('you are Arturita', msgs)
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, 'you are Arturita')
  assert.equal(out[1].content, 'hi')
})

test('[Jp] buildOllamaMessages omits an empty system prompt', () => {
  const out = buildOllamaMessages('   ', [{ role: 'user', content: 'hi' }])
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'user')
})

test('[Jp] parseOllamaChatLine extracts message.content tokens', () => {
  const p = parseOllamaChatLine(JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }))
  assert.equal(p.token, 'Hello')
  assert.equal(p.done, false)
})

test('[Jp] parseOllamaChatLine flags done + handles the final empty chunk', () => {
  const p = parseOllamaChatLine(JSON.stringify({ message: { content: '' }, done: true }))
  assert.equal(p.token, '')
  assert.equal(p.done, true)
})

test('[Jp] parseOllamaChatLine also accepts the /api/generate "response" shape', () => {
  const p = parseOllamaChatLine(JSON.stringify({ response: 'world', done: false }))
  assert.equal(p.token, 'world')
})

test('[Jp] parseOllamaChatLine never throws on blank / garbage', () => {
  assert.deepEqual(parseOllamaChatLine(''), { token: '', done: false })
  assert.deepEqual(parseOllamaChatLine('not json'), { token: '', done: false })
  assert.deepEqual(parseOllamaChatLine('  {bad'), { token: '', done: false })
})

test('[Jp] default url is localhost:11434', () => {
  assert.equal(DEFAULT_OLLAMA_URL, 'http://localhost:11434')
})
