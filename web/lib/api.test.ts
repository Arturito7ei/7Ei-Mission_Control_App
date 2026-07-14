import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transportError } from './api.ts'

// The message the operator actually reads when a write fails before it leaves
// the browser. It used to be a bare "Network error — backend unreachable" for
// every case, which sent us hunting a dead backend while the real cause was a
// CORS policy that did not allow PUT/DELETE.

test('[AGFIX1] a failed write names the method and path, and points at CORS', () => {
  const msg = transportError('PUT', '/api/orgs/o1/agents/a1/files')
  assert.match(msg, /PUT \/api\/orgs\/o1\/agents\/a1\/files/)
  assert.match(msg, /CORS/)
})

test('[AGFIX1] a failed read stays a plain unreachable message', () => {
  const msg = transportError('GET', '/api/orgs/o1/agents/a1/files')
  assert.match(msg, /could not reach the backend/)
  assert.doesNotMatch(msg, /CORS/)
})

test('[AGFIX1] the method is normalised', () => {
  assert.match(transportError('delete', '/x'), /DELETE \/x/)
})
