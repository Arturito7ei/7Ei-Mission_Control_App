import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveTelegramWebhookSecret,
  deriveWebhookSecret,
  checkWebhook,
} from '../services/webhook-auth.ts'

describe('[D1] resolveTelegramWebhookSecret', () => {
  it('returns TELEGRAM_WEBHOOK_SECRET when set', () => {
    assert.equal(
      resolveTelegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: 'telegram-specific' }),
      'telegram-specific',
    )
  })

  it('does not fall back to WEBHOOK_SIGNING_SECRET (separate trust boundary)', () => {
    assert.equal(
      resolveTelegramWebhookSecret({
        TELEGRAM_WEBHOOK_SECRET: 'telegram-specific',
        WEBHOOK_SIGNING_SECRET: 'shared-outbound',
      }),
      'telegram-specific',
    )
    assert.equal(
      resolveTelegramWebhookSecret({ WEBHOOK_SIGNING_SECRET: 'shared-outbound-only' }),
      undefined,
    )
  })

  it('returns undefined when TELEGRAM_WEBHOOK_SECRET is unset', () => {
    assert.equal(resolveTelegramWebhookSecret({}), undefined)
  })

  it('trims whitespace from TELEGRAM_WEBHOOK_SECRET', () => {
    assert.equal(
      resolveTelegramWebhookSecret({ TELEGRAM_WEBHOOK_SECRET: '  abc  ' }),
      'abc',
    )
  })

  it('register and verify resolve identically (global + per-org server secret)', () => {
    const env = { TELEGRAM_WEBHOOK_SECRET: 'parity-secret' }
    const forVerify = resolveTelegramWebhookSecret(env)
    const forRegister = resolveTelegramWebhookSecret(env)
    assert.equal(forVerify, forRegister)
    const orgId = 'org-parity'
    const registeredToken = deriveWebhookSecret(forRegister!, 'telegram', orgId)
    const { authorized } = checkWebhook(forVerify, 'telegram', orgId, registeredToken)
    assert.equal(authorized, true)
  })
})
