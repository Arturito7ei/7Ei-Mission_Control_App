import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ─── Unit tests for KEYS-001 credential management logic ─────────────────────

// Mask key: first 7 + '...' + last 4
function maskKey(key: string): string {
  return key.length > 11
    ? `${key.slice(0, 7)}...${key.slice(-4)}`
    : `${key.slice(0, Math.min(3, key.length))}...`
}

// Simulate POST: add key to deployConfig
function addCredential(
  deployConfig: Record<string, string>,
  provider: string,
  apiKey: string,
): Record<string, string> {
  return { ...deployConfig, [`${provider}_api_key`]: apiKey }
}

// Simulate GET: list masked credentials
function listCredentials(
  deployConfig: Record<string, string>,
): Array<{ provider: string; maskedKey: string }> {
  const providers = ['anthropic', 'openai', 'gemini'] as const
  return providers
    .filter(p => !!deployConfig[`${p}_api_key`])
    .map(p => ({ provider: p, maskedKey: maskKey(deployConfig[`${p}_api_key`]) }))
}

// Simulate DELETE: remove key from deployConfig
function removeCredential(
  deployConfig: Record<string, string>,
  provider: string,
): Record<string, string> {
  const updated = { ...deployConfig }
  delete updated[`${provider}_api_key`]
  return updated
}

describe('[KEYS-001] Credential management', () => {
  describe('maskKey()', () => {
    it('masks a long Anthropic key correctly', () => {
      const key = 'sk-ant-api03-abc123xyzw'
      assert.equal(maskKey(key), 'sk-ant-...xyzw')
    })

    it('masks a long OpenAI key correctly', () => {
      const key = 'sk-proj-abc1234567890'
      assert.equal(maskKey(key), 'sk-proj...7890')
    })

    it('masks a long Gemini key correctly', () => {
      const key = 'AIzaSyAbcDefGhijKlmn'
      assert.equal(maskKey(key), 'AIzaSyA...Klmn')
    })

    it('handles short keys gracefully (≤11 chars)', () => {
      const key = 'abc'
      assert.ok(maskKey(key).endsWith('...'))
    })
  })

  describe('addCredential()', () => {
    it('adds anthropic_api_key to empty deployConfig', () => {
      const result = addCredential({}, 'anthropic', 'sk-ant-test')
      assert.equal(result['anthropic_api_key'], 'sk-ant-test')
    })

    it('adds openai_api_key without affecting other keys', () => {
      const config = { anthropic_api_key: 'sk-ant-existing' }
      const result = addCredential(config, 'openai', 'sk-openai-new')
      assert.equal(result['anthropic_api_key'], 'sk-ant-existing')
      assert.equal(result['openai_api_key'], 'sk-openai-new')
    })

    it('overwrites existing key for same provider', () => {
      const config = { anthropic_api_key: 'sk-ant-old' }
      const result = addCredential(config, 'anthropic', 'sk-ant-new')
      assert.equal(result['anthropic_api_key'], 'sk-ant-new')
    })

    it('adds gemini_api_key', () => {
      const result = addCredential({}, 'gemini', 'AIza-test')
      assert.equal(result['gemini_api_key'], 'AIza-test')
    })
  })

  describe('listCredentials()', () => {
    it('returns empty array for empty deployConfig', () => {
      assert.deepEqual(listCredentials({}), [])
    })

    it('returns one credential when only anthropic is set', () => {
      const config = { anthropic_api_key: 'sk-ant-api03-abc123xyzw' }
      const result = listCredentials(config)
      assert.equal(result.length, 1)
      assert.equal(result[0].provider, 'anthropic')
      assert.equal(result[0].maskedKey, 'sk-ant-...xyzw')
    })

    it('returns multiple credentials when multiple providers are set', () => {
      const config = {
        anthropic_api_key: 'sk-ant-api03-abc123xyzw',
        openai_api_key: 'sk-proj-abc1234567890',
      }
      const result = listCredentials(config)
      assert.equal(result.length, 2)
      const providers = result.map(r => r.provider)
      assert.ok(providers.includes('anthropic'))
      assert.ok(providers.includes('openai'))
    })

    it('does not include providers with no key set', () => {
      const config = { gemini_api_key: 'AIzaSyAbcDefGhijKlmn' }
      const result = listCredentials(config)
      assert.equal(result.length, 1)
      assert.equal(result[0].provider, 'gemini')
    })

    it('ignores unrelated deployConfig keys', () => {
      const config = { other_setting: 'value', anthropic_api_key: 'sk-ant-api03-abc123xyzw' }
      const result = listCredentials(config)
      assert.equal(result.length, 1)
    })
  })

  describe('removeCredential()', () => {
    it('removes anthropic key from deployConfig', () => {
      const config = { anthropic_api_key: 'sk-ant-test', openai_api_key: 'sk-openai-test' }
      const result = removeCredential(config, 'anthropic')
      assert.equal(result['anthropic_api_key'], undefined)
      assert.equal(result['openai_api_key'], 'sk-openai-test')
    })

    it('removing non-existent key is a no-op', () => {
      const config = { anthropic_api_key: 'sk-ant-test' }
      const result = removeCredential(config, 'gemini')
      assert.deepEqual(result, config)
    })

    it('does not mutate original config', () => {
      const config = { anthropic_api_key: 'sk-ant-test' }
      removeCredential(config, 'anthropic')
      assert.equal(config['anthropic_api_key'], 'sk-ant-test')
    })
  })

  describe('round-trip: add → list → delete', () => {
    it('full lifecycle for one credential', () => {
      let config: Record<string, string> = {}
      config = addCredential(config, 'anthropic', 'sk-ant-api03-abc123xyzw')
      let list = listCredentials(config)
      assert.equal(list.length, 1)
      assert.equal(list[0].maskedKey, 'sk-ant-...xyzw')
      config = removeCredential(config, 'anthropic')
      list = listCredentials(config)
      assert.equal(list.length, 0)
    })

    it('all three providers can be added and removed independently', () => {
      let config: Record<string, string> = {}
      config = addCredential(config, 'anthropic', 'sk-ant-api03-abc123xyzw')
      config = addCredential(config, 'openai', 'sk-proj-abc1234567890')
      config = addCredential(config, 'gemini', 'AIzaSyAbcDefGhijKlmn')
      assert.equal(listCredentials(config).length, 3)

      config = removeCredential(config, 'openai')
      const remaining = listCredentials(config)
      assert.equal(remaining.length, 2)
      assert.ok(!remaining.some(r => r.provider === 'openai'))
    })
  })
})
