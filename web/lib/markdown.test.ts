import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, parseMarkdown } from './markdown.ts'

test('[AG3] headings, levels 1–3', () => {
  const b = parseMarkdown('# One\n## Two\n### Three\n#### NotAHeading')
  assert.deepEqual(b.slice(0, 3).map(x => (x as any).level), [1, 2, 3])
  assert.equal(b[3].kind, 'paragraph') // #### is out of scope → plain text
})

test('[AG3] bullet and numbered lists group consecutive items', () => {
  const b = parseMarkdown('- a\n- b\n\n1. x\n2. y')
  assert.equal(b[0].kind, 'list')
  assert.equal((b[0] as any).ordered, false)
  assert.equal((b[0] as any).items.length, 2)
  assert.equal((b[1] as any).ordered, true)
  assert.equal((b[1] as any).items.length, 2)
})

test('[AG3] fenced code is verbatim — markdown inside it is not parsed', () => {
  const b = parseMarkdown('```ts\n# not a heading\nconst a = 1\n```')
  assert.equal(b.length, 1)
  assert.equal(b[0].kind, 'code')
  assert.equal((b[0] as any).lang, 'ts')
  assert.equal((b[0] as any).text, '# not a heading\nconst a = 1')
})

test('[AG3] an unterminated code fence still closes at EOF', () => {
  const b = parseMarkdown('```\nopen forever')
  assert.equal(b[0].kind, 'code')
  assert.equal((b[0] as any).text, 'open forever')
})

test('[AG3] blockquotes and horizontal rules', () => {
  const b = parseMarkdown('> quoted\n> more\n\n---')
  assert.equal(b[0].kind, 'quote')
  assert.equal(b[1].kind, 'rule')
})

test('[AG3] paragraphs join wrapped lines and stop at the next block', () => {
  const b = parseMarkdown('line one\nline two\n# heading')
  assert.equal(b[0].kind, 'paragraph')
  assert.deepEqual((b[0] as any).spans, [{ kind: 'text', text: 'line one line two' }])
  assert.equal(b[1].kind, 'heading')
})

test('[AG3] inline code and bold', () => {
  assert.deepEqual(parseInline('use `npm test` now'), [
    { kind: 'text', text: 'use ' }, { kind: 'code', text: 'npm test' }, { kind: 'text', text: ' now' },
  ])
  assert.deepEqual(parseInline('**bold** tail'), [
    { kind: 'strong', text: 'bold' }, { kind: 'text', text: ' tail' },
  ])
})

test('[AG3] markup is data, never HTML — angle brackets stay literal text', () => {
  const b = parseMarkdown('<img src=x onerror=alert(1)>')
  assert.equal(b[0].kind, 'paragraph')
  assert.deepEqual((b[0] as any).spans, [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
})

test('[AG3] empty input yields no blocks', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n\n  \n'), [])
})
