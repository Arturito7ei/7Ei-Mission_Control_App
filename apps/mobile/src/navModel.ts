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
        // Was MOB-6f. That story got re-scoped to the three operator menus
        // (Governance/Settings/Connectors) and shipped WITHOUT this screen, so
        // the promise moves to MOB-6l rather than pointing at a done story —
        // a placeholder naming a shipped story is exactly the dead end the
        // three-valued `status` exists to avoid. Parity doc §6 table.
        story: 'MOB-6l',
        blurb: 'Org summary — agent, task, and project cards at a glance.',
      },
      {
        id: 'cockpit',
        label: 'Operations',
        glyph: '🛰️',
        status: 'planned',
        // Was MOB-6f — see the note on `overview` above.
        story: 'MOB-6l',
        blurb: 'The live operations shell.',
      },
      // P2 (web #286) — Tasks folds in under Inbox: the operator's queue of work
      // and the approvals waiting on them are ONE area, so Tasks sits beside
      // Inbox and Comms here exactly as it does in the web's tab bar
      // (Inbox | Tasks | Comms).
      //
      // MOB-7a completed that fold. It used to be adjacency ONLY — a shared group
      // here, but two separate screens — which is the web's one tabbed page read
      // as two destinations. Now `tasks` opens the SAME screen `inbox` does, on
      // its Tasks segment (navigation.tsx `TasksEntry` → InboxScreen). The entry
      // stays: it is a web surface, so the model owes it a destination and More
      // still lists it. What changed is where it renders, not whether it exists.
      // MCC-1 — Chat: direct conversation with an agent, replies included. A
      // hosted tab under Inbox on the web (before Tasks in its bar), rendered
      // here as a segment of the same Inbox screen.
      {
        id: 'chat',
        label: 'Chat',
        glyph: '💬',
        status: 'ready',
        blurb: 'Talk to an agent — thread and composer, replies included.',
        webHosted: 'inbox',
      },
      {
        id: 'tasks',
        label: 'Tasks',
        glyph: '📋',
        // MOB-6b built this (it was pencilled in for MOB-6c): the roster→detail
        // work needed the task vocabulary anyway, so the log came with it.
        status: 'ready',
        blurb: 'The task log, in the Inbox beside the approvals it feeds.',
        webHosted: 'inbox',
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
        // MOB-6d built this (it was pencilled in for MOB-6f): the cost work read
        // the same task rows the timeline projects, so the feed came with it.
        status: 'ready',
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
        blurb: 'The agent roster — tap an agent for its detail.',
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
        // MOB-6e built this (it was pencilled in for MOB-6g): the Memory tree and
        // the org tree are the same problem — a heavy web view whose value is a
        // hierarchy, not its canvas — so they shipped as one story.
        status: 'ready',
        blurb: 'Who reports to whom — an indented tree, not the desktop canvas.',
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
        // MOB-6f built this (it was pencilled in for MOB-6h). The blurb already
        // promised read-only-with-edits-on-desktop, and the screen keeps that
        // promise exactly rather than quietly widening it: every write on the
        // web panel (add/remove policy, save permissions, trust tier, rollback)
        // is deferred, because this is the surface that decides what an agent is
        // allowed to do and none of those has an undo.
        status: 'ready',
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
        status: 'ready',
        blurb: 'What the org is spending.',
      },
      {
        id: 'budgets',
        label: 'Budgets',
        glyph: '💵',
        status: 'ready',
        // MOB-6d ships the caps, read-only. Preflight is NOT here: it's a
        // separate web section (cockpit/PreflightSection) with no nav id of its
        // own, so the blurb no longer promises it — the phone shouldn't advertise
        // a surface this row doesn't open.
        blurb: 'Budget caps and how much of each is used.',
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
        status: 'ready',
        // The blurb was already honest about the graph staying on the desk, and
        // MOB-6e kept that promise rather than quietly widening it.
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
        // MOB-6f built this (it was pencilled in for MOB-6k). The blurb's promise
        // is kept verbatim: status reads, and starting an OAuth flow stays on the
        // desktop — as do the credential forms, which this app never shows.
        status: 'ready',
        blurb: 'Integration status. Starting an OAuth flow stays on desktop.',
      },
      {
        id: 'plugins',
        label: 'Plugins',
        glyph: '🧰',
        status: 'planned',
        // Was MOB-6k, which shipped inside MOB-6f (§6.7) WITHOUT this screen —
        // 6f built the connector status read, not the plugin manifests. The
        // parity doc always had this folding into "6i/6k" as a thin read-only
        // list, so it goes to the batch that's still open rather than naming a
        // story that's already done.
        story: 'MOB-6i',
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
        // MOB-6f built this (it was pencilled in for MOB-6j). It is a SHORT
        // screen, because the web's Settings tab is a form whose only reading is
        // these three fields — the blurb already said exactly that, so it stands.
        // `secrets` below stays planned: despite the webHosted bookkeeping, the
        // web's Settings tab does not render it, and MOB-6f reads nothing from
        // the secrets endpoint.
        status: 'ready',
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
