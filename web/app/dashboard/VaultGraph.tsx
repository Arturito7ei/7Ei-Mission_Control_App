'use client'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY,
} from 'd3-force'
import { api } from '@/lib/api'
import { tk, text, space } from './tokens'
import { Button, TextInput, Skeleton } from './ui'
import {
  W, H, radiusOf, labelBudget, isDragGesture, shouldLabelMatches,
  labelSet, visibleSubset, zoomAt, fitTransform, adjacency, keyboardOrder, nextFocusIndex, domId,
  type GNode, type GEdge,
} from '@/lib/vaultGraphView'

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

type GraphResp = {
  source: 'graphify' | 'native'
  nodes: GNode[]; edges: GEdge[]
  stats: { notes: number; tags: number; links: number; unresolved: number; communities?: number; truncated?: boolean; capped?: number; totalNodes?: number }
  repo: string; root: string; branch: string
  hasGraphify: boolean; graphPath?: string; graphifyError?: string; rebuildCommand: string; cached?: boolean
}

// Folder → hue. Ten tokenised slots derived from Okabe–Ito, tuned per theme in
// tokens.ts (which carries the measured numbers).
//
// Colour here is a CLUSTER HINT, not an identifier: ten categorical colours
// cannot all stay distinguishable under three dichromacies — that is measured,
// not assumed. The IDENTIFIER is the folder NAME beside every swatch in the
// filter chips, which is why hue is never the sole signal and why the chips are
// the legend rather than a separate key.
const CVD = Array.from({ length: 10 }, (_, i) => `var(--graph-${i + 1})`)
const TAG_COLOR = 'var(--graph-tag)'

type P = GNode & { x: number; y: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null }
type L = { source: P; target: P; relation: string }


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

  // The drawn subset — kind filter (headings off by default, so the map stays
  // legible), folder filter, then the render cap.
  // The logic lives in lib/vaultGraphView.ts so it can be tested without a DOM.
  const filtered = useMemo(
    () => visibleSubset(data, { showTags, showHeadings, hiddenGroups }),
    [data, showHeadings, showTags, hiddenGroups],
  )

  /**
   * THE BUSY SEAM. `computeLayout` cools the simulation SYNCHRONOUSLY — ~570ms
   * at the cap — and it re-runs on every filter toggle, not just on load. A
   * spinner set in the same render can never help: React would render, block in
   * the memo, and paint once, at the end. The user sees a frozen tab and cannot
   * tell "thinking" from "crashed".
   *
   * `useDeferredValue` is the seam. React renders once with the PREVIOUS drawn
   * set (so the old map stays on screen, dimmed, with a busy chip), paints that
   * frame, and only then re-renders with the new value — which is where the
   * expensive memo actually runs. Everything derived from the drawn set reads
   * `drawn`, not `filtered`, so the stale frame stays internally coherent
   * (adjacency, labels and keyboard order all describe the map being shown,
   * never a mix of the old layout and the new selection).
   *
   * Note `filtered` deliberately does NOT depend on `query`: typing must never
   * re-cool the simulation. Search only dims and highlights what is already
   * laid out, so it stays instant no matter how large the vault is.
   */
  const drawn = useDeferredValue(filtered)
  const cooling = drawn !== filtered
  const layout = useMemo(() => computeLayout(drawn.nodes, drawn.edges), [drawn])

  // Folder → colour, stable + legend-backed. Indexed off the FULL folder list so
  // a folder keeps its hue when others are filtered out.
  const groups = useMemo(() => {
    const map = new Map<string, string>()
    allGroups.forEach((name, i) => map.set(name, CVD[i % CVD.length]))
    return map
  }, [allGroups])
  const colorOf = (n: GNode) => n.kind === 'tag' ? TAG_COLOR : (groups.get(n.group) ?? CVD[0])

  // Adjacency for hover/focus highlight.
  const adj = useMemo(() => adjacency(drawn.edges), [drawn])

  const q = query.trim().toLowerCase()
  const matches = useCallback((n: GNode) => q !== '' && (n.label.toLowerCase().includes(q) || !!n.communityName?.toLowerCase().includes(q)), [q])
  const matchCount = useMemo(() => q === '' ? 0 : drawn.nodes.filter(matches).length, [q, drawn, matches])
  /**
   * A search hit is always labelled — UNLESS the search is so broad that
   * labelling every hit re-creates the text soup the label budget exists to
   * prevent. Typing a single common letter matches most of the vault; those
   * matches still get the accent stroke, they just don't all shout their name.
   */
  const matchesFit = shouldLabelMatches(matchCount, labelCap)

  // Keyboard order: hubs first. Arrowing through the graph should walk the most
  // connected notes before the leaves — that's the order the map is FOR.
  const kbOrder = useMemo(() => keyboardOrder(drawn.nodes), [drawn])

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
    const v = fitTransform(layout.pnodes, W, H)
    view.current = v
    applyTransform()
    setLabelCap(labelBudget(v.k))
  }, [layout, applyTransform])

  // Re-frame whenever the drawn set changes (load, filter, tag/heading toggle).
  useEffect(() => { fitView() }, [fitView])

  /** Only re-render when the zoom crosses a LABEL threshold, not on every tick. */
  const syncZoomFloor = useCallback(() => {
    const f = labelBudget(view.current.k)
    setLabelCap(prev => prev === f ? prev : f)
  }, [])

  // Which nodes get to draw their name: the most-connected, up to the budget.
  const labelled = useMemo(() => labelSet(drawn.nodes, labelCap), [drawn, labelCap])

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
    view.current = zoomAt(view.current, mx, my, e.deltaY)
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
      if (isDragGesture(e.clientX - d.sx, e.clientY - d.sy)) draggedFar.current = true
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
    const n = drawn.nodes.find(x => x.id === id)
    if (n?.path) onOpenNote(n.path)
  }, [drawn, onOpenNote])

  /**
   * The canvas is ONE tab stop with roving focus (aria-activedescendant), not
   * 600 of them: tabbing through every node in a force graph is not access, it's
   * a trap. Arrows walk the hub-first order, Enter opens, Escape lets go.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!kbOrder.length) return
    const i = focusId ? kbOrder.findIndex(n => n.id === focusId) : -1
    const go = (next: number) => {
      const id = kbOrder[nextFocusIndex(next, 0, kbOrder.length)].id
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
  const nothingToDraw = !!data && drawn.nodes.length === 0 && !cooling

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
        {/* FIX-1 — a graph.json we FOUND but could not use is not the same as not
            having one. Silently falling back said "◇ Native parse" and left the
            operator with no idea their committed graph was corrupt or wrongly rooted. */}
        {data?.graphifyError && (
          <span style={{ ...s.meta, color: 'var(--warn)' }} title={data.graphifyError} role="status">
            ⚠ graphify file unusable
          </span>
        )}
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
            ref={attachSvg} viewBox={`0 0 ${W} ${H}`} style={{
              width: '100%', height: H, touchAction: 'none',
              cursor: cooling ? 'progress' : drag.current.panning ? 'grabbing' : 'grab',
              // Dim the STALE map while the next one cools, and stop it taking
              // input it would answer with the old layout's coordinates.
              opacity: cooling ? 0.4 : 1,
              pointerEvents: cooling ? 'none' : undefined,
              transition: 'opacity .12s linear',
            }}
            onPointerDown={onPointerDownBg} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={endDrag} onPointerCancel={endDrag}
            // One tab stop, roving focus. `application` is the role that carries
            // aria-activedescendant for a canvas-shaped widget.
            tabIndex={0} role="application" onKeyDown={onKeyDown}
            onBlur={() => setFocusId(null)}
            aria-label={`Vault graph: ${drawn.nodes.length} nodes, ${drawn.edges.length} links. Arrow keys move between notes (most connected first), Enter opens the focused note, Escape clears focus.`}
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

          {/* The one affordance that separates "it's thinking" from "it crashed".
              `aria-live="polite"` so a screen reader is told too — the canvas
              going quiet for half a second is otherwise silent to it. */}
          {cooling && (
            <div style={s.busy} role="status" aria-live="polite">
              <span style={s.spinner} aria-hidden="true" />
              Laying out {filtered.nodes.length} note{filtered.nodes.length === 1 ? '' : 's'}…
            </div>
          )}

          {/* Cap notice — a partial map must say it is partial. */}
          {drawn.dropped > 0 && (
            <div style={s.capNote} role="status">
              Showing the {drawn.nodes.length} most-connected of {drawn.nodes.length + drawn.dropped} · {drawn.dropped} leaf notes hidden to keep the map interactive
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
  // Centred, so it reads as the canvas's own state rather than a toolbar note.
  busy: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: space.sm, fontSize: text.sm.fontSize, color: tk.textDim, pointerEvents: 'none' },
  // Reuses the existing `mcOrbSpin` keyframe from globals.css — no new animation.
  spinner: { width: 13, height: 13, borderRadius: '50%', border: `2px solid var(--line-strong)`, borderTopColor: tk.accent, display: 'inline-block', animation: 'mcOrbSpin .7s linear infinite' },
  capNote: { position: 'absolute', right: space.md, top: space.md, fontSize: text.xs.fontSize, color: tk.textDim, background: 'var(--glass)', border: '1px solid var(--glass-line)', borderRadius: tk.r.sm, padding: `${space.xs}px ${space.sm}px`, backdropFilter: 'blur(6px)', maxWidth: '46%' },
  footer: { marginTop: space.sm, fontSize: text.sm.fontSize, color: tk.muted },
  link: { color: tk.blue, cursor: 'pointer' },
  code: { background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: 4, padding: '1px 5px', fontSize: text.xs.fontSize, color: tk.accent },
  cmd: { marginTop: 6, padding: space.sm, background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, fontSize: text.xs.fontSize, color: tk.textDim, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  err: { padding: 12, borderRadius: 10, background: 'var(--danger-bg)', border: `1px solid var(--danger-line)`, color: tk.text, fontSize: text.md.fontSize },
}
