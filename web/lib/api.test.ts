import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiHeaders, transportError } from './api.ts'

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

// Content-Type is a claim about a body. Putting it on a bodiless DELETE made the
// backend's JSON parser reject the avatar Remove before the handler saw it.

test('[AGFIX4] a bodiless request does not claim a JSON body', () => {
  const h = apiHeaders({ method: 'DELETE', token: 't' })
  assert.equal(h['Content-Type'], undefined)
  assert.equal(h.Authorization, 'Bearer t')
})

test('[AGFIX4] a request with a body still declares JSON', () => {
  const h = apiHeaders({ method: 'PUT', token: 't', body: JSON.stringify({ a: 1 }) })
  assert.equal(h['Content-Type'], 'application/json')
})

test('[AGFIX4] an explicit Content-Type still wins', () => {
  const h = apiHeaders({ method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } })
  assert.equal(h['Content-Type'], 'text/plain')
})

test('[CC-ATT] a FormData body is left for the browser to type', () => {
  // Only the browser knows the multipart boundary, so claiming JSON over a
  // FormData body produces a request the server can't parse — it must not be set.
  const h = apiHeaders({ method: 'POST', token: 't', body: new FormData() })
  assert.equal(h['Content-Type'], undefined)
  assert.equal(h.Authorization, 'Bearer t')
  // an explicit override still wins, as with every other body type
  const forced = apiHeaders({ method: 'POST', body: new FormData(), headers: { 'Content-Type': 'multipart/form-data; boundary=x' } })
  assert.equal(forced['Content-Type'], 'multipart/form-data; boundary=x')
})
