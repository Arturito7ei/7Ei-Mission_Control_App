// Arturita Local Host — action-layer tests (node --test). Exercises the REAL
// filesystem path against a temp-dir root: reads work, denylist + traversal are
// refused, destructive ops fail closed without approval and are reversible with
// it. Run: `npm test` in adapters/arturita-host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listDir, readFile, preview, applyDestructive, undo } from '../src/actions.mjs'
import { hitsDenylist, hitsSystemIntegrity, decideAccess } from '../src/safety.mjs'

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arturita-host-'))
  return fs.realpathSync(d)
}

test('[host] safety: denylist + system-integrity + traversal', () => {
  assert.equal(hitsDenylist('/Users/op/.ssh/id_rsa'), true)
  assert.equal(hitsDenylist('/Users/op/.arturita-keystore/burner.json'), true)
  assert.equal(hitsSystemIntegrity('/usr/bin/x'), true)
  assert.equal(hitsSystemIntegrity('/usr/local/bin/x'), false)
  const root = tmpRoot()
  // a path outside root is refused
  assert.equal(decideAccess({ op: 'read', target: '/etc/hosts', root }).allowed, false)
})

test('[host] list + read work on real files', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
  fs.mkdirSync(path.join(root, 'sub'))
  const l = listDir({ target: root, root })
  assert.equal(l.ok, true)
  assert.ok(l.entries.find(e => e.name === 'a.txt' && e.bytes === 5))
  const r = readFile({ target: path.join(root, 'a.txt'), root })
  assert.equal(r.ok, true)
  assert.equal(r.content, 'hello')
})

test('[host] a denylisted target is refused for read', () => {
  const root = tmpRoot()
  const ks = path.join(root, '.arturita-keystore')
  fs.mkdirSync(ks); fs.writeFileSync(path.join(ks, 'burner.json'), 'SECRET')
  const r = readFile({ target: path.join(ks, 'burner.json'), root })
  assert.equal(r.ok, false)
  assert.match(r.reason, /denylist/)
})

test('[host] preview summarizes a move without performing it', () => {
  const root = tmpRoot()
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `f${i}.png`), 'xx')
  const pv = preview({ op: 'move', targets: [0, 1, 2].map(i => path.join(root, `f${i}.png`)), destination: path.join(root, 'arch'), root })
  assert.equal(pv.ok, true)
  assert.equal(pv.manifest.fileCount, 3)
  assert.equal(pv.blast.verdict, 'needs_approval') // destructive → approval
  // files still in place (preview didn't move them)
  assert.equal(fs.existsSync(path.join(root, 'f0.png')), true)
})

test('[host] destructive apply FAILS CLOSED without approval', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'del.txt'), 'x')
  const res = applyDestructive({ op: 'delete', targets: [path.join(root, 'del.txt')], root, approved: false })
  assert.equal(res.ok, false)
  assert.match(res.reason, /approved|fail-closed/i)
  assert.equal(fs.existsSync(path.join(root, 'del.txt')), true) // untouched
})

test('[host] approved delete is staged + reversible via undo', () => {
  const root = tmpRoot()
  const f = path.join(root, 'del.txt')
  fs.writeFileSync(f, 'important')
  const res = applyDestructive({ op: 'delete', targets: [f], root, approved: true })
  assert.equal(res.ok, true)
  assert.equal(fs.existsSync(f), false)         // removed from original location
  const u = undo({ token: res.token })
  assert.equal(u.ok, true)
  assert.equal(u.restored, 1)
  assert.equal(fs.existsSync(f), true)          // restored
  assert.equal(fs.readFileSync(f, 'utf8'), 'important')
})

test('[host] approved move relocates the file and is reversible', () => {
  const root = tmpRoot()
  const f = path.join(root, 'a.png')
  const dest = path.join(root, 'archive')
  fs.writeFileSync(f, 'img')
  const res = applyDestructive({ op: 'move', targets: [f], destination: dest, root, approved: true })
  assert.equal(res.ok, true)
  assert.equal(fs.existsSync(path.join(dest, 'a.png')), true)
  assert.equal(fs.existsSync(f), false)
  const u = undo({ token: res.token })
  assert.equal(u.ok, true)
  assert.equal(fs.existsSync(f), true)          // moved back
})
