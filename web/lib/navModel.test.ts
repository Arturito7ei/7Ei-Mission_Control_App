import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAV_GROUPS, allNavItems, navTabIds, findNavItem, isPlaceholder,
  isSection, navSectionKey,
  parseCollapsed, serializeCollapsed, toggleCollapsed, type NavGroupId,
} from './navModel.ts'

// The 14 dashboard tabs that must ALL stay reachable after the re-fold.
const EXISTING_TABS = [
  'overview', 'cockpit', 'assistant', 'memory', 'agents', 'tasks',
  'projects', 'skills', 'costs', 'comms', 'connectors', 'governance', 'usage', 'settings',
]

test('[P0-web] groups are in Paperclip order', () => {
  assert.deepEqual(
    NAV_GROUPS.map(g => g.id),
    ['overview', 'workspace', 'operate', 'delivery', 'company', 'general'],
  )
})

test('[P0-web] every existing tab is re-homed exactly once (nothing lost)', () => {
  const tabIds = navTabIds()
  for (const t of EXISTING_TABS) {
    assert.equal(tabIds.filter(id => id === t).length, 1, `tab ${t} must appear exactly once`)
  }
  // and the nav introduces no phantom tabs beyond the known 14.
  assert.deepEqual([...tabIds].sort(), [...EXISTING_TABS].sort())
})

test('[P0-web] nav item ids are globally unique', () => {
  const ids = allNavItems().map(i => i.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('[P0-web] every item carries an icon, label, and Paperclip mapping', () => {
  for (const i of allNavItems()) {
    assert.ok(i.icon, `${i.id} needs an icon`)
    assert.ok(i.label, `${i.id} needs a label`)
    assert.ok(i.paperclip, `${i.id} needs a paperclip mapping`)
  }
})

test('[P0-web] placeholders are flagged and explain themselves (no faked features)', () => {
  const placeholders = allNavItems().filter(i => i.kind === 'placeholder')
  // The genuinely-missing Paperclip areas, per the mapping doc.
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
  const sections = allNavItems().filter(i => i.kind === 'section')
  // The 8 Cockpit sections we promote out of the Operations stack.
  assert.deepEqual(
    sections.map(i => i.id).sort(),
    ['activity', 'budgets', 'goals', 'inbox', 'org', 'plugins', 'secrets', 'workspaces'].sort(),
  )
  for (const sroot of sections) {
    assert.equal(isSection(sroot.id), true)
    assert.ok(sroot.section, `${sroot.id} needs a section key`)
    assert.equal(navSectionKey(sroot.id), sroot.section)
    assert.ok(COCKPIT_KEYS.has(sroot.section!), `${sroot.id} → ${sroot.section} must be a CockpitPanel key`)
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
