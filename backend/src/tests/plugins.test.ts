import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest, grantedCapabilities, exposedTools, ALLOWED_CAPABILITIES } from '../services/plugins.ts'

const valid = { name: 'weekly-report', version: '1.0.0', capabilities: ['read:tasks', 'notify'], tools: [{ name: 'generate' }] }

describe('[MCA-PC D2] validateManifest', () => {
  it('accepts a valid manifest', () => {
    const r = validateManifest(valid)
    assert.equal(r.ok, true)
    assert.deepEqual(r.errors, [])
  })
  it('requires name + version', () => {
    const r = validateManifest({})
    assert.equal(r.ok, false)
    assert.ok(r.errors.some(e => /name/.test(e)))
    assert.ok(r.errors.some(e => /version/.test(e)))
  })
  it('rejects non-kebab name', () => {
    assert.ok(validateManifest({ name: 'Bad Name', version: '1' }).errors.some(e => /kebab/.test(e)))
  })
  it('rejects unknown capabilities', () => {
    const r = validateManifest({ name: 'p', version: '1', capabilities: ['read:tasks', 'delete:everything'] })
    assert.ok(r.errors.some(e => /unknown capability: delete:everything/.test(e)))
  })
  it('rejects malformed tools', () => {
    assert.ok(validateManifest({ name: 'p', version: '1', tools: [{ description: 'no name' }] }).errors.some(e => /tools\[0\]\.name/.test(e)))
  })
})

describe('[MCA-PC D2] grantedCapabilities / exposedTools', () => {
  it('filters to allowed capabilities', () => {
    const g = grantedCapabilities({ name: 'p', version: '1', capabilities: ['read:tasks', 'bogus'] as any })
    assert.deepEqual(g, ['read:tasks'])
  })
  it('lists exposed tool names', () => {
    assert.deepEqual(exposedTools(valid), ['generate'])
  })
  it('ALLOWED_CAPABILITIES is non-empty', () => assert.ok(ALLOWED_CAPABILITIES.length > 0))
})
