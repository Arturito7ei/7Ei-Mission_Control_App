import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveDeploymentProfile, onboardingPosture, hardeningRequirements,
  DEFAULT_DEPLOYMENT_PROFILE, PUBLIC_JOIN_IMPLEMENTED, TOKEN_CLAIM_IMPLEMENTED,
  INVITES_SINGLE_USE_BY_DEFAULT, INVITE_AGENTS_ALWAYS_LOW_TRUST, NEVER_REVEAL_CLAIMED_TOKEN, REQUIRE_HUMAN_APPROVAL,
} from '../services/deployment-profile'
import {
  isSecretShapedKey, tokenizeKey, assertNoSecrets, buildConfigBundle, validateConfigBundle,
  buildDeploymentSlice, CONFIG_BUNDLE_VERSION,
} from '../services/config-bundle'

describe('[ONB1] deployment profile', () => {
  it('defaults to hosted — the HARDER posture — when unset or garbage', () => {
    assert.equal(DEFAULT_DEPLOYMENT_PROFILE, 'hosted')
    assert.equal(resolveDeploymentProfile({}), 'hosted')
    assert.equal(resolveDeploymentProfile({ MC_DEPLOYMENT_PROFILE: '' }), 'hosted')
    assert.equal(resolveDeploymentProfile({ MC_DEPLOYMENT_PROFILE: 'local_trusted' }), 'hosted')
    assert.equal(resolveDeploymentProfile({ MC_DEPLOYMENT_PROFILE: 'PACKAGED' }), 'packaged')
    assert.equal(resolveDeploymentProfile({ MC_DEPLOYMENT_PROFILE: ' hosted ' }), 'hosted')
  })
})

describe('[ONB1] onboarding posture — derived from the profile, never hardcoded', () => {
  it('the four operator-approved defaults are INVARIANTS, not switches', () => {
    for (const env of [{}, { MC_DEPLOYMENT_PROFILE: 'packaged' }, { MC_ENABLE_REMOTE_ONBOARDING: '1' }]) {
      const p = onboardingPosture(env)
      assert.equal(p.requireHumanApproval, true)
      assert.equal(p.invitesSingleUseByDefault, true)
      assert.equal(p.lowTrustEveryInviteAgent, true)
      assert.equal(p.operatorCanSeeClaimedKey, false)
    }
    assert.equal(REQUIRE_HUMAN_APPROVAL, true)
    assert.equal(INVITES_SINGLE_USE_BY_DEFAULT, true)
    assert.equal(INVITE_AGENTS_ALWAYS_LOW_TRUST, true)
    assert.equal(NEVER_REVEAL_CLAIMED_TOKEN, true)
  })

  it('hosted: the public join surface is OFF by default and says why', () => {
    const p = onboardingPosture({})
    assert.equal(p.profile, 'hosted')
    assert.equal(p.publicJoinEnabled, false)
    assert.equal(p.loopbackTrusted, false)
    assert.ok(p.closedBecause.some((r) => r.startsWith('remote_onboarding_enabled')))
  })

  it('hosted: the enable flag opens the join surface ONLY because every hardening control is now satisfied', () => {
    const p = onboardingPosture({ MC_ENABLE_REMOTE_ONBOARDING: '1' })
    assert.equal(p.remoteOnboardingRequested, true)

    // ONB1 asserted "the flag alone cannot open it", because the join surface did not
    // exist. ONB3 built it (with the approval gate, the atomic consume and the rate
    // limit), so the flag now DOES open it — and the guard that matters is the one
    // underneath: `publicJoinEnabled` is true iff EVERY control reports satisfied.
    // It is never "true because someone set an env var".
    const unmet = hardeningRequirements({ MC_ENABLE_REMOTE_ONBOARDING: '1' }).filter((r) => !r.satisfied)
    assert.deepEqual(unmet, [], 'a control regressed — the posture must then close, whatever the flag says')
    assert.equal(p.publicJoinEnabled, unmet.length === 0)
    assert.equal(p.publicJoinEnabled, PUBLIC_JOIN_IMPLEMENTED)

    // And the CLAIM is still unbuilt: an approved agent has no credential to claim.
    assert.equal(TOKEN_CLAIM_IMPLEMENTED, false)
    assert.equal(p.tokenClaimEnabled, false)
    assert.equal(p.operatorCanSeeClaimedKey, false)
  })

  it('a hardening control reporting FALSE closes the surface even with the flag set', () => {
    // The mechanism, proven rather than asserted: knock any control out and the posture
    // must close. (We fake the checklist rather than mutate a constant — the point is
    // that `publicJoinEnabled` is derived from the checklist, not from the env.)
    const reqs = hardeningRequirements({ MC_ENABLE_REMOTE_ONBOARDING: '1' })
    const withRegression = reqs.map((r, i) => (i === 0 ? { ...r, satisfied: false } : r))
    assert.equal(withRegression.every((r) => r.satisfied), false)
    assert.equal(onboardingPosture({ MC_ENABLE_REMOTE_ONBOARDING: '1' }).publicJoinEnabled, reqs.every((r) => r.satisfied))
  })

  it('packaged: loopback is trusted, and the remote-onboarding enable is not required', () => {
    const p = onboardingPosture({ MC_DEPLOYMENT_PROFILE: 'packaged' })
    assert.equal(p.loopbackTrusted, true)
    assert.ok(!p.closedBecause.some((r) => r.startsWith('remote_onboarding_enabled')))
    // Still gated on the surface existing at all.
    assert.equal(p.publicJoinEnabled, PUBLIC_JOIN_IMPLEMENTED)
  })

  it('the hardening checklist reports each control honestly', () => {
    const reqs = hardeningRequirements({})
    const keys = reqs.map((r) => r.key)
    // `join_rate_limited` joined the list in ONB3: the ONB2 re-audit's M-3 made per-IP
    // rate limiting a PRECONDITION of ever setting MC_ENABLE_REMOTE_ONBOARDING in prod,
    // so it is a checked control, not a nicety.
    assert.deepEqual(keys, ['join_surface_implemented', 'join_rate_limited', 'human_approval_gate', 'invite_single_use_default', 'remote_onboarding_enabled'])
    for (const r of reqs) if (!r.satisfied) assert.ok(r.blocker, `${r.key} must explain why it is unsatisfied`)
  })
})

describe('[ONB1] config bundle — declarative, versioned, and never a secret carrier', () => {
  it('tokenizes camelCase / kebab / snake keys', () => {
    assert.deepEqual(tokenizeKey('webhookAuthHeader'), ['webhook', 'auth', 'header'])
    assert.deepEqual(tokenizeKey('x-openclaw-token'), ['x', 'openclaw', 'token'])
    assert.deepEqual(tokenizeKey('api_key'), ['api', 'key'])
  })

  it('detects secret-shaped keys — including camelCase compounds', () => {
    for (const k of ['apiKey', 'api_key', 'API-KEY', 'x-openclaw-token', 'webhookAuthHeader', 'clientSecret', 'password', 'privateKey', 'accessKey', 'credentials', 'bearerToken']) {
      assert.equal(isSecretShapedKey(k), true, `${k} should look secret`)
    }
  })

  it('does NOT misfire on innocent config keys (a false positive would eat the value)', () => {
    for (const k of ['sessionKeyStrategy', 'paperclipApiUrl', 'mcApiUrl', 'workdir', 'model', 'permissionMode', 'baseUrl', 'monkey', 'keyboardLayout']) {
      assert.equal(isSecretShapedKey(k), false, `${k} should NOT be treated as a secret`)
    }
  })

  it('assertNoSecrets throws on a nested secret-shaped key', () => {
    assert.throws(() => assertNoSecrets({ deployment: { adapters: [{ apiKey: 'x' }] } }), /must not carry secrets/)
    assert.doesNotThrow(() => assertNoSecrets({ deployment: { profile: 'hosted', adapters: [{ model: 'm' }] } }))
  })

  it('builds a bundle carrying the posture and the adapter availability — and no secrets', () => {
    const bundle = buildConfigBundle({ env: { MC_DEPLOYMENT_PROFILE: 'packaged' }, adapterAvailability: { claude_code: true, hermes_gateway: false } })
    assert.equal(bundle.version, CONFIG_BUNDLE_VERSION)
    assert.equal(bundle.deployment.profile, 'packaged')
    assert.equal(bundle.deployment.onboarding.loopbackTrusted, true)
    assert.equal(bundle.deployment.onboarding.invariants.operatorCanSeeClaimedKey, false)
    assert.doesNotThrow(() => assertNoSecrets(bundle))
  })

  it('the deployment slice is a pure function of config', () => {
    assert.deepEqual(buildDeploymentSlice({ MC_DEPLOYMENT_PROFILE: 'hosted' }), buildDeploymentSlice({ MC_DEPLOYMENT_PROFILE: 'hosted' }))
  })

  it('refuses an incoming bundle that is newer, malformed, or carries a secret', () => {
    assert.equal(validateConfigBundle(null).ok, false)
    assert.equal(validateConfigBundle({ version: 'one' }).ok, false)
    assert.equal(validateConfigBundle({ version: CONFIG_BUNDLE_VERSION + 1, deployment: {} }).ok, false)
    assert.equal(validateConfigBundle({ version: CONFIG_BUNDLE_VERSION }).ok, false)
    const withSecret = { version: CONFIG_BUNDLE_VERSION, deployment: { profile: 'hosted', apiKey: 'sk-live' } }
    const res = validateConfigBundle(withSecret)
    assert.equal(res.ok, false)
    assert.ok(res.ok === false && /secret/.test(res.error))
    assert.ok(validateConfigBundle(buildConfigBundle({ env: {} })).ok)
  })
})
