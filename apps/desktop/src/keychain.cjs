// Epic H / H6 — per-install secret generation into the macOS login Keychain.
//
// The AUDIT-H1 requirement (#1): SECRETS_ENC_KEY / RUN_TOKEN_SECRET (and the H6
// loopback session secret) must be RANDOM PER INSTALL and never baked into the
// `.dmg`. This helper is the generator + store. It is ZERO-DEP by design (no
// `keytar`/native module — matching the repo's zero-dep adapter ethos): it shells
// out to the macOS `security` CLI, so the keys live in the user's LOGIN KEYCHAIN.
//
// Why the login Keychain satisfies "OS-user-bound" (H-Q6): a generic-password item
// in the login keychain is readable only within the logged-in user's unlocked
// session — a second OS account on the same Mac cannot read it. So binding the
// loopback session secret here binds the local operator identity to the OS user,
// exactly as the design recommends.
//
// Fail-closed: if `security` is unavailable or errors, this THROWS. The caller
// (main.cjs) must NOT fall back to a default key — a throw here means the backend
// never receives a key, the H6 boot guard refuses, and the shell shows a boot error.
// No real secret is ever encrypted under a throwaway.

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')

// One keychain "service" namespaces all Mission Control items; the "account" is the
// individual key name. Keep the service stable across versions so keys persist across
// app updates (an update must not orphan the existing encrypted DB's key).
const SERVICE = 'ai.7ei.missioncontrol'

/** A fresh 32-byte random key as hex (the `openssl rand -hex 32` equivalent). */
function generateKey() {
  return crypto.randomBytes(32).toString('hex')
}

/** Read an existing key from the login keychain, or null if absent. */
function readKey(account) {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const v = String(out).trim()
    return v.length > 0 ? v : null
  } catch {
    // Non-zero exit = not found (errSecItemNotFound / 44). Treat as absent.
    return null
  }
}

/** Write (create/update) a key into the login keychain. Throws on failure. */
function writeKey(account, value) {
  // -U updates the item if it already exists instead of erroring on a duplicate.
  execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-w', value, '-U'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/**
 * Get the existing per-install key for `account`, or generate + persist a new one.
 * Idempotent across boots: the first boot generates + stores; every later boot reads
 * the same value back (so the encrypted DB stays decryptable). Throws if the keychain
 * is unreachable — the caller fails closed rather than substituting a default.
 */
function getOrCreateKey(account) {
  const existing = readKey(account)
  if (existing) return existing
  const fresh = generateKey()
  writeKey(account, fresh)
  // Read back to confirm it persisted (a silent write failure must not pass a key the
  // next boot can't reproduce — that would orphan the encrypted DB).
  const confirmed = readKey(account)
  if (confirmed !== fresh) {
    throw new Error(`keychain: failed to persist key '${account}' (readback mismatch)`)
  }
  return fresh
}

module.exports = { SERVICE, getOrCreateKey, readKey, writeKey, generateKey }
