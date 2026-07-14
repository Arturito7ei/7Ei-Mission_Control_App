// P2 — org-chart geometry. Zero-dep: node --test --experimental-strip-types.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOrgTree, computeOrgLayout, layoutOrgTree, fitToView, zoomAbout, clampZoom,
  NODE_W, NODE_H, GAP_X, GAP_Y, MIN_ZOOM, MAX_ZOOM,
} from './orgLayout.ts'

const a = (id: string, reportsTo: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ id, name: id.toUpperCase(), role: 'general', reportsTo, ...extra })

// ─── tree derivation ────────────────────────────────────────────────────────

test('buildOrgTree: the agent with no manager is the root, reports nest beneath', () => {
  const roots = buildOrgTree([a('ceo'), a('eng', 'ceo'), a('ops', 'ceo'), a('junior', 'eng')])
  assert.equal(roots.length, 1)
  assert.equal(roots[0].id, 'ceo')
  assert.deepEqual(roots[0].children.map(c => c.id), ['eng', 'ops'])
  assert.deepEqual(roots[0].children[0].children.map(c => c.id), ['junior'])
})

test('buildOrgTree: an agent whose manager is not in the set is promoted to a root', () => {
  const roots = buildOrgTree([a('ceo'), a('orphan', 'someone-deleted')])
  assert.deepEqual(roots.map(r => r.id).sort(), ['ceo', 'orphan'])
})

test('buildOrgTree: self-reference becomes a root rather than a child of itself', () => {
  const roots = buildOrgTree([a('solo', 'solo')])
  assert.deepEqual(roots.map(r => r.id), ['solo'])
  assert.deepEqual(roots[0].children, [])
})

test('buildOrgTree: a reports_to cycle is broken, every agent appears exactly once', () => {
  // a → b → c → a is a full cycle; nothing has a manager outside the loop.
  const roots = buildOrgTree([a('a', 'c'), a('b', 'a'), a('c', 'b')])
  const flatten = (ns: ReturnType<typeof buildOrgTree>): string[] =>
    ns.flatMap(n => [n.id, ...flatten(n.children)])
  const all = flatten(roots)
  assert.equal(all.length, 3, 'no agent is lost and none is duplicated')
  assert.deepEqual([...all].sort(), ['a', 'b', 'c'])
  assert.ok(roots.length >= 1, 'the cycle is broken by promoting a member to a root')
})

test('buildOrgTree: multiple managerless agents each become a root', () => {
  const roots = buildOrgTree([a('one'), a('two'), a('kid', 'two')])
  assert.deepEqual(roots.map(r => r.id), ['one', 'two'])
})

test('buildOrgTree: empty input yields no roots', () => {
  assert.deepEqual(buildOrgTree([]), [])
})

test('buildOrgTree: extra agent fields ride along to the node', () => {
  const [root] = buildOrgTree([a('ceo', null, { llmModel: 'grok-build', avatarUrl: '/x.png' })])
  assert.equal(root.llmModel, 'grok-build')
  assert.equal(root.avatarUrl, '/x.png')
})

// ─── layout ─────────────────────────────────────────────────────────────────

test('layoutOrgTree: the root sits on row 0 and each depth drops one row', () => {
  const { nodes } = computeOrgLayout([a('ceo'), a('eng', 'ceo'), a('junior', 'eng')])
  const at = (id: string) => nodes.find(n => n.id === id)!
  assert.equal(at('ceo').y, 0)
  assert.equal(at('eng').y, NODE_H + GAP_Y)
  assert.equal(at('junior').y, 2 * (NODE_H + GAP_Y))
  assert.equal(at('junior').depth, 2)
})

test('layoutOrgTree: siblings are packed left to right without overlapping', () => {
  const { nodes } = computeOrgLayout([a('ceo'), a('l', 'ceo'), a('r', 'ceo')])
  const l = nodes.find(n => n.id === 'l')!
  const r = nodes.find(n => n.id === 'r')!
  assert.equal(l.x, 0)
  assert.equal(r.x, NODE_W + GAP_X)
  assert.ok(r.x >= l.x + NODE_W, 'sibling cards do not overlap')
})

test('layoutOrgTree: a manager is centred over the span of its children', () => {
  const { nodes } = computeOrgLayout([a('ceo'), a('l', 'ceo'), a('r', 'ceo')])
  const at = (id: string) => nodes.find(n => n.id === id)!
  assert.equal(at('ceo').x, (at('l').x + at('r').x) / 2)
})

test('layoutOrgTree: one edge per reporting line, anchored card-bottom to card-top', () => {
  const { nodes, edges } = computeOrgLayout([a('ceo'), a('eng', 'ceo')])
  assert.equal(edges.length, 1)
  const [e] = edges
  const ceo = nodes.find(n => n.id === 'ceo')!
  const eng = nodes.find(n => n.id === 'eng')!
  assert.equal(e.parentId, 'ceo')
  assert.equal(e.childId, 'eng')
  assert.equal(e.x1, ceo.x + NODE_W / 2)
  assert.equal(e.y1, ceo.y + NODE_H)
  assert.equal(e.x2, eng.x + NODE_W / 2)
  assert.equal(e.y2, eng.y)
})

test('layoutOrgTree: extent covers every card', () => {
  const layout = computeOrgLayout([a('ceo'), a('l', 'ceo'), a('r', 'ceo')])
  assert.equal(layout.width, Math.max(...layout.nodes.map(n => n.x)) + NODE_W)
  assert.equal(layout.height, NODE_H + GAP_Y + NODE_H)
})

test('layoutOrgTree: an empty org has no nodes and zero extent', () => {
  const layout = layoutOrgTree([])
  assert.deepEqual(layout.nodes, [])
  assert.deepEqual(layout.edges, [])
  assert.equal(layout.width, 0)
  assert.equal(layout.height, 0)
})

test('layoutOrgTree: a cyclic org still lays out (no infinite recursion)', () => {
  const layout = computeOrgLayout([a('a', 'c'), a('b', 'a'), a('c', 'b')])
  assert.equal(layout.nodes.length, 3)
})

// ─── viewport maths ─────────────────────────────────────────────────────────

test('clampZoom: holds the zoom inside the allowed range', () => {
  assert.equal(clampZoom(99), MAX_ZOOM)
  assert.equal(clampZoom(0.001), MIN_ZOOM)
  assert.equal(clampZoom(1), 1)
})

test('fitToView: scales a large tree down so it fits with padding to spare', () => {
  const { zoom, x, y } = fitToView({ width: 4000, height: 2000 }, { width: 1000, height: 800 })
  assert.ok(zoom < 1 && zoom >= MIN_ZOOM)
  assert.ok(4000 * zoom <= 1000, 'the scaled tree fits the viewport width')
  assert.ok(x >= 0 && y >= 0, 'the tree is centred, not pushed off-canvas')
})

test('fitToView: a small tree is centred but never magnified past 1x', () => {
  const { zoom, x } = fitToView({ width: 220, height: 104 }, { width: 1000, height: 800 })
  assert.equal(zoom, 1)
  assert.equal(x, (1000 - 220) / 2)
})

test('fitToView: an empty layout is a no-op transform', () => {
  assert.deepEqual(fitToView({ width: 0, height: 0 }, { width: 800, height: 600 }), { x: 0, y: 0, zoom: 1 })
})

test('zoomAbout: the canvas point under the focus stays under the focus', () => {
  const pan = { x: 40, y: 20 }
  const focus = { x: 300, y: 200 }
  // Canvas coords of the focus point before the zoom.
  const before = { x: (focus.x - pan.x) / 1, y: (focus.y - pan.y) / 1 }
  const next = zoomAbout(pan, 1, 1.2, focus)
  const after = { x: (focus.x - next.x) / next.zoom, y: (focus.y - next.y) / next.zoom }
  assert.ok(Math.abs(before.x - after.x) < 1e-9)
  assert.ok(Math.abs(before.y - after.y) < 1e-9)
  assert.equal(next.zoom, 1.2)
})

test('zoomAbout: cannot zoom past the clamp', () => {
  assert.equal(zoomAbout({ x: 0, y: 0 }, 2, 10, { x: 0, y: 0 }).zoom, MAX_ZOOM)
  assert.equal(zoomAbout({ x: 0, y: 0 }, 0.3, 0.01, { x: 0, y: 0 }).zoom, MIN_ZOOM)
})
