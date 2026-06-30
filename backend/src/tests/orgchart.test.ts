import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildOrgChart, directReports, countTree } from '../services/orgchart.ts'

const A = (id: string, reportsTo: string | null = null) =>
  ({ id, name: id.toUpperCase(), role: 'role', reportsTo })

describe('[MCA-PC A1] buildOrgChart', () => {
  it('roots agents with no manager', () => {
    const tree = buildOrgChart([A('ceo')])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].id, 'ceo')
    assert.deepEqual(tree[0].children, [])
  })

  it('nests reports under their manager', () => {
    const tree = buildOrgChart([A('ceo'), A('cto', 'ceo'), A('eng', 'cto')])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].children[0].id, 'cto')
    assert.equal(tree[0].children[0].children[0].id, 'eng')
    assert.equal(countTree(tree), 3)
  })

  it('promotes orphans (manager not in set) to roots', () => {
    const tree = buildOrgChart([A('eng', 'ghost')])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].id, 'eng')
  })

  it('breaks cycles without losing agents', () => {
    const tree = buildOrgChart([A('a', 'b'), A('b', 'a')])
    assert.equal(countTree(tree), 2)  // both present, no infinite loop
  })

  it('handles multiple roots', () => {
    const tree = buildOrgChart([A('ceo'), A('advisor'), A('cto', 'ceo')])
    assert.equal(tree.length, 2)
    assert.equal(countTree(tree), 3)
  })

  it('directReports returns immediate children only', () => {
    const agents = [A('ceo'), A('cto', 'ceo'), A('eng', 'cto')]
    assert.deepEqual(directReports(agents, 'ceo').map(a => a.id), ['cto'])
  })
})
