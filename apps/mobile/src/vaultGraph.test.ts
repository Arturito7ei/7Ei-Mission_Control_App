// MEM-1 — the phone's graph module, and the tripwire that pins it to the
// backend's real one.
//
// THE TRIPWIRE (and why this import is legal). Metro cannot import from
// backend/, so the phone's node/edge shape is a HAND-COPY of the backend's
// `GraphNode`/`GraphEdge`. A copy without a tripwire is silent drift, so the
// last test here builds a graph with the BACKEND'S OWN builder and feeds it to
// this module — if the server's shape moves, this goes red.
//
// `backend/src/services/vault-graph.ts` is import-free (it is pure string and
// array work, no drizzle, no fastify), which is the ONLY reason a cross-
// workspace import is safe here: Mobile CI installs apps/mobile's lockfile
// alone, so importing a module with dependencies would resolve locally and
// silently drop this whole file in CI.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIndex,
  byProminence,
  connectivityLabel,
  neighboursOf,
  nodeGlyph,
  searchNotes,
  topHubs,
  type NoteEdge,
  type NoteNode,
} from './vaultGraph.ts'

const note = (id: string, label: string, degree = 0, extra: Partial<NoteNode> = {}): NoteNode => ({
  id, label, kind: 'note', path: `vault/${label}.md`, group: 'Notes', degree, ...extra,
})

//   moc → plan, moc → status, plan → status, status → #agent
const NODES: NoteNode[] = [
  note('moc', 'MOC', 2),
  note('plan', 'Plan', 2),
  note('status', 'Status', 3),
  { id: 'tag:agent', label: '#agent', kind: 'tag', group: '(tags)', degree: 1 },
]
const EDGES: NoteEdge[] = [
  { source: 'moc', target: 'plan', relation: 'link', weight: 1 },
  { source: 'moc', target: 'status', relation: 'link', weight: 1 },
  { source: 'plan', target: 'status', relation: 'link', weight: 1 },
  { source: 'status', target: 'tag:agent', relation: 'tag', weight: 1 },
]

// ─── Index + neighbourhood ───────────────────────────────────────────────────

test('[MEM-1] buildIndex keeps direction — out is links, in is backlinks', () => {
  const ix = buildIndex(NODES, EDGES)
  assert.deepEqual(ix.out.get('moc'), ['plan', 'status'])
  assert.deepEqual(ix.in.get('status')!.sort(), ['moc', 'plan'])
  assert.equal(ix.in.get('moc'), undefined) // nothing points at the MOC
})

test('[MEM-1] neighboursOf splits links, backlinks and tags', () => {
  const ix = buildIndex(NODES, EDGES)
  const n = neighboursOf(ix, 'status')
  assert.deepEqual(n.backlinks.map(x => x.label), ['MOC', 'Plan'])   // degree tie → A–Z
  assert.deepEqual(n.links.map(x => x.label), [])                     // its only out-edge is a tag
  assert.deepEqual(n.tags.map(x => x.label), ['#agent'])
})

test('[MEM-1] a tag lists the notes carrying it as its backlinks', () => {
  const ix = buildIndex(NODES, EDGES)
  assert.deepEqual(neighboursOf(ix, 'tag:agent').backlinks.map(n => n.label), ['Status'])
})

test('[MEM-1] buildIndex drops edges pointing at capped-away nodes', () => {
  // The server caps by degree; the edges it sheds reference ids we never got.
  const ix = buildIndex([note('a', 'A', 1)], [
    { source: 'a', target: 'gone', relation: 'link', weight: 1 },
    { source: 'gone', target: 'a', relation: 'link', weight: 1 },
  ])
  assert.equal(ix.out.get('a'), undefined)
  assert.equal(ix.in.get('a'), undefined)
  assert.deepEqual(neighboursOf(ix, 'a'), { links: [], backlinks: [], tags: [] })
})

test('[MEM-1] buildIndex de-dupes a pair carrying two relations, and ignores self-links', () => {
  const ix = buildIndex([note('a', 'A'), note('b', 'B')], [
    { source: 'a', target: 'b', relation: 'link', weight: 1 },
    { source: 'a', target: 'b', relation: 'references', weight: 1 },
    { source: 'a', target: 'a', relation: 'link', weight: 1 },
  ])
  assert.deepEqual(ix.out.get('a'), ['b'])   // listed once, not twice
  assert.deepEqual(ix.in.get('b'), ['a'])
})

test('[MEM-1] neighboursOf is empty (not thrown) for an unknown id', () => {
  const ix = buildIndex(NODES, EDGES)
  assert.deepEqual(neighboursOf(ix, 'nope'), { links: [], backlinks: [], tags: [] })
})

// ─── Search ──────────────────────────────────────────────────────────────────

test('[MEM-1] searchNotes ranks exact, then prefix, then substring', () => {
  const nodes = [
    // The substring match is deliberately the MOST connected, to prove rank
    // beats prominence: typing a note's whole name must surface that note, not
    // the hub that happens to mention it.
    note('a', 'Q3 planning', 9),      // substring (mid-label), most connected
    note('b', 'Plan', 1),             // exact, least connected
    note('c', 'Plans for Q3', 5),     // prefix
  ]
  assert.deepEqual(searchNotes(nodes, 'plan').map(n => n.label), ['Plan', 'Plans for Q3', 'Q3 planning'])
})

test('[MEM-1] searchNotes is case-insensitive and matches the Graphify concept name', () => {
  const nodes = [note('a', 'Untitled', 3, { communityName: 'Mission Control Status' })]
  assert.equal(searchNotes(nodes, 'UNTITLED').length, 1)
  assert.equal(searchNotes(nodes, 'mission control')[0].label, 'Untitled')
})

test('[MEM-1] searchNotes returns nothing for an empty query, and honours the limit', () => {
  assert.deepEqual(searchNotes(NODES, ''), [])
  assert.deepEqual(searchNotes(NODES, '   '), [])
  assert.equal(searchNotes(NODES, 't', 2).length, 2)
})

test('[MEM-1] searchNotes finds tag nodes too — a # is a legitimate way in', () => {
  assert.deepEqual(searchNotes(NODES, 'agent').map(n => n.id), ['tag:agent'])
})

// ─── Ordering + display ──────────────────────────────────────────────────────

test('[MEM-1] byProminence sorts by degree, then A–Z case-insensitively', () => {
  const out = [note('a', 'zeta', 1), note('b', 'Alpha', 1), note('c', 'hub', 9)].sort(byProminence)
  assert.deepEqual(out.map(n => n.label), ['hub', 'Alpha', 'zeta'])
})

test('[MEM-1] topHubs returns notes only, most-connected first', () => {
  const hubs = topHubs(NODES, 2)
  assert.deepEqual(hubs.map(n => n.label), ['Status', 'MOC'])
  assert.ok(hubs.every(n => n.kind === 'note'))   // the tag node is not a hub
})

test('[MEM-1] connectivityLabel says what the radius says on the desk', () => {
  const ix = buildIndex(NODES, EDGES)
  assert.equal(connectivityLabel(ix, 'moc'), '2 links')
  assert.equal(connectivityLabel(ix, 'status'), '1 link · 2 back')
  assert.equal(connectivityLabel(ix, 'tag:agent'), '1 back')
  assert.equal(connectivityLabel(buildIndex([note('x', 'X')], []), 'x'), 'no links')
})

test('[MEM-1] nodeGlyph distinguishes kinds without relying on colour', () => {
  assert.equal(nodeGlyph(NODES[0]), '📄')
  assert.equal(nodeGlyph(NODES[3]), '#')
  assert.equal(nodeGlyph({ ...NODES[0], kind: 'heading' }), '§')
})

// ─── The tripwire: the backend's real output must feed this module ───────────

test('[MEM-1] the BACKEND builder output indexes here — shapes still agree', async () => {
  const { buildNativeGraph, capGraph } = await import('../../../backend/src/services/vault-graph.ts')

  const built = buildNativeGraph(
    [
      { path: 'vault/00-Index/MOC.md', markdown: '---\ntags: [index]\n---\n[[Plan]] and [[Status]]' },
      { path: 'vault/01-Projects/Plan.md', markdown: '# Plan\nsee [[Status]] #project' },
      { path: 'vault/07-Agents/Status.md', markdown: '# Status\n#agent' },
    ],
    'vault',
  )

  // The server's node/edge objects must satisfy the phone's types AS THEY ARE —
  // no adapter in between. If the backend renames `degree` or `group`, or emits
  // a `kind` this module doesn't know, the assertions below fail.
  const nodes = built.nodes as NoteNode[]
  const edges = built.edges as NoteEdge[]
  assert.ok(nodes.every(n => typeof n.id === 'string' && typeof n.label === 'string'
    && typeof n.degree === 'number' && typeof n.group === 'string'
    && ['note', 'tag', 'heading'].includes(n.kind)))
  assert.ok(edges.every(e => ['link', 'tag', 'contains', 'references'].includes(e.relation)))
  // …and `degree` must actually be POPULATED, not merely present. `typeof
  // n.degree === 'number'` above is satisfied by the `degree: 0` initializer,
  // so on its own it asserts nothing about the builder having run.
  assert.ok(nodes.some(n => n.degree > 0), 'builder must fill degree, not leave the initializer')

  const ix = buildIndex(nodes, edges)
  const status = nodes.find(n => n.label === 'Status')!
  // MOC and Plan both link to Status — the phone must derive the same backlinks
  // the desk draws as two lines.
  assert.deepEqual(neighboursOf(ix, status.id).backlinks.map(n => n.label).sort(), ['MOC', 'Plan'])
  assert.equal(searchNotes(nodes, 'status')[0].label, 'Status')

  // And the capped payload — what the phone actually receives — still indexes.
  const capped = capGraph(built, 2)
  const cix = buildIndex(capped.nodes as NoteNode[], capped.edges as NoteEdge[])
  assert.ok(capped.nodes.length === 2)
  assert.ok([...cix.out.keys()].every(id => cix.byId.has(id)))

  // THE ASSERTION THAT HAS TO BITE: the cap must preserve VAULT-WIDE degree,
  // not recompute it from the edges that survived. The phone renders that
  // number verbatim (`connectivityLabel` → "12 links · 3 back"), so if the
  // server ever started recomputing, the phone would quietly under-report how
  // connected a note is and nothing else would notice.
  //
  // Checking `degree === <literal>` would only pin today's fixture. Instead we
  // assert the INVARIANT: the surviving hub still claims more connections than
  // it has surviving edges — which is true only if the degree is the full
  // vault's, and is exactly false if it was recomputed post-cap.
  const hubBefore = [...built.nodes].sort((a, b) => b.degree - a.degree)[0] as NoteNode
  const hubAfter = capped.nodes.find(n => n.id === hubBefore.id) as NoteNode | undefined
  assert.ok(hubAfter, 'the highest-degree node must survive a degree-priority cap')
  assert.equal(hubAfter!.degree, hubBefore.degree, 'cap must not rewrite degree')
  const survivingEdges = capped.edges.filter(e => e.source === hubAfter!.id || e.target === hubAfter!.id).length
  assert.ok(
    hubAfter!.degree > survivingEdges,
    `degree (${hubAfter!.degree}) must exceed surviving edges (${survivingEdges}) — equal means it was recomputed from the capped edge set`,
  )
})
