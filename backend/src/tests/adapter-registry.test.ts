import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  listAdapters, getAdapter, adapterTypes, invitableAdapterTypes, joinableAdapterTypes,
  secretFields, runtimeForAdapter, validateDefaultsPayload, publicRegistry,
  MAX_PAYLOAD_BYTES, MAX_PAYLOAD_KEYS, MAX_STRING_FIELD_CHARS,
} from '../services/adapter-registry'

describe('[ONB1] adapter registry — the taxonomy', () => {
  it('declares every runtime the design names', () => {
    const types = adapterTypes()
    for (const t of ['openclaw_local', 'openclaw_gateway', 'claude_code', 'cursor', 'openai_generic', 'http_webhook', 'hermes_gateway', 'hermes_local', 'grok_local', 'internal']) {
      assert.ok(types.includes(t), `missing adapterType: ${t}`)
    }
  })

  it('has no duplicate adapter types', () => {
    const types = adapterTypes()
    assert.equal(new Set(types).size, types.length)
  })

  it('maps every adapter onto a legacy agents.runtime value (no schema churn)', () => {
    for (const a of listAdapters()) {
      assert.ok(['openclaw', 'cursor', 'claude_code', 'custom'].includes(a.runtime), `${a.type} → ${a.runtime}`)
      assert.equal(runtimeForAdapter(a.type), a.runtime)
    }
  })

  it('`internal` is declared but NOT invitable — we run those agents ourselves', () => {
    const internal = getAdapter('internal')!
    assert.equal(internal.invitable, false)
    assert.ok(!invitableAdapterTypes().includes('internal'))
    assert.ok(!joinableAdapterTypes().includes('internal'))
  })

  it('declared-but-unavailable adapters are listed (an honest map) yet not joinable', () => {
    const declaredUnavailable = listAdapters().filter((a) => a.invitable && !a.available).map((a) => a.type)
    assert.ok(declaredUnavailable.length > 0, 'the registry should carry declared-but-unavailable entries')
    for (const t of declaredUnavailable) {
      assert.ok(invitableAdapterTypes().includes(t), `${t} should be declarable on an invite`)
      assert.ok(!joinableAdapterTypes().includes(t), `${t} must not be joinable`)
    }
  })

  // ── AAD-1 — the readiness tripwire: flip an unbuilt runtime to available and CI red ──
  it('[ADD-1] joinableAdapterTypes() is EXACTLY the four built runtimes', () => {
    // Pins the set so the moment anyone flips openclaw_gateway / http_webhook /
    // hermes_gateway / hermes_local / grok_local to `available: true`, this fails — a
    // join would then be accepted for a runtime that can never be handed work (dispatch
    // is pull-only; there is no outbound WS/Hermes/xAI client). See PLAN §2c.
    assert.deepEqual(
      [...joinableAdapterTypes()].sort(),
      ['claude_code', 'cursor', 'openai_generic', 'openclaw_local'],
      'the set of joinable (built) runtimes changed — if this is intentional, update the pin AND ship the dispatch half',
    )
  })

  it('[ADD-1] the five requested-but-unbuilt runtimes are declared, invitable, and NOT available', () => {
    for (const t of ['openclaw_gateway', 'http_webhook', 'hermes_gateway', 'hermes_local', 'grok_local']) {
      const a = getAdapter(t)!
      assert.ok(a, `missing adapter ${t}`)
      assert.equal(a.available, false, `${t} must stay available:false until its dispatch half is built`)
      assert.equal(a.invitable, true, `${t} stays declarable so the taxonomy is an honest map`)
      assert.ok(!joinableAdapterTypes().includes(t), `${t} must not be joinable`)
    }
  })

  it('[ADD-1] every unavailable adapter carries a non-empty note explaining WHY (declared ≠ available)', () => {
    for (const a of listAdapters().filter((x) => !x.available && x.type !== 'internal')) {
      assert.ok(a.note && a.note.trim().length > 0, `${a.type} is unavailable but has no note explaining why`)
    }
  })

  it('[ADD-1] the pickable invariant holds: joinable = invitable && available && kind !== internal', () => {
    const pickable = listAdapters().filter((a) => a.invitable && a.available && a.kind !== 'internal').map((a) => a.type).sort()
    assert.deepEqual(pickable, [...joinableAdapterTypes()].sort(), 'joinableAdapterTypes drifted from the pickable definition')
    assert.ok(!pickable.includes('internal'), 'internal must never be pickable')
  })

  it('an unknown adapterType resolves to null, never a fallback', () => {
    assert.equal(getAdapter('nope'), null)
    assert.equal(getAdapter(''), null)
    assert.equal(getAdapter(null), null)
    assert.equal(runtimeForAdapter('nope'), null)
  })
})

describe('[ONB1] adapter registry — safety defaults that must never regress', () => {
  it('claude_code defaults to plan mode (propose-and-approve) and cannot select autonomy', () => {
    const cc = getAdapter('claude_code')!
    const mode = cc.fields.find((f) => f.key === 'permissionMode')!
    assert.equal(mode.default, 'plan')
    // Autonomy stays behind the CC6 host guards + the CC5 denylist. If a future
    // edit adds an autonomous value to this enum, this test is the tripwire.
    for (const v of mode.enum ?? []) {
      assert.ok(!/auto|bypass|yolo|dangerous/i.test(v), `permissionMode enum must not offer an autonomous value: ${v}`)
    }
  })

  it('openclaw_local does not turn shell execution on by default', () => {
    const f = getAdapter('openclaw_local')!.fields.find((x) => x.key === 'allowShell')!
    assert.equal(f.default, false)
  })

  it('every credential-bearing field is flagged secret', () => {
    assert.deepEqual(secretFields('openclaw_gateway'), ['x-openclaw-token'])
    assert.deepEqual(secretFields('hermes_gateway'), ['apiKey'])
    assert.deepEqual(secretFields('openai_generic'), ['apiKey'])
    assert.deepEqual(secretFields('http_webhook'), ['webhookAuthHeader'])
    assert.deepEqual(secretFields('claude_code'), [])
  })

  it('no secret field carries a default — we never invent a credential', () => {
    for (const a of listAdapters()) {
      for (const f of a.fields) {
        if (f.secret) assert.equal(f.default, undefined, `${a.type}.${f.key} must not have a default`)
      }
    }
  })

  it('the public registry names secret FIELDS but carries no values', () => {
    const json = JSON.stringify(publicRegistry())
    assert.ok(json.includes('x-openclaw-token'))
    assert.ok(!/mca_|sk-|Bearer\s+[A-Za-z0-9]/.test(json), 'registry must not contain anything token-shaped')
  })
})

describe('[ONB1] validateDefaultsPayload — fail-closed', () => {
  it('accepts a well-formed payload and applies defaults', () => {
    const r = validateDefaultsPayload('claude_code', { workdir: '/tmp/checkout' })
    assert.ok(r.ok, r.errors.join('; '))
    assert.equal(r.config.workdir, '/tmp/checkout')
    assert.equal(r.config.permissionMode, 'plan')       // default applied
    assert.equal(r.config.timeoutSeconds, 900)
    assert.deepEqual(r.secrets, {})
  })

  it('splits declared secret fields OUT of config and into secrets', () => {
    const r = validateDefaultsPayload('openai_generic', { baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'sk-live-xyz' })
    assert.ok(r.ok, r.errors.join('; '))
    assert.equal(r.secrets.apiKey, 'sk-live-xyz')
    assert.equal(r.config.apiKey, undefined, 'a secret must never land in a plaintext config column')
    assert.ok(!JSON.stringify(r.config).includes('sk-live-xyz'))
  })

  it('refuses a required field that is missing — including a required SECRET', () => {
    const r = validateDefaultsPayload('claude_code', {})
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => e.includes('workdir')))

    const g = validateDefaultsPayload('openclaw_gateway', { url: 'wss://x/ws' }, { requireAvailable: false })
    assert.ok(!g.ok)
    assert.ok(g.errors.some((e) => e.includes('x-openclaw-token')))
  })

  it('refuses an unknown field (allowlist, not sanitize)', () => {
    const r = validateDefaultsPayload('claude_code', { workdir: '/tmp', somethingElse: 1 })
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => e.includes('somethingElse')))
  })

  it('refuses an UNDECLARED secret-shaped key loudly rather than dropping it silently', () => {
    const r = validateDefaultsPayload('claude_code', { workdir: '/tmp', apiKey: 'sk-live-xyz' })
    assert.ok(!r.ok)
    assert.ok(r.errors.some((e) => /secret-shaped/.test(e)), r.errors.join('; '))
    assert.deepEqual(r.secrets, {}, 'a refused payload yields nothing at all')
    assert.deepEqual(r.config, {})
  })

  it('refuses prototype-pollution keys', () => {
    const r = validateDefaultsPayload('claude_code', JSON.parse('{"workdir":"/tmp","__proto__":{"polluted":true}}'))
    assert.ok(!r.ok || r.config['polluted'] === undefined)
    const nested = validateDefaultsPayload('openai_generic', JSON.parse('{"baseUrl":"u","model":"m","headers":{"__proto__":{"x":1}}}'))
    assert.ok(!nested.ok)
    assert.equal(({} as any).polluted, undefined)
  })

  it('enforces the enum, the type and the string cap', () => {
    assert.ok(!validateDefaultsPayload('claude_code', { workdir: '/tmp', permissionMode: 'bypassPermissions' }).ok)
    assert.ok(!validateDefaultsPayload('claude_code', { workdir: 5 }).ok)
    assert.ok(!validateDefaultsPayload('claude_code', { workdir: '/tmp', timeoutSeconds: 'soon' }).ok)
    assert.ok(!validateDefaultsPayload('claude_code', { workdir: '/tmp', manageWorktree: 'yes' }).ok)
    assert.ok(!validateDefaultsPayload('claude_code', { workdir: 'x'.repeat(MAX_STRING_FIELD_CHARS + 1) }).ok)
  })

  it('enforces the size and key-count caps', () => {
    const big = validateDefaultsPayload('claude_code', { workdir: '/tmp', model: 'x'.repeat(MAX_PAYLOAD_BYTES) })
    assert.ok(!big.ok)
    const many: Record<string, unknown> = { workdir: '/tmp' }
    for (let i = 0; i < MAX_PAYLOAD_KEYS + 5; i++) many[`k${i}`] = 1
    assert.ok(!validateDefaultsPayload('claude_code', many).ok)
  })

  it('refuses an unknown, non-invitable, or unavailable adapterType', () => {
    assert.ok(!validateDefaultsPayload('nope', {}).ok)
    const internal = validateDefaultsPayload('internal', {})
    assert.ok(!internal.ok)
    assert.ok(internal.errors.some((e) => /cannot be invited/.test(e)))
    const gw = validateDefaultsPayload('hermes_gateway', { apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'k' })
    assert.ok(!gw.ok)
    assert.ok(gw.errors.some((e) => /not available/.test(e)))
  })

  it('a non-object payload is refused', () => {
    assert.ok(!validateDefaultsPayload('claude_code', [1, 2, 3] as any).ok)
    assert.ok(!validateDefaultsPayload('claude_code', 'workdir=/tmp' as any).ok)
  })
})
