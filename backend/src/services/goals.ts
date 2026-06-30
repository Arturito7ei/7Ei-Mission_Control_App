// Goals & goal alignment (MCA-PC B1). Pure helpers: build the goal tree, walk a
// goal's ancestry, and format the "why" for an agent's system prompt.

export interface Goal {
  id: string
  title: string
  parentGoalId?: string | null
  description?: string | null
  metric?: string | null
  status?: string | null
}

export interface GoalNode extends Goal { children: GoalNode[] }

/** Build a goal tree from parentGoalId. Orphans become roots; cycles are broken. */
export function buildGoalTree<T extends Goal>(goals: T[]): (T & { children: any[] })[] {
  const byId = new Map<string, T & { children: any[] }>()
  for (const g of goals) byId.set(g.id, { ...g, children: [] })
  const roots: (T & { children: any[] })[] = []
  for (const g of goals) {
    const node = byId.get(g.id)!
    const pid = g.parentGoalId ?? null
    const parent = pid ? byId.get(pid) : undefined
    if (!parent || pid === g.id) { roots.push(node); continue }
    // cycle guard
    let cur: string | null | undefined = pid, cyclic = false
    const seen = new Set<string>()
    while (cur) {
      if (cur === g.id) { cyclic = true; break }
      if (seen.has(cur)) break
      seen.add(cur); cur = byId.get(cur)?.parentGoalId ?? null
    }
    if (cyclic) { roots.push(node); continue }
    parent.children.push(node)
  }
  return roots
}

/** Ordered ancestry root→leaf for a goal id (inclusive). */
export function goalAncestry<T extends Goal>(goals: T[], goalId: string): T[] {
  const byId = new Map(goals.map(g => [g.id, g]))
  const chain: T[] = []
  let cur: string | null | undefined = goalId
  const seen = new Set<string>()
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    chain.push(byId.get(cur)!)
    cur = byId.get(cur)!.parentGoalId ?? null
  }
  return chain.reverse()
}

/** Format goal ancestry (+ optional mission) for the agent prompt. */
export function formatGoalContext(ancestry: Goal[], mission?: string | null): string {
  if (!ancestry.length && !mission) return ''
  const lines = ['=== GOAL ALIGNMENT (why this task matters) ===']
  if (mission) lines.push(`Company mission: ${mission}`)
  ancestry.forEach((g, i) => {
    const m = g.metric ? ` [metric: ${g.metric}]` : ''
    lines.push(`${'  '.repeat(i)}↳ ${g.title}${m}`)
  })
  lines.push('Keep your work traceable to this goal.', '=== END GOAL ALIGNMENT ===')
  return lines.join('\n')
}
