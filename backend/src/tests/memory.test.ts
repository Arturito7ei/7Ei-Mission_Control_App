import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractMemoryInstructions, formatMemoryForPrompt } from '../services/memory.ts'

describe('extractMemoryInstructions', () => {
  it('extracts a single REMEMBER tag', () => {
    const output = 'Here is my answer. [REMEMBER: user_name = Alice]'
    const { toSave, cleanedOutput } = extractMemoryInstructions(output)
    assert.equal(toSave['user_name'], 'Alice')
    assert.ok(!cleanedOutput.includes('[REMEMBER:'))
    assert.ok(cleanedOutput.includes('Here is my answer.'))
  })

  it('extracts multiple REMEMBER tags', () => {
    const output = '[REMEMBER: lang = Spanish] Hello! [REMEMBER: timezone = CET]'
    const { toSave } = extractMemoryInstructions(output)
    assert.equal(toSave['lang'], 'Spanish')
    assert.equal(toSave['timezone'], 'CET')
  })

  it('strips tags from output', () => {
    const output = 'Answer text [REMEMBER: key = value] more text'
    const { cleanedOutput } = extractMemoryInstructions(output)
    assert.ok(!cleanedOutput.includes('[REMEMBER:'))
    assert.ok(cleanedOutput.includes('Answer text'))
    assert.ok(cleanedOutput.includes('more text'))
  })

  it('handles output with no tags', () => {
    const output = 'Just a normal response with no memory tags.'
    const { toSave, cleanedOutput } = extractMemoryInstructions(output)
    assert.deepEqual(toSave, {})
    assert.equal(cleanedOutput, output)
  })

  it('is case-insensitive for REMEMBER keyword', () => {
    const output = '[remember: key = val]'
    const { toSave } = extractMemoryInstructions(output)
    assert.equal(toSave['key'], 'val')
  })

  it('handles values with special characters', () => {
    const output = '[REMEMBER: preferred_model = claude-sonnet-4-20250514]'
    const { toSave } = extractMemoryInstructions(output)
    assert.equal(toSave['preferred_model'], 'claude-sonnet-4-20250514')
  })
})

describe('formatMemoryForPrompt', () => {
  it('returns empty string for empty memory', () => {
    const result = formatMemoryForPrompt({})
    assert.equal(result, '')
  })

  it('formats entries correctly', () => {
    const now = new Date().toISOString()
    const memory = {
      user_name: { key: 'user_name', value: 'Alice', createdAt: now, updatedAt: now },
      lang:      { key: 'lang',      value: 'French', createdAt: now, updatedAt: now },
    }
    const result = formatMemoryForPrompt(memory)
    assert.ok(result.includes('user_name: Alice'))
    assert.ok(result.includes('lang: French'))
    assert.ok(result.includes('Long-term memory'))
  })

  it('includes all entries', () => {
    const now = new Date().toISOString()
    const memory = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `key_${i}`, { key: `key_${i}`, value: `val_${i}`, createdAt: now, updatedAt: now },
      ])
    )
    const result = formatMemoryForPrompt(memory)
    for (let i = 0; i < 5; i++) {
      assert.ok(result.includes(`key_${i}: val_${i}`))
    }
  })
})
