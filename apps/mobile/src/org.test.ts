// MOB-6e — tripwires for the org tree.
//
// `org.ts` mirrors the web's `buildOrgTree`, so the thing worth testing is that
// it stays a mirror. These tests import BOTH and assert they build the same
// tree — the pattern navModel.test.ts and attach.test.ts already use.
//
// The failure this prevents: someone changes how a cycle or an orphan is handled
// on the web (or the backend changes `reportsTo` semantics under both), and the
// phone quietly keeps the old rules — so the same org renders a different
// hierarchy depending on which device you picked up. That is not a cosmetic
// drift: "who reports to whom" IS the screen.
//
// Zero-dep: node --test --experimental-strip-types. `web/lib/orgLayout.ts` is
// pure (no React, no DOM) — which is what makes it loadable outside Metro.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildOrgTree as webBuildOrgTree, type OrgAgent as WebOrgAgent } from '../../../web/lib/orgLayout.ts'
import {
  ORG_CANVAS_NOTE,
  RUNTIME_BADGE,
  buildOrgTree,
  flattenOrg,
  managerIds,
  orgRows,
  roleLine,
  runtimeLine,
  type OrgAgentLite,
} from './org.ts'

/** The shape both modules accept — ours is structurally the web's. */
const ROSTER: (OrgAgentLite & WebOrgAgent)[] = [
  { id: 'ceo', name: 'Arturito', role: 'ceo', title: 'Chief Executive', reportsTo: null },
  { id: 'cto', name: 'Ada', role: 'cto', title: 'CTO', reportsTo: 'ceo' },
  { id: 'eng', name: 'Grace', role: 'engineer', title: '', reportsTo: 'cto' },
  { id: 'ops', name: 'Kay', role: 'ops', title: 'Ops Lead', reportsTo: 'ceo' },
]

/** Compare two trees by ids only — the structure, not the payload. */
const shape = (nodes: { id: string; children: any[] }[]): any =>
  nodes.map((n) => ({ id: n.id, children: shape(n.children) }))

test('[MOB-6e] the phone builds the same tree the web does', () => {
  assert.deepEqual(shape(buildOrgTree(ROSTER)), shape(webBuildOrgTree(ROSTER)))
})

test('[MOB-6e] an orphan is promoted to a root, on both clients', () => {
  // A manager outside the set: the agent must still appear, not vanish.
  const orphaned = [...ROSTER, { id: 'ghost', name: 'Nobody', role: 'x', reportsTo: 'deleted-agent' }]
  assert.deepEqual(shape(buildOrgTree(orphaned)), shape(webBuildOrgTree(orphaned)))
  assert.ok(
    buildOrgTree(orphaned).some((r) => r.id === 'ghost'),
    'an agent whose manager was deleted must still be reachable',
  )
})

test('[MOB-6e] a self-reference is a root, on both clients', () => {
  const selfy = [{ id: 'a', name: 'A', role: 'r', reportsTo: 'a' }]
  assert.deepEqual(shape(buildOrgTree(selfy)), shape(webBuildOrgTree(selfy)))
  assert.equal(buildOrgTree(selfy).length, 1)
})

test('[MOB-6e] a cycle is broken the same way — and never hangs', () => {
  // a → b → a. Both clients must promote, not loop. If this ever regresses the
  // test doesn't fail, it HANGS — which is precisely the phone's failure mode.
  const cyclic = [
    { id: 'a', name: 'A', role: 'r', reportsTo: 'b' },
    { id: 'b', name: 'B', role: 'r', reportsTo: 'a' },
  ]
  assert.deepEqual(shape(buildOrgTree(cyclic)), shape(webBuildOrgTree(cyclic)))
  // Whatever the rule resolves to, every agent appears exactly once.
  assert.equal(flattenOrg(buildOrgTree(cyclic)).length, 2)
})

test('[MOB-6e] every agent appears exactly once, however the roster is shaped', () => {
  for (const roster of [ROSTER, [...ROSTER].reverse(), []]) {
    const rows = orgRows(roster)
    assert.equal(rows.length, roster.length)
    assert.equal(new Set(rows.map((r) => r.agent.id)).size, roster.length)
  }
})

// ─── Flattening — the phone's own half ───────────────────────────────────────

test('[MOB-6e] depth is the reporting distance, and rows are in tree order', () => {
  const rows = orgRows(ROSTER)
  const byId = Object.fromEntries(rows.map((r) => [r.agent.id, r]))
  assert.equal(byId.ceo.depth, 0)
  assert.equal(byId.cto.depth, 1)
  assert.equal(byId.eng.depth, 2, 'a report of a report indents twice')
  assert.equal(byId.ops.depth, 1)
  // Depth-first: a manager is immediately followed by its own subtree.
  assert.deepEqual(rows.map((r) => r.agent.id), ['ceo', 'cto', 'eng', 'ops'])
})

test('[MOB-6e] collapsing a manager hides its whole subtree, not just its children', () => {
  const rows = orgRows(ROSTER, new Set(['cto']))
  assert.deepEqual(rows.map((r) => r.agent.id), ['ceo', 'cto', 'ops'])
  const cto = rows.find((r) => r.agent.id === 'cto')!
  assert.equal(cto.expanded, false)
  assert.equal(cto.hasChildren, true, 'a collapsed manager still advertises that it has reports')
  assert.equal(cto.childCount, 1)
})

test('[MOB-6e] the default is fully expanded — an empty set hides nothing', () => {
  assert.equal(orgRows(ROSTER).length, ROSTER.length)
  assert.equal(orgRows(ROSTER, new Set()).length, ROSTER.length)
})

test('[MOB-6e] collapsing a root hides everything under it', () => {
  const rows = orgRows(ROSTER, new Set(['ceo']))
  assert.deepEqual(rows.map((r) => r.agent.id), ['ceo'])
})

test('[MOB-6e] a leaf gets no caret', () => {
  const eng = orgRows(ROSTER).find((r) => r.agent.id === 'eng')!
  assert.equal(eng.hasChildren, false)
  assert.equal(eng.childCount, 0)
  assert.equal(eng.expanded, false)
})

test('[MOB-6e] managerIds names only agents that actually parent a row', () => {
  const ids = managerIds(ROSTER).sort()
  assert.deepEqual(ids, ['ceo', 'cto'])
  // A dangling or self manager parents nothing, so it must not be listed —
  // "Collapse all" would otherwise fold a row that has no children to fold.
  assert.deepEqual(managerIds([{ id: 'a', name: 'A', role: 'r', reportsTo: 'gone' }]), [])
  assert.deepEqual(managerIds([{ id: 'a', name: 'A', role: 'r', reportsTo: 'a' }]), [])
})

test('[MOB-6e] the flattened rows carry no `children` key', () => {
  // The row payload is the agent, not the node: leaving `children` on would ship
  // the whole subtree to every FlatList item and defeat the flattening.
  for (const r of orgRows(ROSTER)) {
    assert.equal('children' in r.agent, false)
  }
})

// ─── Card lines ──────────────────────────────────────────────────────────────

test('[MOB-6e] the role line falls back the web’s way — `||`, not `??`', () => {
  assert.equal(roleLine({ id: 'x', name: 'X', title: 'CTO', role: 'cto' }), 'CTO')
  // An EMPTY title must fall through to the role. `??` would print '' here —
  // the web uses `title || role`, and this is that distinction.
  assert.equal(roleLine({ id: 'x', name: 'X', title: '', role: 'engineer' }), 'engineer')
  assert.equal(roleLine({ id: 'x', name: 'X', title: null, role: 'engineer' }), 'engineer')
  assert.equal(roleLine({ id: 'x', name: 'X' }), '—', 'a roleless agent still gets a line')
})

test('[MOB-6e] the runtime line mirrors the web’s special cases', () => {
  // internal: the badge + a phrase, never the model.
  assert.equal(runtimeLine({ id: 'x', name: 'X', runtime: 'internal' }), '🧠 Internal — 7Ei executor')
  // A missing runtime IS internal — the web's `?? 'internal'`.
  assert.equal(runtimeLine({ id: 'x', name: 'X' }), '🧠 Internal — 7Ei executor')
  assert.equal(runtimeLine({ id: 'x', name: 'X', runtime: null }), '🧠 Internal — 7Ei executor')
  // external: badge + runtime, model appended only when known.
  assert.equal(
    runtimeLine({ id: 'x', name: 'X', runtime: 'openclaw', llmModel: 'claude-opus-4' }),
    '📎 openclaw · claude-opus-4',
  )
  assert.equal(runtimeLine({ id: 'x', name: 'X', runtime: 'openclaw' }), '📎 openclaw')
  assert.equal(runtimeLine({ id: 'x', name: 'X', runtime: 'openclaw', llmModel: null }), '📎 openclaw')
})

test('[MOB-6e] an unknown runtime still renders, with the fallback badge', () => {
  // A runtime the registry grows later must not blank the line.
  assert.equal(runtimeLine({ id: 'x', name: 'X', runtime: 'brand-new' }), '⚙️ brand-new')
  assert.ok(RUNTIME_BADGE.openclaw, 'the badge map must stay populated')
})

test('[MOB-6e] the dropped canvas is explained on the screen, not just in a doc', () => {
  assert.match(ORG_CANVAS_NOTE, /desktop/i)
})
