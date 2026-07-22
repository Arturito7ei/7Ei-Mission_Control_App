import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAV_GROUPS, HIDDEN_ITEMS, allNavItems, allSurfaces, hostedTabItems, navTabIds,
  findNavItem, isPlaceholder, isSection, isHidden, navSectionKey,
  navPageTabs, navParentId, navSelectedId, navSurfaceTitle,
  parseCollapsed, serializeCollapsed, toggleCollapsed, type NavGroupId,
} from './navModel.ts'

// The dashboard tabs that must ALL stay reachable after the re-fold
// (14 at the P2 re-fold; +chat with MCC-1).
const EXISTING_TABS = [
  'overview', 'cockpit', 'assistant', 'memory', 'agents', 'tasks',
  'projects', 'skills', 'costs', 'comms', 'connectors', 'governance', 'usage', 'settings',
  'chat', // MCC-1
]

// P1 — surfaces taken off the rail entirely. Still routable, never rendered in the sidebar.
// P2 — `tasks` left this list: it is now a hosted tab under Inbox (see FOLDED).
const REMOVED_FROM_RAIL = ['search', 'goals', 'pipelines', 'workspaces', 'artifacts']

// P1 — surfaces folded into a parent page's tab bar: child → parent.
const FOLDED: Record<string, string> = {
  budgets: 'costs',
  plugins: 'connectors',
  chat: 'inbox', // MCC-1 — talk to an agent, replies included
  tasks: 'inbox', // P2 — tasks + approvals are one area
  comms: 'inbox',
  adapters: 'settings',
  secrets: 'settings',
}

test('[P0-web] groups are in Paperclip order', () => {
  assert.deepEqual(
    NAV_GROUPS.map(g => g.id),
    ['overview', 'workspace', 'operate', 'delivery', 'company', 'general'],
  )
})

test('[P0-web] every existing tab is re-homed exactly once (nothing lost)', () => {
  // The invariant survives P1: a tab may now live in the rail, in a parent's tab
  // bar, or off-rail-but-routable — but it must still exist, exactly once.
  const tabIds = navTabIds()
  for (const t of EXISTING_TABS) {
    assert.equal(tabIds.filter(id => id === t).length, 1, `tab ${t} must appear exactly once`)
  }
  // and the nav introduces no phantom tabs beyond the known 14.
  assert.deepEqual([...tabIds].sort(), [...EXISTING_TABS].sort())
})

// ─── P1 — the restructure: removals + folds ─────────────────────────────────

test('[P1-nav] removed surfaces are gone from the sidebar', () => {
  const railIds = allNavItems().map(i => i.id)
  for (const id of REMOVED_FROM_RAIL) {
    assert.equal(railIds.includes(id), false, `${id} must not be a rail item`)
    assert.equal(isHidden(id), true, `${id} must be a hidden (off-rail) surface`)
  }
})

test('[P1-nav] removed surfaces stay routable — the code is kept, not deleted', () => {
  for (const id of REMOVED_FROM_RAIL) {
    const item = findNavItem(id)
    assert.ok(item, `${id} must still resolve (deep links + palette)`)
    assert.equal(item!.id, id)
    assert.ok(item!.label && item!.icon, `${id} still needs a label + icon for the palette`)
    // and it is reachable through the surface set the palette and router walk.
    assert.equal(allSurfaces().some(sfc => sfc.id === id), true)
  }
  // The real surfaces we kept still render the way they always did.
  assert.equal(navSectionKey('goals'), 'goals')
  assert.equal(navSectionKey('workspaces'), 'workspaces')
})

test('[P1-nav] folded surfaces are tabs on their parent page, not rail items', () => {
  const railIds = allNavItems().map(i => i.id)
  for (const [child, parent] of Object.entries(FOLDED)) {
    assert.equal(railIds.includes(child), false, `${child} must not be a rail item any more`)
    assert.equal(railIds.includes(parent), true, `${parent} must still be a rail item`)
    assert.equal(navParentId(child), parent, `${child} must be hosted by ${parent}`)
    // Selecting the child keeps the PARENT lit in the sidebar.
    assert.equal(navSelectedId(child), parent)
    // …and the child is still a fully-resolvable surface.
    assert.ok(findNavItem(child), `${child} must still resolve`)
  }
  // A rail item that hosts nothing has no parent and selects itself.
  assert.equal(navParentId('memory'), undefined)
  assert.equal(navSelectedId('memory'), 'memory')
})

test('[P1-nav] each parent page exposes exactly the expected tab bar, itself first', () => {
  assert.deepEqual(navPageTabs('costs'), [
    { id: 'costs', label: 'Costs' },
    { id: 'budgets', label: 'Budgets' },
  ])
  assert.deepEqual(navPageTabs('connectors'), [
    { id: 'connectors', label: 'Connectors' },
    { id: 'plugins', label: 'Plugins' },
  ])
  // P2 — the tasks + approvals area: the Inbox tab is the approvals view, Tasks
  // is the log, and they sit side by side under one rail entry.
  assert.deepEqual(navPageTabs('inbox'), [
    { id: 'inbox', label: 'Inbox' },
    { id: 'chat', label: 'Chat' }, // MCC-1
    { id: 'tasks', label: 'Tasks' },
    { id: 'comms', label: 'Comms' },
  ])
  assert.deepEqual(navPageTabs('settings'), [
    { id: 'settings', label: 'Settings' },
    { id: 'adapters', label: 'Adapters' },
    { id: 'secrets', label: 'Secrets' },
  ])
  // Pages that host nothing get no tab bar (PageTabs renders null under 2 tabs).
  for (const id of ['overview', 'assistant', 'agents', 'memory', 'usage', 'governance']) {
    assert.deepEqual(navPageTabs(id), [], `${id} must not sprout a tab bar`)
  }
  // Only the four parents host tabs — nothing else silently grows one.
  assert.deepEqual(
    allNavItems().filter(i => i.tabs?.length).map(i => i.id).sort(),
    ['connectors', 'costs', 'inbox', 'settings'],
  )
})

// P2 — the operator asked for tasks folded under Inbox and for "Tasks" to reach
// the tasks + approvals dashboard. These are that ask, locked down.
test('[MCC-1] Chat is folded under Inbox, renders a real tab, and keeps Inbox lit', () => {
  const railIds = allNavItems().map(i => i.id)
  assert.equal(railIds.includes('chat'), false, 'Chat is not its own rail entry')
  assert.equal(isHidden('chat'), false, 'Chat is not an off-rail surface')
  assert.equal(navParentId('chat'), 'inbox')
  assert.equal(navSelectedId('chat'), 'inbox')
  assert.equal(findNavItem('chat')?.kind, 'tab', 'Chat renders the real Chat surface, not a placeholder')
  assert.equal(findNavItem('chat')?.label, 'Chat')
})

test('[P2-nav] Tasks is folded under Inbox and clicking it keeps Inbox lit', () => {
  const railIds = allNavItems().map(i => i.id)
  assert.equal(railIds.includes('tasks'), false, 'Tasks is not its own rail entry')
  assert.equal(isHidden('tasks'), false, 'Tasks is no longer an off-rail surface')
  assert.equal(navParentId('tasks'), 'inbox')
  assert.equal(navSelectedId('tasks'), 'inbox')
  assert.equal(findNavItem('tasks')?.kind, 'tab', 'Tasks still renders the real Task Log, not a placeholder')
  assert.equal(findNavItem('tasks')?.label, 'Tasks')
})

test('[P2-nav] selecting Tasks surfaces the approvals view as a sibling tab', () => {
  // Reaching Tasks puts the operator on the Inbox area's tab bar, where the
  // Inbox tab IS the approvals surface (CockpitPanel section `inbox`).
  const bar = navPageTabs(navSelectedId('tasks'))
  assert.ok(bar.some(t => t.id === 'tasks'), 'Tasks is on the bar it lands on')
  assert.ok(bar.some(t => t.id === 'inbox'), 'approvals are one tab away')
  assert.equal(navSectionKey('inbox'), 'inbox')
})

test('[P2-nav] the Inbox rail entry is labelled for itself, like every other parent', () => {
  // It used to read "Inbox / Comms"; enumerating children stops scaling once a
  // parent hosts more than one, and Costs/Connectors/Settings never did it.
  for (const id of ['inbox', 'costs', 'connectors', 'settings']) {
    const item = allNavItems().find(i => i.id === id)!
    assert.equal(item.label.includes('/'), false, `${id} must not enumerate its children`)
  }
  assert.equal(allNavItems().find(i => i.id === 'inbox')?.label, 'Inbox')
  assert.equal(navSurfaceTitle('inbox'), 'Inbox')
  assert.equal(navSurfaceTitle('tasks'), 'Tasks')
  assert.equal(navSurfaceTitle('comms'), 'Comms')
})

test('[P1-nav] the sidebar is exactly the intended items, in order', () => {
  assert.deepEqual(
    NAV_GROUPS.map(g => [g.id, g.items.map(i => i.id)]),
    [
      ['overview', ['overview', 'assistant', 'cockpit', 'inbox', 'activity']],
      ['workspace', ['agents', 'projects', 'org', 'routines']],
      ['operate', ['governance', 'review-queue']],
      ['delivery', ['costs', 'skills', 'memory']],
      ['company', ['connectors', 'members']],
      ['general', ['usage', 'settings']],
    ],
  )
})

test('[P1-nav] every surface lives in exactly one place: rail, a tab bar, or hidden', () => {
  const ids = allSurfaces().map(i => i.id)
  assert.equal(new Set(ids).size, ids.length, 'no surface is registered twice')
  // Partition check: rail ∪ hosted ∪ hidden == allSurfaces, with no overlap.
  const rail = new Set(allNavItems().map(i => i.id))
  const hosted = new Set(hostedTabItems().map(i => i.id))
  const hidden = new Set(HIDDEN_ITEMS.map(i => i.id))
  assert.equal(rail.size + hosted.size + hidden.size, new Set(ids).size)
  for (const h of hosted) assert.equal(rail.has(h), false)
  for (const h of hidden) { assert.equal(rail.has(h), false); assert.equal(hosted.has(h), false) }
})

// ─── Invariants carried over from P0 ────────────────────────────────────────

// FIX 4 — the nav item is labelled for the surface, not the persona. The id is
// the dashboard Tab value and is deep-linked, so it stays `assistant`.
test('[AGFIX4] the assistant nav item reads "Command Center", keeping its id', () => {
  const item = findNavItem('assistant')
  assert.equal(item?.label, 'Command Center')
  assert.equal(item?.kind, 'tab')
  assert.equal(allSurfaces().filter(i => i.label === 'Arturita').length, 0, 'no nav item is labelled with the persona')
})

// Command Center is the operator's primary way in, so it sits directly under
// Dashboard in Overview and wears the microphone (it is voice-first).
test('[AGFIX5] Command Center is second in Overview, right after Dashboard', () => {
  const overview = NAV_GROUPS.find(g => g.id === 'overview')
  assert.deepEqual(
    overview?.items.slice(0, 2).map(i => i.id),
    ['overview', 'assistant'],
  )
})

test('[AGFIX5] Command Center carries the microphone icon', () => {
  assert.equal(findNavItem('assistant')?.icon, '🎙️')
})

test('[P0-web] nav item ids are globally unique', () => {
  const ids = allSurfaces().map(i => i.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('[P0-web] every item carries an icon, label, and Paperclip mapping', () => {
  for (const i of allSurfaces()) {
    assert.ok(i.icon, `${i.id} needs an icon`)
    assert.ok(i.label, `${i.id} needs a label`)
    assert.ok(i.paperclip, `${i.id} needs a paperclip mapping`)
  }
})

test('[P0-web] placeholders are flagged and explain themselves (no faked features)', () => {
  const placeholders = allSurfaces().filter(i => i.kind === 'placeholder')
  // The genuinely-missing Paperclip areas, per the mapping doc. (Adapters is now
  // a Settings tab, and Search/Pipelines/Artifacts are off-rail — still honest.)
  assert.deepEqual(
    placeholders.map(i => i.id).sort(),
    ['adapters', 'artifacts', 'members', 'pipelines', 'review-queue', 'routines', 'search'].sort(),
  )
  for (const p of placeholders) {
    assert.ok(p.note && p.note.length > 10, `${p.id} placeholder needs an explanatory note`)
    assert.equal(isPlaceholder(p.id), true)
  }
  // A real tab is never mistaken for a placeholder.
  assert.equal(isPlaceholder('governance'), false)
  assert.equal(isPlaceholder('nope'), false)
})

test('[P0b-web] promoted Cockpit sections are first-class areas with valid keys', () => {
  // Keys CockpitPanel knows how to render focused (CockpitSectionKey union).
  const COCKPIT_KEYS = new Set(['inbox', 'voice', 'agents', 'activity', 'org', 'goals', 'budgets', 'secrets', 'workspaces', 'plugins', 'tasks'])
  const sections = allSurfaces().filter(i => i.kind === 'section')
  // The 8 Cockpit sections we promoted out of the Operations stack — same eight
  // after P1; some are rail items, some tabs, some off-rail.
  assert.deepEqual(
    sections.map(i => i.id).sort(),
    ['activity', 'budgets', 'goals', 'inbox', 'org', 'plugins', 'secrets', 'workspaces'].sort(),
  )
  for (const sec of sections) {
    assert.equal(isSection(sec.id), true)
    assert.ok(sec.section, `${sec.id} needs a section key`)
    assert.equal(navSectionKey(sec.id), sec.section)
    assert.ok(COCKPIT_KEYS.has(sec.section!), `${sec.id} → ${sec.section} must be a CockpitPanel key`)
  }
  // A tab is never a section, and navSectionKey is undefined for non-sections.
  assert.equal(isSection('governance'), false)
  assert.equal(navSectionKey('governance'), undefined)
  assert.equal(navSectionKey('nope'), undefined)
})

test('[P0-web] beyond-Paperclip surfaces are tabs, not placeholders', () => {
  for (const id of ['assistant', 'memory', 'comms']) {
    const item = findNavItem(id)
    assert.equal(item?.kind, 'tab')
    assert.equal(item?.beyond, true)
  }
})

test('[P0-web] collapsed state round-trips and ignores garbage', () => {
  const set = parseCollapsed('workspace, delivery ,bogus,,operate')
  assert.deepEqual([...set].sort(), ['delivery', 'operate', 'workspace'])
  // serialize is canonical (group order), not insertion order
  assert.equal(serializeCollapsed(set), 'workspace,operate,delivery')
  // empty / null → empty set
  assert.equal(parseCollapsed(null).size, 0)
  assert.equal(parseCollapsed('').size, 0)
  assert.equal(serializeCollapsed(new Set<NavGroupId>()), '')
})

test('[P0-web] toggleCollapsed flips one group without mutating the input', () => {
  const start = parseCollapsed('operate')
  const opened = toggleCollapsed(start, 'operate')
  assert.equal(opened.has('operate'), false)
  assert.equal(start.has('operate'), true, 'original set is not mutated')
  const closed = toggleCollapsed(opened, 'company')
  assert.equal(closed.has('company'), true)
  assert.equal(closed.has('operate'), false)
})
