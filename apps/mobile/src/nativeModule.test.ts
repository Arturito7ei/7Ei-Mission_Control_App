// The contract that keeps a missing native module from blanking the app.
//
// This module is deliberately dependency-free (no react-native import), which is
// what lets it run under the workspace's node --test harness at all — see
// CLAUDE.md on Mobile CI and cross-workspace test imports.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lazyNativeModule } from './nativeModule.ts'

// The loader logs a warning on failure by design; keep the test output readable.
function silencingWarnings<T>(fn: () => T): T {
  const real = console.warn
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.warn = real
  }
}

test('returns the module when the require succeeds', () => {
  const mod = { getDocumentAsync: () => 'ok' }
  const get = lazyNativeModule('expo-fake', () => mod)
  assert.equal(get(), mod)
})

test('does not load at registration — only on first call', () => {
  let calls = 0
  const get = lazyNativeModule('expo-fake', () => {
    calls++
    return {}
  })
  // THE point of the module: registering it must not touch the native module,
  // because registration happens at module scope, i.e. in the boot path.
  assert.equal(calls, 0, 'lazyNativeModule must not invoke the loader at module scope')
  get()
  assert.equal(calls, 1)
})

test('a throwing require yields null instead of propagating — the white-screen guard', () => {
  const get = lazyNativeModule('expo-missing', () => {
    // Exactly what requireNativeModule does on a host without the module.
    throw new Error("Cannot find native module 'ExpoMissing'")
  })
  const got = silencingWarnings(() => get())
  assert.equal(got, null)
})

test('failure is cached — the loader is not retried on every call', () => {
  let calls = 0
  const get = lazyNativeModule('expo-missing', () => {
    calls++
    throw new Error("Cannot find native module 'ExpoMissing'")
  })
  silencingWarnings(() => {
    assert.equal(get(), null)
    assert.equal(get(), null)
    assert.equal(get(), null)
  })
  assert.equal(calls, 1, 'a missing module must be logged and retried at most once')
})

test('success is cached — the module is required exactly once', () => {
  let calls = 0
  const mod = { ok: true }
  const get = lazyNativeModule('expo-fake', () => {
    calls++
    return mod
  })
  assert.equal(get(), mod)
  assert.equal(get(), mod)
  assert.equal(calls, 1)
})

test('a module that legitimately loads as a falsy value is not treated as a failure', () => {
  let calls = 0
  const get = lazyNativeModule('expo-falsy', () => {
    calls++
    return 0 as unknown as object
  })
  assert.equal(get(), 0 as unknown as object)
  get()
  // `undefined` means "not tried"; a real falsy result must still be cached, or the
  // loader would re-require on every call forever.
  assert.equal(calls, 1)
})
