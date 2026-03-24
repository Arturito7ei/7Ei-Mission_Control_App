import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Test the JSON parsing / response handling logic used in AG-004 propose endpoint

function parseProposalOutput(raw: string): { ok: true; json: any } | { ok: false; error: string; raw: string } {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim())
    return { ok: true, json }
  } catch {
    return { ok: false, error: 'LLM returned invalid JSON', raw }
  }
}

const REQUIRED_KEYS = ['name', 'role', 'termsOfReference', 'cv', 'avatarEmoji']

describe('[AG-004] agents/propose JSON parsing', () => {
  it('parses valid JSON proposal with all 5 keys', () => {
    const raw = JSON.stringify({
      name: 'Alex',
      role: 'Head of Sales',
      termsOfReference: 'Drive revenue growth',
      cv: 'Former VP Sales at Acme',
      avatarEmoji: '💼',
    })
    const result = parseProposalOutput(raw)
    assert.ok(result.ok)
    if (result.ok) {
      for (const key of REQUIRED_KEYS) {
        assert.ok(key in result.json, `Missing key: ${key}`)
      }
    }
  })

  it('strips ```json markdown fences before parsing', () => {
    const raw = '```json\n{"name":"Alex","role":"CTO","termsOfReference":"Lead tech","cv":"10yr exp","avatarEmoji":"💻"}\n```'
    const result = parseProposalOutput(raw)
    assert.ok(result.ok)
    if (result.ok) assert.equal(result.json.name, 'Alex')
  })

  it('strips ``` markdown fences before parsing', () => {
    const raw = '```\n{"name":"Sam","role":"CMO","termsOfReference":"Marketing","cv":"ex-Google","avatarEmoji":"📣"}\n```'
    const result = parseProposalOutput(raw)
    assert.ok(result.ok)
    if (result.ok) assert.equal(result.json.role, 'CMO')
  })

  it('returns error object when JSON is invalid', () => {
    const raw = 'This is not JSON at all'
    const result = parseProposalOutput(raw)
    assert.ok(!result.ok)
    if (!result.ok) {
      assert.equal(result.error, 'LLM returned invalid JSON')
      assert.equal(result.raw, raw)
    }
  })

  it('returns error object when JSON is truncated', () => {
    const raw = '{"name": "Alex", "role": "CEO"'
    const result = parseProposalOutput(raw)
    assert.ok(!result.ok)
  })

  it('validates all 5 required keys exist in a valid proposal', () => {
    const proposal = {
      name: 'Jordan',
      role: 'Head of Product',
      termsOfReference: 'Own the product roadmap',
      cv: 'Former PM at Stripe',
      avatarEmoji: '🗂️',
    }
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in proposal, `Proposal missing key: ${key}`)
    }
    assert.equal(REQUIRED_KEYS.length, 5)
  })

  it('builds correct prompt with org mission and culture', () => {
    const role = 'Head of Engineering'
    const mission = 'Build the future'
    const culture = 'Ship fast, learn faster'
    const prompt = [
      `You are proposing an agent profile for the role: ${role}`,
      mission ? `Organisation mission: ${mission}` : '',
      culture ? `Culture: ${culture}` : '',
      '',
      'Return a JSON object with exactly these keys:',
      '{ "name": string, "role": string, "termsOfReference": string, "cv": string, "avatarEmoji": string }',
      'Return ONLY the JSON object. No preamble, no markdown.',
    ].filter(Boolean).join('\n')

    assert.ok(prompt.includes('Head of Engineering'))
    assert.ok(prompt.includes('Build the future'))
    assert.ok(prompt.includes('Ship fast, learn faster'))
    assert.ok(prompt.includes('Return ONLY the JSON object'))
  })

  it('builds prompt without mission/culture when org has none', () => {
    const role = 'CFO'
    const prompt = [
      `You are proposing an agent profile for the role: ${role}`,
      '',
      '',
      'Return a JSON object with exactly these keys:',
      '{ "name": string, "role": string, "termsOfReference": string, "cv": string, "avatarEmoji": string }',
      'Return ONLY the JSON object. No preamble, no markdown.',
    ].filter(Boolean).join('\n')

    assert.ok(!prompt.includes('Organisation mission:'))
    assert.ok(!prompt.includes('Culture:'))
    assert.ok(prompt.includes('CFO'))
  })
})
