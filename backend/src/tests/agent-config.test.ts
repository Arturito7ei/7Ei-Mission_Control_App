import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_FIELDS, validateConfigPatch, wouldCycle, type AgentNode } from '../services/agent-config'
import { ALLOWED_AVATAR_TYPES, MAX_AVATAR_BYTES, buildAvatarDataUri, isAllowedAvatarType, isSafeAvatarValue } from '../services/agent-avatar'

// ceo ← vp ← eng  (eng reports to vp, vp reports to ceo)
const agents: AgentNode[] = [
  { id: 'ceo', reportsTo: null },
  { id: 'vp', reportsTo: 'ceo' },
  { id: 'eng', reportsTo: 'vp' },
  { id: 'solo', reportsTo: null },
]

describe('[AG5] wouldCycle', () => {
  it('is true for self-management', () => {
    assert.equal(wouldCycle(agents, 'vp', 'vp'), true)
  })

  it('is true when the proposed manager already reports (transitively) to the agent', () => {
    assert.equal(wouldCycle(agents, 'ceo', 'eng'), true) // eng → vp → ceo, so ceo→eng closes the loop
    assert.equal(wouldCycle(agents, 'vp', 'eng'), true)
  })

  it('is false for a legitimate move', () => {
    assert.equal(wouldCycle(agents, 'solo', 'eng'), false)
    assert.equal(wouldCycle(agents, 'eng', 'ceo'), false) // re-parenting upward is fine
  })

  it('terminates on a pre-existing cycle instead of looping forever', () => {
    const broken: AgentNode[] = [{ id: 'a', reportsTo: 'b' }, { id: 'b', reportsTo: 'a' }]
    assert.equal(wouldCycle(broken, 'c', 'a'), false)
  })
})

describe('[AG5] validateConfigPatch', () => {
  const ctx = { agentId: 'vp', agents }

  it('accepts the editable identity fields', () => {
    const r = validateConfigPatch({ name: ' R2D2 ', title: 'CEO', role: 'Chief', jobDescription: 'Runs it', avatarEmoji: '🤖' }, ctx)
    assert.deepEqual(r, { ok: true, fields: { name: 'R2D2', title: 'CEO', role: 'Chief', jobDescription: 'Runs it', avatarEmoji: '🤖' } })
  })

  it('ignores keys that are not in the allowlist (the tab cannot widen its own scope)', () => {
    const r = validateConfigPatch({ name: 'X', status: 'active', permissions: ['*'], orgId: 'other-org', apiTokenHash: 'x' }, ctx)
    assert.equal(r.ok, true)
    assert.deepEqual((r as any).fields, { name: 'X' })
    assert.ok(!CONFIG_FIELDS.includes('status' as any))
  })

  it('requires a name and a role when they are supplied', () => {
    assert.equal(validateConfigPatch({ name: '   ' }, ctx).ok, false)
    assert.equal(validateConfigPatch({ role: '' }, ctx).ok, false)
    assert.match((validateConfigPatch({ name: 'x'.repeat(101) }, ctx) as any).error, /100 characters/)
  })

  it('clears an optional field with an empty string (that is how "unset" is stored)', () => {
    const r = validateConfigPatch({ title: '', reportsTo: '' }, ctx)
    assert.deepEqual((r as any).fields, { title: null, reportsTo: null })
  })

  it('rejects an unknown adapter but accepts every real one', () => {
    assert.match((validateConfigPatch({ runtime: 'skynet' }, ctx) as any).error, /Unknown adapter/)
    for (const rt of ['internal', 'openclaw', 'cursor', 'claude_code', 'custom']) {
      assert.equal(validateConfigPatch({ runtime: rt }, ctx).ok, true, rt)
    }
  })

  it('rejects a manager who is not an agent in this org', () => {
    assert.match((validateConfigPatch({ reportsTo: 'ghost' }, ctx) as any).error, /not an agent in this organisation/)
  })

  it('refuses a reporting loop', () => {
    assert.match((validateConfigPatch({ reportsTo: 'eng' }, ctx) as any).error, /reporting loop/)
    assert.match((validateConfigPatch({ reportsTo: 'vp' }, ctx) as any).error, /reporting loop/) // self
  })

  it('accepts a valid manager', () => {
    assert.deepEqual((validateConfigPatch({ reportsTo: 'ceo' }, ctx) as any).fields, { reportsTo: 'ceo' })
  })

  it('rejects a non-string value and an empty patch', () => {
    assert.equal(validateConfigPatch({ name: 42 as any }, ctx).ok, false)
    assert.equal(validateConfigPatch({}, ctx).ok, false)
    assert.equal(validateConfigPatch({ nothing: 'useful' }, ctx).ok, false)
  })

  it('caps the icon at a single emoji', () => {
    assert.equal(validateConfigPatch({ avatarEmoji: '🤖' }, ctx).ok, true)
    assert.equal(validateConfigPatch({ avatarEmoji: 'not an emoji at all' }, ctx).ok, false)
  })
})

describe('[AG5] avatar upload', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')

  it('accepts the four image types and builds a data URI', () => {
    for (const type of ALLOWED_AVATAR_TYPES) {
      const r = buildAvatarDataUri(type, png)
      assert.equal(r.ok, true, type)
      assert.match((r as any).dataUri, new RegExp(`^data:${type};base64,`))
      assert.equal((r as any).bytes, png.byteLength)
    }
  })

  it('tolerates a charset suffix and odd casing on the content type', () => {
    assert.equal(buildAvatarDataUri('IMAGE/PNG; charset=binary', png).ok, true)
  })

  it('rejects a non-image type', () => {
    for (const bad of ['application/pdf', 'text/html', 'image/svg+xml', '', undefined]) {
      const r = buildAvatarDataUri(bad as any, png)
      assert.equal(r.ok, false, String(bad))
      assert.match((r as any).error, /Unsupported image type|Use PNG/)
    }
    assert.equal(isAllowedAvatarType('image/svg+xml'), false) // SVG can carry script — never allowed
  })

  it('rejects an empty file and one over the byte cap', () => {
    assert.match((buildAvatarDataUri('image/png', Buffer.alloc(0)) as any).error, /empty/)
    const tooBig = Buffer.alloc(MAX_AVATAR_BYTES + 1)
    assert.match((buildAvatarDataUri('image/png', tooBig) as any).error, /limit is/)
  })

  it('isSafeAvatarValue gates what may reach an <img src>', () => {
    assert.equal(isSafeAvatarValue(buildAvatarDataUri('image/png', png).ok ? (buildAvatarDataUri('image/png', png) as any).dataUri : ''), true)
    assert.equal(isSafeAvatarValue('javascript:alert(1)'), false)
    assert.equal(isSafeAvatarValue('https://tracker.example/pixel.png'), false)
    assert.equal(isSafeAvatarValue('data:text/html;base64,PHNjcmlwdD4='), false)
    assert.equal(isSafeAvatarValue('data:image/svg+xml;base64,PHN2Zz4='), false)
    assert.equal(isSafeAvatarValue(null), false)
    assert.equal(isSafeAvatarValue(''), false)
  })
})
