import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calcNextRun, matchCronField } from '../services/scheduler'

// Note: run with: node --test (Node 20+)
// Or: npx tsx --test src/tests/scheduler.test.ts

describe('calcNextRun', () => {
  it('should return a future date', () => {
    const next = calcNextRun('* * * * *')
    assert.ok(next > new Date(), 'Next run should be in the future')
  })

  it('every minute returns ~1 min ahead', () => {
    const next = calcNextRun('* * * * *')
    const diffMs = next.getTime() - Date.now()
    assert.ok(diffMs < 120_000, 'Should be within 2 minutes')
    assert.ok(diffMs > 0, 'Should be positive')
  })

  it('handles daily 9am cron', () => {
    const next = calcNextRun('0 9 * * *')
    assert.equal(next.getMinutes(), 0)
    assert.equal(next.getHours(), 9)
    assert.ok(next > new Date())
  })

  it('handles step expression */30', () => {
    const next = calcNextRun('*/30 * * * *')
    const mins = next.getMinutes()
    assert.ok(mins === 0 || mins === 30, `Minutes should be 0 or 30, got ${mins}`)
  })

  it('handles weekdays only 1-5', () => {
    const next = calcNextRun('0 8 * * 1-5')
    const dow = next.getDay()
    assert.ok(dow >= 1 && dow <= 5, `Should be weekday, got day ${dow}`)
    assert.equal(next.getHours(), 8)
  })

  it('handles comma list', () => {
    const next = calcNextRun('0,30 * * * *')
    const mins = next.getMinutes()
    assert.ok(mins === 0 || mins === 30, `Expected 0 or 30, got ${mins}`)
  })

  it('returns future date for invalid cron', () => {
    const next = calcNextRun('invalid')
    assert.ok(next > new Date())
  })
})

describe('matchCronField', () => {
  it('* matches anything', () => {
    assert.ok(matchCronField('*', 0, 0, 59))
    assert.ok(matchCronField('*', 30, 0, 59))
    assert.ok(matchCronField('*', 59, 0, 59))
  })

  it('exact value matches', () => {
    assert.ok(matchCronField('5', 5, 0, 59))
    assert.ok(!matchCronField('5', 6, 0, 59))
  })

  it('range matches', () => {
    assert.ok(matchCronField('1-5', 3, 0, 6))
    assert.ok(!matchCronField('1-5', 6, 0, 6))
  })

  it('step */n matches multiples', () => {
    assert.ok(matchCronField('*/15', 0, 0, 59))
    assert.ok(matchCronField('*/15', 15, 0, 59))
    assert.ok(matchCronField('*/15', 30, 0, 59))
    assert.ok(!matchCronField('*/15', 7, 0, 59))
  })

  it('comma list matches any in list', () => {
    assert.ok(matchCronField('0,30', 0, 0, 59))
    assert.ok(matchCronField('0,30', 30, 0, 59))
    assert.ok(!matchCronField('0,30', 15, 0, 59))
  })

  it('range with step', () => {
    assert.ok(matchCronField('0-30/10', 0, 0, 59))
    assert.ok(matchCronField('0-30/10', 10, 0, 59))
    assert.ok(matchCronField('0-30/10', 20, 0, 59))
    assert.ok(!matchCronField('0-30/10', 5, 0, 59))
    assert.ok(!matchCronField('0-30/10', 40, 0, 59))
  })
})
