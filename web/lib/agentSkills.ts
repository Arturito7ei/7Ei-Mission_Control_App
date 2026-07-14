// Epic AG / Skills tab — the pure half of ticking a skill on or off.
//
// The tab writes the WHOLE selection on every toggle (install and uninstall are
// the same idempotent PUT), so all the UI has to do is compute the next
// selection and predict the split the server will send back. Keeping that
// prediction here, rather than inline in the component, is what lets the
// checkbox flip instantly and still be provably the same answer the server gives.

export interface SkillView {
  id: string
  name: string
  description?: string | null
  domain?: string | null
  source?: string | null
  installed: boolean
}

export interface SkillsPayload {
  installed: SkillView[]
  other: SkillView[]
  /** names stored on the agent whose library row is gone */
  orphaned: string[]
  selectedCount: number
  adapter: string
  model: string
}

/** Everything the agent currently has: library skills + orphans. */
export function selectionOf(p: Pick<SkillsPayload, 'installed' | 'orphaned'>): string[] {
  return [...p.installed.map(s => s.name), ...p.orphaned]
}

/** Tick → add, untick → remove. */
export function nextSelection(current: string[], name: string): string[] {
  return current.includes(name) ? current.filter(n => n !== name) : [...current, name]
}

/**
 * Predict the server's split for a selection, so the checkbox can flip before
 * the round-trip. Mirrors `splitSkills` on the backend: installed keeps the
 * selection's order, `other` stays alphabetical, and a selected name with no
 * library row stays an orphan (it is still installed, and still counts).
 */
export function optimisticSplit(p: SkillsPayload, selection: string[]): SkillsPayload {
  const library = [...p.installed, ...p.other]
  const byName = new Map(library.map(s => [s.name, s]))
  const wanted = [...new Set(selection.map(n => n.trim()).filter(Boolean))]

  const installed: SkillView[] = []
  const orphaned: string[] = []
  for (const name of wanted) {
    const s = byName.get(name)
    if (s) installed.push({ ...s, installed: true })
    else orphaned.push(name)
  }

  const on = new Set(installed.map(s => s.name))
  const other = library
    .filter(s => !on.has(s.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => ({ ...s, installed: false }))

  return { ...p, installed, other, orphaned, selectedCount: installed.length + orphaned.length }
}
