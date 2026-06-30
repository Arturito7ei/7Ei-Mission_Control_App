import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeWebhookToken, isCronTriggered, normalizeTriggerType, cronSentinel } from '../services/routines.ts'

describe('[MCA-PC C3] makeWebhookToken', () => {
  it('is rt_-prefixed and unique', () => {
    const a = makeWebhookToken(), b = makeWebhookToken()
    assert.match(a, /^rt_[0-9a-f]{48}$/)
    assert.notEqual(a, b)
  })
})

describe('[MCA-PC C3] isCronTriggered', () => {
  it('true for cron / null (back-compat)', () => {
    assert.equal(isCronTriggered('cron'), true)
    assert.equal(isCronTriggered(null), true)
    assert.equal(isCronTriggered(undefined), true)
  })
  it('false for webhook / api', () => {
    assert.equal(isCronTriggered('webhook'), false)
    assert.equal(isCronTriggered('api'), false)
  })
})

describe('[MCA-PC C3] normalizeTriggerType / cronSentinel', () => {
  it('normalizes unknown to cron', () => {
    assert.equal(normalizeTriggerType('webhook'), 'webhook')
    assert.equal(normalizeTriggerType('api'), 'api')
    assert.equal(normalizeTriggerType('nonsense'), 'cron')
  })
  it('sentinel marks non-cron routines', () => {
    assert.equal(cronSentinel('cron'), '')
    assert.equal(cronSentinel('webhook'), '@webhook')
    assert.equal(cronSentinel('api'), '@api')
  })
})
