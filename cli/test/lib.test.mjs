import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest } from '../lib.mjs'

test('routes commands to method + path + body', () => {
  assert.deepEqual(buildRequest(['me']), { method: 'GET', path: '/api/agent/me' })
  assert.equal(buildRequest(['tasks']).path, '/api/agent/tasks?state=assigned')
  assert.equal(buildRequest(['tasks', 'all']).path, '/api/agent/tasks?state=all')
  assert.deepEqual(buildRequest(['claim', 'T1']), { method: 'POST', path: '/api/agent/tasks/T1/claim' })
  const r = buildRequest(['result', 'T1', 'done', 'all', 'good'])
  assert.equal(r.path, '/api/agent/tasks/T1/result')
  assert.deepEqual(r.body, { status: 'done', output: 'all good' })
  assert.equal(buildRequest(['mem', 'tree']).path, '/api/agent/memory/tree?path=vault')
  assert.equal(buildRequest(['mem', 'read', 'vault/a b.md']).path, '/api/agent/memory/file?path=vault%2Fa%20b.md')
  const w = buildRequest(['mem', 'write', 'vault/Memory/x.md', 'hi', 'there'])
  assert.equal(w.method, 'PUT')
  assert.deepEqual(w.body, { path: 'vault/Memory/x.md', markdown: 'hi there' })
  assert.deepEqual(buildRequest(['heartbeat']).body, { status: 'green' })
  assert.equal(buildRequest(['runlog', 'R1', 'step', '2']).body.log, 'step 2')
})

test('errors on missing args + unknown command', () => {
  assert.throws(() => buildRequest(['claim']), /missing taskId/)
  assert.throws(() => buildRequest(['nope']), /unknown command/)
  assert.throws(() => buildRequest(['mem', 'read']), /missing path/)
})
