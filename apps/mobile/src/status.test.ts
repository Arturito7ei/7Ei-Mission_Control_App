// MOB-6b — status.ts is a PORT of web/app/dashboard/status.ts, so the thing
// worth testing is that it stays one. These tests import BOTH modules and assert
// they collapse the same synonyms onto the same rows and pick the same glyphs,
// exactly as navModel.test.ts and attach.test.ts do for their mirrors.
//
// The failure this prevents: someone teaches the web a new status synonym (a new
// run state, a Jira vocabulary word), and the phone quietly files it under
// 'idle' — a ○ where the desk shows ✕. The operator reads "nothing happening"
// off a failed run. Typechecking cannot see that; only comparing the two tables
// can.
//
// The web's statusColor() is deliberately NOT compared: it returns CSS var()
// strings, which is the one part of the table that cannot cross into
// react-native. The glyph is what the colorblind rule actually rests on, and the
// glyph is compared.
//
// Zero-dep: `npm test` → node --test --experimental-strip-types. The web module
// is pure (no React), which is what makes it loadable outside Metro at all.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HEARTBEAT_STATUS as WEB_HEARTBEAT,
  canonicalStatus as webCanonical,
  statusIcon as webIcon,
} from '../../../web/app/dashboard/status.ts'
import {
  HEARTBEAT_STATUS,
  canonicalStatus,
  heartbeatStatus,
  statusIcon,
  statusTone,
} from './status.ts'

/** Every canonical row, every synonym the web knows, and the junk cases. */
const STATUSES = [
  // canonical rows
  'active', 'idle', 'pending', 'done', 'paused', 'blocked', 'failed', 'info',
  // the web's ALIAS table
  'in_progress', 'running', 'todo', 'assigned', 'to do',
  'stopped', 'terminated', 'error', 'stale', 'orphaned',
  'review', 'in review', 'attention',
  // real vocabularies these screens actually see
  'ACTIVE', 'Done', 'In_Progress',
  // junk / absent
  'nonsense', '', null, undefined,
]

test('every status collapses onto the same row as the web', () => {
  for (const s of STATUSES) {
    assert.equal(canonicalStatus(s), webCanonical(s), `canonicalisation drift on ${JSON.stringify(s)}`)
  }
})

test('every status carries the same glyph as the web', () => {
  // The glyph is the colorblind-safe signal — drift here is the operator reading
  // the wrong state, not a cosmetic difference.
  for (const s of STATUSES) {
    assert.equal(statusIcon(s), webIcon(s), `glyph drift on ${JSON.stringify(s)}`)
  }
})

test('heartbeats map onto the table exactly as the web maps them', () => {
  assert.deepEqual(HEARTBEAT_STATUS, WEB_HEARTBEAT)
  for (const h of ['green', 'amber', 'stale', 'unknown']) {
    assert.equal(heartbeatStatus(h), WEB_HEARTBEAT[h], `heartbeat drift on "${h}"`)
  }
  // An absent / unrecognised heartbeat is idle, not a crash.
  assert.equal(heartbeatStatus(null), 'idle')
  assert.equal(heartbeatStatus('bogus'), 'idle')
})

// ─── The colorblind rule (mobile-specific: our palette, the web's intent) ────

test('active is never green, and done never shares failed’s tone', () => {
  // DESIGN_SYSTEM v2: ACTIVE = purple, not green — green/red is the exact pair
  // the operator cannot distinguish. Our purple chip is 'delegate'.
  assert.equal(statusTone('active'), 'delegate')
  assert.equal(statusTone('running'), 'delegate')
  assert.notEqual(statusTone('done'), statusTone('failed'))
})

test('every canonical row has a tone and a glyph', () => {
  for (const s of STATUSES) {
    assert.ok(statusIcon(s), `no glyph for ${JSON.stringify(s)}`)
    assert.ok(statusTone(s), `no tone for ${JSON.stringify(s)}`)
  }
})
