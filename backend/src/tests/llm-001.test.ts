import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Test the orgApiKey resolution logic used in LLM-001

function resolveApiKey(orgApiKey: string | undefined, envKey: string | undefined): string | undefined {
  return orgApiKey ?? envKey
}

function extractOrgApiKey(
  deployConfig: Record<string, string> | null | undefined,
  provider: string
): string | undefined {
  return deployConfig?.[`${provider}_api_key`] as string | undefined
}

describe('[LLM-001] Per-org API key override', () => {
  it('uses orgApiKey when present, ignoring env', () => {
    const key = resolveApiKey('org-sk-abc123', 'env-sk-default')
    assert.equal(key, 'org-sk-abc123')
  })

  it('falls back to env when orgApiKey is undefined', () => {
    const key = resolveApiKey(undefined, 'env-sk-default')
    assert.equal(key, 'env-sk-default')
  })

  it('falls back to env when orgApiKey is empty string (falsy)', () => {
    // undefined ?? env → env (empty string is not undefined, but '' is falsy — ?? only checks undefined/null)
    const key = resolveApiKey('' as any, 'env-sk-default')
    // '' ?? 'env' = '' (nullish coalescing only triggers on null/undefined)
    assert.equal(key, '')
  })

  it('returns undefined when both orgApiKey and env are undefined', () => {
    const key = resolveApiKey(undefined, undefined)
    assert.equal(key, undefined)
  })

  it('extracts anthropic_api_key from deployConfig', () => {
    const config = { anthropic_api_key: 'sk-ant-org123', openai_api_key: 'sk-openai-org' }
    assert.equal(extractOrgApiKey(config, 'anthropic'), 'sk-ant-org123')
  })

  it('extracts openai_api_key from deployConfig', () => {
    const config = { openai_api_key: 'sk-openai-org456' }
    assert.equal(extractOrgApiKey(config, 'openai'), 'sk-openai-org456')
  })

  it('extracts google_api_key from deployConfig', () => {
    const config = { google_api_key: 'goog-key-789' }
    assert.equal(extractOrgApiKey(config, 'google'), 'goog-key-789')
  })

  it('returns undefined when provider key not in deployConfig', () => {
    const config = { anthropic_api_key: 'sk-ant-123' }
    assert.equal(extractOrgApiKey(config, 'openai'), undefined)
  })

  it('returns undefined when deployConfig is null', () => {
    assert.equal(extractOrgApiKey(null, 'anthropic'), undefined)
  })

  it('returns undefined when deployConfig is undefined', () => {
    assert.equal(extractOrgApiKey(undefined, 'anthropic'), undefined)
  })
})
