// Epic H / H1 — electron-builder `afterSign` hook: notarize the signed .app.
//
// WIRED BUT INERT. This hook is registered in electron-builder.yml (`afterSign:
// scripts/notarize.cjs`) and runs on every macOS build, but it SELF-SKIPS unless
// BOTH (a) the build was actually signed and (b) notarization credentials are
// present in the environment. H1 ships UNSIGNED with no Apple account (H-Q1/H-Q2),
// so today this logs a skip and returns — it is a no-op.
//
// THE FLIP — once the operator has an Apple Developer ID + a notarytool credential,
// notarization turns on with NO code change here, purely by providing env:
//   • App-Store-Connect API key (preferred — revocable, CI-friendly):
//       APPLE_API_KEY=/path/to/AuthKey_XXXX.p8  APPLE_API_KEY_ID=XXXX  APPLE_API_ISSUER=<uuid>
//   • or Apple-ID app-specific password:
//       APPLE_ID=you@apple.id  APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx  APPLE_TEAM_ID=TEAMID
// …and by signing the app (provide the Developer ID cert via CSC_LINK/CSC_KEY_PASSWORD
// or the login Keychain, and DROP `CSC_IDENTITY_AUTO_DISCOVERY=false` from the build
// script so electron-builder discovers + signs with it). electron-builder staples
// the ticket after this hook returns. See GO-LIVE "Packaged app — when you have the
// Apple Developer ID".
//
// @electron/notarize ships transitively with electron-builder; it is required
// LAZILY below so an unsigned build never loads it.

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return

  // Was the app actually signed? An unsigned build has nothing to notarize.
  // `CSC_IDENTITY_AUTO_DISCOVERY=false` (set by the unsigned build scripts) or the
  // absence of any signing identity means we skip.
  const signingSkipped = process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false'

  // Two accepted credential shapes (API key preferred).
  const hasApiKey = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  const hasAppleId = !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)

  if (signingSkipped || (!hasApiKey && !hasAppleId)) {
    console.log('[notarize] skipped — unsigned build or no notarization credentials present (H1: expected until the Apple Developer ID is configured).')
    return
  }

  const appName = packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`
  const appBundleId = packager.appInfo.id

  const { notarize } = require('@electron/notarize')
  const creds = hasApiKey
    ? {
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      }
    : {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }

  console.log(`[notarize] submitting ${appName}.app (${appBundleId}) to Apple notary service…`)
  await notarize({ appBundleId, appPath, ...creds })
  console.log('[notarize] done ✓ (electron-builder will staple the ticket).')
}
