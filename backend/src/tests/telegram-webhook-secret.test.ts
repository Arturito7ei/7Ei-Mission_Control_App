import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTelegramWebhookSecret } from '../services/webhook-auth.ts'

describe('[D1] resolveTelegramWebhookSecret', () => {
  it('prefers TELEGRAM_WEBHOOK_SECRET when both are set', () => {
    assert.equal(
      resolveTelegramWebhookSecret({
        TELEGRAM_WEBHOOK_SECRET: 'telegram-specific',
        WEBHOOK_SIGNING_SECRET: 'shared-fallback',
      }),
      'telegram-specific',
    )
  })

  it('falls back to WEBHOOK_SIGNING_SECRET when TELEGRAM_WEBHOOK_SECRET is unset', () => {
    assert.equal(
      resolveTelegramWebhookSecret({ WEBHOOK_SIGNING_SECRET: 'shared-fallback' }),
      'shared-fallback',
    )
  })

  it('returns undefined when neither secret is configured', () => {
    assert.equal(resolveTelegramWebhookSecret({}), undefined)
  })

  it('trims whitespace from configured secrets', () => {
    assert.equal(
      resolveTelegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: '  abc  ' }),
      'abc',
    )
  })
})
