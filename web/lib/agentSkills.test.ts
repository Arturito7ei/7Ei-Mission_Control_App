import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextSelection, optimisticSplit, selectionOf, type SkillsPayload } from './agentSkills.ts'

const sk = (name: string, installed: boolean) => ({ id: name, name, installed })

const payload = (installed: string[], other: string[], orphaned: string[] = []): SkillsPayload => ({
  installed: installed.map(n => sk(n, true)),
  other: other.map(n => sk(n, false)),
  orphaned,
  selectedCount: installed.length + orphaned.length,
  adapter: 'internal',
  model: 'claude-sonnet-4-20250514',
})

test('[AG-SK] selection is the installed library skills plus any orphans', () => {
  assert.deepEqual(selectionOf(payload(['research'], ['writing'], ['gone'])), ['research', 'gone'])
})

test('[AG-SK] ticking adds, unticking removes', () => {
  assert.deepEqual(nextSelection(['research'], 'writing'), ['research', 'writing'])
  assert.deepEqual(nextSelection(['research', 'writing'], 'research'), ['writing'])
})

test('[AG-SK] installing moves the skill across and bumps the count', () => {
  const before = payload(['research'], ['writing'])
  const after = optimisticSplit(before, nextSelection(selectionOf(before), 'writing'))

  assert.deepEqual(after.installed.map(s => s.name), ['research', 'writing'])
  assert.deepEqual(after.other.map(s => s.name), [])
  assert.equal(after.selectedCount, 2)
  assert.ok(after.installed.every(s => s.installed))
})

test('[AG-SK] uninstalling moves it back to Other and drops the count', () => {
  const before = payload(['research', 'writing'], [])
  const after = optimisticSplit(before, nextSelection(selectionOf(before), 'research'))

  assert.deepEqual(after.installed.map(s => s.name), ['writing'])
  assert.deepEqual(after.other.map(s => s.name), ['research'])
  assert.equal(after.selectedCount, 1)
  assert.equal(after.other[0].installed, false)
})

test('[AG-SK] Other stays alphabetical after an uninstall', () => {
  const before = payload(['beta'], ['alpha', 'gamma'])
  const after = optimisticSplit(before, [])
  assert.deepEqual(after.other.map(s => s.name), ['alpha', 'beta', 'gamma'])
})

test('[AG-SK] an orphan stays installed and keeps counting until it is unticked', () => {
  const before = payload(['research'], ['writing'], ['gone'])
  assert.equal(before.selectedCount, 2)

  // Toggling something else must not disturb the orphan.
  const kept = optimisticSplit(before, nextSelection(selectionOf(before), 'writing'))
  assert.deepEqual(kept.orphaned, ['gone'])
  assert.equal(kept.selectedCount, 3)

  // Unticking the orphan is the only way to be rid of it.
  const dropped = optimisticSplit(before, nextSelection(selectionOf(before), 'gone'))
  assert.deepEqual(dropped.orphaned, [])
  assert.equal(dropped.selectedCount, 1)
})

test('[AG-SK] the optimistic split matches what the server would send back', () => {
  // Same fixture, same expectation as the backend's splitSkills — if these two
  // ever disagree the checkbox would flip and then visibly flip back.
  const before = payload(['research'], ['writing', 'analysis'])
  const after = optimisticSplit(before, ['research', 'analysis'])
  assert.deepEqual(after.installed.map(s => s.name), ['research', 'analysis'])
  assert.deepEqual(after.other.map(s => s.name), ['writing'])
  assert.equal(after.selectedCount, 2)
})

test('[AG-SK] uninstalling everything is legitimate and leaves nothing selected', () => {
  const after = optimisticSplit(payload(['a', 'b'], []), [])
  assert.equal(after.selectedCount, 0)
  assert.deepEqual(after.other.map(s => s.name), ['a', 'b'])
})
