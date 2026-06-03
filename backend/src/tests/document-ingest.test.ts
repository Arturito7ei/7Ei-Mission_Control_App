import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractText, fileExtension, summaryInstruction, MAX_SUMMARY_INPUT_CHARS } from '../services/document-ingest.ts'

describe('document-ingest', () => {
  it('fileExtension lowercases and takes the last segment', () => {
    assert.equal(fileExtension('Report.FINAL.PDF'), 'pdf')
    assert.equal(fileExtension('notes.md'), 'md')
    assert.equal(fileExtension('noext'), 'noext')
  })

  it('extractText reads plain text + markdown directly (no parser)', async () => {
    const md = '# Mission\n\nBuild the best AI org platform.'
    assert.equal(await extractText(Buffer.from(md, 'utf-8'), 'mission.md'), md)
    const txt = 'plain culture notes'
    assert.equal(await extractText(Buffer.from(txt, 'utf-8'), 'culture.txt'), txt)
  })

  it('summaryInstruction reflects the target label and demands Markdown-only', () => {
    const mission = summaryInstruction('mission')
    assert.match(mission, /Mission & Vision/)
    assert.match(mission, /Markdown/)
    assert.match(mission, /ONLY/)
    // Unknown target falls back to generic label
    assert.match(summaryInstruction('whatever'), /reference knowledge/)
  })

  it('has a sane summarisation input budget', () => {
    assert.ok(MAX_SUMMARY_INPUT_CHARS >= 10_000)
  })
})
