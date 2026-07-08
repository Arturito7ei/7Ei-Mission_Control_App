import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOST_EXECUTION_ENABLED, assertExecutionEnabled,
  canonicalizePath, isWithinRoot, hitsDenylist, decideAccess,
  classifyBlastRadius, planHostOp, buildUndoEntry, isReversible,
  DEFAULT_DENYLIST, DEFAULT_BLAST_CAPS, DEFAULT_UNDO_WINDOW_MS,
} from '../services/host-planner'

// ─── Fail-closed master switch ───────────────────────────────────────────────

test('[C1] host execution is DISABLED (fail-closed) until S3 confirmed', () => {
  assert.equal(HOST_EXECUTION_ENABLED, false)
  assert.throws(() => assertExecutionEnabled(), /DISABLED|fail-closed/i)
})

// ─── Path canonicalization ───────────────────────────────────────────────────

test('[C1] canonicalizePath resolves . / .. and collapses slashes', () => {
  assert.equal(canonicalizePath('/Users/a/./b/../c'), '/Users/a/c')
  assert.equal(canonicalizePath('/Users/a//b/'), '/Users/a/b')
  assert.equal(canonicalizePath('/Users/a/b/../../..'), '/')       // can't escape root
  assert.equal(canonicalizePath('a/b/../c'), 'a/c')
  assert.equal(canonicalizePath(''), '')
})

// ─── Root prefix check ───────────────────────────────────────────────────────

test('[C1] isWithinRoot allows in-root, blocks traversal + sibling escape', () => {
  const root = '/Users/op/Arturita'
  assert.equal(isWithinRoot('/Users/op/Arturita/docs/x.md', root), true)
  assert.equal(isWithinRoot('/Users/op/Arturita', root), true)               // root itself
  assert.equal(isWithinRoot('/Users/op/Arturita/../secret', root), false)    // .. escape
  assert.equal(isWithinRoot('/Users/op/ArturitaEvil/x', root), false)        // prefix-not-boundary
  assert.equal(isWithinRoot('/etc/passwd', root), false)
})

// ─── Denylist ────────────────────────────────────────────────────────────────

test('[C1] hitsDenylist hard-denies catastrophic targets anywhere in the path', () => {
  assert.equal(hitsDenylist('/Users/op/.ssh/id_rsa'), true)
  assert.equal(hitsDenylist('/Users/op/project/.env'), true)
  assert.equal(hitsDenylist('/Users/op/Library/Keychains/login.keychain'), true)
  assert.equal(hitsDenylist('/Users/op/.metamask/vault'), true)
  assert.equal(hitsDenylist('/Users/op/.arturita-host/config.json'), true)
  assert.equal(hitsDenylist('/Users/op/Documents/notes.md'), false)
  assert.equal(hitsDenylist(''), true) // blank → denied (fail closed)
})

// ─── Access decision ─────────────────────────────────────────────────────────

test('[C1] decideAccess: in-root non-denylisted allowed; escapes + denylist refused', () => {
  const root = '/Users/op/Arturita'
  assert.equal(decideAccess({ op: 'read', path: '/Users/op/Arturita/x.md', root }).allowed, true)
  assert.equal(decideAccess({ op: 'read', path: '/Users/op/Arturita/.ssh/id_rsa', root }).allowed, false)
  assert.equal(decideAccess({ op: 'write', path: '/etc/hosts', root }).allowed, false)
  // symlink escape flag (set by the daemon after real resolution) → refused
  assert.equal(decideAccess({ op: 'write', path: '/Users/op/Arturita/link', root, symlinkEscapes: true }).allowed, false)
})

// ─── Blast radius ────────────────────────────────────────────────────────────

test('[C1] classifyBlastRadius: small read auto-safe; destructive needs approval', () => {
  assert.equal(classifyBlastRadius({ op: 'read', radius: { fileCount: 1, totalBytes: 100 } }).verdict, 'auto_safe')
  assert.equal(classifyBlastRadius({ op: 'write', radius: { fileCount: 2, totalBytes: 1000 } }).verdict, 'auto_safe')
  // destructive is never auto-safe
  assert.equal(classifyBlastRadius({ op: 'delete', radius: { fileCount: 1, totalBytes: 1 } }).verdict, 'needs_approval')
  assert.equal(classifyBlastRadius({ op: 'move', radius: { fileCount: 1, totalBytes: 1 } }).verdict, 'needs_approval')
})

test('[C1] classifyBlastRadius: over auto-safe threshold or recursive → approval', () => {
  assert.equal(classifyBlastRadius({ op: 'write', radius: { fileCount: 999, totalBytes: 1 } }).verdict, 'needs_approval')
  assert.equal(classifyBlastRadius({ op: 'write', radius: { fileCount: 1, totalBytes: 1, recursive: true } }).verdict, 'needs_approval')
})

test('[C1] classifyBlastRadius: over the hard ceiling → refuse outright', () => {
  const over = { fileCount: DEFAULT_BLAST_CAPS.hardMaxFiles + 1, totalBytes: 1 }
  assert.equal(classifyBlastRadius({ op: 'delete', radius: over }).verdict, 'refuse')
  const overBytes = { fileCount: 1, totalBytes: DEFAULT_BLAST_CAPS.hardMaxBytes + 1 }
  assert.equal(classifyBlastRadius({ op: 'read', radius: overBytes }).verdict, 'refuse')
})

// ─── Combined plan ───────────────────────────────────────────────────────────

test('[C1] planHostOp: refused outside root, never executable in this build', () => {
  const root = '/Users/op/Arturita'
  const outside = planHostOp({ op: 'delete', path: '/etc/passwd', root })
  assert.equal(outside.outcome, 'refused')
  assert.equal(outside.executable, false)

  const safe = planHostOp({ op: 'read', path: '/Users/op/Arturita/x.md', root, radius: { fileCount: 1, totalBytes: 10 } })
  assert.equal(safe.outcome, 'auto_safe')
  assert.equal(safe.executable, false) // fail-closed: no execution until S3 + daemon

  const destructive = planHostOp({ op: 'delete', path: '/Users/op/Arturita/old', root, radius: { fileCount: 42, totalBytes: 1000 } })
  assert.equal(destructive.outcome, 'needs_approval')
  assert.equal(destructive.approvalType, 'file_destructive')
  assert.equal(destructive.executable, false)
})

test('[C1] planHostOp refuses a denylisted target even if small + in root', () => {
  const p = planHostOp({ op: 'read', path: '/Users/op/Arturita/.env', root: '/Users/op/Arturita', radius: { fileCount: 1, totalBytes: 10 } })
  assert.equal(p.outcome, 'refused')
})

// ─── Undo journal ────────────────────────────────────────────────────────────

test('[C1] buildUndoEntry + isReversible respect the window and staged originals', () => {
  const e = buildUndoEntry({ op: 'delete', original: '/Users/op/Arturita/x', staged: '/Users/op/.arturita-trash/x', now: 1000 })
  assert.equal(e.expiresAt, 1000 + DEFAULT_UNDO_WINDOW_MS)
  assert.equal(isReversible(e, 1000 + 5000), true)
  assert.equal(isReversible(e, 1000 + DEFAULT_UNDO_WINDOW_MS + 1), false) // window passed
  // no staged original (e.g. a read) → not reversible
  assert.equal(isReversible({ ...e, staged: null }, 1001), false)
  assert.equal(isReversible(null, 1001), false)
})

// ─── S3: system-integrity self-protection + preview manifest ──────────────────

import { hitsSystemIntegrity, buildPreviewManifest, SYSTEM_INTEGRITY_PREFIXES } from '../services/host-planner'

test('[C1/S3] hitsSystemIntegrity denies SIP paths but allows /usr/local + user space', () => {
  assert.equal(hitsSystemIntegrity('/System/Library/CoreServices/x'), true)
  assert.equal(hitsSystemIntegrity('/usr/bin/python3'), true)
  assert.equal(hitsSystemIntegrity('/sbin/launchd'), true)
  assert.equal(hitsSystemIntegrity('/usr/local/bin/brew'), false) // operator carve-out
  assert.equal(hitsSystemIntegrity('/Users/op/Documents/notes.md'), false)
  assert.ok(SYSTEM_INTEGRITY_PREFIXES.length > 0)
})

test('[C1/S3] hitsDenylist now catches OS system-integrity + the burner keystore', () => {
  assert.equal(hitsDenylist('/System/Library/x'), true)
  assert.equal(hitsDenylist('/usr/lib/dyld'), true)
  assert.equal(hitsDenylist('/Users/op/.arturita-keystore/burner.json'), true)
  // whole-machine access: an ordinary user path is still allowed (S3)
  assert.equal(hitsDenylist('/Users/op/Projects/app/src/index.ts'), false)
})

test('[C1] buildPreviewManifest summarizes a destructive op (count/size/dest/sample)', () => {
  const files = Array.from({ length: 42 }, (_, i) => ({ path: `/Users/op/Downloads/f${i}.png`, bytes: 1000 }))
  const m = buildPreviewManifest({ op: 'move', files, destination: '/Users/op/Archive/2026-07', sampleCap: 20 })
  assert.equal(m.fileCount, 42)
  assert.equal(m.totalBytes, 42000)
  assert.equal(m.destination, '/Users/op/Archive/2026-07')
  assert.equal(m.files.length, 20)
  assert.equal(m.truncated, true)
})
