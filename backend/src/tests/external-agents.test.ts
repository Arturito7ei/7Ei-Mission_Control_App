import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createHash } from 'crypto'
import { generateAgentToken, hashToken, createAgentAuth } from '../middleware/agent-token.ts'
import { isExternalAgent, heartbeatFreshness } from '../services/agent-runtime.ts'

// Replicates ExternalAgentSchema from routes/all.ts for validation testing.
const ExternalAgentSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(200),
  runtime: z.enum(['openclaw', 'cursor', 'claude_code', 'custom']),
  llmProvider: z.string().default('minimax'),
  llmModel: z.string().default('minimax'),
  termsOfReference: z.string().optional(),
  avatarEmoji: z.string().default('🤖'),
  externalEndpoint: z.string().url().optional(),
  contactChannel: z.string().optional(),
})

describe('[MCA-EXT] agent tokens', () => {
  it('generateAgentToken returns mca_-prefixed token with matching hash', () => {
    const { token, hash } = generateAgentToken()
    assert.ok(token.startsWith('mca_'))
    assert.equal(hash, createHash('sha256').update(token).digest('hex'))
    assert.equal(hash, hashToken(token))
  })

  it('tokens are unique', () => {
    const a = generateAgentToken(), b = generateAgentToken()
    assert.notEqual(a.token, b.token)
    assert.notEqual(a.hash, b.hash)
  })

  it('hashToken is deterministic', () => {
    assert.equal(hashToken('mca_test'), hashToken('mca_test'))
  })
})

describe('[MCA-EXT] isExternalAgent', () => {
  it('true for agentType external', () => {
    assert.equal(isExternalAgent({ agentType: 'external', runtime: 'internal' }), true)
  })
  it('true for non-internal runtime', () => {
    assert.equal(isExternalAgent({ agentType: 'standard', runtime: 'openclaw' }), true)
  })
  it('false for internal standard agent', () => {
    assert.equal(isExternalAgent({ agentType: 'standard', runtime: 'internal' }), false)
  })
})

describe('[MCA-EXT] heartbeatFreshness', () => {
  const now = 1_000_000_000_000
  it('unknown when never seen', () => assert.equal(heartbeatFreshness(null, now), 'unknown'))
  it('green within 2 min', () => assert.equal(heartbeatFreshness(now - 60_000, now), 'green'))
  it('amber within 10 min', () => assert.equal(heartbeatFreshness(now - 5 * 60_000, now), 'amber'))
  it('stale beyond 10 min', () => assert.equal(heartbeatFreshness(now - 30 * 60_000, now), 'stale'))
  it('accepts Date input', () => assert.equal(heartbeatFreshness(new Date(now - 60_000), now), 'green'))
})

describe('[MCA-EXT] ExternalAgentSchema', () => {
  it('accepts a valid openclaw agent and defaults provider to minimax', () => {
    const p = ExternalAgentSchema.parse({ name: 'Arturito Open Claw', role: 'Ops', runtime: 'openclaw' })
    assert.equal(p.runtime, 'openclaw')
    assert.equal(p.llmProvider, 'minimax')
  })
  it('rejects an unknown runtime', () => {
    assert.throws(() => ExternalAgentSchema.parse({ name: 'X', role: 'Y', runtime: 'k8s' }))
  })
})

describe('[MCA-EXT] agentAuth hook', () => {
  function fakeReply() {
    const r: any = { _code: 200, _body: null }
    r.code = (c: number) => { r._code = c; return r }
    r.send = (b: any) => { r._body = b; return r }
    return r
  }
  const agent = { id: 'a1', orgId: 'o1', name: 'Claw', runtime: 'openclaw' } as any

  it('401 when no Authorization header', async () => {
    const auth = createAgentAuth(async () => agent)
    const reply = fakeReply()
    await auth({ method: 'POST', headers: {} } as any, reply)
    assert.equal(reply._code, 401)
  })

  it('401 when token resolves to no agent', async () => {
    const auth = createAgentAuth(async () => null)
    const reply = fakeReply()
    await auth({ method: 'POST', headers: { authorization: 'Bearer mca_bad' } } as any, reply)
    assert.equal(reply._code, 401)
  })

  it('attaches req.agent on a valid token', async () => {
    const auth = createAgentAuth(async () => agent)
    const reply = fakeReply()
    const req: any = { method: 'POST', headers: { authorization: 'Bearer mca_good' } }
    await auth(req, reply)
    assert.equal(reply._code, 200)
    assert.equal(req.agent.id, 'a1')
    assert.equal(req.orgId, 'o1')
  })
})
