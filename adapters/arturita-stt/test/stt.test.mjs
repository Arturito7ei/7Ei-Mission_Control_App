import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMultipart, boundaryOf } from '../src/multipart.mjs'
import { extForMime, buildWhisperArgs, cleanTranscript } from '../src/transcribe.mjs'
import { allowOrigin } from '../src/server.mjs'

// ─── boundaryOf / parseMultipart ─────────────────────────────────────────────

test('boundaryOf pulls the token from a Content-Type header (quoted or bare)', () => {
  assert.equal(boundaryOf('multipart/form-data; boundary=----abc123'), '----abc123')
  assert.equal(boundaryOf('multipart/form-data; boundary="x Y z"'), 'x Y z')
  assert.equal(boundaryOf('application/json'), '')
})

function buildBody(boundary, parts) {
  // parts: [{ headers, body: Buffer|string }]
  const segs = []
  for (const p of parts) {
    segs.push(Buffer.from(`--${boundary}\r\n${p.headers}\r\n\r\n`))
    segs.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body))
    segs.push(Buffer.from('\r\n'))
  }
  segs.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(segs)
}

test('parseMultipart extracts a binary file part + a text field', () => {
  const boundary = '----7eiBoundary'
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x0d, 0x0a, 0x99]) // includes CRLF bytes
  const body = buildBody(boundary, [
    { headers: 'Content-Disposition: form-data; name="language"', body: 'en' },
    { headers: 'Content-Disposition: form-data; name="file"; filename="clip.webm"\r\nContent-Type: audio/webm', body: audio },
  ])
  const { fields, files } = parseMultipart(body, `multipart/form-data; boundary=${boundary}`)
  assert.equal(fields.language, 'en')
  assert.equal(files.length, 1)
  assert.equal(files[0].name, 'file')
  assert.equal(files[0].filename, 'clip.webm')
  assert.equal(files[0].contentType, 'audio/webm')
  assert.ok(files[0].data.equals(audio), 'binary payload round-trips byte-for-byte (incl. embedded CRLF)')
})

test('parseMultipart throws without a boundary', () => {
  assert.throws(() => parseMultipart(Buffer.from('x'), 'application/json'), /boundary/)
})

// ─── transcribe pure helpers ─────────────────────────────────────────────────

test('extForMime maps MediaRecorder mime types to a friendly extension', () => {
  assert.equal(extForMime('audio/webm;codecs=opus'), 'webm')
  assert.equal(extForMime('audio/ogg'), 'ogg')
  assert.equal(extForMime('audio/mp4'), 'm4a')
  assert.equal(extForMime('audio/wav'), 'wav')
  assert.equal(extForMime(undefined), 'webm') // sensible default
})

test('buildWhisperArgs emits txt output + no-fp16 and honours language auto', () => {
  const a = buildWhisperArgs({ audioPath: '/tmp/a/clip.webm', outDir: '/tmp/a', model: 'small', language: 'en' })
  assert.ok(a.includes('--output_format') && a[a.indexOf('--output_format') + 1] === 'txt')
  assert.ok(a.includes('--model') && a[a.indexOf('--model') + 1] === 'small')
  assert.deepEqual([a[a.indexOf('--fp16') + 1]], ['False'])
  assert.ok(a.includes('--language') && a[a.indexOf('--language') + 1] === 'en')
  const auto = buildWhisperArgs({ audioPath: '/tmp/a/clip.webm', outDir: '/tmp/a', language: 'auto' })
  assert.ok(!auto.includes('--language'), 'auto omits the language flag (auto-detect)')
})

test('cleanTranscript collapses whitespace/newlines to one trimmed line', () => {
  assert.equal(cleanTranscript('  Hello   there.\n\n Arturita  \n'), 'Hello there. Arturita')
  assert.equal(cleanTranscript(''), '')
})

// ─── CORS allowlist ──────────────────────────────────────────────────────────

test('allowOrigin: "*" echoes any origin; an allowlist only matches exactly', () => {
  assert.equal(allowOrigin('https://app.7ei.ai', ['*']), 'https://app.7ei.ai')
  assert.equal(allowOrigin(undefined, ['*']), '*')
  assert.equal(allowOrigin('https://app.7ei.ai', ['https://app.7ei.ai']), 'https://app.7ei.ai')
  assert.equal(allowOrigin('https://evil.example', ['https://app.7ei.ai']), null)
  assert.equal(allowOrigin('http://localhost:3000', ['https://app.7ei.ai', 'http://localhost:3000']), 'http://localhost:3000')
})
