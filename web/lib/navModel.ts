// Epic P / P0a — Paperclip-style folded navigation model (pure, no React).
//
// Mirrors Paperclip's information architecture (docs/TRD-paperclip.md §3): a
// grouped, collapsible sidebar in Paperclip's group order
//   Overview · Workspace · Operate · Delivery · Company · General
// with our existing surfaces re-homed under it. See docs/IA-paperclip-mapping.md.
//
// Kept pure so the structure + collapse/fold logic is unit-testable under
// `node --test` (web has no jest/vitest). The dashboard page renders from this.

export type NavKind =
  | 'tab' // routes to an existing dashboard tab (id === the Tab value)
  | 'section' // a Cockpit section promoted to a first-class area (P0b) — see `section`
  | 'placeholder' // Paperclip area we don't have a web surface for yet (coming soon → Epic P)

export type NavGroupId = 'overview' | 'workspace' | 'operate' | 'delivery' | 'company' | 'general'

export interface NavItem {
  /** Stable id. For `tab` items this equals the dashboard Tab value. */
  id: string
  label: string
  icon: string
  kind: NavKind
  /** The Paperclip area this fulfils (tooltip + mapping doc). */
  paperclip: string
  /** Section-only: the CockpitPanel section key this area renders (P0b). */
  section?: string
  /** Placeholder-only: what/why + where the real surface will live (Epic P). */
  note?: string
  /** Beyond-Paperclip surface kept + re-homed (Arturita/Memory/Comms). */
  beyond?: boolean
}

export interface NavGroup {
  id: NavGroupId
  label: string
  items: NavItem[]
}

// Epic-P gap plan the placeholders point at.
export const GAP_DOC = 'docs/GAP-paperclip-config.md'

// The IA. Group order is Paperclip's; each item maps to §3 of the TRD.
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      { id: 'overview', label: 'Dashboard', icon: '🏠', kind: 'tab', paperclip: 'Dashboard' },
      // The nav label is the surface, not the persona: the tab is the operator's
      // Command Center. The assistant answering inside it is still Arturita, and
      // the id stays `assistant` — it is the dashboard Tab value and is deep-linked.
      // It sits directly under Dashboard: it is the operator's primary way in.
      { id: 'assistant', label: 'Command Center', icon: '🎙️', kind: 'tab', paperclip: 'Board Chat', beyond: true },
      { id: 'cockpit', label: 'Operations', icon: '🛰️', kind: 'tab', paperclip: 'Dashboard / live' },
      { id: 'inbox', label: 'Inbox', icon: '📥', kind: 'section', section: 'inbox', paperclip: 'Inbox' },
      { id: 'activity', label: 'Activity', icon: '📈', kind: 'section', section: 'activity', paperclip: 'Activity' },
      { id: 'search', label: 'Search', icon: '🔍', kind: 'placeholder', paperclip: 'Search', note: 'Global search page. Today: press ⌘K for the command palette. A dedicated search surface is an Epic-P gap.' },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { id: 'tasks', label: 'Issues', icon: '📋', kind: 'tab', paperclip: 'Issues / Tasks' },
      { id: 'agents', label: 'Agents', icon: '🤖', kind: 'tab', paperclip: 'Agents' },
      { id: 'projects', label: 'Projects', icon: '📁', kind: 'tab', paperclip: 'Projects' },
      { id: 'goals', label: 'Goals', icon: '🎯', kind: 'section', section: 'goals', paperclip: 'Goals' },
      { id: 'org', label: 'Org', icon: '🗂️', kind: 'section', section: 'org', paperclip: 'Org' },
      { id: 'routines', label: 'Routines', icon: '🔁', kind: 'placeholder', paperclip: 'Routines', note: 'Recurring scheduled tasks. Backend exists (routines.ts / scheduled_tasks); a dedicated web surface is an Epic-P gap.' },
      { id: 'pipelines', label: 'Pipelines', icon: '🧩', kind: 'placeholder', paperclip: 'Pipelines', note: 'Multi-stage case pipelines. Not yet built (no pipeline/case entity) — Epic-P gap.' },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    items: [
      { id: 'governance', label: 'Governance', icon: '🛡️', kind: 'tab', paperclip: 'Approvals · Review Queue · RBAC' },
      { id: 'workspaces', label: 'Workspaces', icon: '🧱', kind: 'section', section: 'workspaces', paperclip: 'Workspaces' },
      { id: 'review-queue', label: 'Review Queue', icon: '🧪', kind: 'placeholder', paperclip: 'Review Queue', note: 'Low-trust quarantine review lives inside Governance today; a dedicated queue page is an Epic-P gap.' },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      { id: 'costs', label: 'Costs', icon: '💰', kind: 'tab', paperclip: 'Costs · Budgets · Preflight' },
      { id: 'budgets', label: 'Budgets', icon: '💵', kind: 'section', section: 'budgets', paperclip: 'Budgets / Preflight' },
      { id: 'skills', label: 'Skills', icon: '⚡', kind: 'tab', paperclip: 'Skills' },
      { id: 'memory', label: 'Memory', icon: '🧠', kind: 'tab', paperclip: 'Learnings', beyond: true },
      { id: 'artifacts', label: 'Artifacts', icon: '📦', kind: 'placeholder', paperclip: 'Artifacts', note: 'Work-product / artifact stacks. Not yet built — Epic-P gap.' },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    items: [
      { id: 'connectors', label: 'Connectors', icon: '🔌', kind: 'tab', paperclip: 'Plugins / Connectors' },
      { id: 'plugins', label: 'Plugins', icon: '🧰', kind: 'section', section: 'plugins', paperclip: 'Plugins' },
      { id: 'secrets', label: 'Secrets', icon: '🔐', kind: 'section', section: 'secrets', paperclip: 'Secrets' },
      { id: 'comms', label: 'Comms', icon: '📬', kind: 'tab', paperclip: 'Communications', beyond: true },
      { id: 'adapters', label: 'Adapters', icon: '🧷', kind: 'placeholder', paperclip: 'Adapter registry', note: 'BYO-runtime adapter registry + model catalogs + probes. Not yet built — Epic-P gap.' },
      { id: 'members', label: 'Members & Access', icon: '👥', kind: 'placeholder', paperclip: 'Members / Access', note: 'Per-resource RBAC grants ledger. We have org-level roles (org_members); the fine-grained ledger is an Epic-P gap.' },
    ],
  },
  {
    id: 'general',
    label: 'General',
    items: [
      { id: 'usage', label: 'Usage', icon: '📊', kind: 'tab', paperclip: 'Usage' },
      { id: 'settings', label: 'Settings', icon: '⚙️', kind: 'tab', paperclip: 'Settings (Company / Instance)' },
    ],
  },
]

/** Flat list of every nav item, in render order. */
export function allNavItems(): NavItem[] {
  return NAV_GROUPS.flatMap(g => g.items)
}

/** The tab ids the nav can route to (every `kind:'tab'` item). */
export function navTabIds(): string[] {
  return allNavItems().filter(i => i.kind === 'tab').map(i => i.id)
}

/** Look up an item by id (undefined if unknown). */
export function findNavItem(id: string): NavItem | undefined {
  return allNavItems().find(i => i.id === id)
}

/** True when selecting this id should show the "coming soon" placeholder view. */
export function isPlaceholder(id: string): boolean {
  return findNavItem(id)?.kind === 'placeholder'
}

/** True when this id is a Cockpit section promoted to a first-class area (P0b). */
export function isSection(id: string): boolean {
  return findNavItem(id)?.kind === 'section'
}

/** The CockpitPanel section key for a promoted area (undefined otherwise). */
export function navSectionKey(id: string): string | undefined {
  const item = findNavItem(id)
  return item?.kind === 'section' ? item.section : undefined
}

// ─── Collapse persistence (which groups are folded shut) ─────────────────────
// Stored as a comma-separated list of collapsed group ids. Pure parse/serialize
// so the reducer logic is testable without a DOM.

export function parseCollapsed(raw: string | null | undefined): Set<NavGroupId> {
  const valid = new Set(NAV_GROUPS.map(g => g.id))
  const out = new Set<NavGroupId>()
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim()
    if (id && valid.has(id as NavGroupId)) out.add(id as NavGroupId)
  }
  return out
}

export function serializeCollapsed(set: Set<NavGroupId>): string {
  // Emit in canonical group order so the persisted string is stable.
  return NAV_GROUPS.filter(g => set.has(g.id)).map(g => g.id).join(',')
}

/** Toggle one group's collapsed state, returning a new Set (never mutates). */
export function toggleCollapsed(set: Set<NavGroupId>, groupId: NavGroupId): Set<NavGroupId> {
  const next = new Set(set)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  return next
}
