'use client'
// P2 — interactive org-chart canvas (replaces the MCA-80 indented list).
// Drag to pan, wheel/pinch or the +/−/⤢ controls to zoom, click a card to open
// the agent. Geometry lives in web/lib/orgLayout (pure + tested); this file is
// only wiring: pointer state → transform → two stacked layers (SVG edges under
// absolutely-positioned cards), both sharing the same translate/scale.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tk, text, space } from '../tokens'
import { SectionLabel, Button } from '../ui'
import { statusColor, statusIcon, canonicalStatus } from '../status'
import { AgentAvatar } from '../agent/shared'
import { RUNTIME_BADGE, sx } from './shared'
import {
  computeOrgLayout, fitToView, zoomAbout, clampZoom,
  NODE_W, NODE_H, type OrgAgent, type PositionedNode,
} from '../../../lib/orgLayout'

/** Flat roster row the canvas renders. Superset of what /orgchart returns. */
export type OrgRosterAgent = OrgAgent & {
  avatarEmoji?: string | null
  avatarUrl?: string | null
  runtime?: string | null
  llmModel?: string | null
  jobDescription?: string | null
}

const DRAG_THRESHOLD = 6 // px of movement before a press counts as a pan, not a click
const ZOOM_STEP = 1.2

/** "Grok Build (local)" — the adapter/model line under the role. */
function runtimeLine(a: OrgRosterAgent): string {
  const rt = a.runtime ?? 'internal'
  const badge = RUNTIME_BADGE[rt] ?? '⚙️'
  if (rt === 'internal') return `${badge} Internal — 7Ei executor`
  return `${badge} ${rt}${a.llmModel ? ` · ${a.llmModel}` : ''}`
}

// ─── one card ────────────────────────────────────────────────────────────────

function OrgCard({ node, onOpen }: { node: PositionedNode<OrgRosterAgent>; onOpen: (id: string) => void }) {
  const status = canonicalStatus(node.status)
  return (
    <button
      type="button"
      onClick={() => onOpen(node.id)}
      title={`Open ${node.name}`}
      style={{
        position: 'absolute', left: node.x, top: node.y, width: NODE_W, minHeight: NODE_H,
        display: 'flex', alignItems: 'flex-start', gap: space.lg, textAlign: 'left',
        padding: space.lg, cursor: 'pointer',
        background: 'var(--glass-bg, var(--s1))', backdropFilter: 'blur(8px)',
        border: `1px solid ${tk.line}`, borderRadius: tk.r.lg, color: tk.text,
      }}
    >
      {/* Avatar + status dot. The dot is colour AND glyph — never colour alone. */}
      <span style={{ position: 'relative', flexShrink: 0 }}>
        <AgentAvatar agent={node as any} size={36} />
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', right: -3, bottom: -3, width: 14, height: 14, borderRadius: tk.r.pill,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, lineHeight: '9px', color: 'var(--accent-contrast)',
            background: statusColor(node.status), border: `1.5px solid ${tk.surface}`,
          }}
        >
          {statusIcon(node.status)}
        </span>
      </span>

      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 1 }}>
        <span style={{ ...text.md, fontWeight: 700, color: tk.text }}>{node.name}</span>
        <span style={{ ...text.xs, color: tk.textDim }}>{node.title || node.role}</span>
        <span style={{ ...text.xs, color: tk.muted, fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {runtimeLine(node)}
        </span>
        {node.jobDescription && (
          <span style={{ ...text.xs, color: tk.muted, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {node.jobDescription}
          </span>
        )}
        {/* Status as text too, for anyone who can't read the dot. */}
        <span className="sr-only">Status: {status}</span>
      </span>
    </button>
  )
}

// ─── canvas ──────────────────────────────────────────────────────────────────

export default function OrgChart({
  agents, onOpenAgent, onImport, onExport, busy,
}: {
  agents: OrgRosterAgent[] | null
  onOpenAgent?: (id: string) => void
  onImport?: (file: File) => void
  onExport?: () => void
  busy?: string | null
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [grabbing, setGrabbing] = useState(false)

  // Pointer bookkeeping. `moved` distinguishes a pan from a click on a card.
  const drag = useRef({ active: false, startX: 0, startY: 0, startPan: { x: 0, y: 0 }, moved: false })
  const suppressClick = useRef(false)

  const layout = useMemo(() => computeOrgLayout<OrgRosterAgent>(agents ?? []), [agents])

  const fit = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const t = fitToView(layout, { width: el.clientWidth, height: el.clientHeight })
    setPan({ x: t.x, y: t.y })
    setZoom(t.zoom)
  }, [layout])

  // Fit once the tree (or the viewport) is known.
  useEffect(() => { if (layout.nodes.length) fit() }, [layout, fit])

  const zoomBy = (factor: number) => {
    const el = viewportRef.current
    if (!el) return
    const focus = { x: el.clientWidth / 2, y: el.clientHeight / 2 }
    const next = zoomAbout(pan, zoom, zoom * factor, focus)
    setPan({ x: next.x, y: next.y }); setZoom(next.zoom)
  }

  const onWheel = (e: React.WheelEvent) => {
    const el = viewportRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const focus = { x: e.clientX - r.left, y: e.clientY - r.top }
    const next = zoomAbout(pan, zoom, clampZoom(zoom * (e.deltaY < 0 ? 1.08 : 0.92)), focus)
    setPan({ x: next.x, y: next.y }); setZoom(next.zoom)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { active: true, startX: e.clientX, startY: e.clientY, startPan: pan, moved: false }
    setGrabbing(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true
    if (d.moved) setPan({ x: d.startPan.x + dx, y: d.startPan.y + dy })
  }
  const endDrag = () => {
    // A drag that ended over a card must not also "click" it.
    if (drag.current.moved) suppressClick.current = true
    drag.current.active = false
    setGrabbing(false)
  }
  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; e.preventDefault(); e.stopPropagation() }
  }

  const controlStyle = {
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, fontSize: 14,
  } as const

  const empty = agents !== null && agents.length === 0

  return (
    <div>
      <SectionLabel>Org chart</SectionLabel>

      {/* Import / Export — top-left, above the canvas. */}
      <div style={{ display: 'flex', gap: space.sm, marginBottom: space.sm, flexWrap: 'wrap' }}>
        <input
          ref={fileRef} type="file" accept="application/json" hidden
          onChange={e => {
            const f = e.target.files?.[0]
            if (f && onImport) onImport(f)
            e.target.value = '' // let the same file be picked twice
          }}
        />
        <Button onClick={() => fileRef.current?.click()} disabled={!onImport || !!busy} title="Import a company bundle (JSON) as a new organisation">
          ⬆ Import company
        </Button>
        <Button onClick={onExport} disabled={!onExport || !!busy} title="Download this organisation (agents, goals, budgets, routines) as JSON">
          ⬇ Export company
        </Button>
        {busy && <span style={{ ...text.xs, color: tk.muted, alignSelf: 'center' }}>{busy}</span>}
      </div>

      <div
        ref={viewportRef}
        data-testid="org-chart-viewport"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onClickCapture={onClickCapture}
        style={{
          position: 'relative', overflow: 'hidden',
          height: 'min(70vh, 640px)', minHeight: 360,
          background: tk.bg, border: `1px solid ${tk.line}`, borderRadius: tk.r.lg,
          cursor: grabbing ? 'grabbing' : 'grab', touchAction: 'none', overscrollBehavior: 'contain',
        }}
      >
        {/* Zoom controls — top-right, like the reference. */}
        <div style={{ position: 'absolute', top: space.lg, right: space.lg, zIndex: 2, display: 'flex', flexDirection: 'column', gap: space.xs }}>
          <Button style={controlStyle} onClick={() => zoomBy(ZOOM_STEP)} title="Zoom in" aria-label="Zoom in">+</Button>
          <Button style={controlStyle} onClick={() => zoomBy(1 / ZOOM_STEP)} title="Zoom out" aria-label="Zoom out">−</Button>
          <Button style={controlStyle} onClick={fit} title="Fit chart to view" aria-label="Fit chart to view">⤢</Button>
        </div>

        {agents === null && <p style={{ ...sx.loading, padding: space.xl }}>Loading…</p>}
        {empty && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
            <span aria-hidden="true" style={{ fontSize: 28 }}>🗂️</span>
            <p style={sx.empty}>No agents yet — hire one and the reporting tree appears here.</p>
          </div>
        )}

        {/* Edges. Orthogonal elbows: down from the manager, across, down into the report. */}
        <svg aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {layout.edges.map(e => {
              const midY = (e.y1 + e.y2) / 2
              return (
                <path
                  key={`${e.parentId}-${e.childId}`}
                  d={`M ${e.x1} ${e.y1} L ${e.x1} ${midY} L ${e.x2} ${midY} L ${e.x2} ${e.y2}`}
                  fill="none" stroke={tk.line} strokeWidth={1.5}
                />
              )
            })}
          </g>
        </svg>

        {/* Cards, sharing the edges' transform so the two layers stay locked. */}
        <div style={{ position: 'absolute', inset: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
          {layout.nodes.map(n => (
            <OrgCard key={n.id} node={n} onOpen={id => onOpenAgent?.(id)} />
          ))}
        </div>
      </div>
    </div>
  )
}
