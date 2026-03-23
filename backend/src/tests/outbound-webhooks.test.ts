import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentWebhooks, stripAgentWebhooks } from '../services/outbound-webhooks'

describe('parseAgentWebhooks', () => {
  it('parses a single webhook tag', () => {
    const output = '[WEBHOOK: https://hooks.slack.com/test | {"text":"hello"}]'
    const calls = parseAgentWebhooks(output)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://hooks.slack.com/test')
    assert.deepEqual(calls[0].payload, { text: 'hello' })
  })

  it('parses multiple webhook tags', () => {
    const output = '[WEBHOOK: https://a.com | {"a":1}] text [WEBHOOK: https://b.com | {"b":2}]'
    const calls = parseAgentWebhooks(output)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'https://a.com')
    assert.equal(calls[1].url, 'https://b.com')
  })

  it('returns empty array for no tags', () => {
    const calls = parseAgentWebhooks('Normal response.')
    assert.deepEqual(calls, [])
  })

  it('handles invalid JSON gracefully', () => {
    const output = '[WEBHOOK: https://test.com | not valid json]'
    const calls = parseAgentWebhooks(output)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].payload.data, 'not valid json')
  })

  it('requires https:// URLs only', () => {
    const output = '[WEBHOOK: http://insecure.com | {}]'
    const calls = parseAgentWebhooks(output)
    assert.equal(calls.length, 0)
  })
})

describe('stripAgentWebhooks', () => {
  it('strips webhook tags', () => {
    const output = 'Task done! [WEBHOOK: https://a.com | {}] Report sent.'
    const cleaned = stripAgentWebhooks(output)
    assert.ok(!cleaned.includes('[WEBHOOK:'))
    assert.ok(cleaned.includes('Task done!'))
    assert.ok(cleaned.includes('Report sent.'))
  })
})
