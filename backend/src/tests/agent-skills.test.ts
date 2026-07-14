import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSelection, splitSkills, type SkillLike } from '../services/agent-skills'

const library: SkillLike[] = [
  { id: '1', name: 'paperclip', description: 'Control plane API' },
  { id: '2', name: 'paperclip-board', description: 'Board member' },
  { id: '3', name: 'para-memory-files', description: 'PARA memory' },
]

describe('[AG4] splitSkills', () => {
  it('splits the library into installed and other', () => {
    const r = splitSkills(library, ['paperclip'])
    assert.deepEqual(r.installed.map(s => s.name), ['paperclip'])
    assert.deepEqual(r.other.map(s => s.name), ['paperclip-board', 'para-memory-files'])
    assert.equal(r.selectedCount, 1)
    assert.ok(r.installed.every(s => s.installed))
    assert.ok(r.other.every(s => !s.installed))
  })

  it('lists "other" alphabetically and keeps the agent’s stored order for installed', () => {
    const r = splitSkills(library, ['para-memory-files', 'paperclip'])
    assert.deepEqual(r.installed.map(s => s.name), ['para-memory-files', 'paperclip'])
    assert.deepEqual(r.other.map(s => s.name), ['paperclip-board'])
  })

  it('reports a skill that vanished from the library as orphaned, not silently dropped', () => {
    const r = splitSkills(library, ['paperclip', 'deleted-skill'])
    assert.deepEqual(r.orphaned, ['deleted-skill'])
    assert.deepEqual(r.installed.map(s => s.name), ['paperclip'])
    assert.equal(r.selectedCount, 2) // an orphan is still selected on the agent
  })

  it('handles an agent with no skills and an empty library', () => {
    const none = splitSkills(library, [])
    assert.deepEqual(none.installed, [])
    assert.equal(none.other.length, 3)
    assert.equal(none.selectedCount, 0)

    const empty = splitSkills([], ['ghost'])
    assert.deepEqual(empty.other, [])
    assert.deepEqual(empty.orphaned, ['ghost'])
  })

  it('de-duplicates a name stored twice', () => {
    const r = splitSkills(library, ['paperclip', 'paperclip'])
    assert.equal(r.installed.length, 1)
    assert.equal(r.selectedCount, 1)
  })
})

describe('[AG4] resolveSelection', () => {
  it('accepts a valid selection and returns it in library order', () => {
    const r = resolveSelection(library, ['para-memory-files', 'paperclip'])
    assert.deepEqual(r, { ok: true, names: ['paperclip', 'para-memory-files'] })
  })

  it('accepts the empty selection (uninstalling everything is legitimate)', () => {
    assert.deepEqual(resolveSelection(library, []), { ok: true, names: [] })
  })

  it('refuses to store a name the library does not have', () => {
    const r = resolveSelection(library, ['paperclip', 'not-a-skill'])
    assert.equal(r.ok, false)
    assert.match((r as any).error, /not-a-skill/)
  })

  it('rejects a non-array or non-string payload', () => {
    for (const bad of [null, undefined, 'paperclip', { a: 1 }, [1, 2]]) {
      assert.equal(resolveSelection(library, bad).ok, false)
    }
  })

  it('de-duplicates and trims', () => {
    assert.deepEqual(resolveSelection(library, ['paperclip', ' paperclip ', '']), { ok: true, names: ['paperclip'] })
  })

  // The checkbox list resends the whole selection, orphans included. Refusing a
  // name the agent ALREADY carries made every toggle on such an agent a 400 —
  // which is what made the tab look read-only.
  it('keeps an orphan the agent already has instead of failing the whole write', () => {
    const r = resolveSelection(library, ['paperclip', 'gone-from-library'], ['paperclip', 'gone-from-library'])
    assert.equal(r.ok, true)
    assert.ok((r as { names: string[] }).names.includes('gone-from-library'))
  })

  it('still refuses a name that is neither in the library nor already on the agent', () => {
    const r = resolveSelection(library, ['paperclip', 'invented'], ['paperclip'])
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /invented/)
  })

  it('unticking an orphan drops it', () => {
    const r = resolveSelection(library, ['paperclip'], ['paperclip', 'gone-from-library'])
    assert.deepEqual(r, { ok: true, names: ['paperclip'] })
  })
})
