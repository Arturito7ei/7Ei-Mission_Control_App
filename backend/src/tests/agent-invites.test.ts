import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createInvite, generateInviteToken, isInviteTokenShaped, hashToken, hashesEqual,
  inviteStatus, isInviteUsable, checkInviteAccepts, consumeUsePatch, inviteView, inviteUrls,
  parseAllowedAdapterTypes,
  INVITE_TOKEN_PREFIX, DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, DEFAULT_MAX_USES, MAX_MAX_USES,
  type InviteRecord,
} from '../services/agent-invites'

const NOW = new Date('2026-07-14T12:00:00.000Z')
const later = (h: number) => new Date(NOW.getTime() + h * 3600_000)

function mint(over: Partial<Parameters<typeof createInvite>[0]> = {}) {
  const r = createInvite({ id: 'inv-1', orgId: 'org-1', createdBy: 'user_owner', now: NOW, ...over })
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  return (r as Extract<typeof r, { ok: true }>).invite
}

describe('[ONB1] invite token — hash-only, high entropy', () => {
  it('mints a prefixed 128-bit token', () => {
    const t = generateInviteToken()
    assert.ok(t.startsWith(INVITE_TOKEN_PREFIX))
    assert.equal(t.length, INVITE_TOKEN_PREFIX.length + 32)
    assert.ok(isInviteTokenShaped(t))
  })

  it('is unpredictable across mints', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateInviteToken()))
    assert.equal(set.size, 200)
  })

  it('rejects a malformed token before it costs a DB round-trip', () => {
    for (const bad of ['', 'mci_inv_', 'mci_inv_zzz', 'mca_' + 'a'.repeat(32), INVITE_TOKEN_PREFIX + 'a'.repeat(31), INVITE_TOKEN_PREFIX + 'A'.repeat(32)]) {
      assert.equal(isInviteTokenShaped(bad), false, `expected ${JSON.stringify(bad)} to be rejected`)
    }
  })

  it('stores ONLY the hash — the record never carries the raw token', () => {
    const { token, record } = mint()
    assert.equal(record.tokenHash, hashToken(token))
    assert.ok(!JSON.stringify(record).includes(token), 'the raw token must not survive anywhere in the record')
    assert.ok(hashesEqual(hashToken(token), record.tokenHash))
    assert.equal(hashesEqual(hashToken(generateInviteToken()), record.tokenHash), false)
  })
})

describe('[ONB1] createInvite — the operator-approved defaults', () => {
  it('is SINGLE-USE by default', () => {
    assert.equal(mint().record.maxUses, DEFAULT_MAX_USES)
    assert.equal(DEFAULT_MAX_USES, 1)
  })

  it('expires in 72h by default and never beyond the cap', () => {
    assert.equal(mint().record.expiresAt.getTime(), later(DEFAULT_INVITE_TTL_HOURS).getTime())
    const bad = createInvite({ id: 'i', orgId: 'o', createdBy: 'u', now: NOW, expiresInHours: MAX_INVITE_TTL_HOURS + 1 })
    assert.equal(bad.ok, false)
  })

  it('refuses out-of-range inputs rather than silently clamping them', () => {
    for (const input of [
      { expiresInHours: 0 }, { expiresInHours: -3 }, { maxUses: 0 }, { maxUses: 1.5 },
      { maxUses: MAX_MAX_USES + 1 }, { message: 'x'.repeat(2001) }, { allowedAdapterTypes: [] },
    ]) {
      const r = createInvite({ id: 'i', orgId: 'o', createdBy: 'u', now: NOW, ...(input as any) })
      assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be refused`)
    }
  })

  it('multi-use is an explicit, bounded opt-in', () => {
    assert.equal(mint({ maxUses: 5 }).record.maxUses, 5)
  })

  it('accepts an adapter allow-list only of invitable types (declared-but-unavailable is allowed)', () => {
    assert.deepEqual(mint({ allowedAdapterTypes: ['claude_code', 'cursor'] }).record.allowedAdapterTypes, ['claude_code', 'cursor'])
    // A declared-but-unavailable adapter may be named on an invite; the refusal
    // happens at JOIN time, with a reason — an honest map beats a silent gap.
    assert.ok(createInvite({ id: 'i', orgId: 'o', createdBy: 'u', now: NOW, allowedAdapterTypes: ['hermes_gateway'] }).ok)
    // `internal` is not an external runtime and can never be invited.
    assert.equal(createInvite({ id: 'i', orgId: 'o', createdBy: 'u', now: NOW, allowedAdapterTypes: ['internal'] }).ok, false)
    assert.equal(createInvite({ id: 'i', orgId: 'o', createdBy: 'u', now: NOW, allowedAdapterTypes: ['nope'] }).ok, false)
  })

  it('de-duplicates the allow-list', () => {
    assert.deepEqual(mint({ allowedAdapterTypes: ['cursor', 'cursor'] }).record.allowedAdapterTypes, ['cursor'])
  })
})

describe('[ONB1] invite state machine', () => {
  const base = (): InviteRecord => mint().record

  it('active while unrevoked, unexpired and unexhausted', () => {
    const r = base()
    assert.equal(inviteStatus(r, NOW), 'active')
    assert.equal(isInviteUsable(r, NOW), true)
  })

  it('expires exactly at the TTL boundary (<= is closed, not open)', () => {
    const r = base()
    assert.equal(inviteStatus(r, later(DEFAULT_INVITE_TTL_HOURS - 0.001)), 'active')
    assert.equal(inviteStatus(r, later(DEFAULT_INVITE_TTL_HOURS)), 'expired')
    assert.equal(isInviteUsable(r, later(DEFAULT_INVITE_TTL_HOURS)), false)
  })

  it('is "accepted" once its uses are spent — and a single-use invite is spent after one', () => {
    const r = base()
    Object.assign(r, consumeUsePatch(r, NOW))
    assert.equal(r.usedCount, 1)
    assert.equal(inviteStatus(r, NOW), 'accepted')
    assert.equal(isInviteUsable(r, NOW), false)
  })

  it('a multi-use invite stays active until the last use', () => {
    const r = mint({ maxUses: 3 }).record
    Object.assign(r, consumeUsePatch(r, NOW))
    assert.equal(inviteStatus(r, NOW), 'active')
    Object.assign(r, consumeUsePatch(r, NOW))
    Object.assign(r, consumeUsePatch(r, NOW))
    assert.equal(inviteStatus(r, NOW), 'accepted')
  })

  it('revocation outranks everything — an operator shutting the door always reads "revoked"', () => {
    const r = base()
    r.revokedAt = NOW
    r.usedCount = r.maxUses
    assert.equal(inviteStatus(r, later(1000)), 'revoked')
    assert.equal(isInviteUsable(r, NOW), false)
  })
})

describe('[ONB1] checkInviteAccepts — who may walk through', () => {
  it('lets an available, allow-listed adapter through', () => {
    const r = mint({ allowedAdapterTypes: ['claude_code'] }).record
    assert.deepEqual(checkInviteAccepts(r, 'claude_code', NOW), { ok: true })
  })

  it('an unrestricted invite accepts any AVAILABLE invitable adapter', () => {
    const r = mint().record
    assert.equal(checkInviteAccepts(r, 'cursor', NOW).ok, true)
    assert.equal(checkInviteAccepts(r, 'openclaw_local', NOW).ok, true)
    assert.equal(checkInviteAccepts(r, 'hermes_gateway', NOW).ok, false)   // declared, not available
    assert.equal(checkInviteAccepts(r, 'internal', NOW).ok, false)         // never invitable
  })

  it('refuses an adapter that is not on the invite allow-list', () => {
    const r = mint({ allowedAdapterTypes: ['cursor'] }).record
    const res = checkInviteAccepts(r, 'claude_code', NOW)
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.publicReason, 'adapter_not_allowed')
  })

  it('an expired / revoked / exhausted invite is INDISTINGUISHABLE from the outside (flat not_found)', () => {
    const expired = mint().record
    const revoked = mint().record; revoked.revokedAt = NOW
    const spent = mint().record; spent.usedCount = 1
    for (const [rec, at] of [[expired, later(1000)], [revoked, NOW], [spent, NOW]] as const) {
      const res = checkInviteAccepts(rec, 'claude_code', at)
      assert.equal(res.ok, false)
      assert.equal(res.ok === false && res.publicReason, 'not_found', 'must not leak WHY — that is an enumeration oracle')
    }
  })
})

describe('[ONB1-audit] parseAllowedAdapterTypes — a corrupt allow-list must not WIDEN the invite', () => {
  it('null/absent means "any joinable adapter" (the operator never restricted it)', () => {
    assert.equal(parseAllowedAdapterTypes(null), null)
    assert.equal(parseAllowedAdapterTypes(undefined), null)
    assert.equal(parseAllowedAdapterTypes(''), null)
  })

  it('round-trips a stored allow-list, de-duplicated', () => {
    assert.deepEqual(parseAllowedAdapterTypes(JSON.stringify(['cursor', 'claude_code', 'cursor'])), ['cursor', 'claude_code'])
  })

  it('a corrupt / non-array / empty column FAILS CLOSED to an empty allow-list, never to null', () => {
    for (const raw of ['{ not json', '{"cursor":true}', '"cursor"', '[]', '[""]', 'null', '42']) {
      const parsed = parseAllowedAdapterTypes(raw)
      assert.deepEqual(parsed, [], `${raw} must yield a deny-all allow-list, not "any adapter"`)
      // And a deny-all allow-list must actually deny — no adapter walks through.
      const r = mint().record
      r.allowedAdapterTypes = parsed
      assert.equal(checkInviteAccepts(r, 'claude_code', NOW).ok, false)
      assert.equal(checkInviteAccepts(r, 'cursor', NOW).ok, false)
    }
  })
})

describe('[ONB1] operator-facing views', () => {
  it('the invite view never carries the token or its hash', () => {
    const { token, record } = mint()
    const view = inviteView(record, NOW)
    const json = JSON.stringify(view)
    assert.ok(!json.includes(token))
    assert.ok(!json.includes(record.tokenHash))
    assert.equal(view.status, 'active')
    assert.equal(view.usesRemaining, 1)
  })

  it('usesRemaining never goes negative', () => {
    const r = mint().record
    r.usedCount = 9
    assert.equal(inviteView(r, NOW).usesRemaining, 0)
  })

  it('bakes the invite token into every onboarding URL, with no double slash', () => {
    const u = inviteUrls('https://7ei-backend.fly.dev/', 'mci_inv_abc')
    assert.equal(u.inviteUrl, 'https://7ei-backend.fly.dev/api/agent-invites/mci_inv_abc')
    assert.equal(u.onboardingTextUrl, 'https://7ei-backend.fly.dev/api/agent-invites/mci_inv_abc/onboarding.txt')
    assert.ok(u.onboardingUrl.endsWith('/mci_inv_abc/onboarding'))
    assert.ok(!u.inviteUrl.includes('//api'))
  })
})
