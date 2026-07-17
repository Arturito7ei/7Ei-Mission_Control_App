// The tripwire for the bug that cost us a live outage.
//
// react-native ships a PREBUILT React renderer. It hardcodes the React version it
// was compiled against and checks it with a strict !== at first render:
//
//   var isomorphicReactPackageVersion = React.version;
//   if ("19.1.0" !== isomorphicReactPackageVersion)
//     throw Error('Incompatible React versions: The "react" and
//                  "react-native-renderer" packages must have the exact same version…')
//
// WHY THIS TEST EXISTS. react-native's *peer* range is the looser `^19.1.0`, so npm
// installs 19.1.8 happily, tsc type-checks it, and `expo export` bundles it — every
// gate green. The renderer's equality check only runs ON THE DEVICE, at first
// render, where it threw and took the whole tree down to a white screen. Every
// automated signal we had said the app was fine. This test is the signal we didn't
// have: it reads the constant out of the installed renderer and compares it to the
// installed react, so a drift fails in CI instead of on the operator's phone.
//
// If this fails after an SDK/RN bump, do NOT "fix" it by loosening the assert. Set
// `react` (and react-dom) in package.json to EXACTLY the version the renderer names,
// and keep the `overrides` block pinning the tree to it.
//
// Dependency-free on purpose (node:fs only) so it runs under Mobile CI, which
// installs apps/mobile alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

/** The React version a given prebuilt renderer bundle demands, or null. */
function rendererExpectedReact(file: string): string | null {
  const src = readFileSync(require_.resolve(file), 'utf8')
  // Matches the emitted check regardless of minification/formatting:
  //   "19.1.0" !== isomorphicReactPackageVersion
  const m = src.match(/"(\d+\.\d+\.\d+)"\s*!==\s*isomorphicReactPackageVersion/)
  return m ? m[1] : null
}

const RENDERERS = [
  // The one Expo Go runs.
  'react-native/Libraries/Renderer/implementations/ReactNativeRenderer-dev.js',
  // The one a release build runs — must agree, or we'd ship a white screen.
  'react-native/Libraries/Renderer/implementations/ReactNativeRenderer-prod.js',
]

test('react-native still performs an exact-version check (the premise of this test)', () => {
  const v = rendererExpectedReact(RENDERERS[0])
  assert.ok(
    v,
    'Could not find the renderer version check. react-native may have changed how it ' +
      'validates the React version — re-read the renderer source before trusting this suite.',
  )
})

test('the installed react EXACTLY matches what every react-native renderer demands', () => {
  const installed = require_('react/package.json').version as string

  for (const r of RENDERERS) {
    const expected = rendererExpectedReact(r)
    if (!expected) continue
    assert.equal(
      installed,
      expected,
      `react@${installed} !== the ${r.split('/').pop()} renderer's required ${expected}. ` +
        `This throws "Incompatible React versions" on device at first render — a WHITE SCREEN — ` +
        `while npm, tsc and expo export all stay green. Pin react AND react-dom to exactly ` +
        `${expected} in apps/mobile/package.json, and keep the "overrides" block.`,
    )
  }
})

test('react-dom matches react, so Clerk and react never straddle two versions', () => {
  const react = require_('react/package.json').version as string
  const reactDom = require_('react-dom/package.json').version as string
  assert.equal(reactDom, react, 'react-dom must track react exactly')
})

test('react matches the version Expo SDK 54 pins for this react-native', () => {
  // The SDK's own version map is the second, independent opinion — if it and the
  // renderer ever disagree, the pin is not a judgement call and this will say so.
  const bundled = require_('expo/bundledNativeModules.json') as Record<string, string>
  const installed = require_('react/package.json').version as string
  assert.equal(
    installed,
    bundled['react'],
    `Expo SDK pins react to ${bundled['react']} but ${installed} is installed.`,
  )
})
