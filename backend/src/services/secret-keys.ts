// Epic H / H6 — FAIL-CLOSED secret-key guard for the packaged profile.
//
// The AUDIT-H1 report (LOW-3) made four requirements mandatory before the
// packaged `.dmg` may be distributed for real use. This module is requirements
// #1, #2 and #4 in one pure, testable place:
//
//   #1  A real, per-install, randomly-generated `SECRETS_ENC_KEY` — and its own
//       distinct `RUN_TOKEN_SECRET` — never the committed dev/throwaway default.
//   #2  FAIL-CLOSED-ON-DEFAULT-KEY: the backend must REFUSE TO BOOT if, in a
//       packaged/production context, it is running on a missing or known-default
//       key. No real secret may ever be encrypted under a world-readable default.
//   #4  Cover `RUN_TOKEN_SECRET` the same way (it also falls back to
//       `SECRETS_ENC_KEY` in `agent-api.ts` — in packaged we require its own value
//       so that fallback can never silently reuse the encryption key as the run key).
//
// It is PURE (reads a plain env-like record, returns/throws — no `process`, no DB,
// no network), so the boot guard and its regression tests share one implementation.
// The Electron shell (`apps/desktop/src/main.cjs`) generates the real per-install
// keys into the macOS Keychain and injects them; this guard is the backstop that
// turns a mis-provisioned boot into a hard refusal rather than a silent-default run.

import { resolveDeploymentProfile, type EnvLike } from './deployment-profile'

/**
 * Every value that must NEVER key a real secret store. These are the literal
 * defaults that live in the codebase (so a packaged boot that reaches any of them
 * is running unprovisioned) plus the empty string. Keep in sync with the fallbacks
 * in `secrets.ts` (`dev-7ei-mc-secrets-key`), `agent-api.ts` (`dev-7ei-mc-run`),
 * and the H0/H1 shell placeholder (`h0-spike-local-only-not-secure`).
 */
export const KNOWN_INSECURE_KEYS: ReadonlySet<string> = new Set([
  '',
  'dev-7ei-mc-secrets-key',        // secrets.ts default
  'dev-7ei-mc-run',                // agent-api.ts run-token default
  'h0-spike-local-only-not-secure', // apps/desktop/src/main.cjs H0/H1 throwaway
])

/** Is `value` absent or one of the known dev/throwaway defaults? */
export function isInsecureKey(value: string | undefined | null): boolean {
  return value == null || KNOWN_INSECURE_KEYS.has(String(value))
}

export interface SecretKeyCheck {
  ok: boolean
  /** Each unmet requirement, in report order (empty when ok). */
  problems: string[]
  /** The profile the check ran against (packaged is the only gated one). */
  profile: string
}

/**
 * Evaluate the packaged secret-key posture WITHOUT throwing — the testable core.
 *
 *  - `hosted` (the default, incl. every unset/garbage profile): NOT gated here.
 *    Hosted supplies real Fly secrets (`SECRETS_ENC_KEY` / `RUN_TOKEN_SECRET`) and
 *    this guard must stay a no-op so the hosted boot is byte-identical. `ok:true`.
 *  - `packaged`: enforce #1/#2/#4 — both keys present, neither a known default, and
 *    `RUN_TOKEN_SECRET` DISTINCT from `SECRETS_ENC_KEY` (its own per-install value,
 *    not the encryption key reused via the agent-api fallback). Also require the
 *    loopback session secret (H6 auth) so a packaged boot that can authenticate
 *    NO local operator refuses rather than 401-ing every route with a silent-default
 *    encryption key underneath.
 */
export function checkSecretKeys(env: EnvLike = {}): SecretKeyCheck {
  const profile = resolveDeploymentProfile(env)
  if (profile !== 'packaged') return { ok: true, problems: [], profile }

  const problems: string[] = []
  const enc = env.SECRETS_ENC_KEY
  const run = env.RUN_TOKEN_SECRET
  const loop = env.MC_LOOPBACK_SESSION_SECRET

  if (isInsecureKey(enc)) {
    problems.push('SECRETS_ENC_KEY is missing or a known dev/throwaway default — a packaged install must generate a real per-install key into the OS Keychain (never the committed default).')
  }
  if (isInsecureKey(run)) {
    problems.push('RUN_TOKEN_SECRET is missing or a known dev/throwaway default — a packaged install must generate its own real per-install value.')
  }
  // Distinctness (#1/#4): RUN_TOKEN_SECRET must be its OWN value, not SECRETS_ENC_KEY
  // reused. Only flag when both are otherwise-valid (avoid piling onto the above).
  if (!isInsecureKey(enc) && !isInsecureKey(run) && enc === run) {
    problems.push('RUN_TOKEN_SECRET must be distinct from SECRETS_ENC_KEY — generate it as its own per-install key, do not reuse the encryption key.')
  }
  if (isInsecureKey(loop)) {
    problems.push('MC_LOOPBACK_SESSION_SECRET is missing or a known dev/throwaway default — the packaged loopback identity (H6) cannot authenticate the local operator without a real per-install session secret.')
  }

  return { ok: problems.length === 0, problems, profile }
}

/**
 * The BOOT GUARD. Call once at the very top of `start()` (before any route that
 * could encrypt a secret is reachable). In `packaged` it THROWS on a missing/default
 * key set — `start().catch(() => process.exit(1))` turns that into a hard refusal
 * (fail-closed). In `hosted` it returns immediately (no-op — byte-identical boot).
 */
export function assertSecretKeysSafe(env: EnvLike = {}): void {
  const result = checkSecretKeys(env)
  if (result.ok) return
  const lines = result.problems.map((p) => `  • ${p}`).join('\n')
  throw new Error(
    `[H6 fail-closed] refusing to boot the packaged profile on an unprovisioned secret-key set:\n${lines}\n` +
      'Provision real per-install keys (the Electron shell writes them to the macOS Keychain) before starting the backend.',
  )
}
