// Arturita J1 — pure Assistant-tab logic tests. Node 22 built-in runner +
// type-stripping (see web/package.json `test`), no test-runner dep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  orbVisual, resolveVoiceState, toConverseRequest, toArturitaMessage,
  revealNext, isRevealComplete, revealStepFor, routingBadge,
  rejectAttachment, attachmentChipLabel, canSendTurn, formatFileSize,
  ATTACH_EXTS, ATTACH_ACCEPT, ATTACH_MAX_BYTES,
  rejectImage, imageChipLabel, imageMediaType, IMAGE_EXTS, IMAGE_ACCEPT, IMAGE_MAX_BYTES,
  resolveJiraProjectSelection, jiraProjectLabel,
  type Message, type ConverseResponse,
} from './assistant.logic.ts'

// ─── Orb state machine ───────────────────────────────────────────────────────

test('[J1] every voice state has a colorblind-safe orb descriptor (icon + label + motion)', () => {
  for (const s of ['idle', 'listening', 'thinking', 'speaking'] as const) {
    const v = orbVisual(s)
    assert.equal(v.state, s)
    assert.ok(v.icon.length > 0, `${s} has an icon`)
    assert.ok(v.label.length > 0, `${s} has a label`)
    assert.ok(v.motion.length > 0, `${s} has a motion`)
    assert.match(v.colorVar, /^var\(--/)
  }
})

test('[J1] orb states are visually distinct (no two share icon+motion — not color-only)', () => {
  const keys = (['idle', 'listening', 'thinking', 'speaking'] as const).map(s => {
    const v = orbVisual(s); return `${v.icon}|${v.motion}`
  })
  assert.equal(new Set(keys).size, 4)
})

test('[J1] unknown state falls back to idle', () => {
  // @ts-expect-error — exercise the fallback
  assert.equal(orbVisual('nope').state, 'idle')
})

test('[J1] resolveVoiceState precedence: speaking > thinking > listening > idle', () => {
  assert.equal(resolveVoiceState({ speaking: true, thinking: true, listening: true }), 'speaking')
  assert.equal(resolveVoiceState({ thinking: true, listening: true }), 'thinking')
  assert.equal(resolveVoiceState({ listening: true }), 'listening')
  assert.equal(resolveVoiceState({}), 'idle')
})

// ─── Request builder ─────────────────────────────────────────────────────────

test('[J1] toConverseRequest trims, carries the flag/thread, maps + caps history', () => {
  const history: Message[] = Array.from({ length: 14 }, (_, i) => ({
    id: String(i), role: i % 2 === 0 ? 'user' : 'arturita', text: `m${i}`,
  }))
  const req = toConverseRequest({ message: '  hello  ', explicitDelegate: true, existingThreadId: 't1', history, historyLimit: 6 })
  assert.equal(req.message, 'hello')
  assert.equal(req.explicitDelegate, true)
  assert.equal(req.existingThreadId, 't1')
  assert.equal(req.history.length, 6)
  // arturita → assistant role mapping
  assert.ok(req.history.every(h => h.role === 'user' || h.role === 'assistant'))
})

test('[J1] toConverseRequest drops empty-text turns from history', () => {
  const history: Message[] = [
    { id: '1', role: 'user', text: 'real' },
    { id: '2', role: 'arturita', text: '   ' },
  ]
  const req = toConverseRequest({ message: 'x', history })
  assert.equal(req.history.length, 1)
  assert.equal(req.history[0].content, 'real')
})

// ─── Response → message ──────────────────────────────────────────────────────

test('[J1] toArturitaMessage carries mode + routing + taskId and starts streaming', () => {
  const resp: ConverseResponse = {
    mode: 'delegate', taskId: 'task-9',
    routing: { trigger: 'build_order', reason: 'build order', destructive: false, workMode: 'execute' },
    reply: { text: 'On it.' },
  }
  const m = toArturitaMessage({ id: 'a1', resp })
  assert.equal(m.role, 'arturita')
  assert.equal(m.text, 'On it.')
  assert.equal(m.mode, 'delegate')
  assert.equal(m.taskId, 'task-9')
  assert.equal(m.streaming, true)
})

test('[J1] toArturitaMessage never throws on an empty reply', () => {
  const m = toArturitaMessage({ id: 'a2', resp: {} })
  assert.ok(m.text.length > 0)
  assert.equal(m.mode, 'answer')
})

// ─── Streaming reveal ────────────────────────────────────────────────────────

test('[J1] revealNext advances by step and clamps to total', () => {
  assert.equal(revealNext(0, 10, 3), 3)
  assert.equal(revealNext(8, 10, 3), 10)
  assert.equal(revealNext(0, 10, 0), 0)     // no step → no movement
  assert.equal(revealNext(-5, 10, 3), 3)    // negative shown floored at 0
})

test('[J1] isRevealComplete true once shown reaches total', () => {
  assert.equal(isRevealComplete(9, 10), false)
  assert.equal(isRevealComplete(10, 10), true)
  assert.equal(isRevealComplete(11, 10), true)
})

test('[J1] revealStepFor scales with length and is always >= 2', () => {
  assert.ok(revealStepFor(10) >= 2)
  assert.ok(revealStepFor(4000) > revealStepFor(40))
})

// ─── Routing badge ───────────────────────────────────────────────────────────

test('[J1] routingBadge distinguishes answer / delegate / approval (icon + label)', () => {
  assert.equal(routingBadge({ mode: 'answer' }).tone, 'answer')
  assert.equal(routingBadge({ mode: 'delegate', routing: { trigger: 'x', reason: 'y' } }).tone, 'delegate')
  assert.equal(routingBadge({ mode: 'delegate', routing: { trigger: 'x', reason: 'y', destructive: true } }).tone, 'approval')
  for (const m of [{ mode: 'answer' as const }, { mode: 'delegate' as const, routing: { trigger: 'x', reason: 'y' } }]) {
    const b = routingBadge(m)
    assert.ok(b.icon.length > 0 && b.label.length > 0)
  }
})

// ─── Attachments (CC-ATT) ────────────────────────────────────────────────────
// The composer's guard rails. These are a COURTESY check (the server re-enforces
// type, size and length) — their job is to fail instantly in the composer rather
// than after a 10 MB upload, so the messages must name the fix.

test('[CC-ATT] rejectAttachment accepts every type the backend parser reads', () => {
  for (const ext of ATTACH_EXTS) {
    assert.equal(rejectAttachment({ name: `doc.${ext}`, size: 1000 }), null, `${ext} should attach`)
  }
})

test('[CC-ATT] rejectAttachment names the readable types on an unsupported file', () => {
  const r = rejectAttachment({ name: 'clip.mp4', size: 1000 })
  assert.match(r!, /\.mp4/)
  assert.match(r!, /pdf/)          // tells the operator what WOULD work
})

test('[CC-ATT] rejectAttachment states the real limit on an oversized file', () => {
  const r = rejectAttachment({ name: 'big.pdf', size: ATTACH_MAX_BYTES + 1 })
  assert.match(r!, /10\.0 MB/)
  assert.equal(rejectAttachment({ name: 'big.pdf', size: ATTACH_MAX_BYTES }), null, 'the boundary is inclusive')
  assert.match(rejectAttachment({ name: 'empty.txt', size: 0 })!, /empty/)
})

test('[CC-ATT] rejectAttachment ignores extension case', () => {
  assert.equal(rejectAttachment({ name: 'Report.FINAL.PDF', size: 10 }), null)
})

test('[CC-ATT] the accept list is a real file-dialog filter', () => {
  assert.match(ATTACH_ACCEPT, /\.pdf/)
  assert.match(ATTACH_ACCEPT, /\.docx/)
  assert.ok(!ATTACH_ACCEPT.includes(' '))
})

test('[CC-ATT] the chip reads name · size, and says when text was truncated', () => {
  assert.equal(attachmentChipLabel({ name: 'Q3.pdf', size: 2048 }), 'Q3.pdf · 2 KB')
  assert.match(attachmentChipLabel({ name: 'big.pdf', size: 5 * 1024 * 1024, truncated: true }), /5\.0 MB · truncated/)
  assert.equal(formatFileSize(512), '512 B')
})

test('[CC-ATT] canSendTurn: text alone, or a fully-extracted document alone', () => {
  assert.equal(canSendTurn({ typed: 'hi' }), true)
  assert.equal(canSendTurn({ typed: '   ' }), false)
  // a document still being parsed has no text yet → cannot send
  assert.equal(canSendTurn({ typed: '', attachment: { name: 'a.pdf', size: 10 } }), false)
  assert.equal(canSendTurn({ typed: '', attachment: { name: 'a.pdf', size: 10, text: 'body' } }), true)
  // busy (thinking / still reading) blocks the send either way
  assert.equal(canSendTurn({ typed: 'hi', busy: true }), false)
})

test('[CC-ATT] toConverseRequest carries an extracted attachment, and only then', () => {
  const base = { message: 'read this', history: [] }
  assert.equal(toConverseRequest(base).attachment, undefined)
  // a picked-but-unparsed doc must not be sent as an empty block
  assert.equal(toConverseRequest({ ...base, attachment: { name: 'a.pdf', size: 9 } }).attachment, undefined)
  assert.equal(toConverseRequest({ ...base, attachment: { name: 'a.pdf', size: 9, text: '   ' } }).attachment, undefined)

  const withDoc = toConverseRequest({ ...base, attachment: { name: 'Q3.pdf', size: 9, text: 'revenue 4M', truncated: true } })
  assert.deepEqual(withDoc.attachment, { name: 'Q3.pdf', text: 'revenue 4M', truncated: true })
  // the existing contract is untouched
  assert.equal(withDoc.message, 'read this')
  assert.equal(withDoc.explicitDelegate, false)
})

// ─── Photos (MOB-7b) ─────────────────────────────────────────────────────────
// A photo rides the /converse call itself as base64 and reaches the model as a
// real image block — there is no extract round-trip, because there is no text to
// extract. Same courtesy-check contract as the document gate above: fail in the
// composer, with the fix named, rather than after the upload.

test('[MOB-7b] rejectImage accepts every format the vision providers read', () => {
  for (const ext of IMAGE_EXTS) {
    assert.equal(rejectImage({ name: `snap.${ext}`, size: 1000 }), null, `${ext} should attach`)
  }
})

test('[MOB-7b] rejectImage names the formats on an unsupported file', () => {
  const r = rejectImage({ name: 'scan.tiff', size: 1000 })
  assert.match(r!, /\.tiff/)
  assert.match(r!, /jpg|jpeg/)          // tells the operator what WOULD work
})

test('[MOB-7b] rejectImage gives HEIC — the iPhone default — the actual fix', () => {
  // The most likely rejection in production: a photo dragged out of Photos on a
  // Mac is HEIC. "Unsupported" alone would read as "photos don't work".
  const r = rejectImage({ name: 'IMG_0042.heic', size: 1000 })
  assert.match(r!, /JPEG/i)
})

test('[MOB-7b] rejectImage states the real limit, and the boundary is inclusive', () => {
  assert.equal(rejectImage({ name: 'big.jpg', size: IMAGE_MAX_BYTES }), null, 'the boundary is inclusive')
  const r = rejectImage({ name: 'big.jpg', size: IMAGE_MAX_BYTES + 1 })
  assert.match(r!, /3\.8 MB/)
  assert.match(rejectImage({ name: 'empty.png', size: 0 })!, /empty/)
})

test('[MOB-7b] the image limit stays under the provider’s base64 ceiling', () => {
  // Mirrors the backend's reasoning: base64 inflates by 4/3 and Anthropic caps an
  // encoded image at 5 MB. Rounding this up to a friendlier 5 MB would make every
  // large photo fail at the provider instead of in the composer.
  assert.ok(IMAGE_MAX_BYTES * (4 / 3) <= 5 * 1024 * 1024)
})

test('[MOB-7b] imageMediaType trusts the browser, falls back to the extension', () => {
  assert.equal(imageMediaType({ name: 'a.png', type: 'image/png' }), 'image/png')
  // some browsers leave `type` blank on a drag-drop
  assert.equal(imageMediaType({ name: 'a.png', type: '' }), 'image/png')
  assert.equal(imageMediaType({ name: 'a.jpg' }), 'image/jpeg')
  // `image/jpg` is not a real media type — normalise it, or the server 415s a
  // perfectly good JPEG.
  assert.equal(imageMediaType({ name: 'a.jpg', type: 'image/jpg' }), 'image/jpeg')
})

test('[MOB-7b] canSendTurn: a fully-read photo alone is a valid turn', () => {
  const img = { name: 'p.jpg', size: 10, mediaType: 'image/jpeg' }
  // a photo still being read has no bytes yet → cannot send
  assert.equal(canSendTurn({ typed: '', image: img }), false)
  assert.equal(canSendTurn({ typed: '', image: { ...img, data: 'QUJD' } }), true)
  assert.equal(canSendTurn({ typed: '', image: { ...img, data: 'QUJD' }, busy: true }), false)
  // the document gate is untouched
  assert.equal(canSendTurn({ typed: '', attachment: { name: 'a.pdf', size: 1, text: 'b' } }), true)
  assert.equal(canSendTurn({ typed: '' }), false)
})

test('[MOB-7b] toConverseRequest carries a read photo, and only then', () => {
  const base = { message: 'what is this?', history: [] }
  assert.equal(toConverseRequest(base).image, undefined)
  // a picked-but-unread photo must not be sent as an empty block
  assert.equal(toConverseRequest({ ...base, image: { name: 'p.jpg', size: 9, mediaType: 'image/jpeg' } }).image, undefined)

  const withImg = toConverseRequest({ ...base, image: { name: 'p.jpg', size: 9, mediaType: 'image/jpeg', data: 'QUJD' } })
  assert.deepEqual(withImg.image, { name: 'p.jpg', mediaType: 'image/jpeg', data: 'QUJD' })
  // the existing contract is untouched
  assert.equal(withImg.message, 'what is this?')
  assert.equal(withImg.attachment, undefined)
})

test('[MOB-7b] a document and a photo can ride the same turn', () => {
  const r = toConverseRequest({
    message: 'compare these', history: [],
    attachment: { name: 'a.pdf', size: 1, text: 'spec' },
    image: { name: 'p.jpg', size: 9, mediaType: 'image/jpeg', data: 'QUJD' },
  })
  assert.ok(r.attachment && r.image, 'the two attach paths are independent, not exclusive')
})

test('[GC-3] resolveJiraProjectSelection prefers saved, then default, then first', () => {
  const projects = [
    { id: '1', key: 'MCA', name: 'Mission Control' },
    { id: '2', key: 'OS', name: '7Ei OS' },
  ]
  assert.equal(resolveJiraProjectSelection(projects, 'OS', 'MCA'), 'OS')
  assert.equal(resolveJiraProjectSelection(projects, 'GONE', 'MCA'), 'MCA')
  assert.equal(resolveJiraProjectSelection(projects, null, null), 'MCA')
})
