// MOB-7a — the Inbox fold's tripwire.
//
// The segmented control is a hand-copy of the web's `navPageTabs('inbox')`, so
// this pins it to the web model. Two failures it exists to prevent:
//
//   1. The web adds/renames/reorders an Inbox tab and the phone silently keeps the
//      old bar — the two clients stop being one product.
//   2. A tab the phone CAN now render (Comms, when MOB-6i lands) stays out of the
//      control, so the fold quietly drifts back apart into separate destinations.
//
// Both web modules are dep-free under `node --test --experimental-strip-types`
// (navModel.ts is pure data), which is what lets this run with only apps/mobile's
// lockfile installed — the shape Mobile CI has.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { navPageTabs as webNavPageTabs } from '../../../web/lib/navModel.ts'
import { allNavItems, findNavItem } from './navModel.ts'
import {
  DEFAULT_INBOX_SEGMENT,
  INBOX_SEGMENTS,
  isInboxSegment,
  resolveInboxSegment,
} from './inboxSegments.ts'

const webTabs = webNavPageTabs('inbox')

test('[MOB-7a] the web still hosts Inbox as a tabbed section', () => {
  // The premise of the whole fold. If this goes, the segmented control is wrong.
  assert.ok(webTabs.length > 1, 'web navModel no longer gives Inbox a tab bar — the fold’s premise changed')
  assert.equal(webTabs[0]!.id, 'inbox', 'the web’s Inbox bar no longer leads with the section itself')
})

test('[MOB-7a] every segment is a real web Inbox tab, with the web’s label and order', () => {
  const webById = new Map(webTabs.map((t) => [t.id, t]))
  for (const seg of INBOX_SEGMENTS) {
    const peer = webById.get(seg.id)
    assert.ok(peer, `segment "${seg.id}" is not a tab on the web’s Inbox page`)
    assert.equal(seg.label, peer!.label, `label drift on segment "${seg.id}"`)
  }
  // Order is the web's: filtering may drop tabs, never reshuffle them.
  const webOrder = webTabs.map((t) => t.id).filter((id) => INBOX_SEGMENTS.some((s) => s.id === id))
  assert.deepEqual(INBOX_SEGMENTS.map((s) => s.id), webOrder)
})

test('[MOB-7a] the segments are exactly the web Inbox tabs the phone can render', () => {
  // THE fold tripwire. A web tab is a segment iff the phone has a ready screen for
  // it. When MOB-6i flips `comms` to 'ready', this fails until Comms joins the
  // control — which is the only thing stopping the fold drifting back apart.
  const renderable = webTabs
    .filter((t) => findNavItem(t.id)?.status === 'ready')
    .map((t) => t.id)
  assert.deepEqual(
    INBOX_SEGMENTS.map((s) => s.id),
    renderable,
    'the Inbox control does not match the web tabs this phone can render',
  )
})

test('[MOB-7a] Tasks lives inside the Inbox, not beside it', () => {
  // The fold itself: Tasks must be a segment, and the nav model must still record
  // that the web hosts it under Inbox.
  assert.ok(isInboxSegment('tasks'), 'Tasks is no longer a segment of the Inbox screen')
  assert.equal(findNavItem('tasks')?.webHosted, 'inbox')
})

test('[MOB-7a] Tasks stays a reachable destination in its own right', () => {
  // Folding Tasks into the Inbox must not orphan it: it is still a web surface, so
  // navModel.test.ts requires a destination for it, and More still lists it. The
  // fold is about where it RENDERS, not whether it exists.
  const tasks = findNavItem('tasks')
  assert.ok(tasks, 'the tasks destination disappeared from the nav model')
  assert.equal(tasks!.status, 'ready')
  assert.equal(tasks!.primary, undefined, 'Tasks must not take a tab-bar slot of its own')
})

test('[MOB-7a] a web Inbox tab the phone cannot render is left out, not shown as a dead end', () => {
  const notReady = webTabs.filter((t) => findNavItem(t.id)?.status !== 'ready').map((t) => t.id)
  for (const id of notReady) {
    assert.ok(!isInboxSegment(id), `"${id}" has no ready screen but is offered as a segment`)
  }
  // Today that is exactly Comms — asserted so this test can't quietly pass by
  // becoming vacuous if the web's tab list is emptied.
  assert.deepEqual(notReady, ['comms'])
})

test('[MOB-7a] every segment id is a destination the nav model knows', () => {
  const known = new Set(allNavItems().map((i) => i.id))
  for (const seg of INBOX_SEGMENTS) {
    assert.ok(known.has(seg.id), `segment "${seg.id}" is not in the nav model`)
  }
})

test('[MOB-7a] the screen opens on the approvals, which is what the tab means', () => {
  assert.equal(DEFAULT_INBOX_SEGMENT, 'inbox')
  assert.ok(isInboxSegment(DEFAULT_INBOX_SEGMENT))
})

test('[MOB-7a] an unknown or absent segment falls back to the Inbox', () => {
  // A stale deep link or a push payload naming a surface this screen doesn't host
  // must land somewhere real, not on an empty control.
  assert.equal(resolveInboxSegment('comms'), 'inbox')
  assert.equal(resolveInboxSegment('nonsense'), 'inbox')
  assert.equal(resolveInboxSegment(null), 'inbox')
  assert.equal(resolveInboxSegment(undefined), 'inbox')
  assert.equal(resolveInboxSegment(''), 'inbox')
})

test('[MOB-7a] a known segment is honoured', () => {
  assert.equal(resolveInboxSegment('tasks'), 'tasks')
  assert.equal(resolveInboxSegment('inbox'), 'inbox')
})

test('[MOB-7a] segment ids are unique', () => {
  const ids = INBOX_SEGMENTS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
})
