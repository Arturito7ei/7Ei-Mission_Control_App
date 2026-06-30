import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canAgentRun, parseApprovalDirectives, stripApprovalDirectives } from '../services/governance.ts'

describe('[MCA-PC B2] canAgentRun', () => {
  it('blocks paused and terminated', () => {
    assert.equal(canAgentRun('paused'), false)
    assert.equal(canAgentRun('terminated'), false)
  })
  it('allows normal statuses', () => {
    for (const s of ['idle', 'active', undefined, null]) assert.equal(canAgentRun(s as any), true)
  })
})

describe('[MCA-PC B2] parseApprovalDirectives', () => {
  it('parses type + summary and normalises the type', () => {
    const d = parseApprovalDirectives('ok [APPROVAL: Spend | Buy $500 of ads] done')
    assert.equal(d.length, 1)
    assert.equal(d[0].type, 'spend')
    assert.equal(d[0].summary, 'Buy $500 of ads')
  })
  it('parses multiple', () => {
    assert.equal(parseApprovalDirectives('[APPROVAL: hire | a dev] [APPROVAL: external action | post tweet]').length, 2)
  })
  it('returns none when absent', () => {
    assert.deepEqual(parseApprovalDirectives('no directives here'), [])
  })
  it('strips directives from visible output', () => {
    assert.equal(stripApprovalDirectives('Plan ready. [APPROVAL: spend | x]'), 'Plan ready.')
  })
})
