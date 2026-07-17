// MOB-7a — the boot path's standing guard.
//
// #296/#297 chased a WHITE SCREEN twice. The cause both times was the same shape:
// an Expo native package resolves `requireNativeModule(…)` in its own MODULE BODY,
// so importing it for its VALUE throws AT IMPORT on a host that doesn't carry it.
// navigation.tsx imports every screen and App.tsx imports navigation.tsx, so ANY
// such import under a screen sits in the boot path — and because it throws during
// module evaluation, the top-level ErrorBoundary cannot catch it (there is no
// render to catch). The operator gets a blank white app and the real error only in
// the Metro terminal.
//
// `nativeModule.ts` states the rule: import native packages for their TYPES
// (`import type`, erased at compile time) and pull the VALUE through
// lazyNativeModule at the point of use. `nativeModule.test.ts` proves the loader
// honours it. This file proves the CODEBASE does — which is the half a unit test
// of the loader can't reach, because the bug is a line someone writes elsewhere.
//
// MOB-7a added three native packages (react-native-svg, expo-av, expo-speech), so
// the rule now has three more ways to be broken. Hence the scan.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// The scan roots at the PACKAGE, not at src/. App.tsx and index.ts live outside
// src/ and are the boot path's first two frames — index.ts registers App.tsx,
// which imports navigation.tsx. Rooting at src/ left the two files a native
// value-import is *most* likely to be added to unscanned, so the guard passed on
// a mutation planted in App.tsx. Anything not source (node_modules, dist, the
// Expo build output) is skipped by name.
const PKG = new URL('..', import.meta.url).pathname
const SKIP_DIRS = new Set(['node_modules', 'dist', '.expo', 'assets', 'android', 'ios'])

/**
 * Packages that resolve a native module at import. Importing any of these for
 * their value anywhere reachable from App.tsx is the white-screen bug.
 *
 * react-native itself is deliberately NOT here: it is the runtime, always present,
 * and every screen imports it for View/Text. The entries below are the OPTIONAL
 * native surface — the packages a given host (Expo Go, a dev build, a simulator)
 * may or may not carry.
 */
const NATIVE_PACKAGES = [
  'expo-av',
  'expo-document-picker',
  'expo-file-system',
  'expo-local-authentication',
  'expo-notifications',
  'expo-speech',
  'react-native-svg',
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return []
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return []
    return [full]
  })
}

const FILES = sourceFiles(PKG)

test('[MOB-7a] the scan actually sees the source tree', () => {
  // A guard that silently matches nothing is worse than no guard: it reads as a
  // pass forever. Anchor it on files we know exist.
  assert.ok(FILES.length > 10, `expected a populated src tree, found ${FILES.length} files`)
  assert.ok(FILES.some((f) => f.endsWith('CommandCenterScreen.tsx')))
  assert.ok(FILES.some((f) => f.endsWith('Reactor.tsx')))
  // The boot path's entry frames, which live OUTSIDE src/. These two assertions
  // are the ones that keep the scan rooted at the package: re-root it at src/ and
  // they fail rather than letting the blind spot return quietly.
  assert.ok(FILES.some((f) => f.endsWith('App.tsx')), 'App.tsx is not being scanned')
  assert.ok(FILES.some((f) => f.endsWith('index.ts')), 'index.ts is not being scanned')
})

test('[MOB-7a] no native package is imported for its VALUE anywhere in src', () => {
  // `import type … from 'expo-av'` is fine — erased at compile time, never reaches
  // the bundle. `import … from 'expo-av'` is the bug. Same for a bare
  // `import 'expo-av'`, which is a pure side-effect import: the worst case.
  const offenders: string[] = []
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8')
    for (const pkg of NATIVE_PACKAGES) {
      // Any `import … from '<pkg>'` (or `import '<pkg>'`) that is not `import type`.
      const re = new RegExp(`^\\s*import\\s+(?!type\\s)[^\\n]*?['"]${pkg}['"]`, 'm')
      const bare = new RegExp(`^\\s*import\\s+['"]${pkg}['"]`, 'm')
      if (re.test(src) || bare.test(src)) {
        offenders.push(`${file.replace(PKG, '')} imports "${pkg}" for its value`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `native packages must be reached through lazyNativeModule (see nativeModule.ts), not imported:\n  ${offenders.join('\n  ')}`,
  )
})

test('[MOB-7a] every native package in use is reached through lazyNativeModule', () => {
  // The other half: a file that `require`s a native package without the loader has
  // dodged the caching AND the fail-soft null, so a missing module throws at the
  // tap instead of degrading. Every raw require of a native package must sit
  // inside a lazyNativeModule(...) call.
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8')
    for (const pkg of NATIVE_PACKAGES) {
      const requires = [...src.matchAll(new RegExp(`require\\(\\s*['"]${pkg}['"]\\s*\\)`, 'g'))]
      if (!requires.length) continue
      const wrapped = [...src.matchAll(
        new RegExp(`lazyNativeModule\\(\\s*['"]${pkg}['"][\\s\\S]{0,160}?require\\(\\s*['"]${pkg}['"]\\s*\\)`, 'g'),
      )]
      assert.equal(
        requires.length,
        wrapped.length,
        `${file.replace(PKG, '')} requires "${pkg}" outside lazyNativeModule — a missing module would throw at the tap instead of degrading`,
      )
    }
  }
})

test('[MOB-7a] the packages MOB-7a added are actually guarded, not just absent', () => {
  // Pins the test to reality: these three ARE used, through the loader. If someone
  // deletes the reactor or the voice legs, this fails and asks the question rather
  // than leaving a guard quietly protecting nothing.
  const all = FILES.map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const pkg of ['react-native-svg', 'expo-av', 'expo-speech', 'expo-file-system']) {
    assert.match(
      all,
      new RegExp(`lazyNativeModule\\(\\s*['"]${pkg}['"]`),
      `"${pkg}" is no longer loaded through lazyNativeModule`,
    )
  }
})
