import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindCodeMsRemaining,
  formatBindExpiry,
  formatTelegramStartCommand,
  isBindCodeActive,
  maskTelegramChatId,
} from './arturitaTelegram.logic.ts'

describe('arturitaTelegram.logic', () => {
  const now = Date.parse('2026-08-27T12:00:00.000Z')

  it('formatTelegramStartCommand uppercases the bind code', () => {
    assert.equal(formatTelegramStartCommand(' abcd1234 '), '/start ABCD1234')
    assert.equal(formatTelegramStartCommand(''), '/start')
  })

  it('bindCodeMsRemaining and formatBindExpiry', () => {
    const exp = '2026-08-27T12:05:00.000Z'
    assert.equal(bindCodeMsRemaining(exp, now), 5 * 60 * 1000)
    assert.equal(formatBindExpiry(exp, now), '5 min left')
    assert.equal(formatBindExpiry(exp, now + 6 * 60 * 1000), 'Expired — generate a new code')
    assert.equal(isBindCodeActive(exp, now), true)
    assert.equal(isBindCodeActive(exp, now + 6 * 60 * 1000), false)
  })

  it('maskTelegramChatId hides all but the last four characters', () => {
    assert.equal(maskTelegramChatId('123456789'), '…6789')
    assert.equal(maskTelegramChatId(null), '—')
  })
})
