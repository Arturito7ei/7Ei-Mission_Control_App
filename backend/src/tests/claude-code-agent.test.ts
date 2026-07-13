import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { prepareApprovalRecord, renderActionSummary } from '../services/dangerous-approvals.ts'

// Epic CC / CC2 — the propose-and-approve machine_exec bridge. When the Claude
// Code adapter proposes a command it files `{type:'machine_exec', action:{argv}}`
// through the agent-facing approvals route; `prepareApprovalRecord` guarantees
// the human sees the VERBATIM argv (never the agent's prose) + step-up, and
// fail-closes on a malformed payload. Shared with the human approvals route.

describe('[CC2] prepareApprovalRecord — machine_exec verbatim render', () => {
  it('machine-renders the verbatim argv, ignoring agent-supplied summary', () => {
    const r = prepareApprovalRecord({
      type: 'machine_exec',
      summary: 'trust me, this is safe',              // model prose — must be ignored
      action: { argv: ['npm', 'run', 'build'], cwd: '/repo' },
    })
    assert.equal(r.ok, true)
    assert.equal(r.summary, 'Run: npm run build (cwd: /repo)')
    assert.equal(/trust me/.test(r.summary!), false)  // prose never leaks into the card
    assert.equal(r.payload.requiresStepUp, true)      // inherits A2 step-up
    assert.deepEqual(r.payload.action.argv, ['npm', 'run', 'build'])
  })

  it('reads action from payload.action when action is absent', () => {
    const r = prepareApprovalRecord({ type: 'machine_exec', payload: { action: { argv: ['git', 'status'] } } })
    assert.equal(r.ok, true)
    assert.equal(r.summary, 'Run: git status')
    assert.equal(r.payload.requiresStepUp, true)
  })

  it('fail-closed: empty/missing argv is rejected (no row is written)', () => {
    for (const bad of [{}, { argv: [] }, { argv: 'rm -rf /' }, undefined]) {
      const r = prepareApprovalRecord({ type: 'machine_exec', action: bad as any })
      assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`)
      assert.match(r.error!, /dangerous approval/)
    }
  })

  it('surfaces the not-allowlisted warning on the card', () => {
    const r = prepareApprovalRecord({ type: 'machine_exec', action: { argv: ['curl', 'x'], allowlisted: false } })
    assert.equal(r.ok, true)
    assert.ok((r.warnings ?? []).some(w => /allowlist/i.test(w)))
    assert.ok((r.payload.warnings ?? []).some((w: string) => /allowlist/i.test(w)))
  })
})

describe('[CC2] prepareApprovalRecord — other dangerous + safe types', () => {
  it('file_destructive is machine-rendered + step-up', () => {
    const r = prepareApprovalRecord({ type: 'file_destructive', action: { op: 'delete', count: 3, root: '/tmp/x' } })
    assert.equal(r.ok, true)
    assert.match(r.summary!, /Delete 3 items/)
    assert.equal(r.payload.requiresStepUp, true)
  })

  it('file_destructive fail-closed on bad op', () => {
    const r = prepareApprovalRecord({ type: 'file_destructive', action: { op: 'chmod', count: 1 } })
    assert.equal(r.ok, false)
  })

  it('a safe type keeps the caller summary + passthrough payload, no step-up tag', () => {
    const r = prepareApprovalRecord({ type: 'memory.write', summary: 'write a note', payload: { path: 'x.md' } })
    assert.equal(r.ok, true)
    assert.equal(r.summary, 'write a note')
    assert.deepEqual(r.payload, { path: 'x.md' })
  })

  it('a safe type without a summary is rejected', () => {
    const r = prepareApprovalRecord({ type: 'memory.write' })
    assert.equal(r.ok, false)
    assert.match(r.error!, /summary/)
  })

  it('matches renderActionSummary for the dangerous summary (single source of truth)', () => {
    const action = { argv: ['ls', '-la'] }
    assert.equal(prepareApprovalRecord({ type: 'machine_exec', action }).summary, renderActionSummary('machine_exec', action).summary)
  })
})
