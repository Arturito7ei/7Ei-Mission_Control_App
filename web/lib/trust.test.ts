import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTrustMode, isLowTrust, parseBoundaryFields, boundaryToFields,
  boundaryCount, trustBadge, isContainedToNothing, isReviewCase, REVIEW_CASE_TYPE,
} from './trust.ts'

test('[P1-web] parseTrustMode defaults/garbage → standard (never lowers containment)', () => {
  assert.equal(parseTrustMode(undefined), 'standard')
  assert.equal(parseTrustMode('nope'), 'standard')
  assert.equal(parseTrustMode(' Low_Trust_Review '), 'low_trust_review')
  assert.equal(isLowTrust('low_trust_review'), true)
  assert.equal(isLowTrust('standard'), false)
})

test('[P1-web] boundary fields round-trip (trim, dedupe, drop empties)', () => {
  const b = parseBoundaryFields({ projects: 'p1, p1 , ,p2', tasks: 't1', agents: '' })
  assert.deepEqual(b, { projects: ['p1', 'p2'], tasks: ['t1'], agents: [] })
  assert.deepEqual(boundaryToFields(b), { projects: 'p1, p2', tasks: 't1', agents: '' })
  assert.equal(boundaryCount(b), 3)
})

test('[P1-web] trustBadge is colorblind-safe (icon + label + tone, not color alone)', () => {
  const low = trustBadge('low_trust_review')
  assert.equal(low.icon, '🛡')
  assert.equal(low.label, 'Low-trust review')
  assert.equal(low.tone, 'warn')
  const std = trustBadge('standard')
  assert.equal(std.label, 'Standard')
  assert.equal(std.tone, 'muted')
})

test('[P1-web] isContainedToNothing flags a low-trust agent with an empty boundary', () => {
  assert.equal(isContainedToNothing('low_trust_review', { projects: [], tasks: [], agents: [] }), true)
  assert.equal(isContainedToNothing('low_trust_review', { projects: ['p1'] }), false)
  assert.equal(isContainedToNothing('standard', {}), false)
})

test('[P1-web] isReviewCase identifies the shared quarantine approvals type', () => {
  assert.equal(REVIEW_CASE_TYPE, 'low_trust_review')
  assert.equal(isReviewCase('low_trust_review'), true)
  assert.equal(isReviewCase('spend'), false)
})
