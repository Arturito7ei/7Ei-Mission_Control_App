import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideApproval, APPROVAL_DECISIONS } from '../services/approvals.ts'

const now = new Date(1_700_000_000_000)

describe('[MCA-84 V2] decideApproval', () => {
  it('accepts approved with no note', () => {
    const r = decideApproval({ decision: 'approved', actor: 'u1', now })
    assert.equal(r.ok, true)
    assert.equal(r.patch!.status, 'approved')
    assert.equal(r.patch!.decidedBy, 'u1')
    assert.equal(r.patch!.decidedAt, now)
    assert.equal(r.patch!.decisionNote, null)
  })
  it('accepts rejected with an optional trimmed note', () => {
    const r = decideApproval({ decision: 'rejected', note: '  too risky  ', actor: 'u1', now })
    assert.equal(r.ok, true)
    assert.equal(r.patch!.status, 'rejected')
    assert.equal(r.patch!.decisionNote, 'too risky')
  })
  it('requires a note for revision_requested (the loop)', () => {
    const missing = decideApproval({ decision: 'revision_requested', actor: 'u1', now })
    assert.equal(missing.ok, false)
    assert.match(missing.error!, /note/)
    const blank = decideApproval({ decision: 'revision_requested', note: '   ', actor: 'u1', now })
    assert.equal(blank.ok, false)
  })
  it('accepts revision_requested with a note', () => {
    const r = decideApproval({ decision: 'revision_requested', note: 'add a cost cap', actor: 'u1', now })
    assert.equal(r.ok, true)
    assert.equal(r.patch!.status, 'revision_requested')
    assert.equal(r.patch!.decisionNote, 'add a cost cap')
  })
  it('rejects an unknown decision', () => {
    for (const bad of ['approve', 'pending', '', null, undefined, 42]) {
      const r = decideApproval({ decision: bad, actor: 'u1', now })
      assert.equal(r.ok, false, `decision=${String(bad)}`)
    }
  })
  it('exposes exactly the three decisions', () => {
    assert.deepEqual([...APPROVAL_DECISIONS].sort(), ['approved', 'rejected', 'revision_requested'])
  })
})
