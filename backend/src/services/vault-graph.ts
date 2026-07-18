// Vault graph builder — turns an Obsidian vault (markdown) into a force-directed
// graph model the Memory tab renders. Two sources, one output shape:
//   1. `parseGraphifyGraph()` — normalize a Graphify `graph.json` (the richer
//      AST/semantic backend) into our node/edge model when one exists in the vault.
//   2. `buildNativeGraph()`   — parse markdown ourselves for [[wikilinks]], #tags
//      and frontmatter tags when there is no Graphify output (the fallback).
// Both are PURE (no IO): the route fetches bytes and calls these. Colorblind
// clustering is by folder — the web layer maps `group` → a colorblind-safe hue.

export type NodeKind = 'note' | 'tag' | 'heading'
export type EdgeRelation = 'link' | 'tag' | 'contains' | 'references'
export type GraphSource = 'graphify' | 'native'

export interface GraphNode {
  id: string
  label: string
  kind: NodeKind
  /** vault-relative path for note nodes (opens in the reader on click) */
  path?: string
  /** top-level folder under the vault root — the cluster key */
  group: string
  /** wikilink + tag degree, filled by `withDegrees()` */
  degree: number
  tags?: string[]
  /** Graphify community id (Louvain) — undefined for the native graph */
  community?: number
  /** Graphify LLM-named community label (the "concept" of the cluster) */
  communityName?: string
}

export interface GraphEdge {
  source: string
  target: string
  relation: EdgeRelation
  weight: number
}

export interface VaultGraph {
  source: GraphSource
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: {
    notes: number
    tags: number
    links: number
    /** wikilink targets that did not resolve to a known note */
    unresolved: number
    /** distinct named Graphify communities (semantic pass); 0 for native */
    communities?: number
    /** true when the native builder hit its file-read cap */
    truncated?: boolean
    /** nodes dropped by `capGraph()` — 0/absent when the whole vault fit */
    capped?: number
    /** total nodes BEFORE the cap, so a client can say "showing 600 of 4,200" */
    totalNodes?: number
  }
  generatedAt?: string
}

export interface VaultFile { path: string; markdown: string }

// ─── Path / id helpers ───────────────────────────────────────────────────────

/** Stable node id from a vault-relative path: lowercased, extension-stripped. */
export function nodeIdForPath(path: string): string {
  return String(path ?? '')
    .replace(/^\/+/, '')
    .replace(/\.(md|markdown|txt)$/i, '')
    .toLowerCase()
}

/** File name without directory or extension — the human label. */
export function baseName(path: string): string {
  const p = String(path ?? '').replace(/\/+$/, '')
  const last = p.slice(p.lastIndexOf('/') + 1)
  return last.replace(/\.(md|markdown|txt)$/i, '')
}

/** Top-level folder under `root` (the cluster key). '' → root-level notes. */
export function folderOf(path: string, root: string): string {
  let p = String(path ?? '').replace(/^\/+/, '')
  const r = String(root ?? '').replace(/^\/+|\/+$/g, '')
  if (r && (p === r || p.startsWith(r + '/'))) p = p.slice(r.length).replace(/^\/+/, '')
  const slash = p.indexOf('/')
  return slash === -1 ? '(root)' : p.slice(0, slash)
}

// ─── Markdown parsing (pure) ─────────────────────────────────────────────────

/** Extract the YAML frontmatter block body (between the leading `---` fences). */
export function frontmatter(md: string): string {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(String(md ?? ''))
  return m ? m[1] : ''
}

/** Tags from frontmatter (`tags: [a, b]` or a `- a` list) + inline `#tags`. */
export function extractTags(md: string): string[] {
  const out = new Set<string>()
  const fm = frontmatter(md)
  // `[^\S\r\n]*` = horizontal whitespace only, so the capture never crosses the
  // newline into a list-form value.
  const line = /^tags:[^\S\r\n]*(.*)$/im.exec(fm)
  if (line) {
    const inline = line[1].trim()
    if (inline.startsWith('[')) {
      for (const t of inline.replace(/^\[|\]$/g, '').split(',')) {
        const v = t.trim().replace(/^['"]|['"]$/g, '')
        if (v) out.add(normalizeTag(v))
      }
    }
    // list form: subsequent `  - tag` lines (skip blanks; stop at the next key)
    const after = fm.slice((line.index ?? 0) + line[0].length)
    for (const l of after.split(/\r?\n/)) {
      if (l.trim() === '') continue
      const li = /^\s*-\s+(.+)$/.exec(l)
      if (!li) break
      const v = li[1].trim().replace(/^['"]|['"]$/g, '')
      if (v) out.add(normalizeTag(v))
    }
  }
  // inline #tags in the body (skip the frontmatter and code fences)
  const body = String(md ?? '').slice(fm ? fm.length : 0)
  for (const m of body.matchAll(/(^|\s)#([a-z0-9][a-z0-9_/-]*)/gi)) out.add(normalizeTag(m[2]))
  return [...out]
}

export function normalizeTag(t: string): string {
  return String(t).replace(/^#/, '').trim().toLowerCase()
}

/** [[wikilink]] targets — strips `|alias`, `#heading`, and `.md`; keeps the note name. */
export function extractWikilinks(md: string): string[] {
  const out: string[] = []
  for (const m of String(md ?? '').matchAll(/\[\[([^\]]+)\]\]/g)) {
    let t = m[1].split('|')[0].split('#')[0].trim()
    t = t.replace(/\.(md|markdown)$/i, '')
    if (t) out.push(t)
  }
  return out
}

// ─── Native builder ──────────────────────────────────────────────────────────

/**
 * Build a graph from raw markdown files. `includeTags` adds tag nodes/edges.
 * Wikilinks resolve by note basename (case-insensitive), falling back to a
 * path-suffix match; unresolved targets are counted, not added as ghost nodes.
 */
export function buildNativeGraph(
  files: VaultFile[], root: string,
  opts: { includeTags?: boolean; truncated?: boolean } = {},
): VaultGraph {
  const includeTags = opts.includeTags !== false
  const notes: GraphNode[] = []
  const byBase = new Map<string, string>()   // lower basename → id (last wins on dupes)
  const byId = new Map<string, GraphNode>()

  for (const f of files) {
    const id = nodeIdForPath(f.path)
    if (byId.has(id)) continue
    const tags = extractTags(f.markdown)
    const node: GraphNode = {
      id, label: baseName(f.path), kind: 'note', path: f.path,
      group: folderOf(f.path, root), degree: 0, tags,
    }
    notes.push(node); byId.set(id, node)
    byBase.set(baseName(f.path).toLowerCase(), id)
  }

  const edges: GraphEdge[] = []
  const tagNodes = new Map<string, GraphNode>()
  let links = 0, unresolved = 0
  const edgeKey = new Set<string>()
  const addEdge = (source: string, target: string, relation: EdgeRelation) => {
    const k = `${source}\u0000${target}\u0000${relation}`
    if (edgeKey.has(k)) { const e = edges.find(x => x.source === source && x.target === target && x.relation === relation); if (e) e.weight++; return }
    edgeKey.add(k); edges.push({ source, target, relation, weight: 1 })
  }

  for (const f of files) {
    const from = nodeIdForPath(f.path)
    for (const raw of extractWikilinks(f.markdown)) {
      const target = resolveWikilink(raw, byBase, byId)
      if (!target) { unresolved++; continue }
      if (target === from) continue
      addEdge(from, target, 'link'); links++
    }
    if (includeTags) {
      const src = byId.get(from)
      for (const t of src?.tags ?? []) {
        const tid = `tag:${t}`
        if (!tagNodes.has(tid)) tagNodes.set(tid, { id: tid, label: `#${t}`, kind: 'tag', group: '(tags)', degree: 0 })
        addEdge(from, tid, 'tag')
      }
    }
  }

  const nodes = [...notes, ...tagNodes.values()]
  return withDegrees({
    source: 'native', nodes, edges,
    stats: { notes: notes.length, tags: tagNodes.size, links, unresolved, truncated: opts.truncated },
  })
}

/** Resolve a [[target]] to a node id: exact basename, then path-suffix match. */
export function resolveWikilink(raw: string, byBase: Map<string, string>, byId: Map<string, GraphNode>): string | null {
  const name = raw.replace(/^\/+/, '').toLowerCase()
  const base = name.slice(name.lastIndexOf('/') + 1)
  if (byBase.has(base)) return byBase.get(base)!
  // path form like "07-Agents/STATUS" → match by id suffix
  const asId = nodeIdForPath(raw)
  if (byId.has(asId)) return asId
  for (const id of byId.keys()) if (id.endsWith('/' + asId) || id === asId) return id
  return null
}

// ─── Graphify normalizer ─────────────────────────────────────────────────────

/**
 * Normalize a Graphify `graph.json` ({ nodes:[…], links:[…] }) into our model.
 * Drops nodes outside the vault root (e.g. `.obsidian/` config, absolute-path
 * leaks) so the view stays scoped to notes. File-level nodes (source_location
 * `L1`) are `note`; deeper ones are `heading`.
 */
export function parseGraphifyGraph(json: any, root: string): VaultGraph {
  const rawNodes: any[] = Array.isArray(json?.nodes) ? json.nodes : []
  const rawLinks: any[] = Array.isArray(json?.links) ? json.links : (Array.isArray(json?.edges) ? json.edges : [])
  const r = String(root ?? '').replace(/^\/+|\/+$/g, '')

  const keep = new Map<string, GraphNode>()
  for (const n of rawNodes) {
    const sf: string = String(n?.source_file ?? '')
    if (!inVault(sf, r)) continue
    if (/(^|\/)\.obsidian\//.test(sf)) continue
    const isFile = String(n?.source_location ?? 'L1').replace(/^L/i, '') === '1'
    // Semantic-pass fields (present after `graphify cluster-only/label`): the
    // Louvain community id + its LLM-named concept. A placeholder "Community N"
    // name is treated as absent so the UI can fall back to folder clustering.
    const community = Number.isFinite(n?.community) ? Number(n.community) : undefined
    const rawName = typeof n?.community_name === 'string' ? n.community_name.trim() : ''
    const communityName = rawName && !/^Community\s+\d+$/i.test(rawName) ? rawName : undefined
    keep.set(String(n.id), {
      id: String(n.id),
      label: String(n.label ?? baseName(sf) ?? n.id),
      kind: isFile ? 'note' : 'heading',
      path: isFile ? sf.replace(/^\/+/, '') : undefined,
      group: folderOf(sf, r),
      degree: 0,
      ...(community !== undefined ? { community } : {}),
      ...(communityName ? { communityName } : {}),
    })
  }

  const edges: GraphEdge[] = []
  let links = 0
  for (const l of rawLinks) {
    const s = String(l?.source ?? ''), t = String(l?.target ?? '')
    if (!keep.has(s) || !keep.has(t) || s === t) continue
    const relation = (l?.relation === 'contains' ? 'contains' : l?.relation === 'references' ? 'references' : 'link') as EdgeRelation
    edges.push({ source: s, target: t, relation, weight: Number(l?.weight) || 1 })
    if (relation !== 'contains') links++
  }

  const nodes = [...keep.values()]
  const communities = new Set(nodes.map(n => n.communityName).filter(Boolean)).size
  return withDegrees({
    source: 'graphify', nodes, edges,
    stats: { notes: nodes.filter(n => n.kind === 'note').length, tags: 0, links, unresolved: 0, communities },
    generatedAt: typeof json?.generatedAt === 'string' ? json.generatedAt : undefined,
  })
}

function inVault(sourceFile: string, root: string): boolean {
  const p = String(sourceFile ?? '').replace(/^\/+/, '')
  if (p.includes('..')) return false
  return !root || p === root || p.startsWith(root + '/')
}

// ─── Shared ──────────────────────────────────────────────────────────────────

/**
 * MEM-1 — bound the payload so one enormous vault can't blow up the response
 * (or the tab that renders it).
 *
 * The native builder is already capped at the FETCH (it costs a GitHub call per
 * note), but the Graphify fast path is a single `graph.json` read: a vault with
 * thousands of notes arrives whole, ships whole, and lands in a force
 * simulation that is O(n log n) per tick. This is the bound for that path.
 *
 * WHAT SURVIVES THE CAP: the highest-DEGREE nodes. Degree is the closest cheap
 * proxy we have for "load-bearing note" — a hub that fifteen notes link to is
 * the thing an operator is looking for, and the singleton leaf is the thing
 * they can find faster in the reader's tree anyway. Ties break notes-first
 * (headings and tag nodes are scaffolding around notes, not the payload) and
 * then by id, so the same vault always yields the same map — a cap that
 * reshuffled on every fetch would make the view untrustworthy.
 *
 * `degree` is deliberately NOT recomputed after the drop: it stays the node's
 * TRUE connectivity in the whole vault, so radius keeps meaning "how central is
 * this note" rather than "how much of it survived the cap". The count that was
 * dropped is reported (`stats.capped`) so the UI can say so out loud instead of
 * quietly showing a partial vault as if it were the whole one.
 */
export function capGraph(g: VaultGraph, maxNodes: number): VaultGraph {
  const total = g.nodes.length
  if (!Number.isFinite(maxNodes) || maxNodes <= 0 || total <= maxNodes) {
    return { ...g, stats: { ...g.stats, totalNodes: total } }
  }
  const rank = (n: GraphNode) => (n.kind === 'note' ? 0 : n.kind === 'heading' ? 1 : 2)
  const kept = [...g.nodes]
    .sort((a, b) => (b.degree - a.degree) || (rank(a) - rank(b)) || a.id.localeCompare(b.id))
    .slice(0, maxNodes)
  const keep = new Set(kept.map(n => n.id))
  const edges = g.edges.filter(e => keep.has(e.source) && keep.has(e.target))
  return {
    ...g,
    nodes: kept,
    edges,
    stats: { ...g.stats, capped: total - kept.length, totalNodes: total },
  }
}

/** Fill `degree` (edge count per node) — drives node radius in the view. */
export function withDegrees(g: VaultGraph): VaultGraph {
  const deg = new Map<string, number>()
  for (const e of g.edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  for (const n of g.nodes) n.degree = deg.get(n.id) ?? 0
  return g
}
