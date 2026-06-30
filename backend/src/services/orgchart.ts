// Org chart & hierarchy (MCA-PC A1).
// Pure helpers to assemble a reporting tree from a flat agent list.

export interface OrgAgent {
  id: string
  name: string
  role: string
  title?: string | null
  reportsTo?: string | null
  avatarEmoji?: string | null
  status?: string | null
  runtime?: string | null
}

export interface OrgNode extends OrgAgent {
  children: OrgNode[]
}

/**
 * Build a reporting tree. Roots are agents whose reportsTo is null/empty or
 * points outside the set (orphans are promoted to roots so none are lost).
 * Cycles are broken: an agent already placed never becomes its own descendant.
 */
export function buildOrgChart<T extends OrgAgent>(agents: T[]): (T & { children: any[] })[] {
  const byId = new Map<string, T & { children: any[] }>()
  for (const a of agents) byId.set(a.id, { ...a, children: [] })

  const roots: (T & { children: any[] })[] = []
  const placed = new Set<string>()

  for (const a of agents) {
    const node = byId.get(a.id)!
    const parentId = a.reportsTo ?? null
    const parent = parentId ? byId.get(parentId) : undefined
    // Root when: no manager, manager missing from set, or self-reference.
    if (!parent || parentId === a.id) {
      roots.push(node); placed.add(a.id); continue
    }
    // Cycle guard: walk up from parent; if we reach this agent, treat as root.
    let cursor: string | null | undefined = parentId
    let cyclic = false
    const seen = new Set<string>()
    while (cursor) {
      if (cursor === a.id) { cyclic = true; break }
      if (seen.has(cursor)) break
      seen.add(cursor)
      cursor = byId.get(cursor)?.reportsTo ?? null
    }
    if (cyclic) { roots.push(node); placed.add(a.id); continue }
    parent.children.push(node); placed.add(a.id)
  }
  return roots
}

/** Direct reports of an agent. */
export function directReports<T extends OrgAgent>(agents: T[], managerId: string): T[] {
  return agents.filter(a => a.reportsTo === managerId)
}

/** Total agents in a (sub)tree, including roots. */
export function countTree(nodes: { children: any[] }[]): number {
  return nodes.reduce((n, node) => n + 1 + countTree(node.children), 0)
}
