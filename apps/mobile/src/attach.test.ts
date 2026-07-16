// CC-ATT (mobile) — the attach logic is a MIRROR of the web's, so the thing
// worth testing is that it stays one. These tests import BOTH modules and assert
// they decide the same way, exactly as navModel.test.ts does for the nav model.
//
// The failure this prevents is silent drift: someone raises the size limit or
// teaches the backend a new file type on the web, and the phone quietly keeps
// refusing files the office can read — or worse, waves through a file the server
// then rejects with different wording. Typechecking can't see that; only
// comparing the two lists can.
//
// Zero-dep: run with `npm test` → node --test --experimental-strip-types. Both
// modules are pure (no React, no react-native), which is what makes the web one
// loadable outside Metro at all.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ATTACH_EXTS as WEB_EXTS,
  ATTACH_MAX_BYTES as WEB_MAX_BYTES,
  formatFileSize as webFormatFileSize,
  rejectAttachment as webReject,
  canSendTurn as webCanSend,
  toConverseRequest as webToConverseRequest,
} from '../../../web/app/dashboard/assistant.logic.ts'
import { CONVERSE_HISTORY_LIMIT } from './api.ts'
import {
  ATTACH_EXTS,
  ATTACH_MAX_BYTES,
  attachExtension,
  attachmentChipLabel,
  canSendTurn,
  formatFileSize,
  rejectAttachment,
  toConverseAttachment,
} from './attach.ts'

// ─── The mirror itself ───────────────────────────────────────────────────────

test('the readable types are exactly the web’s', () => {
  assert.deepEqual([...ATTACH_EXTS], [...WEB_EXTS])
})

test('the size limit is exactly the web’s', () => {
  assert.equal(ATTACH_MAX_BYTES, WEB_MAX_BYTES)
})

test('size wording matches the web, so one file reads one way on both clients', () => {
  for (const bytes of [0, 1, 512, 1023, 1024, 2048, 1024 * 1024, 10 * 1024 * 1024, 1536 * 1024]) {
    assert.equal(formatFileSize(bytes), webFormatFileSize(bytes), `size wording drift at ${bytes} B`)
  }
})

test('a rejected file is rejected identically on both clients', () => {
  const cases = [
    { name: 'notes.exe', size: 10 },
    { name: 'photo.heic', size: 10 },
    { name: 'empty.pdf', size: 0 },
    { name: 'huge.pdf', size: ATTACH_MAX_BYTES + 1 },
    { name: 'fine.pdf', size: 1024 },
    { name: 'FINE.PDF', size: 1024 },
  ]
  for (const c of cases) {
    assert.equal(rejectAttachment(c), webReject(c), `rejection drift on "${c.name}"`)
  }
})

test('the send gate matches the web', () => {
  const doc = { name: 'a.pdf', size: 10, text: 'hello' }
  const cases = [
    { typed: '', attachment: null, busy: false },
    { typed: 'hi', attachment: null, busy: false },
    { typed: '', attachment: doc, busy: false },
    { typed: 'hi', attachment: doc, busy: true },
    { typed: '   ', attachment: null, busy: false },
  ]
  for (const c of cases) {
    assert.equal(canSendTurn(c), webCanSend(c), `send-gate drift on ${JSON.stringify(c)}`)
  }
})

test('the phone remembers exactly as far back as the desk', () => {
  // The web's history depth is a DEFAULT inside toConverseRequest (`?? 10`), not
  // an exported constant, so pin it by behaviour: hand the web 25 turns and see
  // how many it keeps. The backend's zod .max(20) is the ceiling, not the
  // contract — the phone sent 20 until this was caught, so the same question
  // asked from two devices could get two different answers.
  const history = Array.from({ length: 25 }, (_, i) => ({
    id: `${i}`, role: (i % 2 ? 'arturita' : 'user') as 'user' | 'arturita', text: `turn ${i}`,
  }))
  const webDepth = webToConverseRequest({ message: 'hi', history }).history.length
  assert.equal(
    CONVERSE_HISTORY_LIMIT,
    webDepth,
    'converse history depth drifted from the web default',
  )
})

// ─── Mobile-specific behaviour (no web peer — the picker's unknown size) ─────

test('an unknown size skips the size gate but never the type gate', () => {
  // iOS's picker doesn't always report a size. Unknown means "let the server
  // decide", not "assume it's fine to parse anything".
  assert.equal(rejectAttachment({ name: 'report.pdf' }), null)
  assert.match(rejectAttachment({ name: 'movie.mov' }) ?? '', /can't read \.mov/)
})

test('an unknown size drops the size from the chip rather than inventing one', () => {
  assert.equal(attachmentChipLabel({ name: 'report.pdf' }), 'report.pdf')
  assert.equal(attachmentChipLabel({ name: 'report.pdf', size: 2048 }), 'report.pdf · 2 KB')
  assert.equal(
    attachmentChipLabel({ name: 'report.pdf', size: 2048, truncated: true }),
    'report.pdf · 2 KB · truncated',
  )
})

test('an unextracted document cannot be sent, and is not put on the wire', () => {
  // The chip appears on pick, before the text exists. Sending then would post an
  // attachment with no content — tokens spent on an empty block.
  const picked = { name: 'a.pdf', size: 10 }
  assert.equal(canSendTurn({ typed: '', attachment: picked }), false)
  assert.equal(toConverseAttachment(picked), undefined)
  assert.equal(toConverseAttachment({ ...picked, text: '   ' }), undefined)
  assert.deepEqual(toConverseAttachment({ ...picked, text: 'body' }), {
    name: 'a.pdf', text: 'body', truncated: false,
  })
})

test('extensions are read case-insensitively', () => {
  assert.equal(attachExtension('Report.PDF'), 'pdf')
  assert.equal(attachExtension('noext'), 'noext')
})
