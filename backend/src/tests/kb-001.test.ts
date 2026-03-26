import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../routes/all.ts'

describe('[KB-001] chunkText', () => {
  it('returns single chunk when text is shorter than wordsPerChunk', () => {
    const chunks = chunkText('hello world', 500, 50)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0], 'hello world')
  })

  it('returns [text] when input is empty-ish', () => {
    const chunks = chunkText('one', 500, 50)
    assert.equal(chunks.length, 1)
  })

  it('chunks 1000-word text into 3 chunks with 500-word chunks and 50-word overlap', () => {
    // step = 500 - 50 = 450
    // i=0 → words[0..499], i=450 → words[450..949], i=900 → words[900..999], break
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`)
    const text = words.join(' ')
    const chunks = chunkText(text, 500, 50)
    assert.equal(chunks.length, 3)
  })

  it('overlap means second chunk starts before end of first chunk', () => {
    const words = Array.from({ length: 600 }, (_, i) => `w${i}`)
    const text = words.join(' ')
    const chunks = chunkText(text, 500, 50)
    // Second chunk starts at index 450 (500 - 50)
    // So word450 should be in both first and second chunk
    assert.ok(chunks[0].includes('w449'))  // last area of first chunk
    assert.ok(chunks[1].includes('w450'))  // start area of second chunk (overlap)
  })

  it('each chunk contains approximately wordsPerChunk words', () => {
    const words = Array.from({ length: 1500 }, (_, i) => `w${i}`)
    const text = words.join(' ')
    const chunks = chunkText(text, 500, 50)
    for (const chunk of chunks) {
      const wordCount = chunk.split(/\s+/).length
      assert.ok(wordCount <= 500, `chunk has ${wordCount} words, expected <= 500`)
    }
  })

  it('handles exact multiple of step size', () => {
    // 900 words, step=450 (500-50), chunk1: 0-499, chunk2: 450-899
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`)
    const chunks = chunkText(words.join(' '), 500, 50)
    assert.ok(chunks.length >= 2)
  })

  it('returns at least one chunk for non-empty text', () => {
    const chunks = chunkText('just one word', 500, 50)
    assert.ok(chunks.length >= 1)
  })
})
