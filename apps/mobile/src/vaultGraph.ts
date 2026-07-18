// MEM-1 — the vault GRAPH's pure half, for the phone. No React, no
// react-native, so `vaultGraph.test.ts` can load it (and the BACKEND's
// vault-graph service) under `node --test` and assert the two still agree.
//
// WHAT THE WEB DOES, AND WHAT THE PHONE DOES INSTEAD
//
// The web's ⬡ Graph view (web/app/dashboard/VaultGraph.tsx) is a d3-force
// simulation cooled to a static layout and drawn as ~600 SVG nodes you pan,
// zoom, drag and hover. MOB-6e DROPPED it — parity doc §6.6 — and MEM-1 does
// NOT bring it back. The reasons held up on re-examination:
//
//   1. HIT-TESTING. A vault of a few hundred notes packs nodes a handful of
//      points apart. A finger is a 44pt target. Disambiguating a node means
//      pinch-zooming until only one is under the thumb — which is a search,
//      performed badly, with a gesture.
//   2. THE JS THREAD. Cooling the simulation is a synchronous 140–420 tick loop.
//      On the web that's a hitch on a thread that isn't painting; in React
//      Native it blocks THE js thread — the one running the navigator, the
//      list, and the gesture responder. The whole app stops, not just the view.
//   3. IT WOULD COST A DEP. `d3-force` lives in web/ only. react-native-svg IS
//      bundled (so a canvas is technically reachable in Expo Go) — the blocker
//      is 1 and 2, not the renderer.
//
// So the phone mirrors the graph's VALUE rather than its pixels. What the map
// is actually FOR is traversing link structure — "what does this note connect
// to, and what points back at it" — plus finding a note by name across the
// WHOLE vault, which the folder tree genuinely cannot do (it fetches one
// directory at a time, so it can only search what you've already opened).
// Both of those are list-shaped, thumb-shaped, and this module is their engine.
//
// It reads the SAME endpoint the web's canvas reads (`GET …/memory/graph`),
// with `?max=` set lower, since a list has no use for the long tail the canvas
// draws as background texture.

/** One graph node, the subset of the backend's `GraphNode` a list needs. */
export type NoteNode = {
  id: string
  label: string
  kind: 'note' | 'tag' | 'heading'
  path?: string
  group: string
  degree: number
  tags?: string[]
  communityName?: string
}

/** One graph edge, verbatim from the backend's `GraphEdge`. */
export type NoteEdge = {
  source: string
  target: string
  relation: 'link' | 'tag' | 'contains' | 'references'
  weight: number
}

/** The `…/memory/graph` payload, as much of it as the phone reads. */
export type GraphLite = {
  source: 'graphify' | 'native'
  nodes: NoteNode[]
  edges: NoteEdge[]
  stats: {
    notes: number
    tags: number
    links: number
    unresolved: number
    communities?: number
    truncated?: boolean
    capped?: number
    totalNodes?: number
  }
  repo: string
  root: string
  branch: string
  /** FIX-1 — set when a graphify graph.json was FOUND but could not be used
   *  (corrupt, or scoped to a different root). Distinct from simply not having
   *  one: the phone says so rather than silently reading "◇ native parse". */
  graphifyError?: string
}

/** Why there is no force-directed canvas here. Rendered on the screen, not just here. */
export const GRAPH_TREATMENT_NOTE =
  'The desk draws this as a force-directed map. On a phone the same links are a list you can walk: search the whole vault, open a note, and follow what it links to — or what links back.'

// ─── The index ───────────────────────────────────────────────────────────────

/**
 * Adjacency, built once per fetch.
 *
 * DIRECTION IS KEPT, and that is the point. The web's canvas draws an undirected
 * line because a line has no arrow you'd read at that size; a list can afford
 * the distinction, and it is the more useful half of the graph: "what this note
 * links TO" is the author's own trail of thought, while "what links BACK" is
 * the note's standing in the vault — who found it worth citing. Obsidian calls
 * the second backlinks, and it is the thing operators actually hunt for.
 */
export type GraphIndex = {
  byId: Map<string, NoteNode>
  /** id → ids this node points at (the note's own [[wikilinks]] and #tags). */
  out: Map<string, string[]>
  /** id → ids that point at this node (its backlinks). */
  in: Map<string, string[]>
}

export function buildIndex(nodes: NoteNode[], edges: NoteEdge[]): GraphIndex {
  const byId = new Map<string, NoteNode>()
  for (const n of nodes) byId.set(n.id, n)

  const out = new Map<string, string[]>()
  const inn = new Map<string, string[]>()
  // De-dupe per direction: the backend may carry two relations between the same
  // pair (a `link` and a `references`), and a list must show that neighbour once.
  const seenOut = new Set<string>()
  const seenIn = new Set<string>()
  const push = (m: Map<string, string[]>, seen: Set<string>, from: string, to: string) => {
    const k = `${from}\u0000${to}`
    if (seen.has(k)) return
    seen.add(k)
    const cur = m.get(from)
    if (cur) cur.push(to)
    else m.set(from, [to])
  }
  for (const e of edges) {
    // An edge to a node the cap dropped is not a neighbour we can navigate to,
    // so it is not a neighbour we list. (The server caps by degree; the tail it
    // sheds is exactly the tail whose edges land here.)
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
    push(out, seenOut, e.source, e.target)
    push(inn, seenIn, e.target, e.source)
  }
  return { byId, out, in: inn }
}

/** A node's neighbours, split by direction and resolved to nodes. */
export type Neighbourhood = {
  /** Notes/headings this note links to. */
  links: NoteNode[]
  /** Notes that link to this one — Obsidian's backlinks. */
  backlinks: NoteNode[]
  /** Tag nodes this note carries (split out: a tag is a label, not a sibling). */
  tags: NoteNode[]
}

export function neighboursOf(index: GraphIndex, id: string): Neighbourhood {
  const resolve = (ids: string[] | undefined) =>
    (ids ?? []).map(i => index.byId.get(i)).filter((n): n is NoteNode => !!n)
  const outbound = resolve(index.out.get(id))
  return {
    links: outbound.filter(n => n.kind !== 'tag').sort(byProminence),
    tags: outbound.filter(n => n.kind === 'tag').sort((a, b) => a.label.localeCompare(b.label)),
    // A tag's "backlinks" are the notes carrying it, which is exactly what you
    // want when you tap a tag — so this needs no special case.
    backlinks: resolve(index.in.get(id)).sort(byProminence),
  }
}

/** Most-connected first, then A–Z. The order every list here uses. */
export function byProminence(a: NoteNode, b: NoteNode): number {
  return (b.degree - a.degree) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
}

/** The landing list: the vault's hubs, which is where you'd start on a map too. */
export function topHubs(nodes: NoteNode[], limit = 30): NoteNode[] {
  return nodes.filter(n => n.kind === 'note').sort(byProminence).slice(0, limit)
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Find notes by name across the WHOLE vault.
 *
 * This is the capability the folder tree cannot have: `…/memory/tree` returns
 * one directory per call, so the tree only knows what the operator has already
 * expanded. The graph payload names every note in one response, so search here
 * is client-side, instant, and complete — no request per keystroke.
 *
 * Ranking is exact → prefix → substring, then prominence. A vault has many
 * notes whose titles share a word; the one you typed the whole of is the one
 * you meant, and it must not sit below a hub that merely contains the string.
 */
export function searchNotes(nodes: NoteNode[], query: string, limit = 50): NoteNode[] {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return []
  const scored: { n: NoteNode; rank: number }[] = []
  for (const n of nodes) {
    const label = n.label.toLowerCase()
    // A community name is the concept Graphify inferred for the cluster; it's a
    // legitimate way to find a note you can only describe by subject.
    const concept = n.communityName?.toLowerCase() ?? ''
    let rank: number
    if (label === q) rank = 0
    else if (label.startsWith(q)) rank = 1
    else if (label.includes(q)) rank = 2
    else if (concept.includes(q)) rank = 3
    else continue
    scored.push({ n, rank })
  }
  return scored
    .sort((a, b) => (a.rank - b.rank) || byProminence(a.n, b.n))
    .slice(0, limit)
    .map(s => s.n)
}

// ─── Display helpers ─────────────────────────────────────────────────────────

/**
 * "12 links · 3 back" — a node's connectivity, in words.
 *
 * The web encodes this as RADIUS (a bigger circle is a more connected note).
 * A list has no radius, and reproducing one as a bar chart would be decoration;
 * the number is what the radius was standing in for, so the list just says it.
 */
export function connectivityLabel(index: GraphIndex, id: string): string {
  const out = (index.out.get(id) ?? []).length
  const inn = (index.in.get(id) ?? []).length
  if (!out && !inn) return 'no links'
  const parts: string[] = []
  if (out) parts.push(`${out} link${out === 1 ? '' : 's'}`)
  if (inn) parts.push(`${inn} back`)
  return parts.join(' · ')
}

/** A tag node's id is `tag:<name>`; a note's is its path. Used for glyphs. */
export function nodeGlyph(n: NoteNode): string {
  return n.kind === 'tag' ? '#' : n.kind === 'heading' ? '§' : '📄'
}
