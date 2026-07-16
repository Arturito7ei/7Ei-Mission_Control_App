// MOB-6a — the mobile navigation model. Pure data, no React, no react-navigation.
//
// Ported from `web/lib/navModel.ts`: the group order (Overview · Workspace ·
// Operate · Delivery · Company · General), the ids, and the labels are the web's.
// This is a PORT OF THE DATA, not a new IA — an id here is the same surface as
// the id there, so a deep link, a doc, or a push payload means one thing in both
// clients. What differs is only what a phone needs:
//
//   * The web's rail/hosted-tab/hidden split is flattened. A 390pt screen has no
//     rail to fold, and a hosted tab (Budgets under Costs) is just another row in
//     a list. `webHosted` / `webHidden` record where a surface lives on the web so
//     the mapping stays auditable, but they don't shape mobile navigation.
//   * `status` is the mobile-only axis the web has no need for — see below.
//   * `primary` marks the few surfaces that earn a bottom-tab slot.
//
// ADDING A SCREEN LATER (stages 6b+) is a two-line change: flip `status` to
// 'ready' here, and add the component to SCREENS in `navigation.tsx`. Nothing
// else in the app enumerates surfaces.

/**
 * How real a destination is on the PHONE — deliberately three-valued, because
 * "no screen yet" has two very different causes and the placeholder should say
 * which one honestly rather than showing one vague "coming soon":
 *
 *   'ready'   — a real mobile screen ships today.
 *   'planned' — the web surface exists and the data is reachable from the phone
 *               (see DESIGN-mobile-parity.md §4: the Clerk JWT reaches every REST
 *               surface). A later MOB-6x story builds the screen; `story` names it.
 *   'gap'     — nothing exists on the web either. These are Epic-P placeholders
 *               (`web/lib/navModel.ts` kind:'placeholder'). There is no port to do
 *               and no story to wait for — the web must grow the surface first.
 */
export type NavStatus = 'ready' | 'planned' | 'gap'

export interface NavItem {
  /** Stable id — identical to the web's `NavItem.id` (and its dashboard Tab value). */
  id: string
  label: string
  /** Text glyph. Paired with the label everywhere — never meaning-by-hue (see theme.ts). */
  glyph: string
  status: NavStatus
  /** One line: what this surface is for. Row subtitle + placeholder body. */
  blurb: string
  /** 'planned' only — the story that builds it (docs/DESIGN-mobile-parity.md §6). */
  story?: string
  /** Bottom-tab slot. Exactly the surfaces MOB-1..4 shipped. */
  primary?: boolean
  /** Web-only bookkeeping: this surface renders as a tab on that web page. */
  webHosted?: string
  /** Web-only bookkeeping: off the web rail, reachable via ⌘K. */
  webHidden?: boolean
  /** No web peer at all — mobile-only (Status). */
  mobileOnly?: boolean
}

export type NavGroupId = 'overview' | 'workspace' | 'operate' | 'delivery' | 'company' | 'general'

export interface NavGroup {
  id: NavGroupId
  label: string
  items: NavItem[]
}

/** The plan every 'planned' blurb is promising against. */
export const PARITY_DOC = 'docs/DESIGN-mobile-parity.md'

// The IA. Group order + ids + labels are the web's (web/lib/navModel.ts).
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      {
        id: 'assistant',
        label: 'Command Center',
        // MOB-1's glyph, kept verbatim: the tab bar must not shift under anyone.
        glyph: '✦',
        status: 'ready',
        blurb: 'Ask Arturita. Text chat against the hosted backend.',
        primary: true,
      },
      {
        id: 'inbox',
        label: 'Inbox',
        glyph: '✓',
        status: 'ready',
        blurb: 'Approvals: approve, reject, or request changes from the phone.',
        primary: true,
      },
      {
        id: 'overview',
        label: 'Dashboard',
        glyph: '🏠',
        status: 'planned',
        story: 'MOB-6f',
        blurb: 'Org summary — agent, task, and project cards at a glance.',
      },
      {
        id: 'cockpit',
        label: 'Operations',
        glyph: '🛰️',
        status: 'planned',
        story: 'MOB-6f',
        blurb: 'The live operations shell.',
      },
      {
        id: 'comms',
        label: 'Comms',
        glyph: '📬',
        status: 'planned',
        story: 'MOB-6i',
        blurb: 'Notification triage, alongside the Inbox.',
        webHosted: 'inbox',
      },
      {
        id: 'activity',
        label: 'Activity',
        glyph: '📈',
        status: 'planned',
        story: 'MOB-6f',
        blurb: 'The event timeline — what happened, when.',
      },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      {
        id: 'agents',
        label: 'Agents',
        glyph: '🤖',
        status: 'ready',
        blurb: 'The agent roster. Detail views arrive in MOB-6b.',
        primary: true,
      },
      {
        id: 'projects',
        label: 'Projects',
        glyph: '📁',
        status: 'planned',
        story: 'MOB-6i',
        blurb: 'The project list.',
      },
      {
        id: 'org',
        label: 'Org',
        glyph: '🗂️',
        status: 'planned',
        story: 'MOB-6g',
        blurb: 'Who reports to whom — an indented tree, not the desktop canvas.',
      },
      {
        id: 'tasks',
        label: 'Issues',
        glyph: '📋',
        status: 'planned',
        story: 'MOB-6c',
        blurb: 'Tasks and issues — list plus a read-only detail.',
        webHidden: true,
      },
      {
        id: 'routines',
        label: 'Routines',
        glyph: '🔁',
        status: 'gap',
        blurb: 'Recurring scheduled tasks. The backend exists; no UI does, on any client.',
      },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    items: [
      {
        id: 'governance',
        label: 'Governance',
        glyph: '🛡️',
        status: 'planned',
        story: 'MOB-6h',
        blurb: 'Policies, trust tiers, and revisions — read-only; edits stay on desktop.',
      },
      {
        id: 'review-queue',
        label: 'Review Queue',
        glyph: '🧪',
        status: 'gap',
        blurb: 'Low-trust quarantine review lives inside Governance today.',
      },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      {
        id: 'costs',
        label: 'Costs',
        glyph: '💰',
        status: 'planned',
        story: 'MOB-6d',
        blurb: 'What the org is spending.',
      },
      {
        id: 'budgets',
        label: 'Budgets',
        glyph: '💵',
        status: 'planned',
        story: 'MOB-6d',
        blurb: 'Budget caps and preflight checks.',
        webHosted: 'costs',
      },
      {
        id: 'skills',
        label: 'Skills',
        glyph: '⚡',
        status: 'planned',
        story: 'MOB-6i',
        blurb: 'The skill catalogue.',
      },
      {
        id: 'memory',
        label: 'Memory',
        glyph: '🧠',
        status: 'planned',
        story: 'MOB-6e',
        blurb: 'Browse the vault and read a note. The force graph stays on desktop.',
      },
      {
        id: 'goals',
        label: 'Goals',
        glyph: '🎯',
        status: 'planned',
        story: 'MOB-6i',
        blurb: 'Org goals.',
        webHidden: true,
      },
      {
        id: 'workspaces',
        label: 'Workspaces',
        glyph: '🧱',
        status: 'planned',
        story: 'MOB-6i',
        blurb: 'Workspace list.',
        webHidden: true,
      },
      {
        id: 'artifacts',
        label: 'Artifacts',
        glyph: '📦',
        status: 'gap',
        blurb: 'Work-product stacks. Not built on any client.',
        webHidden: true,
      },
      {
        id: 'pipelines',
        label: 'Pipelines',
        glyph: '🧩',
        status: 'gap',
        blurb: 'Multi-stage case pipelines. No pipeline entity exists yet.',
        webHidden: true,
      },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    items: [
      {
        id: 'connectors',
        label: 'Connectors',
        glyph: '🔌',
        status: 'planned',
        story: 'MOB-6k',
        blurb: 'Integration status. Starting an OAuth flow stays on desktop.',
      },
      {
        id: 'plugins',
        label: 'Plugins',
        glyph: '🧰',
        status: 'planned',
        story: 'MOB-6k',
        blurb: 'Installed plugin manifests.',
        webHosted: 'connectors',
      },
      {
        id: 'members',
        label: 'Members & Access',
        glyph: '👥',
        status: 'gap',
        blurb: 'Per-resource grants. We have org-level roles; the ledger is unbuilt.',
      },
    ],
  },
  {
    id: 'general',
    label: 'General',
    items: [
      {
        id: 'status',
        label: 'Status',
        // MOB-1's glyph, kept verbatim.
        glyph: '◈',
        status: 'ready',
        blurb: 'Backend health, push notifications, and this session.',
        primary: true,
        mobileOnly: true,
      },
      {
        id: 'usage',
        label: 'Usage',
        glyph: '📊',
        status: 'planned',
        story: 'MOB-6i',
        blurb: 'Usage statistics.',
      },
      {
        id: 'settings',
        label: 'Settings',
        glyph: '⚙️',
        status: 'planned',
        story: 'MOB-6j',
        blurb: 'Org description, mission, and culture — read-only.',
      },
      {
        id: 'secrets',
        label: 'Secrets',
        glyph: '🔐',
        status: 'planned',
        story: 'MOB-6j',
        // Not a nicety: the phone shows which secrets are SET, never their values.
        blurb: 'Which secrets are configured. References only — never a value.',
        webHosted: 'settings',
      },
      {
        id: 'adapters',
        label: 'Adapters',
        glyph: '🧷',
        status: 'gap',
        blurb: 'BYO-runtime adapter registry. Not built on any client.',
        webHosted: 'settings',
      },
      {
        id: 'search',
        label: 'Search',
        glyph: '🔍',
        status: 'gap',
        blurb: 'Global search. The web has ⌘K; neither client has a search page.',
        webHidden: true,
      },
    ],
  },
]

/** Every destination, in group order. */
export function allNavItems(): NavItem[] {
  return NAV_GROUPS.flatMap((g) => g.items)
}

/** Look up any destination by id (undefined if unknown). */
export function findNavItem(id: string): NavItem | undefined {
  return allNavItems().find((i) => i.id === id)
}

/**
 * The bottom-tab surfaces, in tab-bar order. A phone tab bar holds ~5 before the
 * targets get too small, so this stays deliberately short — everything else is
 * one tap away under More.
 */
export function primaryItems(): NavItem[] {
  return allNavItems().filter((i) => i.primary)
}

export function isPrimary(id: string): boolean {
  return !!findNavItem(id)?.primary
}

/** What the More screen lists: every non-primary destination, grouped. */
export function moreGroups(): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.primary) })).filter(
    (g) => g.items.length > 0,
  )
}

/** Destinations reachable only through More (i.e. everything the tab bar drops). */
export function moreItems(): NavItem[] {
  return moreGroups().flatMap((g) => g.items)
}
