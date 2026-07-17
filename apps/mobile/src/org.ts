// MOB-6e — the org chart's pure half. No React, no react-native, so
// `org.test.ts` can load it AND the web's `lib/orgLayout.ts` under `node --test`
// and assert the two build the same tree.
//
// WHAT CARRIES OVER, AND WHAT DOESN'T
//
// The web's org view (web/app/dashboard/cockpit/OrgChart.tsx) is a pan/zoom
// canvas: cards positioned by `layoutOrgTree`, elbowed SVG edges under them, drag
// to pan, wheel to zoom, ⤢ to fit. Every bit of that is DESKTOP GEOMETRY. The
// reporting structure it draws is not — that's the fact the operator opens the
// screen for, and it survives the trip perfectly well as an indented list.
//
// So the phone drops the canvas and keeps the hierarchy:
//
//   * `buildOrgTree` (the roots + cycle rules) is MIRRORED here — pinned by the
//     tripwire, because whether a cyclic agent appears once, twice, or hangs the
//     renderer must not depend on which device you picked up.
//   * `layoutOrgTree` / `fitToView` / `zoomAbout` / NODE_W / NODE_H are NOT
//     mirrored. They answer "where on a 2000px canvas does this card sit", a
//     question a 390pt column never asks. Indentation replaces them.
//
// So this module is deliberately HALF of orgLayout.ts: the half that is about
// the org, not about the canvas. Dropped, not deferred — parity doc §6.6.
//
// THE DATA IS THE ROSTER'S. `GET …/orgchart` returns `{ tree, agents, count }`;
// we read `agents` (the flat roster) and derive the tree client-side, exactly as
// the web does — same endpoint, same field, same derivation. The backend's own
// `tree` is left alone on both clients, so neither can drift onto a second
// answer for "who reports to whom". (AgentsScreen's roster comes from
// `…/agents`, a different projection of the same table: it has heartbeat and
// trust, and no `reportsTo`. This screen needs `reportsTo` and nothing else, so
// it uses the endpoint that has it — as the web does.)

/** The org-chart columns the backend's `/orgchart` returns. Superset-tolerant. */
export interface OrgAgentLite {
  id: string
  name: string
  role?: string | null
  title?: string | null
  reportsTo?: string | null
  status?: string | null
  avatarEmoji?: string | null
  // MOB-7c — the uploaded picture (data URI). The `/orgchart` route selects it
  // (backend/src/routes/agents.ts), so the tree can show real faces like the web's
  // OrgChart does; absent → the emoji. See AgentAvatar.tsx.
  avatarUrl?: string | null
  runtime?: string | null
  llmModel?: string | null
  jobDescription?: string | null
}

export type OrgTreeNodeLite<T extends OrgAgentLite = OrgAgentLite> = T & {
  children: OrgTreeNodeLite<T>[]
}

/** Why there's no canvas here. Rendered on the screen, not just in this comment. */
export const ORG_CANVAS_NOTE =
  'Drag-and-zoom lives on the desktop chart. This is the same reporting tree — tap an agent to open it.'

/**
 * Build the reporting tree from the flat roster. A MIRROR of the web's
 * `buildOrgTree` (web/lib/orgLayout.ts), which is itself a mirror of the
 * backend's `buildOrgChart` — same three root rules, same cycle guard:
 *
 *   * no manager, a manager outside the set, or self-reference → a root,
 *   * a cycle (a → b → a) is broken by promoting the agent to a root,
 *
 * so every agent appears EXACTLY ONCE and no input can hang the renderer. That
 * last property is the whole reason this is mirrored rather than eyeballed: a
 * cycle reaching a hand-rolled walk is an infinite loop, and an infinite loop on
 * a phone is a hang with no console to explain it.
 */
export function buildOrgTree<T extends OrgAgentLite>(agents: T[]): OrgTreeNodeLite<T>[] {
  const byId = new Map<string, OrgTreeNodeLite<T>>()
  for (const a of agents) byId.set(a.id, { ...a, children: [] })

  const roots: OrgTreeNodeLite<T>[] = []
  for (const a of agents) {
    const node = byId.get(a.id)!
    const parentId = a.reportsTo ?? null
    const parent = parentId ? byId.get(parentId) : undefined
    if (!parent || parentId === a.id) {
      roots.push(node)
      continue
    }
    // Walk up from the manager: reaching this agent again means a cycle.
    let cursor: string | null | undefined = parentId
    let cyclic = false
    const seen = new Set<string>()
    while (cursor) {
      if (cursor === a.id) {
        cyclic = true
        break
      }
      if (seen.has(cursor)) break
      seen.add(cursor)
      cursor = byId.get(cursor)?.reportsTo ?? null
    }
    if (cyclic) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}

/** One rendered row — a FlatList item, not a nested component. */
export type OrgRow<T extends OrgAgentLite = OrgAgentLite> = {
  agent: T
  /** 0 for a root; +1 per manager above. Indentation, not position. */
  depth: number
  /** Has reports (so it gets a caret at all). */
  hasChildren: boolean
  /** Its reports are showing. */
  expanded: boolean
  /** Direct reports — the count the collapsed row advertises. */
  childCount: number
}

/**
 * Walk the tree into a FLAT list of rows, honouring the collapsed set.
 *
 * Flat for the same reason the vault tree is (see memory.ts): FlatList recycles
 * rows, and a nested render would re-render every descendant on each toggle.
 * Depth becomes an indent, not a component boundary.
 *
 * COLLAPSED, not expanded, is what's tracked: an org chart is useful open. The
 * operator opens this to see the shape of the org, so the default is the whole
 * shape — folding is the exception, and an empty set means "show everything".
 */
export function flattenOrg<T extends OrgAgentLite>(
  roots: OrgTreeNodeLite<T>[],
  collapsed: ReadonlySet<string> = new Set(),
): OrgRow<T>[] {
  const rows: OrgRow<T>[] = []
  const walk = (nodes: OrgTreeNodeLite<T>[], depth: number) => {
    for (const node of nodes) {
      const { children, ...rest } = node
      const isCollapsed = collapsed.has(node.id)
      rows.push({
        agent: rest as unknown as T,
        depth,
        hasChildren: children.length > 0,
        expanded: children.length > 0 && !isCollapsed,
        childCount: children.length,
      })
      if (children.length && !isCollapsed) walk(children, depth + 1)
    }
  }
  walk(roots, 0)
  return rows
}

/** Roster → rows in one step, the way the screen wants it. */
export function orgRows<T extends OrgAgentLite>(
  agents: T[],
  collapsed: ReadonlySet<string> = new Set(),
): OrgRow<T>[] {
  return flattenOrg(buildOrgTree(agents), collapsed)
}

/** Every id with at least one report — what "Collapse all" needs to know. */
export function managerIds<T extends OrgAgentLite>(agents: T[]): string[] {
  const ids = new Set<string>()
  const known = new Set(agents.map((a) => a.id))
  for (const a of agents) {
    const p = a.reportsTo ?? null
    // Only a manager that survives the root rules actually parents a row.
    if (p && p !== a.id && known.has(p)) ids.add(p)
  }
  return [...ids]
}

/**
 * The web card's second line: the title, falling back to the role.
 * `OrgChart.tsx` renders `{node.title || node.role}` — the `||` (not `??`) is
 * load-bearing, since an empty title should fall through to the role.
 */
export function roleLine(a: OrgAgentLite): string {
  return a.title || a.role || '—'
}

/**
 * The web card's third line: "📎 openclaw · claude-opus-4" / "🧠 Internal — 7Ei
 * executor". Mirrors `runtimeLine` + `RUNTIME_BADGE` from the web's cockpit
 * (`web/app/dashboard/cockpit/shared.tsx`) — badges included, since a runtime the
 * operator recognises by its glyph on the desk should look the same in their hand.
 *
 * ⚠ THIS COPY IS NOT IMPORT-TRIPWIRED, and it's the only web-copied constant in
 * MOB-6e that isn't. `shared.tsx` contains JSX, so `node --test
 * --experimental-strip-types` cannot load it — there is no way to import it from
 * a test that runs outside Metro. (`orgLayout.ts` and the backend's
 * `vault-connector.ts` are plain `.ts`, which is why the tree rules and the path
 * rules ARE pinned.) `org.test.ts` pins the SHAPE instead — the fallback, the
 * internal special case, the model suffix — so a drift in the map's VALUES is the
 * one thing that can still slip. It is cosmetic when it does: a wrong glyph
 * beside a correct word, on a line whose meaning the word already carries.
 *
 * Verified by hand against shared.tsx:41 at MOB-6e. If you change the web's map,
 * change this one — the check is a grep, not a test.
 */
export const RUNTIME_BADGE: Record<string, string> = {
  internal: '🧠',
  openclaw: '📎',
  cursor: '⌨️',
  claude_code: '🤖',
  custom: '⚙️',
}

export function runtimeLine(a: OrgAgentLite): string {
  const rt = a.runtime ?? 'internal'
  const badge = RUNTIME_BADGE[rt] ?? '⚙️'
  if (rt === 'internal') return `${badge} Internal — 7Ei executor`
  return `${badge} ${rt}${a.llmModel ? ` · ${a.llmModel}` : ''}`
}
