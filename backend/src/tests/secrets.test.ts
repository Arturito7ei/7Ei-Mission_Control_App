import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encrypt, decrypt, maskValue, resolveSecretsForAgent } from '../services/secrets.ts'

describe('[MCA-PC D4] encrypt/decrypt', () => {
  it('round-trips and does not store plaintext', () => {
    const v = 'sk-super-secret-123'
    const blob = encrypt(v)
    assert.notEqual(blob, v)
    assert.ok(!blob.includes(v))
    assert.equal(decrypt(blob), v)
  })
  it('produces a fresh IV each time (different ciphertext)', () => {
    assert.notEqual(encrypt('x'), encrypt('x'))
  })
})

describe('[MCA-PC D4] maskValue', () => {
  it('shows only the last 4', () => {
    assert.equal(maskValue('sk-abcd1234'), '••••1234')
    assert.equal(maskValue('ab'), '••••')
  })
})

describe('[MCA-PC D4] resolveSecretsForAgent', () => {
  const secrets = [
    { scope: 'company', key: 'OPENAI_KEY', value: 'co' },
    { scope: 'company', key: 'SHARED', value: 'c' },
    { scope: 'agent', scopeId: 'a1', key: 'SHARED', value: 'a' },
    { scope: 'agent', scopeId: 'a2', key: 'OTHER', value: 'x' },
  ]
  it('agent scope overrides company; unrelated agent secrets excluded', () => {
    const r = resolveSecretsForAgent(secrets, 'a1')
    assert.equal(r.OPENAI_KEY, 'co')
    assert.equal(r.SHARED, 'a')      // agent override
    assert.equal(r.OTHER, undefined) // belongs to a2
  })
})
