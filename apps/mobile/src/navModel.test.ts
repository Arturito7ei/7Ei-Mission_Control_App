// MOB-6a — the mobile nav model is a PORT of web/lib/navModel.ts, so the thing
// worth testing is that it stays one. These tests import both models and assert
// they describe the same set of surfaces under the same names.
//
// The failure this prevents is drift-by-omission: someone adds a surface to the
// web rail, ships it, and the phone silently never grows a row for it. No amount
// of typechecking catches that — only comparing the two lists does.
//
// Zero-dep, matching the web workspace's convention (no jest/vitest anywhere in
// this repo): run with `npm test` → node --test --experimental-strip-types. Both
// modules are pure data with no React and no react-native import, which is what
// makes them loadable outside Metro at all.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NAV_GROUPS as WEB_GROUPS,
  allSurfaces as webSurfaces,
  isHidden as webIsHidden,
  navParentId as webParentId,
  type NavItem as WebNavItem,
} from '../../../web/lib/navModel.ts'
import {
  NAV_GROUPS,
  allNavItems,
  findNavItem,
  moreItems,
  primaryItems,
} from './navModel.ts'

const web = webSurfaces()
const webById = new Map(web.map((i) => [i.id, i]))
/** The web's own label for a surface — its tab label wins, as it does on the web. */
const webLabel = (i: WebNavItem) => i.tabLabel ?? i.label

test('every web surface is reachable on the phone', () => {
  const missing = web.filter((i) => !findNavItem(i.id)).map((i) => i.id)
  assert.deepEqual(missing, [], `web surfaces with no mobile destination: ${missing.join(', ')}`)
})

test('the phone invents no IA of its own', () => {
  // Anything here is either a web surface or explicitly flagged mobile-only.
  const invented = allNavItems()
    .filter((i) => !i.mobileOnly && !webById.has(i.id))
    .map((i) => i.id)
  assert.deepEqual(invented, [], `mobile ids with no web peer: ${invented.join(', ')}`)
})

test('Status is the only mobile-only destination', () => {
  assert.deepEqual(
    allNavItems().filter((i) => i.mobileOnly).map((i) => i.id),
    ['status'],
  )
})

test('labels match the web, so one surface has one name', () => {
  for (const item of allNavItems()) {
    if (item.mobileOnly) continue
    assert.equal(item.label, webLabel(webById.get(item.id)!), `label drift on "${item.id}"`)
  }
})

test("'gap' is exactly the web's placeholder set", () => {
  // A gap means "unbuilt on every client" — which is precisely what the web
  // records as kind:'placeholder'. If these diverge, a placeholder screen is
  // lying to the operator about whether the data exists.
  const mobileGaps = allNavItems().filter((i) => i.status === 'gap').map((i) => i.id).sort()
  const webPlaceholders = web.filter((i) => i.kind === 'placeholder').map((i) => i.id).sort()
  assert.deepEqual(mobileGaps, webPlaceholders)
})

test('a gap has no build story, and every planned surface names one', () => {
  for (const item of allNavItems()) {
    if (item.status === 'planned') {
      assert.match(item.story ?? '', /^MOB-6[a-z]$/, `"${item.id}" is planned but names no story`)
    } else {
      assert.equal(item.story, undefined, `"${item.id}" is ${item.status} but names a story`)
    }
  }
})

test('web-placement bookkeeping matches the web', () => {
  for (const item of allNavItems()) {
    if (item.mobileOnly) continue
    assert.equal(item.webHosted, webParentId(item.id), `webHosted wrong on "${item.id}"`)
    assert.equal(item.webHidden ?? false, webIsHidden(item.id), `webHidden wrong on "${item.id}"`)
  }
})

test('group ids and order mirror the web', () => {
  assert.deepEqual(
    NAV_GROUPS.map((g) => g.id),
    WEB_GROUPS.map((g) => g.id),
  )
  for (const g of NAV_GROUPS) {
    assert.equal(g.label, WEB_GROUPS.find((w) => w.id === g.id)!.label)
  }
})

test('ids are unique', () => {
  const ids = allNavItems().map((i) => i.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('the tab bar holds only shipped screens, and stays small', () => {
  const primary = primaryItems()
  // Every tab must be a real screen — a placeholder in the tab bar would be a
  // permanent dead end rather than a signpost.
  assert.deepEqual(primary.filter((i) => i.status !== 'ready'), [])
  assert.deepEqual(primary.map((i) => i.id), ['assistant', 'inbox', 'agents', 'status'])
  // Plus More, iOS starts collapsing the bar itself past 5.
  assert.ok(primary.length + 1 <= 5, 'the tab bar has outgrown its slot budget')
})

test('every destination is reachable: tab bar ∪ More covers the model', () => {
  assert.deepEqual(
    [...primaryItems(), ...moreItems()].map((i) => i.id).sort(),
    allNavItems().map((i) => i.id).sort(),
  )
})

test("'ready' is exactly the set of screens that exist", () => {
  // A tripwire for stages 6b+: flipping a status to 'ready' without adding the
  // component to SCREENS in navigation.tsx renders the placeholder forever. That
  // registry imports react-native and can't load here, so this list is the guard.
  //
  // MOB-1..4 shipped assistant/inbox/agents/status; MOB-6b added `tasks` (the
  // Task Log); MOB-6d added `costs`, `budgets` and `activity`; MOB-6e added
  // `memory` and `org` (the two heavy web views, as native trees). The agent
  // DETAIL screen is deliberately absent — it is not a navModel surface on either
  // client (the web reaches it by drilling into the Agents area, not from the
  // rail), so it is a stack route pushed from the roster rather than a
  // destination the model knows.
  assert.deepEqual(
    allNavItems().filter((i) => i.status === 'ready').map((i) => i.id).sort(),
    ['activity', 'agents', 'assistant', 'budgets', 'costs', 'inbox', 'memory', 'org', 'status', 'tasks'],
  )
})
