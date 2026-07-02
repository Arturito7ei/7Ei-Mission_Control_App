import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBlockedBy, blockersSatisfied, isLeaseExpired, isClaimable, appendLog } from '../services/runs'

test('parseBlockedBy tolerates junk and non-arrays', () => {
  assert.deepEqual(parseBlockedBy('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseBlockedBy(null), [])
  assert.deepEqual(parseBlockedBy('nope'), [])
  assert.deepEqual(parseBlockedBy('{"x":1}'), [])
  assert.deepEqual(parseBlockedBy('[1,"a",true]'), ['a'])
})

test('blockersSatisfied requires every blocker done', () => {
  assert.equal(blockersSatisfied([]), true)
  assert.equal(blockersSatisfied(['done', 'done']), true)
  assert.equal(blockersSatisfied(['done', 'in_progress']), false)
})

test('isLeaseExpired treats missing lock as expired and honours the window', () => {
  const now = 1_000_000
  assert.equal(isLeaseExpired(null, now, 1000), true)
  assert.equal(isLeaseExpired(now - 500, now, 1000), false)
  assert.equal(isLeaseExpired(now - 2000, now, 1000), true)
  assert.equal(isLeaseExpired(new Date(now - 2000), now, 1000), true)
})

test('isClaimable: assigned always, in_progress only when lease expired', () => {
  const now = 1_000_000
  assert.equal(isClaimable({ status: 'assigned' }, now, 1000), true)
  assert.equal(isClaimable({ status: 'in_progress', lockedAt: now - 500 }, now, 1000), false)
  assert.equal(isClaimable({ status: 'in_progress', lockedAt: now - 2000 }, now, 1000), true)
  assert.equal(isClaimable({ status: 'done' }, now, 1000), false)
})

test('appendLog appends, timestamps, and caps at 200 entries', () => {
  const one = appendLog(null, 'hello', 42)
  assert.deepEqual(JSON.parse(one), [{ t: 42, msg: 'hello' }])
  let acc = ''
  for (let i = 0; i < 250; i++) acc = appendLog(acc, `m${i}`, i)
  const arr = JSON.parse(acc)
  assert.equal(arr.length, 200)
  assert.equal(arr[arr.length - 1].msg, 'm249')
})
