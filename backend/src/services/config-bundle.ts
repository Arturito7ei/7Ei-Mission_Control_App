// Epic ONB / ONB1 (+ Epic H) — the declarative, versioned CONFIG BUNDLE.
//
// Every system setting/parameter should be expressible as ONE declarative,
// versioned document that:
//   * Export/Import (the org portability we already ship, `services/portability.ts`)
//     can move between machines, and
//   * the future .dmg installer (Epic H — H4 "fresh-machine config/secret
//     bootstrap") seeds a clean machine from.
//
// **Secrets are never in the bundle.** They stay in the encrypted store
// (`services/secrets.ts`, AES-256-GCM) and are re-supplied per machine. The
// bundle carries *shape and posture*, never credentials — `assertNoSecrets()`
// below is the enforcement, and it is a hard throw, not a warning.
//
// ONB1 ships the bundle's SPINE: the version, the secret-shaped-key detector
// (which the adapter registry also uses to route `agentDefaultsPayload` fields
// into the encrypted store), and the deployment slice. Later slices (org
// profile, agents, budgets, routines — already covered by `portability.ts`) fold
// in under Epic H rather than being rebuilt here.

import { onboardingPosture, resolveDeploymentProfile, type EnvLike, type DeploymentProfile, type OnboardingPosture } from './deployment-profile'

/** Bump when a slice's shape changes incompatibly. Importers refuse a newer version. */
export const CONFIG_BUNDLE_VERSION = 1

// ─── Secret-shaped key detection ─────────────────────────────────────────────
//
// Used in two places, deliberately: (a) the bundle refuses to carry a secret,
// (b) the adapter registry routes a secret-shaped `agentDefaultsPayload` field
// into the encrypted store instead of a plaintext config column. One detector,
// so the two can never drift apart.

// Whole-word secret vocabulary. Matching is on TOKENS, not substrings, so
// `apiKey`, `api_key`, `x-openclaw-token` and `webhookAuthHeader` are all caught
// while `sessionKeyStrategy` and `paperclipApiUrl` are correctly left alone — a
// substring rule would either miss the camelCase ones or swallow the innocent.
const SECRET_TOKENS = new Set([
  'secret', 'secrets', 'token', 'password', 'passwd', 'pwd', 'passphrase',
  'credential', 'credentials', 'bearer', 'auth',
  'apikey', 'privatekey', 'secretkey', 'accesskey', 'authtoken', 'apitoken',
])

/** Split a key into lowercase words across camelCase, `-`, `_`, `.` and spaces. */
export function tokenizeKey(key: string): string[] {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
}

/** Does this key name look like it holds a secret? Single tokens plus adjacent
 *  pairs (`api`+`key` → `apikey`), so compound names are caught without the
 *  bare word `key` — which would misfire on `sessionKeyStrategy`. */
export function isSecretShapedKey(key: string): boolean {
  const tokens = tokenizeKey(key)
  if (tokens.length === 0) return false
  if (tokens.some((t) => SECRET_TOKENS.has(t))) return true
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (SECRET_TOKENS.has(tokens[i] + tokens[i + 1])) return true
  }
  return false
}

/** Keys that must never appear in a parsed object (prototype pollution). */
export const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const

export function isForbiddenKey(key: string): boolean {
  return (FORBIDDEN_KEYS as readonly string[]).includes(String(key))
}

/** Walk an object graph and throw on the first secret-shaped key. The bundle is
 *  a transport artifact — a throw here is strictly better than a shipped key. */
export function assertNoSecrets(value: unknown, path = 'bundle'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`))
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretShapedKey(k)) {
      throw new Error(`config bundle must not carry secrets: secret-shaped key at ${path}.${k}`)
    }
    assertNoSecrets(v, `${path}.${k}`)
  }
}

// ─── Slices ─────────────────────────────────────────────────────────────────

/** The deployment slice: what profile this machine runs in and the onboarding
 *  posture that derives from it. Pure config — safe to move between machines. */
export interface DeploymentSlice {
  profile: DeploymentProfile
  onboarding: {
    publicJoinEnabled: boolean
    loopbackTrusted: boolean
    remoteOnboardingRequested: boolean
    /** The four invariants, restated declaratively so an importing machine can
     *  verify it agrees with them rather than assume. */
    invariants: {
      requireHumanApproval: boolean
      invitesSingleUseByDefault: boolean
      lowTrustEveryInviteAgent: boolean
      operatorCanSeeClaimedKey: boolean
    }
  }
}

export function buildDeploymentSlice(env: EnvLike = {}): DeploymentSlice {
  const posture: OnboardingPosture = onboardingPosture(env)
  return {
    profile: resolveDeploymentProfile(env),
    onboarding: {
      publicJoinEnabled: posture.publicJoinEnabled,
      loopbackTrusted: posture.loopbackTrusted,
      remoteOnboardingRequested: posture.remoteOnboardingRequested,
      invariants: {
        requireHumanApproval: posture.requireHumanApproval,
        invitesSingleUseByDefault: posture.invitesSingleUseByDefault,
        lowTrustEveryInviteAgent: posture.lowTrustEveryInviteAgent,
        operatorCanSeeClaimedKey: posture.operatorCanSeeClaimedKey,
      },
    },
  }
}

export interface ConfigBundle {
  version: number
  deployment: DeploymentSlice
  /** Adapter availability overrides, by adapterType. The registry's *shape* is
   *  code (it ships with the app); only what a given machine turns on travels. */
  adapterAvailability: Record<string, boolean>
}

/** Build a bundle. Throws if any slice carries a secret-shaped key. */
export function buildConfigBundle(input: { env?: EnvLike; adapterAvailability?: Record<string, boolean> }): ConfigBundle {
  const bundle: ConfigBundle = {
    version: CONFIG_BUNDLE_VERSION,
    deployment: buildDeploymentSlice(input.env ?? {}),
    adapterAvailability: { ...(input.adapterAvailability ?? {}) },
  }
  assertNoSecrets(bundle)
  return bundle
}

/** Validate an incoming bundle before applying it. Never applies a newer version
 *  than this build understands, and never accepts a bundle carrying a secret. */
export function validateConfigBundle(raw: unknown): { ok: true; bundle: ConfigBundle } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'bundle must be an object' }
  const b = raw as Partial<ConfigBundle>
  if (typeof b.version !== 'number') return { ok: false, error: 'bundle.version is required' }
  if (b.version > CONFIG_BUNDLE_VERSION) return { ok: false, error: `bundle version ${b.version} is newer than this build understands (${CONFIG_BUNDLE_VERSION})` }
  if (!b.deployment || typeof b.deployment !== 'object') return { ok: false, error: 'bundle.deployment is required' }
  try {
    assertNoSecrets(raw)
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) }
  }
  return { ok: true, bundle: raw as ConfigBundle }
}
