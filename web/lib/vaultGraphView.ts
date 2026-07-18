// MEM-1 — the Memory graph's VIEW LOGIC, extracted from VaultGraph.tsx so it
// can be tested without a DOM.
//
// WHY THIS FILE EXISTS. The independent audit of #327 found two HIGH defects in
// the graph's interaction layer — a drag that navigated away, and a zoom that
// scrolled the page — and both reached `main` because 351 lines of new logic had
// no web test at all. The component cannot be rendered under `node --test`
// (no jest, no DOM), so anything left inside it is untestable by construction.
// Everything here is pure: same inputs, same outputs, no React, no document.
//
// The component keeps what genuinely needs the DOM (listener registration,
// refs, the SVG tree). This keeps the DECISIONS.

export type GNode = {
  id: string
  label: string
  kind: 'note' | 'tag' | 'heading'
  path?: string
  group: string
  degree: number
  tags?: string[]
  community?: number
  communityName?: string
}

export type GEdge = { source: string; target: string; relation: string; weight: number }

/** Canvas coordinate space. The SVG scales; the space doesn't. */
export const W = 960
export const H = 620

/** See VaultGraph.tsx for the measured degradation curve behind this number. */
export const RENDER_CAP = 600

/**
 * Pointer travel, in client px, past which a node interaction is a DRAG and not
 * a click.
 *
 * This exists because a click always jitters a pixel or two — a mouse moves
 * between press and release, and a trackpad tap moves more. Without a slop
 * threshold you must choose between "every click is a drag" and "every drag is
 * also a click", and the audit caught us shipping the latter: releasing a node
 * you had just dragged fired `onClick`, which opened the Reader, which unmounts
 * the graph. The layout you had just arranged by hand was impossible to look at.
 */
export const DRAG_SLOP = 4

/** Node radius — degree-scaled, so a hub reads as a hub. Tags are fixed and small. */
export function radiusOf(n: { degree: number; kind: string }): number {
  if (n.kind === 'tag') return 3.5
  return 4 + Math.min(11, Math.sqrt(n.degree) * 2.2)
}

/**
 * How many labels the canvas may draw at a given zoom — a BUDGET, not a degree
 * threshold. A fixed floor ("label degree >= 4") reads fine on a sparse vault
 * and turns a dense one into unreadable text soup, because a dense graph has
 * hundreds of nodes past any floor. The screen's room for text is roughly fixed,
 * so the budget is fixed and the highest-degree nodes spend it.
 */
export function labelBudget(k: number): number {
  if (k < 0.7) return 12
  if (k < 1.4) return 40
  if (k < 2.5) return 110
  return 400
}

/** Did this pointer interaction travel far enough to be a drag rather than a click? */
export function isDragGesture(dx: number, dy: number, slop: number = DRAG_SLOP): boolean {
  return Math.abs(dx) > slop || Math.abs(dy) > slop
}

/**
 * Should search MATCHES be labelled?
 *
 * A hit is normally labelled regardless of budget — that's the point of
 * searching. But typing one common letter matches most of the vault, and
 * labelling every hit re-creates exactly the text soup the budget exists to
 * prevent. Above the budget the matches keep their accent stroke (still findable)
 * and simply stop shouting their names.
 *
 * Tied to the live `labelCap` rather than a literal, so zooming in — which
 * genuinely makes room for more text — also widens what search will label.
 */
export function shouldLabelMatches(matchCount: number, labelCap: number): boolean {
  return matchCount > 0 && matchCount <= labelCap
}

/** The ids allowed to draw their name: highest-degree first, up to the budget. */
export function labelSet(nodes: GNode[], cap: number): Set<string> {
  return new Set(
    nodes.filter(n => n.kind !== 'tag')
      .sort((a, b) => (b.degree - a.degree) || a.label.localeCompare(b.label))
      .slice(0, Math.max(0, cap))
      .map(n => n.id),
  )
}

/**
 * The drawn subset: kind filter → folder filter → render cap, with the edges
 * narrowed to survivors at each step.
 *
 * The cap sheds the LOWEST-degree nodes (leaves you'd find faster in the
 * Reader's tree) and reports how many went, because a partial map that doesn't
 * say it is partial is a lie about the vault.
 */
export function visibleSubset(
  data: { nodes: GNode[]; edges: GEdge[] } | null,
  opts: { showTags: boolean; showHeadings: boolean; hiddenGroups: ReadonlySet<string>; cap?: number },
): { nodes: GNode[]; edges: GEdge[]; dropped: number } {
  if (!data) return { nodes: [], edges: [], dropped: 0 }
  const cap = opts.cap ?? RENDER_CAP
  const byKind = data.nodes.filter(n =>
    (n.kind === 'note') || (n.kind === 'tag' && opts.showTags) || (n.kind === 'heading' && opts.showHeadings))
  // A tag has no folder of its own, so it rides along with whatever notes remain.
  const byGroup = byKind.filter(n => n.kind === 'tag' || !opts.hiddenGroups.has(n.group))

  let nodes = byGroup
  let dropped = 0
  if (byGroup.length > cap) {
    const keep = new Set(
      [...byGroup].sort((a, b) => (b.degree - a.degree) || a.id.localeCompare(b.id))
        .slice(0, cap).map(n => n.id),
    )
    // Filter the ORIGINAL order rather than using the sorted array, so the
    // layout's seeding order stays stable across filter changes.
    nodes = byGroup.filter(n => keep.has(n.id))
    dropped = byGroup.length - nodes.length
  }
  const keepIds = new Set(nodes.map(n => n.id))
  return { nodes, edges: data.edges.filter(e => keepIds.has(e.source) && keepIds.has(e.target)), dropped }
}

export type View = { k: number; x: number; y: number }

/** Zoom about a cursor point, so the pixel under the pointer stays put. */
export function zoomAt(view: View, mx: number, my: number, deltaY: number): View {
  const factor = deltaY < 0 ? 1.12 : 1 / 1.12
  const k = Math.max(0.2, Math.min(6, view.k * factor))
  return { k, x: mx - (mx - view.x) * (k / view.k), y: my - (my - view.y) * (k / view.k) }
}

/**
 * Frame the whole graph. A force layout's extent depends on how many nodes it
 * had to push apart, so a fixed k=1 shows a small vault marooned in space and a
 * large one spilling off every edge. Never zooms PAST 1:1 — a three-note vault
 * blown up to fill the canvas looks broken, not close.
 */
export function fitTransform(
  nodes: { x: number; y: number; degree: number; kind: string }[],
  w: number = W, h: number = H, pad = 28,
): View {
  if (!nodes.length) return { k: 1, x: 0, y: 0 }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of nodes) {
    const r = radiusOf(p)
    if (p.x - r < minX) minX = p.x - r
    if (p.x + r > maxX) maxX = p.x + r
    if (p.y - r < minY) minY = p.y - r
    if (p.y + r > maxY) maxY = p.y + r
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY)
  const k = Math.max(0.2, Math.min(1, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)))
  return { k, x: (w - (minX + maxX) * k) / 2, y: (h - (minY + maxY) * k) / 2 }
}

/** Undirected adjacency, for the hover/focus neighbourhood highlight. */
export function adjacency(edges: GEdge[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!m.has(e.source)) m.set(e.source, new Set())
    m.get(e.source)!.add(e.target)
    if (!m.has(e.target)) m.set(e.target, new Set())
    m.get(e.target)!.add(e.source)
  }
  return m
}

/** Keyboard walk order: hubs first — the order the map is FOR. */
export function keyboardOrder(nodes: GNode[]): GNode[] {
  return [...nodes].sort((a, b) => (b.degree - a.degree) || a.label.localeCompare(b.label))
}

/** Step the roving focus, wrapping at both ends. */
export function nextFocusIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1
  return ((current + delta) % length + length) % length
}

/** A DOM id for a node — node ids contain `/` and `:`, which ids may not. */
export const domId = (id: string) => `vg-${id.replace(/[^a-z0-9]/gi, '_')}`
