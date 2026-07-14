// P2 — pure geometry for the org-chart canvas. No React, no DOM: every function
// here is deterministic so the layout is testable without rendering.
//
// The chart is a classic tidy top-down tree: children sit on the row below their
// manager, siblings are packed left-to-right, and a manager is centred over the
// span of its own subtree. Multiple roots (agents with no manager) are laid out
// side by side as separate trees.

export const NODE_W = 220
export const NODE_H = 104
export const GAP_X = 32 // horizontal gutter between sibling subtrees
export const GAP_Y = 72 // vertical gutter between depth rows
export const PADDING = 60 // breathing room around the tree when fitting to view
export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 2

/** The subset of an agent the chart needs. Extra fields ride along untouched. */
export interface OrgAgent {
  id: string
  name: string
  role: string
  title?: string | null
  reportsTo?: string | null
  status?: string | null
  [k: string]: unknown
}

export type OrgTreeNode<T extends OrgAgent = OrgAgent> = T & { children: OrgTreeNode<T>[] }

/** A node with its resolved position on the canvas (top-left of the card). */
export type PositionedNode<T extends OrgAgent = OrgAgent> = T & { x: number; y: number; depth: number }

export interface OrgEdge {
  parentId: string
  childId: string
  /** Card centres/anchors, precomputed so the renderer stays dumb. */
  x1: number; y1: number; x2: number; y2: number
}

export interface OrgLayout<T extends OrgAgent = OrgAgent> {
  nodes: PositionedNode<T>[]
  edges: OrgEdge[]
  width: number
  height: number
}

/**
 * Build the reporting tree from a flat agent list — the web mirror of the
 * backend's buildOrgChart (services/orgchart.ts), same loop-guard contract:
 *   - roots are agents with no manager, a manager outside the set, or self-reference,
 *   - a cycle (a → b → a) is broken by promoting the agent to a root,
 * so every agent appears exactly once and no input can hang the renderer.
 */
export function buildOrgTree<T extends OrgAgent>(agents: T[]): OrgTreeNode<T>[] {
  const byId = new Map<string, OrgTreeNode<T>>()
  for (const a of agents) byId.set(a.id, { ...a, children: [] })

  const roots: OrgTreeNode<T>[] = []
  for (const a of agents) {
    const node = byId.get(a.id)!
    const parentId = a.reportsTo ?? null
    const parent = parentId ? byId.get(parentId) : undefined
    if (!parent || parentId === a.id) { roots.push(node); continue }

    // Walk up from the manager: reaching this agent again means a cycle.
    let cursor: string | null | undefined = parentId
    let cyclic = false
    const seen = new Set<string>()
    while (cursor) {
      if (cursor === a.id) { cyclic = true; break }
      if (seen.has(cursor)) break
      seen.add(cursor)
      cursor = (byId.get(cursor)?.reportsTo as string | null | undefined) ?? null
    }
    if (cyclic) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}

/**
 * Position every node. Leaves are packed left to right in visit order; a parent
 * is centred over its first and last child. Returns the canvas extent too, so
 * the caller can fit the tree to the viewport without measuring the DOM.
 */
export function layoutOrgTree<T extends OrgAgent>(roots: OrgTreeNode<T>[]): OrgLayout<T> {
  const nodes: PositionedNode<T>[] = []
  const edges: OrgEdge[] = []
  let cursorX = 0 // left edge of the next leaf column

  // Post-order: children first, then centre the parent over them.
  const place = (node: OrgTreeNode<T>, depth: number): number => {
    const y = depth * (NODE_H + GAP_Y)
    const childXs = node.children.map(c => place(c, depth + 1))
    let x: number
    if (childXs.length === 0) {
      x = cursorX
      cursorX += NODE_W + GAP_X
    } else {
      x = (childXs[0] + childXs[childXs.length - 1]) / 2
    }
    const { children, ...rest } = node
    nodes.push({ ...(rest as unknown as T), x, y, depth })

    const childY = (depth + 1) * (NODE_H + GAP_Y)
    node.children.forEach((c, i) => {
      edges.push({
        parentId: node.id, childId: c.id,
        x1: x + NODE_W / 2, y1: y + NODE_H,
        x2: childXs[i] + NODE_W / 2, y2: childY,
      })
    })
    return x
  }
  for (const r of roots) place(r, 0)

  const width = nodes.length ? Math.max(...nodes.map(n => n.x)) + NODE_W : 0
  const height = nodes.length ? Math.max(...nodes.map(n => n.y)) + NODE_H : 0
  return { nodes, edges, width, height }
}

/** Flat list → positioned chart, in one call. */
export function computeOrgLayout<T extends OrgAgent>(agents: T[]): OrgLayout<T> {
  return layoutOrgTree(buildOrgTree(agents))
}

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/**
 * Transform that centres the whole tree in a viewport, scaled to fit with
 * PADDING to spare (never magnified past 1× — a two-node org shouldn't render
 * as billboards). Returns pan in screen px and the zoom to apply.
 */
export function fitToView(
  layout: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; zoom: number } {
  if (layout.width <= 0 || layout.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, zoom: 1 }
  }
  const zoom = clampZoom(Math.min(
    1,
    (viewport.width - PADDING * 2) / layout.width,
    (viewport.height - PADDING * 2) / layout.height,
  ))
  return {
    x: (viewport.width - layout.width * zoom) / 2,
    y: (viewport.height - layout.height * zoom) / 2,
    zoom,
  }
}

/**
 * Zoom about a fixed screen point (the viewport centre for the +/− buttons, the
 * cursor for wheel zoom): the canvas point under `focus` stays under `focus`.
 */
export function zoomAbout(
  pan: { x: number; y: number }, zoom: number, nextZoom: number, focus: { x: number; y: number },
): { x: number; y: number; zoom: number } {
  const z = clampZoom(nextZoom)
  const k = z / zoom
  return { x: focus.x - k * (focus.x - pan.x), y: focus.y - k * (focus.y - pan.y), zoom: z }
}
