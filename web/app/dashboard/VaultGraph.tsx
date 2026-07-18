'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY,
} from 'd3-force'
import { api } from '@/lib/api'
import { tk, text, space } from './tokens'
import { Button, TextInput, Skeleton } from './ui'

// Epic M3 / MEM-1 — interactive force-directed map of the Obsidian vault.
// Renders from the backend /memory/graph (Graphify graph.json when present, the
// native [[wikilink]] parse otherwise). Layout is d3-force, cooled headlessly to
// a STATIC layout (no live timer — robust for large graphs); pan/zoom is applied
// to the <g> transform via a ref so panning never re-renders the node tree.
//
// MEM-1 added, on top of the Epic M original:
//   · a DRAWN-NODE CAP (see RENDER_CAP) so a large vault degrades by shedding
//     leaves rather than by freezing the tab;
//   · KEYBOARD access — the canvas is one tab stop with roving focus, so the
//     graph is operable without a pointer (and the Reader tab remains the
//     non-canvas fallback for the same data);
//   · folder filtering, zoom-responsive labels, real empty states, and a
//     palette that survives BOTH themes (the hues are tokens now — see
//     `--graph-*` in tokens.ts, where light darkens the pale end of Okabe–Ito).

type Getter = () => Promise<string | null>

type GNode = { id: string; label: string; kind: 'note' | 'tag' | 'heading'; path?: string; group: string; degree: number; tags?: string[]; community?: number; communityName?: string }
type GEdge = { source: string; target: string; relation: string; weight: number }
type GraphResp = {
  source: 'graphify' | 'native'
  nodes: GNode[]; edges: GEdge[]
  stats: { notes: number; tags: number; links: number; unresolved: number; communities?: number; truncated?: boolean; capped?: number; totalNodes?: number }
  repo: string; root: string; branch: string
  hasGraphify: boolean; graphPath?: string; rebuildCommand: string; cached?: boolean
}

// Folder → hue. Ten tokenised slots (Okabe–Ito, tuned per theme in tokens.ts).
// Every hue is paired with its folder NAME in the filter chips above the canvas,
// so colour is never the sole signal — the chips are the legend, made clickable.
const CVD = Array.from({ length: 10 }, (_, i) => `var(--graph-${i + 1})`)
const TAG_COLOR = 'var(--graph-tag)'

const W = 960, H = 620

/**
 * How many nodes we DRAW. The backend already bounds what it SENDS (1500), but
 * every drawn node is an SVG group plus a body in an O(n log n)-per-tick force
 * simulation, and the simulation runs synchronously on the main thread — so the
 * render budget is tighter than the transport budget.
 *
 * MEASURED (this exact force config, cooling a DENSE 8k-node Graphify graph —
 * 17.9k edges, denser than any real vault; the shipped TARCO vault at 153 drawn
 * nodes cools in 67ms):
 *
 *     nodes   edges   cool
 *       150     560    65ms     imperceptible
 *       300   1,565   235ms     fine
 *       600   3,101   597ms  ←  the cap: a visible hitch, still responsive
 *     1,000   4,532  1,070ms    crosses a second — the tab stops feeling alive
 *     2,500   9,946  3,350ms    janks hard
 *     4,000  13,603  5,879ms    unusable
 *
 * The cool is SYNCHRONOUS and re-runs on every filter change, so this is a
 * budget paid repeatedly, not once at load. 600 is where the hitch is still
 * worth the map. Above it we shed the LOWEST-degree nodes (the leaves you'd
 * find faster in the Reader's tree anyway) and say so in the toolbar, rather
 * than quietly showing a partial vault as if it were the whole one. A vault
 * that genuinely needs more than this wants a Graphify pass that CLUSTERS
 * before the browser ever sees it — not a bigger number here.
 */
const RENDER_CAP = 600

type P = GNode & { x: number; y: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null }
type L = { source: P; target: P; relation: string }

function radiusOf(n: { degree: number; kind: string }): number {
  if (n.kind === 'tag') return 3.5
  return 4 + Math.min(11, Math.sqrt(n.degree) * 2.2)
}

/** A DOM id for a node, for `aria-activedescendant` (node ids contain `/`). */
const domId = (id: string) => `vg-${id.replace(/[^a-z0-9]/gi, '_')}`

/**
 * How many labels the canvas may draw at a given zoom — a BUDGET, not a degree
 * threshold, and that distinction is load-bearing.
 *
 * A threshold ("label everything with degree ≥ 4") reads well on a sparse vault
 * and collapses on a dense one: the 8k-node stress graph has hundreds of nodes
 * past any fixed floor, so every one of them draws its name and the map becomes
 * unreadable text soup — exactly the hairball the labels were meant to prevent.
 * The screen has a roughly fixed amount of room for text, so the budget is
 * fixed too, and the highest-degree nodes spend it. Sparse vaults are unaffected
 * (they never had that many candidates); dense ones stay legible.
 *
 * Zoomed in, the same nodes occupy more space, so more names fit. The hovered /
 * focused / searched node is always labelled regardless of budget.
 */
function labelBudget(k: number): number {
  if (k < 0.7) return 12
  if (k < 1.4) return 40
  if (k < 2.5) return 110
  return 400
}

/** Cool a d3-force simulation to a static layout (no live timer). */
function computeLayout(nodes: GNode[], edges: GEdge[]): { pnodes: P[]; links: L[] } {
  const n = nodes.length || 1
  // deterministic-ish ring seeding avoids degenerate all-at-origin starts
  const pnodes: P[] = nodes.map((nd, i) => {
    const a = (i / n) * Math.PI * 2, r = 40 + (i % 40) * 6
    return { ...nd, x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r }
  })
  const byId = new Map(pnodes.map(p => [p.id, p]))
  const links: L[] = edges
    .filter(e => byId.has(e.source) && byId.has(e.target))
    .map(e => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, relation: e.relation }))

  const sim = forceSimulation(pnodes)
    .force('charge', forceManyBody().strength(-150).distanceMax(400))
    .force('link', forceLink(links).id((d: any) => d.id).distance(46).strength(0.35))
    .force('center', forceCenter(W / 2, H / 2))
    .force('collide', forceCollide().radius((d: any) => radiusOf(d) + 2))
    .force('x', forceX(W / 2).strength(0.035))
    .force('y', forceY(H / 2).strength(0.035))
    .stop()
  const ticks = Math.min(420, Math.max(140, Math.round(Math.sqrt(n) * 22)))
  for (let i = 0; i < ticks; i++) sim.tick()
  return { pnodes, links }
}

export default function VaultGraph({ orgId, getToken, onOpenNote }: { orgId: string; getToken: Getter; onOpenNote: (path: string) => void }) {
  const [data, setData] = useState<GraphResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [showHeadings, setShowHeadings] = useState(false)
  const [showTags, setShowTags] = useState(true)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [showCmd, setShowCmd] = useState(false)
  /** Folders the operator has switched OFF (empty = show everything). */
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set())
  /** Bucketed zoom — mirrored into state ONLY when it crosses a label
   *  threshold, so wheeling doesn't re-render the tree on every event. */
  const [labelCap, setLabelCap] = useState(() => labelBudget(1))

  const svgRef = useRef<SVGSVGElement | null>(null)
  const gRef = useRef<SVGGElement | null>(null)
  const view = useRef({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ id: string | null; panning: boolean; sx: number; sy: number; ox: number; oy: number }>({ id: null, panning: false, sx: 0, sy: 0, ox: 0, oy: 0 })
  const rafRef = useRef<number | null>(null)
  /** Set when a node pointer-down turned into a real drag, so the click that
   *  the browser fires on release doesn't ALSO open the note. Without this the
   *  drag is unusable: repositioning a node navigates to the Reader, which
   *  unmounts the graph — you can never see the layout you just arranged. */
  const draggedFar = useRef(false)

  const load = useCallback(async (rebuild = false) => {
    setLoading(true); setErr(null)
    try {
      const r = await api<GraphResp>(`/api/orgs/${orgId}/memory/graph${rebuild ? '?rebuild=1' : ''}`, { token: await getToken() })
      setData(r)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load graph') }
    setLoading(false)
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  // All folders present in the payload — the filter's universe. Derived from
  // the RAW data, not the filtered set, so switching a folder off doesn't make
  // its own chip disappear and strand the operator with no way to switch it on.
  const allGroups = useMemo(
    () => [...new Set((data?.nodes ?? []).filter(n => n.kind !== 'tag').map(n => n.group))].sort(),
    [data],
  )

  // Visible subset — default hides Graphify heading nodes so the map stays
  // legible, then applies the folder filter, then the draw cap.
  const filtered = useMemo(() => {
    if (!data) return { nodes: [] as GNode[], edges: [] as GEdge[], dropped: 0 }
    const byKind = data.nodes.filter(n =>
      (n.kind === 'note') || (n.kind === 'tag' && showTags) || (n.kind === 'heading' && showHeadings))
    // A tag node has no folder, so it rides along with whatever notes remain.
    const byGroup = byKind.filter(n => n.kind === 'tag' || !hiddenGroups.has(n.group))
    // Shed the least-connected first; keep the order stable for a stable layout.
    let nodes = byGroup, dropped = 0
    if (byGroup.length > RENDER_CAP) {
      const keep = new Set(
        [...byGroup].sort((a, b) => (b.degree - a.degree) || a.id.localeCompare(b.id))
          .slice(0, RENDER_CAP).map(n => n.id),
      )
      nodes = byGroup.filter(n => keep.has(n.id))
      dropped = byGroup.length - nodes.length
    }
    const keepIds = new Set(nodes.map(n => n.id))
    const edges = data.edges.filter(e => keepIds.has(e.source) && keepIds.has(e.target))
    return { nodes, edges, dropped }
  }, [data, showHeadings, showTags, hiddenGroups])

  const layout = useMemo(() => computeLayout(filtered.nodes, filtered.edges), [filtered])

  // Folder → colour, stable + legend-backed. Indexed off the FULL folder list so
  // a folder keeps its hue when others are filtered out.
  const groups = useMemo(() => {
    const map = new Map<string, string>()
    allGroups.forEach((name, i) => map.set(name, CVD[i % CVD.length]))
    return map
  }, [allGroups])
  const colorOf = (n: GNode) => n.kind === 'tag' ? TAG_COLOR : (groups.get(n.group) ?? CVD[0])

  // Adjacency for hover/focus highlight.
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of filtered.edges) {
      if (!m.has(e.source)) m.set(e.source, new Set()); m.get(e.source)!.add(e.target)
      if (!m.has(e.target)) m.set(e.target, new Set()); m.get(e.target)!.add(e.source)
    }
    return m
  }, [filtered])

  const q = query.trim().toLowerCase()
  const matches = useCallback((n: GNode) => q !== '' && (n.label.toLowerCase().includes(q) || !!n.communityName?.toLowerCase().includes(q)), [q])
  const matchCount = useMemo(() => q === '' ? 0 : filtered.nodes.filter(matches).length, [q, filtered, matches])
  /**
   * A search hit is always labelled — UNLESS the search is so broad that
   * labelling every hit re-creates the text soup the label budget exists to
   * prevent. Typing a single common letter matches most of the vault; those
   * matches still get the accent stroke, they just don't all shout their name.
   */
  const matchesFit = matchCount > 0 && matchCount <= 40

  // Keyboard order: hubs first. Arrowing through the graph should walk the most
  // connected notes before the leaves — that's the order the map is FOR.
  const kbOrder = useMemo(
    () => [...filtered.nodes].sort((a, b) => (b.degree - a.degree) || a.label.localeCompare(b.label)),
    [filtered],
  )

  const applyTransform = useCallback(() => {
    const v = view.current
    if (gRef.current) gRef.current.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`)
  }, [])

  /**
   * Frame the whole graph. A force layout's extent depends on how many nodes it
   * had to push apart, so a fixed k=1 shows a small vault marooned in space and
   * a large one spilling off every edge — the operator's first sight of the map
   * shouldn't be a map that needs fixing. Fit on load, and make "Reset view"
   * mean "back to the whole graph" rather than "back to an arbitrary scale".
   */
  const fitView = useCallback(() => {
    const ps = layout.pnodes
    if (!ps.length) { view.current = { k: 1, x: 0, y: 0 }; applyTransform(); return }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of ps) {
      const r = radiusOf(p)
      if (p.x - r < minX) minX = p.x - r
      if (p.x + r > maxX) maxX = p.x + r
      if (p.y - r < minY) minY = p.y - r
      if (p.y + r > maxY) maxY = p.y + r
    }
    const pad = 28
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY)
    // Never zoom PAST 1:1 — a three-note vault blown up to fill 960×620 looks
    // broken, not close. Only ever scale down to fit.
    const k = Math.max(0.2, Math.min(1, Math.min((W - pad * 2) / w, (H - pad * 2) / h)))
    view.current = {
      k,
      x: (W - (minX + maxX) * k) / 2,
      y: (H - (minY + maxY) * k) / 2,
    }
    applyTransform()
    setLabelCap(labelBudget(k))
  }, [layout, applyTransform])

  // Re-frame whenever the drawn set changes (load, filter, tag/heading toggle).
  useEffect(() => { fitView() }, [fitView])

  /** Only re-render when the zoom crosses a LABEL threshold, not on every tick. */
  const syncZoomFloor = useCallback(() => {
    const f = labelBudget(view.current.k)
    setLabelCap(prev => prev === f ? prev : f)
  }, [])

  // Which nodes get to draw their name: the most-connected, up to the budget.
  const labelled = useMemo(() => new Set(
    filtered.nodes.filter(n => n.kind !== 'tag')
      .sort((a, b) => (b.degree - a.degree) || a.label.localeCompare(b.label))
      .slice(0, labelCap).map(n => n.id),
  ), [filtered, labelCap])

  // Pan/zoom via direct DOM transform (no React re-render while dragging).
  //
  // Registered as a NATIVE listener below, not via `onWheel`. React delegates
  // `wheel` at the root as PASSIVE, so `preventDefault()` on the synthetic
  // event is silently ignored — zooming the graph would also scroll the
  // dashboard out from under it. Only a non-passive listener can hold the page.
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = svgRef.current!.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (W / rect.width), my = (e.clientY - rect.top) * (H / rect.height)
    const v = view.current
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const k = Math.max(0.2, Math.min(6, v.k * factor))
    v.x = mx - (mx - v.x) * (k / v.k); v.y = my - (my - v.y) * (k / v.k); v.k = k
    applyTransform(); syncZoomFloor()
  }
  const toGraph = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const px = (clientX - rect.left) * (W / rect.width), py = (clientY - rect.top) * (H / rect.height)
    const v = view.current
    return { x: (px - v.x) / v.k, y: (py - v.y) / v.k }
  }
  const onPointerDownBg = (e: React.PointerEvent) => {
    drag.current = { id: null, panning: true, sx: e.clientX, sy: e.clientY, ox: view.current.x, oy: view.current.y }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d.panning) {
      const rect = svgRef.current!.getBoundingClientRect()
      view.current.x = d.ox + (e.clientX - d.sx) * (W / rect.width)
      view.current.y = d.oy + (e.clientY - d.sy) * (H / rect.height)
      applyTransform()
    } else if (d.id) {
      // 4px of slop: a click always jitters a pixel or two, a drag doesn't.
      if (Math.abs(e.clientX - d.sx) > 4 || Math.abs(e.clientY - d.sy) > 4) draggedFar.current = true
      const p = toGraph(e.clientX, e.clientY)
      const node = layout.pnodes.find(n => n.id === d.id)
      if (!node) return
      node.x = p.x; node.y = p.y
      // Coalesce to one re-render per FRAME. A pointermove can fire at 120–240Hz
      // on a high-rate trackpad; re-rendering the whole node tree that often is
      // how a drag turns to treacle on a big map.
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => { rafRef.current = null; forceRerender(x => x + 1) })
      }
    }
  }
  const endDrag = () => { drag.current = { id: null, panning: false, sx: 0, sy: 0, ox: 0, oy: 0 } }

  // Non-passive wheel registration. The handler is re-created every render, so
  // it goes through a ref — that keeps the listener itself stable (registered
  // once per mounted svg) while always calling the current closure.
  const wheelRef = useRef(onWheel)
  wheelRef.current = onWheel
  const wheelBound = useRef<((e: WheelEvent) => void) | null>(null)
  // A ref CALLBACK, not an effect: the svg mounts and unmounts with the
  // empty/error branches, and a callback ref fires exactly on that transition
  // without needing to name the state that caused it.
  const attachSvg = useCallback((el: SVGSVGElement | null) => {
    if (svgRef.current && wheelBound.current) {
      svgRef.current.removeEventListener('wheel', wheelBound.current)
      wheelBound.current = null
    }
    svgRef.current = el
    if (el) {
      const h = (e: WheelEvent) => wheelRef.current(e)
      wheelBound.current = h
      el.addEventListener('wheel', h, { passive: false })
    }
  }, [])
  const [, forceRerender] = useState(0)
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }, [])

  const resetView = () => fitView()

  /** Bring a node to the middle of the canvas — keyboard focus must be VISIBLE. */
  const centerOn = useCallback((id: string) => {
    const n = layout.pnodes.find(p => p.id === id)
    if (!n) return
    const v = view.current
    v.x = W / 2 - n.x * v.k
    v.y = H / 2 - n.y * v.k
    applyTransform()
  }, [layout, applyTransform])

  const openNode = useCallback((id: string) => {
    const n = filtered.nodes.find(x => x.id === id)
    if (n?.path) onOpenNote(n.path)
  }, [filtered, onOpenNote])

  /**
   * The canvas is ONE tab stop with roving focus (aria-activedescendant), not
   * 600 of them: tabbing through every node in a force graph is not access, it's
   * a trap. Arrows walk the hub-first order, Enter opens, Escape lets go.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!kbOrder.length) return
    const i = focusId ? kbOrder.findIndex(n => n.id === focusId) : -1
    const go = (next: number) => {
      const id = kbOrder[(next + kbOrder.length) % kbOrder.length].id
      setFocusId(id); centerOn(id)
      e.preventDefault()
    }
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': return go(i + 1)
      case 'ArrowLeft': case 'ArrowUp': return go(i - 1)
      case 'Home': return go(0)
      case 'End': return go(kbOrder.length - 1)
      case 'Enter': case ' ':
        if (focusId) { openNode(focusId); e.preventDefault() }
        return
      case 'Escape':
        if (focusId) { setFocusId(null); e.preventDefault() }
        return
    }
  }

  // Hover and keyboard focus drive the SAME neighbourhood highlight.
  const active = hover ?? focusId

  if (err) return (
    <div style={s.err}>⚠ {err}
      {/vault/i.test(err) && <div style={{ marginTop: 6, color: tk.muted }}>Connect the vault in <b>Connectors → Obsidian Vault</b> (repo, root, branch, GitHub token).</div>}
      <div style={{ marginTop: 6, color: tk.muted }}>The same notes are readable without the map — switch to <b>📄 Reader</b>.</div>
    </div>
  )

  const totalNodes = data?.stats.totalNodes ?? data?.nodes.length ?? 0
  const nothingToDraw = !!data && filtered.nodes.length === 0

  return (
    <div>
      <div style={s.toolbar}>
        <TextInput placeholder="Search notes…" value={query} onChange={e => setQuery(e.target.value)} style={{ width: 200 }} aria-label="Search notes in the graph" />
        {q !== '' && <span style={s.meta} role="status">{matchCount} match{matchCount === 1 ? '' : 'es'}</span>}
        <label style={s.chk}><input type="checkbox" checked={showTags} onChange={e => setShowTags(e.target.checked)} /> Tags</label>
        {data?.nodes.some(n => n.kind === 'heading') &&
          <label style={s.chk}><input type="checkbox" checked={showHeadings} onChange={e => setShowHeadings(e.target.checked)} /> Headings</label>}
        <Button onClick={() => { resetView(); setQuery(''); setHiddenGroups(new Set()); setFocusId(null) }} style={{ fontSize: text.sm.fontSize }}>⤢ Reset view</Button>
        <div style={{ flex: 1 }} />
        {data && <span style={s.meta}>
          {data.source === 'graphify'
            ? <span title={data.graphPath}>⬡ Graphify · {data.stats.notes} notes · {data.stats.links} links{data.stats.communities ? ` · ${data.stats.communities} concepts` : ''}</span>
            : <span>◇ Native parse · {data.stats.notes} notes · {data.stats.links} links{data.stats.unresolved ? ` · ${data.stats.unresolved} unresolved` : ''}{data.stats.truncated ? ' · truncated' : ''}</span>}
        </span>}
        <Button onClick={() => load(true)} disabled={loading} style={{ fontSize: text.sm.fontSize }}>↻ Rebuild</Button>
      </div>

      {/* Folder filter — the legend IS the control, so there is one list to read
          and one place to click, rather than a legend that only explains. */}
      {allGroups.length > 1 && (
        <div style={s.chips} role="group" aria-label="Filter by folder">
          {allGroups.map(name => {
            const on = !hiddenGroups.has(name)
            return (
              <button key={name} onClick={() => setHiddenGroups(prev => {
                const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n
              })}
                aria-pressed={on}
                title={on ? `Hide ${name}` : `Show ${name}`}
                style={{ ...s.chip, opacity: on ? 1 : 0.4, borderColor: on ? 'var(--graph-node-stroke)' : 'transparent' }}>
                <span style={{ ...s.swatch, background: groups.get(name) }} />
                {name}
                {!on && <span style={{ color: tk.muted }}> ⃠</span>}
              </button>
            )
          })}
        </div>
      )}

      {loading && !data && <div style={s.canvas}><Skeleton h={H} /></div>}

      {!loading && data && (
        <div style={s.canvas}>
          {/* 0 nodes is a real state, not a blank canvas: an empty vault, a
              vault of unlinked notes, and every folder switched off are three
              different problems and each gets its own sentence. */}
          {nothingToDraw ? (
            <div style={s.empty}>
              <div style={{ fontSize: 28, marginBottom: space.sm }}>⬡</div>
              {hiddenGroups.size > 0
                ? <>Every folder is filtered out. <a style={s.link} onClick={() => setHiddenGroups(new Set())}>Show all folders</a>.</>
                : totalNodes === 0
                  ? <>This vault has no notes yet. Add markdown to <code style={s.code}>{data.root}/</code> and rebuild.</>
                  : <>Nothing to draw with the current filters — try switching <b>Tags</b> back on.</>}
              <div style={{ marginTop: space.md, color: tk.muted, fontSize: text.sm.fontSize }}>
                The vault is always browsable in <b>📄 Reader</b>.
              </div>
            </div>
          ) : (
          <svg
            ref={attachSvg} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, touchAction: 'none', cursor: drag.current.panning ? 'grabbing' : 'grab' }}
            onPointerDown={onPointerDownBg} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={endDrag} onPointerCancel={endDrag}
            // One tab stop, roving focus. `application` is the role that carries
            // aria-activedescendant for a canvas-shaped widget.
            tabIndex={0} role="application" onKeyDown={onKeyDown}
            onBlur={() => setFocusId(null)}
            aria-label={`Vault graph: ${filtered.nodes.length} nodes, ${filtered.edges.length} links. Arrow keys move between notes (most connected first), Enter opens the focused note, Escape clears focus.`}
            aria-activedescendant={focusId ? domId(focusId) : undefined}
          >
            <g ref={gRef}>
              {layout.links.map((l, i) => {
                const on = active != null && (l.source.id === active || l.target.id === active)
                return <line key={i} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y}
                  stroke={on ? tk.accent : 'var(--graph-edge)'} strokeWidth={on ? 1.4 : (l.relation === 'contains' ? 0.5 : 0.9)}
                  strokeOpacity={active != null && !on ? 0.12 : (l.relation === 'contains' ? 0.45 : 0.7)} />
              })}
              {layout.pnodes.map(n => {
                const neigh = active != null && (n.id === active || adj.get(active)?.has(n.id))
                const dim = (active != null && !neigh) || (q !== '' && !matches(n))
                const hot = matches(n)
                const isFocused = n.id === focusId
                const r = radiusOf(n)
                const showLabel = n.kind !== 'tag' && (labelled.has(n.id) || n.id === active || (hot && matchesFit))
                return (
                  <g key={n.id} id={domId(n.id)} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.18 : 1}
                    role="option" aria-selected={isFocused}
                    aria-label={`${n.label}${n.communityName ? `, ${n.communityName}` : ''}, ${n.degree} link${n.degree === 1 ? '' : 's'}, folder ${n.group}`}
                    style={{ cursor: n.path ? 'pointer' : 'default' }}
                    onPointerDown={(e) => { e.stopPropagation(); draggedFar.current = false; drag.current = { id: n.id, panning: false, sx: e.clientX, sy: e.clientY, ox: 0, oy: 0 }; (e.target as Element).setPointerCapture?.(e.pointerId) }}
                    onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(h => h === n.id ? null : h)}
                    onClick={() => { if (draggedFar.current) { draggedFar.current = false; return } if (n.path) onOpenNote(n.path) }}>
                    <title>{n.label}{n.communityName ? ` — ${n.communityName}` : ''}</title>
                    {/* The keyboard focus ring is a RING, not a colour swap — it
                        has to be legible on a node of any hue, in either theme. */}
                    {isFocused && <circle r={r + 5} fill="none" stroke={tk.accent} strokeWidth={2} strokeDasharray="3 2" />}
                    <circle r={r} fill={colorOf(n)} stroke={hot ? tk.accent : 'var(--graph-node-stroke)'} strokeWidth={hot ? 2 : 1} />
                    {showLabel &&
                      <text x={r + 3} y={3} fontSize={9} fill={tk.text} style={{ pointerEvents: 'none', paintOrder: 'stroke' }} stroke="var(--s1)" strokeWidth={2.5}>{n.label}</text>}
                  </g>
                )
              })}
            </g>
          </svg>
          )}

          {/* Cap notice — a partial map must say it is partial. */}
          {filtered.dropped > 0 && (
            <div style={s.capNote} role="status">
              Showing the {filtered.nodes.length} most-connected of {filtered.nodes.length + filtered.dropped} · {filtered.dropped} leaf notes hidden to keep the map interactive
            </div>
          )}
        </div>
      )}

      {data && (
        <div style={s.footer}>
          {data.hasGraphify
            ? <span>Rendering the committed Graphify graph. </span>
            : <span>No Graphify <code style={s.code}>graph.json</code> in the vault yet — showing the native wikilink parse. </span>}
          {!!data.stats.capped && <span>The vault has {data.stats.totalNodes} nodes; the server sent the {(data.stats.totalNodes ?? 0) - data.stats.capped} most-connected. </span>}
          <a style={s.link} onClick={() => setShowCmd(v => !v)}>{showCmd ? 'Hide' : 'How to (re)build the richer graph'}</a>
          {showCmd && <pre style={s.cmd}>{data.rebuildCommand}</pre>}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  toolbar: { display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginBottom: space.md },
  chk: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: text.sm.fontSize, color: tk.textDim, cursor: 'pointer' },
  meta: { fontSize: text.sm.fontSize, color: tk.muted },
  canvas: { position: 'relative', background: tk.surface, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, overflow: 'hidden' },
  // folder filter chips (the legend, made interactive)
  chips: { display: 'flex', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: text.xs.fontSize, color: tk.textDim, background: tk.surface, border: '1px solid', borderRadius: tk.r.pill, padding: `3px ${space.md}px`, cursor: 'pointer' },
  swatch: { width: 9, height: 9, borderRadius: 2, display: 'inline-block', flex: '0 0 auto' },
  empty: { height: H, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: tk.textDim, fontSize: text.md.fontSize, padding: space.xl },
  capNote: { position: 'absolute', right: space.md, top: space.md, fontSize: text.xs.fontSize, color: tk.textDim, background: 'var(--glass)', border: '1px solid var(--glass-line)', borderRadius: tk.r.sm, padding: `${space.xs}px ${space.sm}px`, backdropFilter: 'blur(6px)', maxWidth: '46%' },
  footer: { marginTop: space.sm, fontSize: text.sm.fontSize, color: tk.muted },
  link: { color: tk.blue, cursor: 'pointer' },
  code: { background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: 4, padding: '1px 5px', fontSize: text.xs.fontSize, color: tk.accent },
  cmd: { marginTop: 6, padding: space.sm, background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, fontSize: text.xs.fontSize, color: tk.textDim, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  err: { padding: 12, borderRadius: 10, background: 'var(--danger-bg)', border: `1px solid var(--danger-line)`, color: tk.text, fontSize: text.md.fontSize },
}
