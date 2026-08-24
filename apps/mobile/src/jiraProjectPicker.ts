// GC-3 — the Command Center Jira project picker, phone side. DECISIONS ONLY.
//
// Metro cannot import from `web/`, so this hand-copies the desk's decisions and pins
// them with jiraProjectPicker.test.ts against `web/app/dashboard/assistant.logic.ts`.

export type JiraProjectOption = { id: string; key: string; name: string; type?: string | null }

export function resolveJiraProjectSelection(
  projects: ReadonlyArray<JiraProjectOption>,
  savedKey: string | null | undefined,
  defaultKey: string | null | undefined,
): string {
  const keys = new Set(projects.map(p => p.key))
  if (savedKey && keys.has(savedKey)) return savedKey
  if (defaultKey && keys.has(defaultKey)) return defaultKey
  return projects[0]?.key ?? ''
}

export function jiraProjectLabel(projects: ReadonlyArray<JiraProjectOption>, key: string): string {
  const hit = projects.find(p => p.key === key)
  return hit ? `${hit.key} — ${hit.name}` : (key || 'No project')
}
