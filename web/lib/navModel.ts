// Epic P / P0a — Paperclip-style folded navigation model (pure, no React).
//
// Mirrors Paperclip's information architecture (docs/TRD-paperclip.md §3): a
// grouped, collapsible sidebar in Paperclip's group order
//   Overview · Workspace · Operate · Delivery · Company · General
// with our existing surfaces re-homed under it. See docs/IA-paperclip-mapping.md.
//
// P1 — the rail is deliberately short. Two mechanisms keep it that way without
// losing a surface:
//   * hosted tabs (`tabs`)  — a child surface renders as a tab on its parent's
//     page (Budgets under Costs, Plugins under Connectors, Tasks + Comms under
//     Inbox, Adapters + Secrets under Settings). One rail entry, two-plus surfaces.
//   * HIDDEN_ITEMS        — surfaces dropped from the rail but still routable:
//     the command palette lists them and the dashboard still renders them, so
//     nothing is deleted and no deep link dies.
// Every surface in the app is therefore in exactly one of NAV_GROUPS (rail),
// a parent's `tabs`, or HIDDEN_ITEMS — `allSurfaces()` is the union, and the
// tests assert that union still covers every dashboard tab.
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
  /**
   * P1 — surfaces this page hosts as tabs, after its own. The parent stays the
   * single rail entry; `navPageTabs(parent.id)` builds the page's tab bar.
   */
  tabs?: NavItem[]
  /**
   * The parent's own tab label, when its rail entry needs to read differently
   * from its first tab. No parent needs it today (each is labelled for itself);
   * `navPageTabs` / `navSurfaceTitle` fall back to `label`.
   */
  tabLabel?: string
}

export interface NavGroup {
  id: NavGroupId
  label: string
  items: NavItem[]
}

/** One entry in a tabbed page's tab bar. */
export interface PageTab {
  id: string
  label: string
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
      // P1 — Comms folds in here. P2 — Tasks folds in too: the operator's queue of
      // work and the approvals waiting on them are one area, so the rail carries a
      // single "Inbox" entry with tabs Inbox | Tasks | Comms. The Inbox tab is the
      // approvals + notifications view (CockpitPanel's InboxSection); Tasks is the
      // task log next to it. Labelled for the parent alone, like Costs / Connectors
      // / Settings — enumerating children in the rail label stops scaling at two.
      {
        id: 'inbox', label: 'Inbox', icon: '📥', kind: 'section', section: 'inbox', paperclip: 'Inbox',
        tabs: [
          // MCC-1 — direct conversation with an agent (thread + composer), replies
          // included. Hosted here because "talk to my office" and "what needs me"
          // are the same area of attention.
          { id: 'chat', label: 'Chat', icon: '💬', kind: 'tab', paperclip: 'Board Chat / DMs', beyond: true },
          { id: 'tasks', label: 'Tasks', icon: '📋', kind: 'tab', paperclip: 'Issues / Tasks' },
          { id: 'comms', label: 'Comms', icon: '📬', kind: 'tab', paperclip: 'Communications', beyond: true },
        ],
      },
      { id: 'activity', label: 'Activity', icon: '📈', kind: 'section', section: 'activity', paperclip: 'Activity' },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { id: 'agents', label: 'Agents', icon: '🤖', kind: 'tab', paperclip: 'Agents' },
      { id: 'projects', label: 'Projects', icon: '📁', kind: 'tab', paperclip: 'Projects' },
      { id: 'org', label: 'Org', icon: '🗂️', kind: 'section', section: 'org', paperclip: 'Org' },
      { id: 'routines', label: 'Routines', icon: '🔁', kind: 'placeholder', paperclip: 'Routines', note: 'Recurring scheduled tasks. Backend exists (routines.ts / scheduled_tasks); a dedicated web surface is an Epic-P gap.' },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    items: [
      { id: 'governance', label: 'Governance', icon: '🛡️', kind: 'tab', paperclip: 'Approvals · Review Queue · RBAC' },
      { id: 'review-queue', label: 'Review Queue', icon: '🧪', kind: 'placeholder', paperclip: 'Review Queue', note: 'Low-trust quarantine review lives inside Governance today; a dedicated queue page is an Epic-P gap.' },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      // P1 — Budgets folds in here: tabs Costs | Budgets.
      {
        id: 'costs', label: 'Costs', icon: '💰', kind: 'tab', paperclip: 'Costs · Budgets · Preflight',
        tabs: [
          { id: 'budgets', label: 'Budgets', icon: '💵', kind: 'section', section: 'budgets', paperclip: 'Budgets / Preflight' },
        ],
      },
      { id: 'skills', label: 'Skills', icon: '⚡', kind: 'tab', paperclip: 'Skills' },
      { id: 'memory', label: 'Memory', icon: '🧠', kind: 'tab', paperclip: 'Learnings', beyond: true },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    items: [
      // P1 — Plugins folds in here: tabs Connectors | Plugins.
      {
        id: 'connectors', label: 'Connectors', icon: '🔌', kind: 'tab', paperclip: 'Plugins / Connectors',
        tabs: [
          { id: 'plugins', label: 'Plugins', icon: '🧰', kind: 'section', section: 'plugins', paperclip: 'Plugins' },
        ],
      },
      { id: 'members', label: 'Members & Access', icon: '👥', kind: 'placeholder', paperclip: 'Members / Access', note: 'Per-resource RBAC grants ledger. We have org-level roles (org_members); the fine-grained ledger is an Epic-P gap.' },
    ],
  },
  {
    id: 'general',
    label: 'General',
    items: [
      { id: 'usage', label: 'Usage', icon: '📊', kind: 'tab', paperclip: 'Usage' },
      // P1 — Adapters + Secrets fold in here: tabs Settings | Adapters | Secrets.
      {
        id: 'settings', label: 'Settings', icon: '⚙️', kind: 'tab', paperclip: 'Settings (Company / Instance)',
        tabs: [
          { id: 'adapters', label: 'Adapters', icon: '🧷', kind: 'placeholder', paperclip: 'Adapter registry', note: 'BYO-runtime adapter registry + model catalogs + probes. Not yet built — Epic-P gap.' },
          { id: 'secrets', label: 'Secrets', icon: '🔐', kind: 'section', section: 'secrets', paperclip: 'Secrets' },
        ],
      },
    ],
  },
]

/**
 * P1 — surfaces removed from the rail but NOT from the app. They stay routable:
 * the command palette lists them, the dashboard still renders them, and any
 * deep link to their id keeps working. Nothing here is deleted; the rail is
 * simply not where they live any more.
 */
export const HIDDEN_ITEMS: NavItem[] = [
  { id: 'search', label: 'Search', icon: '🔍', kind: 'placeholder', paperclip: 'Search', note: 'Global search page. Today: press ⌘K for the command palette. A dedicated search surface is an Epic-P gap.' },
  { id: 'goals', label: 'Goals', icon: '🎯', kind: 'section', section: 'goals', paperclip: 'Goals' },
  { id: 'pipelines', label: 'Pipelines', icon: '🧩', kind: 'placeholder', paperclip: 'Pipelines', note: 'Multi-stage case pipelines. Not yet built (no pipeline/case entity) — Epic-P gap.' },
  { id: 'workspaces', label: 'Workspaces', icon: '🧱', kind: 'section', section: 'workspaces', paperclip: 'Workspaces' },
  { id: 'artifacts', label: 'Artifacts', icon: '📦', kind: 'placeholder', paperclip: 'Artifacts', note: 'Work-product / artifact stacks. Not yet built — Epic-P gap.' },
]

/** The rail's own items, in render order (top-level only — hosted tabs excluded). */
export function allNavItems(): NavItem[] {
  return NAV_GROUPS.flatMap(g => g.items)
}

/** Surfaces hosted as tabs on some parent page (Budgets, Plugins, Comms, …). */
export function hostedTabItems(): NavItem[] {
  return allNavItems().flatMap(i => i.tabs ?? [])
}

/**
 * Every routable surface: rail items + the tabs they host + the hidden ones.
 * This is the "nothing is lost" set — the palette and the router use it.
 */
export function allSurfaces(): NavItem[] {
  return [...allNavItems(), ...hostedTabItems(), ...HIDDEN_ITEMS]
}

/** The tab ids anything can route to (every `kind:'tab'` surface). */
export function navTabIds(): string[] {
  return allSurfaces().filter(i => i.kind === 'tab').map(i => i.id)
}

/** Look up any routable surface by id (undefined if unknown). */
export function findNavItem(id: string): NavItem | undefined {
  return allSurfaces().find(i => i.id === id)
}

/** True when this surface is reachable but no longer in the rail (P1 removals). */
export function isHidden(id: string): boolean {
  return HIDDEN_ITEMS.some(i => i.id === id)
}

/**
 * The tab bar for a page that hosts tabs: the page itself first, then its
 * children. Empty for a page with no hosted tabs (most of them).
 */
export function navPageTabs(id: string): PageTab[] {
  const parent = allNavItems().find(i => i.id === id)
  if (!parent?.tabs?.length) return []
  return [
    { id: parent.id, label: parent.tabLabel ?? parent.label },
    ...parent.tabs.map(t => ({ id: t.id, label: t.label })),
  ]
}

/** The rail item hosting this surface as a tab (undefined if it isn't hosted). */
export function navParentId(id: string): string | undefined {
  return allNavItems().find(i => i.tabs?.some(t => t.id === id))?.id
}

/** Which rail item should read as active while `id` is open. */
export function navSelectedId(id: string): string {
  return navParentId(id) ?? id
}

/** The heading a surface shows on its own page (tab label wins over rail label). */
export function navSurfaceTitle(id: string): string | undefined {
  const item = findNavItem(id)
  return item ? (item.tabLabel ?? item.label) : undefined
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
