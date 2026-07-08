'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY,
} from 'd3-force'
import { api } from '@/lib/api'
import { tk, text, space } from './tokens'
import { Button, TextInput, Skeleton } from './ui'

// Epic M3 — interactive force-directed map of the Obsidian vault. Renders from
// the backend /memory/graph (Graphify graph.json when present, native
// [[wikilink]] parse otherwise). Layout is d3-force, cooled headlessly to a
// static layout (robust for large graphs); pan/zoom is applied to the <g>
// transform via a ref so panning never re-renders the node/edge tree.

type Getter = () => Promise<string | null>

type GNode = { id: string; label: string; kind: 'note' | 'tag' | 'heading'; path?: string; group: string; degree: number; tags?: string[]; community?: number; communityName?: string }
type GEdge = { source: string; target: string; relation: string; weight: number }
type GraphResp = {
  source: 'graphify' | 'native'
  nodes: GNode[]; edges: GEdge[]
  stats: { notes: number; tags: number; links: number; unresolved: number; communities?: number; truncated?: boolean }
  repo: string; root: string; branch: string
  hasGraphify: boolean; graphPath?: string; rebuildCommand: string; cached?: boolean
}

// Okabe–Ito qualitative palette — the canonical colorblind-safe categorical
// ramp (deuteranopia/protanopia/tritanopia distinguishable). Folder → hue is
// always paired with the text legend below, so color is never the sole signal.
const CVD = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#F0E442', '#999999', '#664D9E', '#117733']
const TAG_COLOR = '#8a8a8a'

const W = 960, H = 620

type P = GNode & { x: number; y: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null }
type L = { source: P; target: P; relation: string }

function radiusOf(n: { degree: number; kind: string }): number {
  if (n.kind === 'tag') return 3.5
  return 4 + Math.min(11, Math.sqrt(n.degree) * 2.2)
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
  const [showCmd, setShowCmd] = useState(false)

  const svgRef = useRef<SVGSVGElement | null>(null)
  const gRef = useRef<SVGGElement | null>(null)
  const view = useRef({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ id: string | null; panning: boolean; sx: number; sy: number; ox: number; oy: number }>({ id: null, panning: false, sx: 0, sy: 0, ox: 0, oy: 0 })

  const load = useCallback(async (rebuild = false) => {
    setLoading(true); setErr(null)
    try {
      const r = await api<GraphResp>(`/api/orgs/${orgId}/memory/graph${rebuild ? '?rebuild=1' : ''}`, { token: await getToken() })
      setData(r)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load graph') }
    setLoading(false)
  }, [orgId, getToken])

  useEffect(() => { load() }, [load])

  // Visible subset — default hides Graphify heading nodes so the map stays legible.
  const filtered = useMemo(() => {
    if (!data) return { nodes: [] as GNode[], edges: [] as GEdge[] }
    const nodes = data.nodes.filter(n =>
      (n.kind === 'note') || (n.kind === 'tag' && showTags) || (n.kind === 'heading' && showHeadings))
    const keep = new Set(nodes.map(n => n.id))
    const edges = data.edges.filter(e => keep.has(e.source) && keep.has(e.target))
    return { nodes, edges }
  }, [data, showHeadings, showTags])

  const layout = useMemo(() => computeLayout(filtered.nodes, filtered.edges), [filtered])

  // Folder → color, stable + legend-backed.
  const groups = useMemo(() => {
    const g = [...new Set(filtered.nodes.filter(n => n.kind !== 'tag').map(n => n.group))].sort()
    const map = new Map<string, string>()
    g.forEach((name, i) => map.set(name, CVD[i % CVD.length]))
    return map
  }, [filtered])
  const colorOf = (n: GNode) => n.kind === 'tag' ? TAG_COLOR : (groups.get(n.group) ?? CVD[0])

  // Adjacency for hover-highlight.
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

  const applyTransform = useCallback(() => {
    const v = view.current
    if (gRef.current) gRef.current.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`)
  }, [])
  useEffect(() => { applyTransform() }, [layout, applyTransform])

  // Pan/zoom via direct DOM transform (no React re-render while dragging).
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = svgRef.current!.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (W / rect.width), my = (e.clientY - rect.top) * (H / rect.height)
    const v = view.current
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const k = Math.max(0.2, Math.min(6, v.k * factor))
    v.x = mx - (mx - v.x) * (k / v.k); v.y = my - (my - v.y) * (k / v.k); v.k = k
    applyTransform()
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
      const p = toGraph(e.clientX, e.clientY)
      const node = layout.pnodes.find(n => n.id === d.id)
      if (node) { node.x = p.x; node.y = p.y; forceRerender(x => x + 1) }
    }
  }
  const endDrag = () => { drag.current = { id: null, panning: false, sx: 0, sy: 0, ox: 0, oy: 0 } }
  const [, forceRerender] = useState(0)

  const resetView = () => { view.current = { k: 1, x: 0, y: 0 }; applyTransform() }

  if (err) return (
    <div style={s.err}>⚠ {err}
      {/vault/i.test(err) && <div style={{ marginTop: 6, color: tk.muted }}>Connect the vault in <b>Connectors → Obsidian Vault</b> (repo, root, branch, GitHub token).</div>}
    </div>
  )

  return (
    <div>
      <div style={s.toolbar}>
        <TextInput placeholder="Search notes…" value={query} onChange={e => setQuery(e.target.value)} style={{ width: 200 }} aria-label="Search notes in the graph" />
        <label style={s.chk}><input type="checkbox" checked={showTags} onChange={e => setShowTags(e.target.checked)} /> Tags</label>
        {data?.nodes.some(n => n.kind === 'heading') &&
          <label style={s.chk}><input type="checkbox" checked={showHeadings} onChange={e => setShowHeadings(e.target.checked)} /> Headings</label>}
        <Button onClick={resetView} style={{ fontSize: text.sm.fontSize }}>⤢ Reset view</Button>
        <div style={{ flex: 1 }} />
        {data && <span style={s.meta}>
          {data.source === 'graphify'
            ? <span title={data.graphPath}>⬡ Graphify · {data.stats.notes} notes · {data.stats.links} links{data.stats.communities ? ` · ${data.stats.communities} concepts` : ''}</span>
            : <span>◇ Native parse · {data.stats.notes} notes · {data.stats.links} links{data.stats.unresolved ? ` · ${data.stats.unresolved} unresolved` : ''}{data.stats.truncated ? ' · truncated' : ''}</span>}
        </span>}
        <Button onClick={() => load(true)} disabled={loading} style={{ fontSize: text.sm.fontSize }}>↻ Rebuild</Button>
      </div>

      {loading && !data && <div style={s.canvas}><Skeleton h={H} /></div>}

      {!loading && data && (
        <div style={s.canvas}>
          <svg
            ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, touchAction: 'none', cursor: drag.current.panning ? 'grabbing' : 'grab' }}
            onWheel={onWheel} onPointerDown={onPointerDownBg} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={endDrag}
          >
            <g ref={gRef}>
              {layout.links.map((l, i) => {
                const active = hover != null && (l.source.id === hover || l.target.id === hover)
                return <line key={i} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y}
                  stroke={active ? tk.accent : 'var(--line-strong)'} strokeWidth={active ? 1.4 : (l.relation === 'contains' ? 0.5 : 0.9)}
                  strokeOpacity={hover != null && !active ? 0.12 : (l.relation === 'contains' ? 0.35 : 0.55)} />
              })}
              {layout.pnodes.map(n => {
                const neigh = hover != null && (n.id === hover || adj.get(hover)?.has(n.id))
                const dim = (hover != null && !neigh) || (q !== '' && !matches(n))
                const hot = matches(n)
                const r = radiusOf(n)
                return (
                  <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.18 : 1}
                    style={{ cursor: n.path ? 'pointer' : 'default' }}
                    onPointerDown={(e) => { e.stopPropagation(); drag.current = { id: n.id, panning: false, sx: e.clientX, sy: e.clientY, ox: 0, oy: 0 }; (e.target as Element).setPointerCapture?.(e.pointerId) }}
                    onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(h => h === n.id ? null : h)}
                    onClick={() => { if (n.path) onOpenNote(n.path) }}>
                    <title>{n.label}{n.communityName ? ` — ${n.communityName}` : ''}</title>
                    <circle r={r} fill={colorOf(n)} stroke={hot ? tk.accent : 'var(--s1)'} strokeWidth={hot ? 2 : 1} />
                    {(n.kind !== 'tag') && (n.degree >= 4 || n.id === hover || hot) &&
                      <text x={r + 3} y={3} fontSize={9} fill={tk.text} style={{ pointerEvents: 'none', paintOrder: 'stroke' }} stroke="var(--s1)" strokeWidth={2.5}>{n.label}</text>}
                  </g>
                )
              })}
            </g>
          </svg>

          {/* folder legend — color is always paired with the folder name (never color-only) */}
          <div style={s.legend}>
            {[...groups.entries()].map(([name, c]) => (
              <span key={name} style={s.legendItem}><span style={{ ...s.swatch, background: c }} /> {name}</span>
            ))}
            {filtered.nodes.some(n => n.kind === 'tag') && <span style={s.legendItem}><span style={{ ...s.swatch, background: TAG_COLOR }} /> #tags</span>}
          </div>
        </div>
      )}

      {data && (
        <div style={s.footer}>
          {data.hasGraphify
            ? <span>Rendering the committed Graphify graph. </span>
            : <span>No Graphify <code style={s.code}>graph.json</code> in the vault yet — showing the native wikilink parse. </span>}
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
  legend: { position: 'absolute', left: space.md, bottom: space.md, display: 'flex', flexWrap: 'wrap', gap: `4px ${space.md}px`, maxWidth: '70%', padding: `${space.xs}px ${space.sm}px`, background: 'var(--glass)', border: `1px solid var(--glass-line)`, borderRadius: tk.r.sm, backdropFilter: 'blur(6px)' },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: text.xs.fontSize, color: tk.textDim },
  swatch: { width: 9, height: 9, borderRadius: 2, display: 'inline-block' },
  footer: { marginTop: space.sm, fontSize: text.sm.fontSize, color: tk.muted },
  link: { color: tk.blue, cursor: 'pointer' },
  code: { background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: 4, padding: '1px 5px', fontSize: text.xs.fontSize, color: tk.accent },
  cmd: { marginTop: 6, padding: space.sm, background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: tk.r.sm, fontSize: text.xs.fontSize, color: tk.textDim, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  err: { padding: 12, borderRadius: 10, background: 'var(--danger-bg)', border: `1px solid var(--danger-line)`, color: tk.text, fontSize: text.md.fontSize },
}
