import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDelegateDirectives, stripDelegateDirectives } from '../services/orchestrator'

describe('parseDelegateDirectives', () => {
  it('parses a single DELEGATE tag', () => {
    const output = 'Let me route this. [DELEGATE: Dev | Build a login form in React]'
    const dirs = parseDelegateDirectives(output)
    assert.equal(dirs.length, 1)
    assert.equal(dirs[0].targetName, 'Dev')
    assert.equal(dirs[0].task, 'Build a login form in React')
  })

  it('parses multiple DELEGATE tags', () => {
    const output = '[DELEGATE: Dev | Write the API] [DELEGATE: Maya | Draft the announcement]'
    const dirs = parseDelegateDirectives(output)
    assert.equal(dirs.length, 2)
    assert.equal(dirs[0].targetName, 'Dev')
    assert.equal(dirs[1].targetName, 'Maya')
  })

  it('returns empty array when no tags', () => {
    const output = 'Normal response without any delegation.'
    const dirs = parseDelegateDirectives(output)
    assert.deepEqual(dirs, [])
  })

  it('is case-insensitive', () => {
    const output = '[delegate: Finance | Prepare Q3 budget]'
    const dirs = parseDelegateDirectives(output)
    assert.equal(dirs.length, 1)
    assert.equal(dirs[0].targetName, 'Finance')
  })

  it('handles extra whitespace gracefully', () => {
    const output = '[DELEGATE:  Dev Agent  |  Fix the bug in auth module  ]'
    const dirs = parseDelegateDirectives(output)
    assert.equal(dirs[0].targetName, 'Dev Agent')
    assert.equal(dirs[0].task, 'Fix the bug in auth module')
  })
})

describe('stripDelegateDirectives', () => {
  it('removes DELEGATE tags from output', () => {
    const output = 'I will coordinate this. [DELEGATE: Dev | Build it] [DELEGATE: Maya | Market it]'
    const cleaned = stripDelegateDirectives(output)
    assert.ok(!cleaned.includes('[DELEGATE:'))
    assert.ok(cleaned.includes('I will coordinate this.'))
  })

  it('does not strip regular text', () => {
    const output = 'Plain response with no tags.'
    const cleaned = stripDelegateDirectives(output)
    assert.equal(cleaned, output)
  })

  it('collapses extra blank lines after stripping', () => {
    const output = 'Before\n\n[DELEGATE: Dev | task]\n\n\n\nAfter'
    const cleaned = stripDelegateDirectives(output)
    assert.ok(!cleaned.includes('\n\n\n'))
  })
})
