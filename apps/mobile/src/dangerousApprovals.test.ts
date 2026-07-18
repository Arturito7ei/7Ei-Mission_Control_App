// APPR-1 — tripwires pinning the phone's dangerous-approval-type copy.
//
// `constants.ts` hand-copies DANGEROUS_APPROVAL_TYPES from the backend. Metro can't
// import backend source, and `backend/src/services/dangerous-approvals.ts` is not
// importable even from a test: it pulls `./cc-denylist` + `./connector-authz`, and
// Mobile CI installs ONLY apps/mobile's dependencies — a transitive drizzle import
// would silently drop this entire test file in CI while passing locally. So the
// backend side is TEXT-READ, the same pattern the connector-catalog and
// execution-status tripwires already use (agentConnectors.test.ts).
//
// Before APPR-1 NO test pinned this copy, and it had drifted: `connector_action`
// was missing, so a connector approval reached step-up only via the incidental
// `payload.requiresStepUp` fallback. Both assertions below are EQUALITY, not
// subset — a backend type we lack means a one-tap approve that 403s, and a type we
// have that the backend doesn't means step-up friction on a safe action.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DANGEROUS_APPROVAL_TYPES,
  isDangerousApprovalType,
  approvalNeedsStepUp,
} from './constants.ts'
// The web's copy. Safe to import here ONLY because `web/lib/dangerousApprovals.ts`
// is deliberately import-free — see the cross-workspace constraint in the root
// CLAUDE.md (Mobile CI has no web/ node_modules, so any dep would drop this file).
import { DANGEROUS_APPROVAL_TYPES as WEB_DANGEROUS_APPROVAL_TYPES } from '../../../web/lib/dangerousApprovals.ts'

function backendDangerousTypes(): string[] {
  const src = readFileSync(
    new URL('../../../backend/src/services/dangerous-approvals.ts', import.meta.url),
    'utf8',
  )
  const m = /DANGEROUS_APPROVAL_TYPES\s*=\s*\[([\s\S]*?)\n\]/.exec(src)
  assert.ok(m, 'could not locate DANGEROUS_APPROVAL_TYPES in the backend source')
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

test('[APPR-1] the phone’s dangerous-type set EQUALS the backend’s', () => {
  const backend = backendDangerousTypes()
  assert.ok(backend.length > 0, 'backend set parsed empty — the check would be vacuous')
  assert.deepEqual(
    [...DANGEROUS_APPROVAL_TYPES].sort(),
    [...backend].sort(),
    'apps/mobile/src/constants.ts drifted from backend/src/services/dangerous-approvals.ts — ' +
      'reconcile before merging (a missing type = a one-tap Approve that 403s at the server)',
  )
})

test('[APPR-1] the phone’s dangerous-type set EQUALS the web’s', () => {
  assert.deepEqual(
    [...DANGEROUS_APPROVAL_TYPES].sort(),
    [...WEB_DANGEROUS_APPROVAL_TYPES].sort(),
    'phone and desk disagree about which approvals are dangerous — one surface is gating and the other is not',
  )
})

test('[APPR-1] connector_action is covered without leaning on the payload fallback', () => {
  // The regression that motivated APPR-1: with `connector_action` absent from the
  // list, THIS assertion failed and step-up was reached only via payload.requiresStepUp.
  assert.ok(isDangerousApprovalType('connector_action'))
  assert.ok(approvalNeedsStepUp({ type: 'connector_action' }), 'must need step-up on TYPE alone')
  assert.ok(
    approvalNeedsStepUp({ type: 'connector_action', payload: null }),
    'must need step-up even with NO payload — proving the type clause, not the fallback, carries it',
  )
})

test('[APPR-1] the payload.requiresStepUp fallback is retained (defence in depth)', () => {
  // Belt and braces: a low_trust_review WRAPPING a dangerous action has a safe outer
  // type but the flag set. The backend gates on it too, so the phone must as well.
  assert.ok(approvalNeedsStepUp({ type: 'low_trust_review', payload: { requiresStepUp: true } }))
  assert.equal(approvalNeedsStepUp({ type: 'note_review', payload: { requiresStepUp: false } }), false)
  assert.equal(approvalNeedsStepUp({ type: 'note_review', payload: null }), false)
})
