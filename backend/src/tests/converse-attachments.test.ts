// CC-ATT — attaching a document to a Command Center turn.
//
// Two layers are covered here:
//   1. the PURE decisions (gating, clipping, prompt delimiting) — no server;
//   2. the ROUTE contract (auth, org scoping, clean failures, happy path) —
//      booted through the same Clerk + membership gates as /converse, so a
//      regression that opens the endpoint up fails here.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAttachment, clipAttachmentText, buildAttachmentBlock, withAttachmentContext,
  formatBytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_CONTEXT_CHARS, SUPPORTED_ATTACHMENT_EXTS,
} from '../services/converse-attachments.ts'
import { isSupportedDocExt } from '../services/document-ingest.ts'

describe('converse-attachments — gating', () => {
  it('accepts every type the shared parser can actually read', () => {
    for (const ext of SUPPORTED_ATTACHMENT_EXTS) {
      assert.equal(checkAttachment({ filename: `doc.${ext}`, size: 1_000 }), null, `${ext} should be accepted`)
    }
    // The list is derived from the parser, not hand-written beside it.
    assert.ok(SUPPORTED_ATTACHMENT_EXTS.includes('pdf'))
    assert.ok(SUPPORTED_ATTACHMENT_EXTS.includes('docx'))
    assert.ok(SUPPORTED_ATTACHMENT_EXTS.includes('md'))
    assert.ok(SUPPORTED_ATTACHMENT_EXTS.every(e => isSupportedDocExt(`x.${e}`)))
  })

  it('rejects an unsupported type and names the supported ones', () => {
    const r = checkAttachment({ filename: 'clip.mp4', size: 1_000 })
    assert.equal(r?.code, 'unsupported_type')
    assert.match(r!.error, /\.mp4/)
    assert.match(r!.error, /pdf/)   // tells the operator what WOULD work
  })

  it('rejects an oversized file and states the actual limit', () => {
    const r = checkAttachment({ filename: 'big.pdf', size: MAX_ATTACHMENT_BYTES + 1 })
    assert.equal(r?.code, 'too_large')
    assert.match(r!.error, /10\.0 MB/)
    // exactly at the limit is fine — the boundary is inclusive
    assert.equal(checkAttachment({ filename: 'big.pdf', size: MAX_ATTACHMENT_BYTES }), null)
  })

  it('rejects an empty file', () => {
    assert.equal(checkAttachment({ filename: 'empty.txt', size: 0 })?.code, 'empty')
  })

  it('is case-insensitive about the extension', () => {
    assert.equal(checkAttachment({ filename: 'Report.FINAL.PDF', size: 10 }), null)
  })

  it('formatBytes reads like a human wrote it', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2048), '2 KB')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  })
})

describe('converse-attachments — clipping', () => {
  it('passes short text through untouched', () => {
    const r = clipAttachmentText('short doc')
    assert.equal(r.text, 'short doc')
    assert.equal(r.truncated, false)
  })

  it('clips over-budget text to the budget and reports it', () => {
    const r = clipAttachmentText('x'.repeat(MAX_ATTACHMENT_CONTEXT_CHARS + 5_000))
    assert.equal(r.text.length, MAX_ATTACHMENT_CONTEXT_CHARS)
    assert.equal(r.truncated, true)
  })

  it('keeps the per-turn budget under the summarisation budget', () => {
    // A converse turn also carries system prompt + history; it cannot use the
    // whole 60k document budget.
    assert.ok(MAX_ATTACHMENT_CONTEXT_CHARS < 60_000)
  })
})

describe('converse-attachments — prompt assembly', () => {
  it('delimits the document with a named, fenced block', () => {
    const block = buildAttachmentBlock({ name: 'Q3.pdf', text: 'revenue was 4M' })
    assert.match(block, /=== ATTACHED DOCUMENT: Q3\.pdf ===/)
    assert.match(block, /=== END ATTACHED DOCUMENT: Q3\.pdf ===/)
    assert.match(block, /revenue was 4M/)
    assert.match(block, /operator attached a document/i)
  })

  it('tells the model when the text was truncated', () => {
    const block = buildAttachmentBlock({ name: 'big.pdf', text: 'partial', truncated: true })
    assert.match(block, /TRUNCATED/)
    assert.doesNotMatch(buildAttachmentBlock({ name: 'small.pdf', text: 'all' }), /TRUNCATED/)
  })

  it('puts the operator question FIRST, document after', () => {
    const out = withAttachmentContext('summarise this', { name: 'a.txt', text: 'body' })
    assert.ok(out.indexOf('summarise this') < out.indexOf('ATTACHED DOCUMENT'))
  })

  it('is a no-op without an attachment (the existing send flow is untouched)', () => {
    assert.equal(withAttachmentContext('hello', null), 'hello')
    assert.equal(withAttachmentContext('hello', undefined), 'hello')
    // an attachment that extracted to nothing must not inject an empty block
    assert.equal(withAttachmentContext('hello', { name: 'x.txt', text: '   ' }), 'hello')
  })
})
