// APPR-1 — tripwire: the desk's dangerous-type copy must equal the backend's.
//
// `web/lib/dangerousApprovals.ts` hand-copies DANGEROUS_APPROVAL_TYPES because the
// backend module pulls cc-denylist + connector-authz (and transitively drizzle),
// which must not enter the browser bundle. A copy without a tripwire is silent
// drift — exactly how the phone ended up one entry behind (missing
// `connector_action`) and relying on an incidental payload fallback to reach
// step-up at all.
//
// Read the backend as TEXT (it cannot be imported here for the reason above) and
// assert SET EQUALITY, not subset:
//   • a backend type we lack  → the desk renders a plain Approve for a dangerous
//     action, sends no step-up header, and the operator sees a 403 they cannot act on;
//   • a type we have and the backend does not → the desk demands step-up for
//     something the server waves through — friction on a safe path.
// Both are bugs, so neither direction is allowed to pass.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DANGEROUS_APPROVAL_TYPES,
  isDangerousApprovalType,
  approvalNeedsStepUp,
  typedConfirmationOk,
  dangerDetails,
  TYPED_CONFIRM_WORD,
} from './dangerousApprovals.ts'

function backendDangerousTypes(): string[] {
  const src = readFileSync(
    new URL('../../backend/src/services/dangerous-approvals.ts', import.meta.url),
    'utf8',
  )
  const m = /DANGEROUS_APPROVAL_TYPES\s*=\s*\[([\s\S]*?)\n\]/.exec(src)
  assert.ok(m, 'could not locate DANGEROUS_APPROVAL_TYPES in the backend source')
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

test('[APPR-1] the desk’s dangerous-type set EQUALS the backend’s', () => {
  const backend = backendDangerousTypes()
  assert.ok(backend.length > 0, 'backend set parsed empty — the check would be vacuous')
  assert.deepEqual(
    [...DANGEROUS_APPROVAL_TYPES].sort(),
    [...backend].sort(),
    'web/lib/dangerousApprovals.ts drifted from backend/src/services/dangerous-approvals.ts — ' +
      'reconcile before merging (a missing type = a dangerous action approved with no step-up header → 403 the operator cannot clear)',
  )
})

test('[APPR-1] connector_action is covered — the CONN-9 everyday case', () => {
  // Named explicitly: CONN-9 wired connector actions into the agent run loop, so
  // this is the type most likely to hit the desk. The generic equality test above
  // would catch its removal, but this states the intent for the next reader.
  assert.ok(backendDangerousTypes().includes('connector_action'), 'backend no longer marks connector_action dangerous — intentional?')
  assert.ok(isDangerousApprovalType('connector_action'))
  assert.ok(approvalNeedsStepUp({ type: 'connector_action' }))
})

test('[APPR-1] type matching is normalized exactly like the backend', () => {
  // The direct approval-creation route stores `type` verbatim, so these shapes reach
  // the client and must all be caught — else the desk shows a plain Approve.
  for (const t of ['machine_exec', 'Machine_Exec', ' machine exec ', 'MACHINE  EXEC']) {
    assert.ok(isDangerousApprovalType(t), `should be dangerous: ${JSON.stringify(t)}`)
  }
  for (const t of [null, undefined, '', 'note_review', 'join_request']) {
    assert.equal(isDangerousApprovalType(t as any), false, `should NOT be dangerous: ${JSON.stringify(t)}`)
  }
})

test('[APPR-1] the payload.requiresStepUp fallback is retained (defence in depth)', () => {
  // A low_trust_review WRAPPING a dangerous action: outer type is safe, payload
  // flags it. The backend gates on this too, so the desk must route it to step-up.
  assert.ok(approvalNeedsStepUp({ type: 'low_trust_review', payload: { requiresStepUp: true } }))
  assert.equal(approvalNeedsStepUp({ type: 'low_trust_review', payload: { requiresStepUp: false } }), false)
  assert.equal(approvalNeedsStepUp({ type: 'note_review', payload: null }), false)
  assert.equal(approvalNeedsStepUp({ type: 'note_review' }), false)
})

test('[APPR-1] typed confirmation is exact and case-sensitive', () => {
  assert.ok(typedConfirmationOk('APPROVE'))
  assert.ok(typedConfirmationOk('  APPROVE  '), 'surrounding whitespace is trimmed')
  for (const bad of ['approve', 'Approve', 'APPROVED', 'OK', '', null, undefined]) {
    assert.equal(typedConfirmationOk(bad as any), false, `should not confirm: ${JSON.stringify(bad)}`)
  }
  assert.equal(TYPED_CONFIRM_WORD, 'APPROVE')
})

test('[APPR-1] dangerDetails surfaces the machine-rendered summary + warnings, never throws', () => {
  const d = dangerDetails({
    type: 'connector_action',
    summary: 'DESTRUCTIVE GitHub: repo.delete → 7ei/mission-control',
    payload: { warnings: ['Destructive connector action — always requires approval, even for a trusted connector.'] },
  })
  assert.equal(d.typeLabel, 'connector action')
  assert.match(d.summary, /repo\.delete/)
  assert.equal(d.warnings.length, 1)

  // Defensive shapes — an odd payload must degrade, not crash the Inbox.
  assert.deepEqual(dangerDetails({ type: 'wallet_tx', summary: 's', payload: null }).warnings, [])
  assert.deepEqual(dangerDetails({ type: 'wallet_tx', summary: 's', payload: { warnings: 'nope' } }).warnings, [])
  assert.equal(dangerDetails({ type: 'wallet_tx', summary: '', payload: {} }).summary, '(no summary provided)')
})
