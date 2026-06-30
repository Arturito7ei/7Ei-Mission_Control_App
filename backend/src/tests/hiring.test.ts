import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildHirePrompt, parseHireProposal } from '../services/hiring.ts'

describe('[MCA-PC A2] buildHirePrompt', () => {
  it('includes mission, roster ids, and the request', () => {
    const { system, user } = buildHirePrompt(
      'a growth marketer',
      { mission: 'Win the market', culture: 'sovereign' },
      [{ id: 'ceo1', name: 'Arturito', role: 'CEO', title: 'CEO' }],
    )
    assert.match(system, /JSON object/)
    assert.match(user, /Win the market/)
    assert.match(user, /id=ceo1/)
    assert.match(user, /a growth marketer/)
  })
  it('handles an empty roster', () => {
    const { user } = buildHirePrompt('first hire', null, [])
    assert.match(user, /no agents yet/)
  })
})

describe('[MCA-PC A2] parseHireProposal', () => {
  it('parses fenced JSON and keeps fields', () => {
    const raw = '```json\n' + JSON.stringify({
      name: 'Maya', title: 'Head of Marketing', role: 'Marketing', jobDescription: 'Grow.',
      avatarEmoji: '📣', llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514',
      skills: ['seo', 'content'], runtime: 'internal', reportsTo: 'ceo1', termsOfReference: 'ToR',
    }) + '\n```'
    const p = parseHireProposal(raw)
    assert.equal(p.name, 'Maya')
    assert.equal(p.runtime, 'internal')
    assert.deepEqual(p.skills, ['seo', 'content'])
    assert.equal(p.reportsTo, 'ceo1')
  })
  it('applies safe defaults on junk', () => {
    const p = parseHireProposal('not json at all')
    assert.equal(p.name, 'New Agent')
    assert.equal(p.runtime, 'internal')
    assert.equal(p.avatarEmoji, '🤖')
    assert.equal(p.llmProvider, 'anthropic')
    assert.deepEqual(p.skills, [])
    assert.equal(p.reportsTo, null)
  })
  it('coerces an invalid runtime to internal', () => {
    assert.equal(parseHireProposal('{"runtime":"k8s"}').runtime, 'internal')
  })
  it('defaults openclaw runtime to minimax model', () => {
    const p = parseHireProposal('{"runtime":"openclaw","name":"Claw"}')
    assert.equal(p.runtime, 'openclaw')
    assert.equal(p.llmProvider, 'minimax')
    assert.equal(p.llmModel, 'MiniMax-Text-01')
  })
})
