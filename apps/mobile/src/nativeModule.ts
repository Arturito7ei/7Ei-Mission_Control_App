// Lazy, fail-soft loading for native modules — the boot path's safety rail.
//
// THE PROBLEM THIS SOLVES. An Expo native package resolves its native counterpart
// in its own MODULE BODY:
//
//     export default requireNativeModule('ExpoDocumentPicker')   // throws AT IMPORT
//
// so `import * as DocumentPicker from 'expo-document-picker'` throws at IMPORT if
// the host doesn't carry that native module — not on first use, where a try/catch
// would be waiting. And because navigation.tsx imports every screen and App.tsx
// imports navigation.tsx, ANY such import anywhere under a screen sits in the BOOT
// path. One absent module there takes down the entire app before React mounts.
//
// That failure is uniquely nasty: it happens during module evaluation, so the
// top-level ErrorBoundary cannot catch it (there is no render to catch), and the
// operator sees a plain WHITE screen with the real error only in the Metro
// terminal. That is exactly the class of bug this module exists to make impossible.
//
// THE RULE: no native package may be imported for its VALUE at module scope in the
// boot path. Import it for its TYPES (`import type`, erased at compile time), and
// pull the value through here at the point of use.
//
// Failure is cached, so a missing module logs once rather than on every tap, and
// callers get a null they must handle — which turns "the app is white" into "the
// attach button says it can't open".

/**
 * Wrap a `require` of a native package so it can never throw at module scope.
 *
 * @param name  the package name, for the log line only.
 * @param load  `() => require('the-package')` — called at most once.
 * @returns a getter: the module, or null if it isn't available on this host.
 *
 * Usage:
 *   import type * as FooNS from 'expo-foo'
 *   const getFoo = lazyNativeModule('expo-foo', () => require('expo-foo') as typeof FooNS)
 *   ...
 *   const Foo = getFoo()
 *   if (!Foo) return  // degrade; never crash
 */
export function lazyNativeModule<T>(name: string, load: () => T): () => T | null {
  // `undefined` = not tried yet; `null` = tried and unavailable. Distinct on purpose:
  // a module that legitimately loads as null would otherwise be retried forever.
  let cached: T | null | undefined

  return () => {
    if (cached !== undefined) return cached
    try {
      cached = load()
    } catch (e) {
      cached = null
      // The one line that names the missing module. If a white screen ever returns,
      // this is what to grep for in the Metro terminal.
      console.warn(
        `[7Ei] native module "${name}" is unavailable on this host — the features that need it are disabled. ` +
          `This is usually a client (e.g. Expo Go) that doesn't bundle it. Cause: ${
            (e as Error)?.message ?? String(e)
          }`,
      )
    }
    return cached
  }
}
