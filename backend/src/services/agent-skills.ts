// Epic AG / AG4 — the Skills tab: the company skills library split into what is
// installed on this agent and what isn't. Pure; the route does the I/O.
//
// Storage reality: `agents.skills` is a JSON array of skill NAMES (not ids), and
// there was no uninstall path at all — only an append-by-id route. So the tab
// works on a whole SELECTION (the checkbox list you see), which makes install and
// uninstall the same idempotent operation and can't drift into a half-applied set.

export interface SkillLike {
  id: string
  name: string
  description?: string | null
  domain?: string | null
  source?: string | null
}

export interface SkillView extends SkillLike {
  installed: boolean
}

/**
 * Split the library for display. `installed` preserves the agent's stored order
 * (that is the order the agent sees them in); `other` is alphabetical.
 *
 * A name stored on the agent that no longer exists in the library is surfaced as
 * `orphaned` rather than silently dropped — it still counts as installed, and the
 * UI can tell the operator the skill went away.
 */
export function splitSkills(library: SkillLike[], installedNames: string[]) {
  const byName = new Map(library.map(s => [s.name, s]))
  const wanted = dedupe(installedNames)

  const installed: SkillView[] = []
  const orphaned: string[] = []
  for (const name of wanted) {
    const s = byName.get(name)
    if (s) installed.push({ ...s, installed: true })
    else orphaned.push(name)
  }

  const installedSet = new Set(installed.map(s => s.name))
  const other: SkillView[] = library
    .filter(s => !installedSet.has(s.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => ({ ...s, installed: false }))

  return { installed, other, orphaned, selectedCount: installed.length + orphaned.length }
}

/**
 * Resolve a requested selection (skill names) against the library.
 *
 * A name the library does not have is refused — the agent's skill list may only
 * ever gain names the library actually has. The exception is a name the agent is
 * ALREADY carrying (an orphan: the library row was deleted underneath it). The
 * checkbox list resends the whole selection, orphans included, so refusing those
 * made every toggle 400 on any agent that had one — the tab was unusable and
 * looked read-only. An orphan the operator kept ticked is kept; unticking it
 * drops it, which is the only way to get rid of one.
 */
export function resolveSelection(
  library: SkillLike[],
  requested: unknown,
  stored: string[] = [],
): { ok: true; names: string[] } | { ok: false; error: string } {
  if (!Array.isArray(requested)) return { ok: false, error: 'skills must be an array of skill names' }
  if (!requested.every(n => typeof n === 'string')) return { ok: false, error: 'skills must be an array of skill names' }

  const names = dedupe(requested as string[])
  const known = new Set(library.map(s => s.name))
  const alreadyOn = new Set(dedupe(stored))
  const unknown = names.filter(n => !known.has(n) && !alreadyOn.has(n))
  if (unknown.length) return { ok: false, error: `Unknown skill(s): ${unknown.join(', ')}` }

  // Keep library order so the stored array is stable regardless of click order.
  // Orphans have no library index; park them after the known ones.
  const order = new Map(library.map((s, i) => [s.name, i]))
  const idx = (n: string) => order.get(n) ?? Number.MAX_SAFE_INTEGER
  return { ok: true, names: names.sort((a, b) => idx(a) - idx(b)) }
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const n = (raw ?? '').trim()
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}
