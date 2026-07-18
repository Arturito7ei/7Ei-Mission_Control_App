// MEM-1 — tests for the Memory graph's view logic.
//
// These exist because the independent audit of #327 found two HIGH interaction
// defects (a drag that navigated away, a zoom that scrolled the page) that
// shipped through a total absence of web coverage. Three of the tests below are
// the direct regression guards for what was found; the rest cover the logic
// those defects were hiding in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  W, H, RENDER_CAP, DRAG_SLOP,
  radiusOf, labelBudget, isDragGesture, shouldLabelMatches, labelSet, visibleSubset,
  zoomAt, fitTransform, adjacency, keyboardOrder, nextFocusIndex, domId,
  type GNode, type GEdge,
} from './vaultGraphView.ts'

const node = (id: string, over: Partial<GNode> = {}): GNode => ({
  id, label: id, kind: 'note', group: 'Notes', degree: 0, path: `vault/${id}.md`, ...over,
})

// ─── REGRESSION 1 (HIGH): dragging a node must not navigate ──────────────────

test('[MEM-1] a click is not a drag — small jitter still opens the note', () => {
  // A mouse always moves a pixel or two between press and release; a trackpad
  // tap moves more. If that counted as a drag, clicking would stop opening
  // notes at all — the opposite failure, equally broken.
  assert.equal(isDragGesture(0, 0), false)
  assert.equal(isDragGesture(2, -3), false)
  assert.equal(isDragGesture(DRAG_SLOP, DRAG_SLOP), false)  // exactly at slop = still a click
})

test('[MEM-1] a real drag IS a drag — releasing must not open the Reader', () => {
  assert.equal(isDragGesture(DRAG_SLOP + 1, 0), true)
  assert.equal(isDragGesture(0, -(DRAG_SLOP + 1)), true)
  assert.equal(isDragGesture(60, 40), true)
  // direction must not matter
  assert.equal(isDragGesture(-60, -40), true)
})

test('[MEM-1] the node click handler actually CONSULTS the drag flag', () => {
  // The predicate above being correct is not the regression guard — the audit
  // defect was in the WIRING: `onClick` opened the note unconditionally, so a
  // correct `isDragGesture` would have sat there unused. (That is exactly how
  // this story's mobile tripwire managed to be vacuous, so: not twice.)
  //
  // The click path needs a DOM to exercise, so it is asserted against the
  // source. Deleting the guard must fail here.
  const src = readFileSync(new URL('../app/dashboard/VaultGraph.tsx', import.meta.url), 'utf8')
  // Anchor on `role="option"` — that attribute is unique to the node <g>. A
  // bare /onClick=/ search finds the toolbar's Reset button first and passes
  // for the wrong reason (it did, on the first run of this test).
  const at = src.indexOf('role="option"')
  assert.ok(at > 0, 'the node <g> must still be the element carrying role="option"')
  const nodeEl = src.slice(at, at + 900)
  const onClick = /onClick=\{\(\) => \{([\s\S]{0,240}?)\}\}/.exec(nodeEl)
  assert.ok(onClick, 'the node <g> must still have an onClick handler')
  assert.match(onClick![1], /draggedFar/,
    'onClick must consult the drag flag before navigating, or dragging a node opens the Reader')
  // …and the flag must actually be SET from the gesture predicate.
  assert.match(src, /isDragGesture\([\s\S]{0,80}draggedFar\.current = true/,
    'the drag flag must be set from isDragGesture, not from an inlined literal')
})

// ─── REGRESSION 2 (HIGH): zooming must not scroll the dashboard ──────────────

test('[MEM-1] wheel is bound as a NON-PASSIVE native listener, never React onWheel', () => {
  // THE AUDIT DEFECT: React 17+ delegates `wheel` at the root as PASSIVE, so
  // `preventDefault()` on the synthetic event is silently ignored and zooming
  // the graph also scrolled the dashboard out from under it. Only a listener
  // registered with `{ passive: false }` can hold the page still.
  //
  // This is a DOM registration fact, not pure logic, so it is asserted against
  // the source — the same shape of tripwire the repo uses elsewhere. It is
  // deliberately strict: reverting to the `onWheel` prop must fail here.
  const src = readFileSync(new URL('../app/dashboard/VaultGraph.tsx', import.meta.url), 'utf8')
  assert.match(src, /addEventListener\(\s*'wheel'[\s\S]{0,80}passive:\s*false/,
    'wheel must be registered natively with { passive: false }')
  assert.doesNotMatch(src, /<svg[\s\S]{0,600}?onWheel=/,
    'the svg must not use React onWheel — its preventDefault is inert (passive root delegation)')
  assert.match(src, /removeEventListener\(\s*'wheel'/,
    'the native listener must be removed when the svg unmounts')
})

test('[MEM-1] zoomAt keeps the point under the cursor fixed, and clamps', () => {
  const v = { k: 1, x: 0, y: 0 }
  const zoomed = zoomAt(v, 480, 310, -1)
  assert.ok(zoomed.k > 1, 'negative deltaY zooms in')
  // the graph-space point under the cursor must be unchanged by the zoom
  const before = { x: (480 - v.x) / v.k, y: (310 - v.y) / v.k }
  const after = { x: (480 - zoomed.x) / zoomed.k, y: (310 - zoomed.y) / zoomed.k }
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9)
  // clamps: no infinite zoom in either direction
  let far = { k: 1, x: 0, y: 0 }
  for (let i = 0; i < 200; i++) far = zoomAt(far, 0, 0, -1)
  assert.equal(far.k, 6)
  let near = { k: 1, x: 0, y: 0 }
  for (let i = 0; i < 200; i++) near = zoomAt(near, 0, 0, 1)
  assert.equal(near.k, 0.2)
})

// ─── REGRESSION 3 (MEDIUM): search must respect the label budget ─────────────

test('[MEM-1] search labels its hits — until labelling them all is text soup again', () => {
  // THE AUDIT DEFECT: a hit was ALWAYS labelled, so typing one common letter
  // matched most of the vault and re-created exactly the hairball the budget
  // exists to prevent.
  const cap = labelBudget(1)          // 40 at default zoom
  assert.equal(shouldLabelMatches(1, cap), true)
  assert.equal(shouldLabelMatches(cap, cap), true)
  assert.equal(shouldLabelMatches(cap + 1, cap), false)
  assert.equal(shouldLabelMatches(0, cap), false)   // nothing matched = nothing to label
})

test('[MEM-1] the search-label allowance widens with zoom — one budget, not a magic number', () => {
  // Tied to the live budget: zooming in genuinely makes room for more text, so
  // a 60-hit search that is soup at 1× is legible at 3×.
  assert.equal(shouldLabelMatches(60, labelBudget(1)), false)
  assert.equal(shouldLabelMatches(60, labelBudget(3)), true)
})

// ─── The label budget itself ─────────────────────────────────────────────────

test('[MEM-1] labelBudget grows with zoom and is never negative', () => {
  assert.ok(labelBudget(0.3) < labelBudget(1))
  assert.ok(labelBudget(1) < labelBudget(2))
  assert.ok(labelBudget(2) < labelBudget(5))
  for (const k of [0, 0.2, 1, 2.4, 2.5, 99]) assert.ok(labelBudget(k) > 0)
})

test('[MEM-1] labelSet spends the budget on hubs, and never labels a tag', () => {
  const nodes = [
    node('leaf', { degree: 1 }),
    node('hub', { degree: 9 }),
    node('mid', { degree: 5 }),
    node('t', { kind: 'tag', degree: 99, label: '#everything' }),
  ]
  const s = labelSet(nodes, 2)
  assert.deepEqual([...s].sort(), ['hub', 'mid'])
  assert.ok(!s.has('t'), 'a tag is scaffolding — it never spends label budget')
  assert.equal(labelSet(nodes, 0).size, 0)
  assert.equal(labelSet(nodes, -5).size, 0)   // a nonsense budget must not throw
})

test('[MEM-1] labelSet is deterministic — equal degrees break by label, not insertion order', () => {
  const a = [node('z', { degree: 3, label: 'zeta' }), node('a', { degree: 3, label: 'alpha' })]
  const b = [node('a', { degree: 3, label: 'alpha' }), node('z', { degree: 3, label: 'zeta' })]
  assert.deepEqual([...labelSet(a, 1)], [...labelSet(b, 1)])
})

// ─── The drawn subset + render cap ───────────────────────────────────────────

const DATA = {
  nodes: [
    node('n1', { group: 'A', degree: 5 }),
    node('n2', { group: 'B', degree: 3 }),
    node('h1', { kind: 'heading', group: 'A', degree: 2 }),
    node('t1', { kind: 'tag', group: '(tags)', degree: 1 }),
  ],
  edges: [
    { source: 'n1', target: 'n2', relation: 'link', weight: 1 },
    { source: 'n1', target: 't1', relation: 'tag', weight: 1 },
    { source: 'n1', target: 'h1', relation: 'contains', weight: 1 },
  ] as GEdge[],
}
const OPTS = { showTags: true, showHeadings: false, hiddenGroups: new Set<string>() }

test('[MEM-1] headings are hidden by default; tags follow their checkbox', () => {
  const withTags = visibleSubset(DATA, OPTS)
  assert.deepEqual(withTags.nodes.map(n => n.id).sort(), ['n1', 'n2', 't1'])
  const noTags = visibleSubset(DATA, { ...OPTS, showTags: false })
  assert.deepEqual(noTags.nodes.map(n => n.id).sort(), ['n1', 'n2'])
  const withHeadings = visibleSubset(DATA, { ...OPTS, showHeadings: true })
  assert.ok(withHeadings.nodes.some(n => n.id === 'h1'))
})

test('[MEM-1] edges never dangle — an edge to a hidden node is dropped with it', () => {
  const r = visibleSubset(DATA, { ...OPTS, showTags: false })
  const ids = new Set(r.nodes.map(n => n.id))
  assert.ok(r.edges.every(e => ids.has(e.source) && ids.has(e.target)))
  assert.ok(!r.edges.some(e => e.target === 't1'))
})

test('[MEM-1] the folder filter hides notes but never strands the tags', () => {
  const r = visibleSubset(DATA, { ...OPTS, hiddenGroups: new Set(['A']) })
  assert.ok(!r.nodes.some(n => n.id === 'n1'))
  assert.ok(r.nodes.some(n => n.id === 't1'), 'a tag has no folder — it rides along')
})

test('[MEM-1] the render cap sheds the LEAST connected and reports how many', () => {
  const many = { nodes: Array.from({ length: 50 }, (_, i) => node(`n${i}`, { degree: i })), edges: [] as GEdge[] }
  const r = visibleSubset(many, { ...OPTS, cap: 10 })
  assert.equal(r.nodes.length, 10)
  assert.equal(r.dropped, 40)
  assert.ok(r.nodes.every(n => n.degree >= 40), 'the survivors are the hubs')
})

test('[MEM-1] under the cap nothing is dropped, and null data is empty not thrown', () => {
  assert.equal(visibleSubset(DATA, OPTS).dropped, 0)
  assert.deepEqual(visibleSubset(null, OPTS), { nodes: [], edges: [], dropped: 0 })
})

test('[MEM-1] RENDER_CAP is the measured 600 — changing it is a deliberate act', () => {
  // Pinned because the number is the conclusion of a benchmark (see the comment
  // in VaultGraph.tsx); drifting it silently would discard that finding.
  assert.equal(RENDER_CAP, 600)
})

// ─── Framing ─────────────────────────────────────────────────────────────────

test('[MEM-1] fitTransform frames every node inside the canvas', () => {
  const pts = [
    { x: -400, y: -200, degree: 9, kind: 'note' },
    { x: 1800, y: 1400, degree: 1, kind: 'note' },
    { x: 500, y: 300, degree: 3, kind: 'note' },
  ]
  const v = fitTransform(pts, W, H)
  for (const p of pts) {
    const sx = p.x * v.k + v.x, sy = p.y * v.k + v.y
    assert.ok(sx >= 0 && sx <= W, `x ${sx} inside 0..${W}`)
    assert.ok(sy >= 0 && sy <= H, `y ${sy} inside 0..${H}`)
  }
})

test('[MEM-1] fitTransform never magnifies past 1:1 — a tiny vault is not blown up', () => {
  const v = fitTransform([{ x: 480, y: 310, degree: 0, kind: 'note' }, { x: 490, y: 320, degree: 0, kind: 'note' }], W, H)
  assert.ok(v.k <= 1)
})

test('[MEM-1] fitTransform on an empty graph is identity, not NaN', () => {
  assert.deepEqual(fitTransform([], W, H), { k: 1, x: 0, y: 0 })
})

// ─── Adjacency, keyboard order, ids ──────────────────────────────────────────

test('[MEM-1] adjacency is undirected — hover lights the whole neighbourhood', () => {
  const m = adjacency(DATA.edges)
  assert.ok(m.get('n1')!.has('n2'))
  assert.ok(m.get('n2')!.has('n1'), 'the highlight must work from either end')
})

test('[MEM-1] keyboardOrder walks hubs first — the order the map is for', () => {
  const order = keyboardOrder([node('a', { degree: 1 }), node('b', { degree: 7 }), node('c', { degree: 4 })])
  assert.deepEqual(order.map(n => n.id), ['b', 'c', 'a'])
})

test('[MEM-1] roving focus wraps at both ends and survives an empty graph', () => {
  assert.equal(nextFocusIndex(0, 1, 3), 1)
  assert.equal(nextFocusIndex(2, 1, 3), 0)     // wraps forward
  assert.equal(nextFocusIndex(0, -1, 3), 2)    // wraps backward
  assert.equal(nextFocusIndex(-1, 1, 3), 0)    // nothing focused yet → first
  assert.equal(nextFocusIndex(0, 1, 0), -1)    // empty graph → no focus, no throw
})

test('[MEM-1] domId survives the characters real node ids contain', () => {
  // Node ids are vault paths and `tag:` keys — both illegal in a DOM id, and
  // aria-activedescendant needs a real one.
  assert.match(domId('vault/07-Agents/STATUS'), /^vg-[A-Za-z0-9_]+$/)
  assert.match(domId('tag:agent/ops'), /^vg-[A-Za-z0-9_]+$/)
  assert.notEqual(domId('a/b'), domId('a/c'))
})

// ─── Radius ──────────────────────────────────────────────────────────────────

test('[MEM-1] radius grows with degree but is bounded, and tags stay small', () => {
  assert.ok(radiusOf({ degree: 9, kind: 'note' }) > radiusOf({ degree: 1, kind: 'note' }))
  assert.ok(radiusOf({ degree: 100000, kind: 'note' }) <= 15, 'one mega-hub must not swallow the canvas')
  assert.equal(radiusOf({ degree: 99, kind: 'tag' }), 3.5)
})
