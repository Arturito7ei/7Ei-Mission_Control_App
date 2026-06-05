import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClerkAuth, extractBearerToken, type ClerkClaims } from '../middleware/clerk-auth.ts'

// ─── Test doubles ───────────────────────────────────────────────────────────

interface FakeReply {
  statusCode: number | null
  body: unknown
  code(c: number): FakeReply
  send(b: unknown): FakeReply
}

function makeReply(): FakeReply {
  return {
    statusCode: null,
    body: undefined,
    code(c) { this.statusCode = c; return this },
    send(b) { this.body = b; return this },
  }
}

function makeReq(opts: { method?: string; authorization?: string }) {
  return {
    method: opts.method ?? 'POST',
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as any
}

// A verifier that returns fixed claims, and records whether it was called.
function fakeVerifier(claims: ClerkClaims) {
  const calls: string[] = []
  const fn = async (token: string) => { calls.push(token); return claims }
  return { fn, calls }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('[MCA-14] Clerk auth middleware', () => {
  it('replies 401 when the Authorization header is missing', async () => {
    const { fn, calls } = fakeVerifier({ sub: 'user_x' })
    const auth = createClerkAuth(fn)
    const req = makeReq({})
    const reply = makeReply()

    await auth(req, reply as any)

    assert.equal(reply.statusCode, 401)
    assert.deepEqual(reply.body, { error: 'Unauthorized' })
    assert.equal(req.userId, undefined)
    assert.equal(calls.length, 0, 'verifier must not be called without a token')
  })

  it('replies 401 when the token is malformed (verifier throws)', async () => {
    const throwingVerifier = async () => { throw new Error('jwt malformed') }
    const auth = createClerkAuth(throwingVerifier)
    const req = makeReq({ authorization: 'Bearer not.a.real.jwt' })
    const reply = makeReply()

    await auth(req, reply as any)

    assert.equal(reply.statusCode, 401)
    assert.deepEqual(reply.body, { error: 'Unauthorized' })
    assert.equal(req.userId, undefined)
  })

  it('replies 401 when the header is present but not a Bearer token', async () => {
    const { fn, calls } = fakeVerifier({ sub: 'user_x' })
    const auth = createClerkAuth(fn)
    const req = makeReq({ authorization: 'Basic abc123' })
    const reply = makeReply()

    await auth(req, reply as any)

    assert.equal(reply.statusCode, 401)
    assert.equal(calls.length, 0)
  })

  it('attaches req.userId, req.clerkSession and req.auth on a valid token', async () => {
    const claims: ClerkClaims = { sub: 'user_2abc', sid: 'sess_123' }
    const { fn, calls } = fakeVerifier(claims)
    const auth = createClerkAuth(fn)
    const req = makeReq({ authorization: 'Bearer valid.jwt.token' })
    const reply = makeReply()

    await auth(req, reply as any)

    assert.equal(reply.statusCode, null, 'must not reply on success')
    assert.equal(req.userId, 'user_2abc')
    assert.deepEqual(req.clerkSession, claims)
    assert.equal(req.auth.userId, 'user_2abc')
    assert.equal(req.auth.sessionId, 'sess_123')
    assert.equal(calls[0], 'valid.jwt.token')
  })

  it('replies 401 when the verified token has no sub claim', async () => {
    const auth = createClerkAuth(async () => ({} as ClerkClaims))
    const req = makeReq({ authorization: 'Bearer token.without.sub' })
    const reply = makeReply()

    await auth(req, reply as any)

    assert.equal(reply.statusCode, 401)
    assert.equal(req.userId, undefined)
  })

  it('skips OPTIONS preflight without requiring a token', async () => {
    const { fn, calls } = fakeVerifier({ sub: 'user_x' })
    const auth = createClerkAuth(fn)
    const req = makeReq({ method: 'OPTIONS' })
    const reply = makeReply()

    await auth(req, reply as any)

    assert.equal(reply.statusCode, null, 'preflight must pass through untouched')
    assert.equal(calls.length, 0)
  })

  it('extractBearerToken parses the token and is case-insensitive on the scheme', () => {
    assert.equal(extractBearerToken({ headers: { authorization: 'Bearer abc.def' } } as any), 'abc.def')
    assert.equal(extractBearerToken({ headers: { authorization: 'bearer abc.def' } } as any), 'abc.def')
    assert.equal(extractBearerToken({ headers: {} } as any), null)
    assert.equal(extractBearerToken({ headers: { authorization: 'Bearer ' } } as any), null)
  })
})
