import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requiresApproval, parseCapabilities, isCapabilityAllowed, signRunToken, verifyRunToken } from '../services/governance2'

test('requiresApproval matches action + truthy flag', () => {
  const pol = [{ action: 'agent.hire', requiresApproval: true }, { action: 'deploy', requiresApproval: 0 }]
  assert.equal(requiresApproval(pol, 'agent.hire'), true)
  assert.equal(requiresApproval(pol, 'deploy'), false)
  assert.equal(requiresApproval(pol, 'unknown'), false)
  assert.equal(requiresApproval(null, 'x'), false)
})

test('isCapabilityAllowed: allow-all when unset, else exact/wildcard', () => {
  assert.equal(isCapabilityAllowed(null, 'memory:write'), true)
  assert.equal(isCapabilityAllowed([], 'memory:write'), true)
  assert.equal(isCapabilityAllowed(['memory:read'], 'memory:write'), false)
  assert.equal(isCapabilityAllowed(['memory:write'], 'memory:write'), true)
  assert.equal(isCapabilityAllowed(['memory:*'], 'memory:write'), true)
  assert.equal(isCapabilityAllowed(['*'], 'anything:goes'), true)
  assert.equal(isCapabilityAllowed(['connector:github'], 'connector:slack'), false)
})

test('parseCapabilities tolerates junk', () => {
  assert.deepEqual(parseCapabilities('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseCapabilities(null), [])
  assert.deepEqual(parseCapabilities('{"x":1}'), [])
})

test('run token round-trips, rejects tampering + expiry', () => {
  const now = 1_000_000_000_000
  const tok = signRunToken({ agentId: 'a1', runId: 'r1' }, 'sekret', now, 60_000)
  const ok = verifyRunToken(tok, 'sekret', now + 1000)
  assert.equal(ok.valid, true)
  assert.equal(ok.payload.agentId, 'a1')
  assert.equal(verifyRunToken(tok, 'wrong-secret', now).valid, false)
  assert.equal(verifyRunToken(tok + 'x', 'sekret', now).valid, false)
  const expired = verifyRunToken(tok, 'sekret', now + 120_000)
  assert.equal(expired.valid, false)
  assert.equal(expired.reason, 'expired')
  assert.equal(verifyRunToken('garbage', 'sekret', now).valid, false)
})
