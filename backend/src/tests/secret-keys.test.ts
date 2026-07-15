// Epic H / H6 — FAIL-CLOSED secret-key guard (AUDIT-H1 LOW-3 #1/#2/#4).
//
// Pure unit tests: no DB, no process.env — every case passes an explicit env record,
// so the guard's behaviour is pinned independent of the ambient environment.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSecretKeys, assertSecretKeysSafe, isInsecureKey, KNOWN_INSECURE_KEYS } from '../services/secret-keys'

// A fully-provisioned packaged env: three distinct, non-default keys.
const GOOD = {
  MC_DEPLOYMENT_PROFILE: 'packaged',
  SECRETS_ENC_KEY: 'a'.repeat(64),
  RUN_TOKEN_SECRET: 'b'.repeat(64),
  MC_LOOPBACK_SESSION_SECRET: 'c'.repeat(64),
}

test('[H6] hosted profile is a NO-OP — the guard never fires (byte-identical boot)', () => {
  // Default profile (unset), and explicit hosted, both pass even on the dev defaults.
  assert.equal(checkSecretKeys({}).ok, true)
  assert.equal(checkSecretKeys({ SECRETS_ENC_KEY: 'dev-7ei-mc-secrets-key' }).ok, true)
  assert.equal(checkSecretKeys({ MC_DEPLOYMENT_PROFILE: 'hosted', SECRETS_ENC_KEY: '' }).ok, true)
  // A garbage profile resolves to hosted (the safe default) → no-op.
  assert.equal(checkSecretKeys({ MC_DEPLOYMENT_PROFILE: 'nonsense', SECRETS_ENC_KEY: '' }).ok, true)
  assert.doesNotThrow(() => assertSecretKeysSafe({ MC_DEPLOYMENT_PROFILE: 'hosted' }))
})

test('[H6] packaged with real per-install keys passes', () => {
  const r = checkSecretKeys(GOOD)
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
  assert.equal(r.profile, 'packaged')
  assert.doesNotThrow(() => assertSecretKeysSafe(GOOD))
})

test('[H6] packaged FAILS CLOSED on a missing SECRETS_ENC_KEY', () => {
  const r = checkSecretKeys({ ...GOOD, SECRETS_ENC_KEY: undefined })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /SECRETS_ENC_KEY is missing or a known/)
  assert.throws(() => assertSecretKeysSafe({ ...GOOD, SECRETS_ENC_KEY: undefined }), /fail-closed/)
})

test('[H6] packaged FAILS CLOSED on the known dev/throwaway defaults', () => {
  for (const bad of ['dev-7ei-mc-secrets-key', 'h0-spike-local-only-not-secure', '']) {
    assert.equal(checkSecretKeys({ ...GOOD, SECRETS_ENC_KEY: bad }).ok, false, `SECRETS_ENC_KEY=${bad} must fail`)
  }
})

test('[H6] packaged FAILS CLOSED when RUN_TOKEN_SECRET is missing/default (req #4)', () => {
  assert.equal(checkSecretKeys({ ...GOOD, RUN_TOKEN_SECRET: undefined }).ok, false)
  assert.equal(checkSecretKeys({ ...GOOD, RUN_TOKEN_SECRET: 'dev-7ei-mc-run' }).ok, false)
})

test('[H6] packaged FAILS CLOSED when RUN_TOKEN_SECRET reuses SECRETS_ENC_KEY (req #1 — its own value)', () => {
  const same = 'a'.repeat(64)
  const r = checkSecretKeys({ ...GOOD, SECRETS_ENC_KEY: same, RUN_TOKEN_SECRET: same })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /RUN_TOKEN_SECRET must be distinct/)
})

test('[H6] packaged FAILS CLOSED without a loopback session secret (H6 identity)', () => {
  assert.equal(checkSecretKeys({ ...GOOD, MC_LOOPBACK_SESSION_SECRET: undefined }).ok, false)
  assert.equal(checkSecretKeys({ ...GOOD, MC_LOOPBACK_SESSION_SECRET: 'h0-spike-local-only-not-secure' }).ok, false)
})

test('[H6] isInsecureKey covers the known defaults + absent values', () => {
  assert.equal(isInsecureKey(undefined), true)
  assert.equal(isInsecureKey(null), true)
  assert.equal(isInsecureKey(''), true)
  for (const k of KNOWN_INSECURE_KEYS) assert.equal(isInsecureKey(k), true)
  assert.equal(isInsecureKey('a'.repeat(64)), false)
})
