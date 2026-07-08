import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mintSession, hashToken, hashesEqual, generateSessionToken,
  isExpired, isRevoked, isSessionValid, isFresh, needsStepUp, stepUpPatch,
  beginBinding, confirmBinding, generateBindCode, isBoundChat, isBoundOperator,
  isFreshNonce, panicPlan, buildArturitaAgent,
  DEFAULT_SESSION_TTL_MS, DEFAULT_STEPUP_FRESHNESS_MS, DEFAULT_BIND_CODE_TTL_MS,
} from '../services/arturita-session'

const T0 = new Date('2026-07-08T12:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

// ─── Token hashing ───────────────────────────────────────────────────────────

test('[A1] session token is opaque, prefixed, and only its hash is stored', () => {
  const tok = generateSessionToken()
  assert.match(tok, /^art_[0-9a-f]{48}$/)
  const h = hashToken(tok)
  assert.match(h, /^[0-9a-f]{64}$/)
  assert.notEqual(h, tok)
  // deterministic
  assert.equal(hashToken(tok), h)
})

test('[A1] hashesEqual is constant-time-safe and length-guarded', () => {
  assert.equal(hashesEqual('abc', 'abc'), true)
  assert.equal(hashesEqual('abc', 'abd'), false)
  assert.equal(hashesEqual('abc', 'abcd'), false) // different lengths never throw
})

// ─── Session lifecycle ───────────────────────────────────────────────────────

test('[A1] a freshly minted session is valid and fresh', () => {
  const { token, record } = mintSession({ source: 'desk', now: T0, token: 'art_test' })
  assert.equal(token, 'art_test')
  assert.equal(record.tokenHash, hashToken('art_test'))
  assert.equal(record.source, 'desk')
  assert.equal(record.revokedAt, null)
  assert.equal(record.expiresAt.getTime(), T0.getTime() + DEFAULT_SESSION_TTL_MS)
  assert.equal(isSessionValid(record, T0), true)
  assert.equal(isFresh(record, T0), true)
  assert.equal(needsStepUp(record, T0), false)
})

test('[A1] session expires on TTL — fail closed after expiry', () => {
  const { record } = mintSession({ source: 'telegram', now: T0 })
  assert.equal(isExpired(record, at(DEFAULT_SESSION_TTL_MS - 1)), false)
  assert.equal(isExpired(record, at(DEFAULT_SESSION_TTL_MS)), true)
  assert.equal(isSessionValid(record, at(DEFAULT_SESSION_TTL_MS)), false)
})

test('[A1] revoked session is never valid, even before expiry', () => {
  const { record } = mintSession({ source: 'desk', now: T0 })
  const revoked = { ...record, revokedAt: at(1000) }
  assert.equal(isRevoked(revoked), true)
  assert.equal(isSessionValid(revoked, at(2000)), false)
  assert.equal(isFresh(revoked, at(2000)), false)
})

test('[A1] unknown token (null record) is never valid or fresh — fail closed', () => {
  assert.equal(isSessionValid(null, T0), false)
  assert.equal(isSessionValid(undefined, T0), false)
  assert.equal(isFresh(null, T0), false)
  assert.equal(needsStepUp(null, T0), true)
})

// ─── Step-up freshness ───────────────────────────────────────────────────────

test('[A1] a valid-but-stale session needs step-up for dangerous actions', () => {
  const { record } = mintSession({ source: 'desk', now: T0 })
  // Just inside the freshness window: still fresh.
  assert.equal(isFresh(record, at(DEFAULT_STEPUP_FRESHNESS_MS - 1)), true)
  // Past the freshness window (but before TTL): valid, but needs step-up.
  const stale = at(DEFAULT_STEPUP_FRESHNESS_MS + 1)
  assert.equal(isSessionValid(record, stale), true)
  assert.equal(isFresh(record, stale), false)
  assert.equal(needsStepUp(record, stale), true)
})

test('[A1] stepUpPatch refreshes freshness from the step-up moment', () => {
  const { record } = mintSession({ source: 'desk', now: T0 })
  const stale = at(DEFAULT_STEPUP_FRESHNESS_MS + 1000)
  assert.equal(isFresh(record, stale), false)
  const patched = { ...record, ...stepUpPatch(stale) }
  assert.equal(isFresh(patched, stale), true)
  assert.equal(patched.lastStepupAt.getTime(), stale.getTime())
})

test('[A1] freshness anchors on createdAt when never stepped up', () => {
  const { record } = mintSession({ source: 'desk', now: T0 })
  const noStepup = { ...record, lastStepupAt: null }
  assert.equal(isFresh(noStepup, at(DEFAULT_STEPUP_FRESHNESS_MS - 1)), true)
  assert.equal(isFresh(noStepup, at(DEFAULT_STEPUP_FRESHNESS_MS + 1)), false)
})

// ─── Binding (single operator) ───────────────────────────────────────────────

test('[A1] bind code is uppercased and hashed with a TTL', () => {
  const code = generateBindCode('a1b2c3d4')
  assert.equal(code, 'A1B2C3D4')
  const rec = beginBinding({ operatorUserId: 'user_1', code, now: T0 })
  assert.equal(rec.operatorUserId, 'user_1')
  assert.equal(rec.telegramChatId, null)
  assert.equal(rec.boundAt, null)
  assert.equal(rec.bindCodeHash, hashToken(code))
  assert.equal(rec.bindCodeExpiresAt!.getTime(), T0.getTime() + DEFAULT_BIND_CODE_TTL_MS)
})

test('[A1] confirmBinding: happy path binds the chat and clears the code (single-use)', () => {
  const code = 'ABCD1234'
  const rec = beginBinding({ operatorUserId: 'user_1', code, now: T0 })
  const res = confirmBinding(rec, { code, telegramChatId: '55501', now: at(1000) })
  assert.equal(res.ok, true)
  assert.equal(res.patch!.telegramChatId, '55501')
  assert.equal(res.patch!.boundAt.getTime(), at(1000).getTime())
  assert.equal(res.patch!.bindCodeHash, null) // cleared → not reusable
  assert.equal(res.patch!.bindCodeExpiresAt, null)
})

test('[A1] confirmBinding fails closed on wrong code, expiry, no-binding, revoked', () => {
  const code = 'GOODCODE'
  const rec = beginBinding({ operatorUserId: 'user_1', code, now: T0 })
  assert.equal(confirmBinding(rec, { code: 'WRONG', telegramChatId: '1', now: at(1) }).ok, false)
  assert.equal(confirmBinding(rec, { code, telegramChatId: '1', now: at(DEFAULT_BIND_CODE_TTL_MS + 1) }).ok, false)
  assert.equal(confirmBinding(null, { code, telegramChatId: '1', now: T0 }).ok, false)
  assert.equal(confirmBinding({ ...rec, revokedAt: T0 }, { code, telegramChatId: '1', now: at(1) }).ok, false)
  // Missing chat id
  assert.equal(confirmBinding(rec, { code, telegramChatId: '  ', now: at(1) }).ok, false)
  // Already-consumed code (bindCodeHash cleared)
  assert.equal(confirmBinding({ ...rec, bindCodeHash: null, bindCodeExpiresAt: null }, { code, telegramChatId: '1', now: at(1) }).ok, false)
})

test('[A1] isBoundChat: only the bound chat matches; fail closed otherwise', () => {
  const bound = {
    operatorUserId: 'u', telegramChatId: '999', bindCodeHash: null, bindCodeExpiresAt: null,
    boundAt: T0, revokedAt: null,
  }
  assert.equal(isBoundChat(bound, '999'), true)
  assert.equal(isBoundChat(bound, '888'), false)
  assert.equal(isBoundChat(bound, ''), false)
  assert.equal(isBoundChat(bound, null), false)
  assert.equal(isBoundChat({ ...bound, revokedAt: T0 }, '999'), false)   // revoked
  assert.equal(isBoundChat({ ...bound, boundAt: null }, '999'), false)   // not yet bound
  assert.equal(isBoundChat(null, '999'), false)
})

test('[A1] isBoundOperator: only the operator who owns the binding matches', () => {
  const b = { operatorUserId: 'owner_1', telegramChatId: null, bindCodeHash: 'x', bindCodeExpiresAt: T0, boundAt: null, revokedAt: null }
  assert.equal(isBoundOperator(b, 'owner_1'), true)
  assert.equal(isBoundOperator(b, 'someone_else'), false)
  assert.equal(isBoundOperator(b, ''), false)
  assert.equal(isBoundOperator({ ...b, revokedAt: T0 }, 'owner_1'), false)
  assert.equal(isBoundOperator(null, 'owner_1'), false)
})

// ─── Nonce / replay ──────────────────────────────────────────────────────────

test('[A1] isFreshNonce rejects seen nonces and blanks', () => {
  const seen = new Set(['n1', 'n2'])
  assert.equal(isFreshNonce(seen, 'n3'), true)
  assert.equal(isFreshNonce(seen, 'n1'), false)  // replay
  assert.equal(isFreshNonce(seen, ''), false)    // blank never fresh
  assert.equal(isFreshNonce(['a', 'b'], 'a'), false) // accepts an iterable
})

// ─── /panic ──────────────────────────────────────────────────────────────────

test('[A1] panicPlan pauses, revokes live sessions, cancels in-flight runs', () => {
  const sessions = [
    { tokenHash: 'h1', revokedAt: null },
    { tokenHash: 'h2', revokedAt: at(-1000) }, // already revoked → skipped
    { tokenHash: 'h3', revokedAt: null },
  ]
  const plan = panicPlan(sessions as any, T0)
  assert.deepEqual(plan.agentPatch, { status: 'paused' })
  assert.deepEqual(plan.sessionsToRevoke, ['h1', 'h3']) // idempotent: skips revoked
  assert.equal(plan.revokePatch.revokedAt.getTime(), T0.getTime())
  assert.deepEqual(plan.cancelRunStatuses, ['running', 'queued'])
})

test('[A1] panicPlan on no sessions is a safe no-op plan', () => {
  const plan = panicPlan([], T0)
  assert.deepEqual(plan.sessionsToRevoke, [])
  assert.deepEqual(plan.agentPatch, { status: 'paused' })
})

// ─── Persona ─────────────────────────────────────────────────────────────────

test('[A1] buildArturitaAgent seeds an owner-scoped, internal-runtime persona', () => {
  const a = buildArturitaAgent('org_1', 'agent_1', T0)
  assert.equal(a.orgId, 'org_1')
  assert.equal(a.id, 'agent_1')
  assert.equal(a.name, 'Arturita')
  assert.equal(a.agentType, 'arturita')
  assert.equal(a.runtime, 'internal')
  assert.equal(a.status, 'idle')
  assert.match(a.persona, /approval/i)      // safety posture is in the persona
  assert.match(a.personality, /never signs/i)
})
