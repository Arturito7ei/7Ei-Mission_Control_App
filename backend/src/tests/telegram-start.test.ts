import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeBindCode,
  unlinkedStartMessage,
  bindCodeAcceptedMessage,
  bindCodeRejectedMessage,
} from '../services/telegram-start.ts'

describe('[CRIT-01] telegram /start linking policy', () => {
  it('normalizeBindCode uppercases and trims', () => {
    assert.equal(normalizeBindCode('  abcd1234  '), 'ABCD1234')
    assert.equal(normalizeBindCode(''), null)
    assert.equal(normalizeBindCode(undefined), null)
  })

  it('unlinkedStartMessage refuses auto-connect', () => {
    assert.match(unlinkedStartMessage(), /does not auto\\-connect/)
    assert.match(unlinkedStartMessage(), /Settings → \*Telegram\*/)
    assert.match(unlinkedStartMessage(), /\/start YOUR\\-CODE/)
  })

  it('bindCodeAcceptedMessage includes org name', () => {
    assert.match(bindCodeAcceptedMessage('Acme Corp'), /Acme Corp/)
  })

  it('bindCodeRejectedMessage escapes markdown hazards', () => {
    const msg = bindCodeRejectedMessage('invalid.code')
    assert.match(msg, /invalid\\.code/)
  })
})
