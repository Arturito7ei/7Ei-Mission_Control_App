import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildGoalTree, goalAncestry, formatGoalContext } from '../services/goals.ts'

const G = (id: string, parentGoalId: string | null = null, extra: any = {}) =>
  ({ id, title: id.toUpperCase(), parentGoalId, ...extra })

describe('[MCA-PC B1] buildGoalTree', () => {
  it('nests subgoals under parents', () => {
    const tree = buildGoalTree([G('root'), G('a', 'root'), G('b', 'a')])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].children[0].id, 'a')
    assert.equal(tree[0].children[0].children[0].id, 'b')
  })
  it('promotes orphans to roots and breaks cycles', () => {
    assert.equal(buildGoalTree([G('x', 'ghost')]).length, 1)
    const cyc = buildGoalTree([G('a', 'b'), G('b', 'a')])
    assert.equal(cyc.length + cyc[0].children.length, 2)  // no infinite loop, both present
  })
})

describe('[MCA-PC B1] goalAncestry', () => {
  it('returns ordered root→leaf inclusive', () => {
    const goals = [G('root'), G('mid', 'root'), G('leaf', 'mid')]
    assert.deepEqual(goalAncestry(goals, 'leaf').map(g => g.id), ['root', 'mid', 'leaf'])
  })
  it('handles missing id', () => assert.deepEqual(goalAncestry([G('a')], 'nope'), []))
})

describe('[MCA-PC B1] formatGoalContext', () => {
  it('includes mission, titles, and metrics', () => {
    const out = formatGoalContext([G('root', null, { metric: '$1M MRR' }), G('leaf', 'root')], 'Win')
    assert.match(out, /Company mission: Win/)
    assert.match(out, /ROOT \[metric: \$1M MRR\]/)
    assert.match(out, /LEAF/)
  })
  it('empty when nothing to say', () => assert.equal(formatGoalContext([], null), ''))
})
