import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nodeIdForPath, baseName, folderOf, frontmatter, extractTags, normalizeTag,
  extractWikilinks, resolveWikilink, buildNativeGraph, parseGraphifyGraph, withDegrees, capGraph,
  type GraphNode, type VaultGraph,
} from '../services/vault-graph'

// ─── Path/id helpers ─────────────────────────────────────────────────────────

test('[M1] nodeIdForPath lowercases + strips markdown extension', () => {
  assert.equal(nodeIdForPath('vault/07-Agents/STATUS.md'), 'vault/07-agents/status')
  assert.equal(nodeIdForPath('/A/B.markdown'), 'a/b')
})

test('[M1] baseName returns file name without dir or extension', () => {
  assert.equal(baseName('vault/01-Projects/Plan.md'), 'Plan')
  assert.equal(baseName('README.md'), 'README')
})

test('[M1] folderOf returns the top-level folder under root', () => {
  assert.equal(folderOf('vault/07-Agents/STATUS.md', 'vault'), '07-Agents')
  assert.equal(folderOf('vault/README.md', 'vault'), '(root)')
  assert.equal(folderOf('vault/Company/HR/policy.md', 'vault'), 'Company')
})

// ─── Frontmatter + tags ──────────────────────────────────────────────────────

test('[M1] frontmatter extracts the YAML block', () => {
  assert.match(frontmatter('---\ntitle: X\ntags: [a]\n---\nbody'), /tags: \[a\]/)
  assert.equal(frontmatter('no frontmatter here'), '')
})

test('[M1] extractTags reads inline-array frontmatter tags', () => {
  const tags = extractTags('---\ntags: [Project, "Agent-7"]\n---\nhi')
  assert.deepEqual(tags.sort(), ['agent-7', 'project'])
})

test('[M1] extractTags reads YAML list frontmatter tags', () => {
  const tags = extractTags('---\ntags:\n  - Alpha\n  - beta\n---\nbody')
  assert.deepEqual(tags.sort(), ['alpha', 'beta'])
})

test('[M1] extractTags picks up inline #tags in the body', () => {
  const tags = extractTags('body with #Memory and #agent/ops here')
  assert.ok(tags.includes('memory'))
  assert.ok(tags.includes('agent/ops'))
})

test('[M1] normalizeTag strips leading # and lowercases', () => {
  assert.equal(normalizeTag('#Foo'), 'foo')
})

// ─── Wikilinks ───────────────────────────────────────────────────────────────

test('[M1] extractWikilinks strips alias, heading, and extension', () => {
  assert.deepEqual(
    extractWikilinks('see [[Note A|the note]] and [[Note B#section]] and [[c.md]]'),
    ['Note A', 'Note B', 'c'],
  )
})

test('[M1] resolveWikilink matches by basename then path suffix', () => {
  const nodes: GraphNode[] = [
    { id: '07-agents/status', label: 'STATUS', kind: 'note', group: '07-Agents', degree: 0 },
    { id: 'projects/plan', label: 'Plan', kind: 'note', group: 'Projects', degree: 0 },
  ]
  const byId = new Map(nodes.map(n => [n.id, n]))
  const byBase = new Map([['status', '07-agents/status'], ['plan', 'projects/plan']])
  assert.equal(resolveWikilink('STATUS', byBase, byId), '07-agents/status')
  assert.equal(resolveWikilink('Projects/Plan', byBase, byId), 'projects/plan')
  assert.equal(resolveWikilink('Nonexistent', byBase, byId), null)
})

// ─── Native graph ────────────────────────────────────────────────────────────

const FILES = [
  { path: 'vault/00-Index/MOC.md', markdown: '---\ntags: [index]\n---\n# MOC\nlinks: [[Plan]] and [[Status]]' },
  { path: 'vault/01-Projects/Plan.md', markdown: '# Plan\nsee [[Status]] #project' },
  { path: 'vault/07-Agents/Status.md', markdown: '# Status\nno links, #agent tag, and a [[Ghost]] link' },
]

test('[M1] buildNativeGraph builds note nodes + wikilink edges', () => {
  const g = buildNativeGraph(FILES, 'vault')
  assert.equal(g.source, 'native')
  assert.equal(g.stats.notes, 3)
  const moc = g.nodes.find(n => n.id === 'vault/00-index/moc')!
  assert.equal(moc.group, '00-Index')
  // MOC → Plan, MOC → Status, Plan → Status  = 3 resolved links
  const linkEdges = g.edges.filter(e => e.relation === 'link')
  assert.equal(linkEdges.length, 3)
  // [[Ghost]] does not resolve
  assert.equal(g.stats.unresolved, 1)
})

test('[M1] buildNativeGraph adds tag nodes + edges when includeTags', () => {
  const g = buildNativeGraph(FILES, 'vault', { includeTags: true })
  const tagNodes = g.nodes.filter(n => n.kind === 'tag')
  assert.ok(tagNodes.some(t => t.label === '#index'))
  assert.ok(tagNodes.some(t => t.label === '#project'))
  assert.ok(g.edges.some(e => e.relation === 'tag'))
})

test('[M1] buildNativeGraph omits tag nodes when includeTags=false', () => {
  const g = buildNativeGraph(FILES, 'vault', { includeTags: false })
  assert.equal(g.nodes.filter(n => n.kind === 'tag').length, 0)
})

test('[M1] degree is filled and drives note prominence', () => {
  const g = buildNativeGraph(FILES, 'vault', { includeTags: false })
  const status = g.nodes.find(n => n.id === 'vault/07-agents/status')!
  // Status is linked from MOC and Plan → degree 2
  assert.equal(status.degree, 2)
})

// ─── Graphify normalizer ─────────────────────────────────────────────────────

test('[M1] parseGraphifyGraph normalizes nodes/links and scopes to the vault root', () => {
  const json = {
    nodes: [
      { id: 'a', label: 'A.md', source_file: 'vault/01-Projects/A.md', source_location: 'L1' },
      { id: 'a_h', label: 'Heading', source_file: 'vault/01-Projects/A.md', source_location: 'L9' },
      { id: 'obs', label: 'app.json', source_file: 'vault/.obsidian/app.json', source_location: 'L1' },
      { id: 'leak', label: 'x', source_file: '/tmp/outside/x.md', source_location: 'L1' },
    ],
    links: [
      { source: 'a', target: 'a_h', relation: 'contains' },
      { source: 'a', target: 'obs', relation: 'references' },   // dropped: obs filtered
    ],
  }
  const g = parseGraphifyGraph(json, 'vault')
  assert.equal(g.source, 'graphify')
  const ids = g.nodes.map(n => n.id).sort()
  assert.deepEqual(ids, ['a', 'a_h'])                     // .obsidian + leak dropped
  assert.equal(g.nodes.find(n => n.id === 'a')!.kind, 'note')
  assert.equal(g.nodes.find(n => n.id === 'a_h')!.kind, 'heading')
  assert.equal(g.edges.length, 1)                          // ref to dropped node removed
  assert.equal(g.edges[0].relation, 'contains')
})

test('[M2] parseGraphifyGraph surfaces semantic community id + name', () => {
  const json = {
    nodes: [
      { id: 'a', label: 'A.md', source_file: 'vault/01-Projects/A.md', source_location: 'L1', community: 3, community_name: 'Mission Control Status' },
      { id: 'b', label: 'B.md', source_file: 'vault/01-Projects/B.md', source_location: 'L1', community: 3, community_name: 'Mission Control Status' },
      // placeholder name is treated as absent (unlabeled community)
      { id: 'c', label: 'C.md', source_file: 'vault/07-Agents/C.md', source_location: 'L1', community: 9, community_name: 'Community 9' },
    ],
    links: [{ source: 'a', target: 'b', relation: 'references' }],
  }
  const g = parseGraphifyGraph(json, 'vault')
  const a = g.nodes.find(n => n.id === 'a')!
  assert.equal(a.community, 3)
  assert.equal(a.communityName, 'Mission Control Status')
  const c = g.nodes.find(n => n.id === 'c')!
  assert.equal(c.community, 9)
  assert.equal(c.communityName, undefined)          // placeholder dropped
  assert.equal(g.stats.communities, 1)               // one distinct named community
})

test('[M2] native graph leaves community fields undefined', () => {
  const g = buildNativeGraph(FILES, 'vault')
  assert.ok(g.nodes.every(n => n.community === undefined && n.communityName === undefined))
  assert.equal(g.stats.communities, undefined)
})

test('[M1] parseGraphifyGraph tolerates an empty/garbage payload', () => {
  const g = parseGraphifyGraph({}, 'vault')
  assert.equal(g.nodes.length, 0)
  assert.equal(g.edges.length, 0)
  assert.equal(g.source, 'graphify')
})

test('[M1] withDegrees counts undirected degree', () => {
  const g: VaultGraph = {
    source: 'native',
    nodes: [
      { id: 'x', label: 'x', kind: 'note', group: 'g', degree: 0 },
      { id: 'y', label: 'y', kind: 'note', group: 'g', degree: 0 },
    ],
    edges: [{ source: 'x', target: 'y', relation: 'link', weight: 1 }],
    stats: { notes: 2, tags: 0, links: 1, unresolved: 0 },
  }
  withDegrees(g)
  assert.equal(g.nodes[0].degree, 1)
  assert.equal(g.nodes[1].degree, 1)
})

// ─── MEM-1 · payload cap ─────────────────────────────────────────────────────

/** n nodes with descending degree (n0 highest), chained so edges exist. */
function ladder(n: number, kind: GraphNode['kind'] = 'note'): VaultGraph {
  const nodes: GraphNode[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, label: `n${i}`, kind, group: 'g', degree: n - i,
  }))
  const edges = nodes.slice(1).map(nd => ({ source: 'n0', target: nd.id, relation: 'link' as const, weight: 1 }))
  return { source: 'native', nodes, edges, stats: { notes: n, tags: 0, links: edges.length, unresolved: 0 } }
}

test('[MEM-1] capGraph keeps the highest-degree nodes and reports the drop', () => {
  const g = capGraph(ladder(10), 4)
  assert.equal(g.nodes.length, 4)
  assert.deepEqual(g.nodes.map(n => n.id), ['n0', 'n1', 'n2', 'n3'])
  assert.equal(g.stats.capped, 6)
  assert.equal(g.stats.totalNodes, 10)
})

test('[MEM-1] capGraph drops edges whose endpoints were cut', () => {
  const g = capGraph(ladder(10), 3)
  const ids = new Set(g.nodes.map(n => n.id))
  assert.ok(g.edges.every(e => ids.has(e.source) && ids.has(e.target)))
  // n0→n1, n0→n2 survive; the other seven point at dropped nodes.
  assert.equal(g.edges.length, 2)
})

test('[MEM-1] capGraph is a no-op under the cap, but still reports the total', () => {
  const g = capGraph(ladder(5), 50)
  assert.equal(g.nodes.length, 5)
  assert.equal(g.stats.capped, undefined)
  assert.equal(g.stats.totalNodes, 5)
})

test('[MEM-1] capGraph preserves TRUE degree — radius means vault centrality, not survival', () => {
  const g = capGraph(ladder(10), 3)
  // n0 keeps degree 10 even though only 2 of its edges are still drawn.
  assert.equal(g.nodes.find(n => n.id === 'n0')!.degree, 10)
})

test('[MEM-1] capGraph breaks degree ties notes-first, then by id — stable across fetches', () => {
  const mk = (id: string, kind: GraphNode['kind']): GraphNode => ({ id, label: id, kind, group: 'g', degree: 5 })
  const g: VaultGraph = {
    source: 'graphify',
    // deliberately unsorted, and tag/heading before the notes
    nodes: [mk('z-tag', 'tag'), mk('a-head', 'heading'), mk('m-note', 'note'), mk('b-note', 'note')],
    edges: [],
    stats: { notes: 2, tags: 1, links: 0, unresolved: 0 },
  }
  const once = capGraph(g, 2).nodes.map(n => n.id)
  const twice = capGraph(g, 2).nodes.map(n => n.id)
  assert.deepEqual(once, ['b-note', 'm-note'])   // notes win the tie, then id order
  assert.deepEqual(once, twice)                   // deterministic — same vault, same map
})

test('[MEM-1] capGraph tolerates a nonsense cap and an empty graph', () => {
  const empty: VaultGraph = { source: 'native', nodes: [], edges: [], stats: { notes: 0, tags: 0, links: 0, unresolved: 0 } }
  assert.equal(capGraph(empty, 100).nodes.length, 0)
  assert.equal(capGraph(empty, 100).stats.totalNodes, 0)
  // 0/negative/NaN mean "no cap", never "drop everything"
  assert.equal(capGraph(ladder(5), 0).nodes.length, 5)
  assert.equal(capGraph(ladder(5), -1).nodes.length, 5)
  assert.equal(capGraph(ladder(5), Number.NaN).nodes.length, 5)
})

test('[MEM-1] capGraph does not mutate its input', () => {
  const g = ladder(10)
  capGraph(g, 3)
  assert.equal(g.nodes.length, 10)
  assert.equal(g.edges.length, 9)
})
