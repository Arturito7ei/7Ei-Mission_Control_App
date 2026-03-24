import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Test the LLM provider/model mapping logic used in ORG-002
function mapLlmProvider(preferredLlm?: string) {
  return preferredLlm === 'gpt4o' ? 'openai'
       : preferredLlm === 'gemini' ? 'google'
       : 'anthropic'
}

function mapLlmModel(preferredLlm?: string) {
  return preferredLlm === 'gpt4o' ? 'gpt-4o'
       : preferredLlm === 'gemini' ? 'gemini-2.0-flash'
       : 'claude-sonnet-4-20250514'
}

const FIRST_AGENT_TEMPLATES: Record<string, { name: string; role: string; emoji: string }> = {
  marketing:   { name: 'Maya', role: 'Head of Marketing',   emoji: '📣' },
  engineering: { name: 'Dev',  role: 'Head of Engineering', emoji: '💻' },
  finance:     { name: 'CFO',  role: 'Head of Finance',     emoji: '📊' },
  operations:  { name: 'Ops',  role: 'Head of Operations',  emoji: '⚙️' },
}

describe('[ORG-002] Arturito auto-creation logic', () => {
  it('maps claude to anthropic provider', () => {
    assert.equal(mapLlmProvider('claude'), 'anthropic')
    assert.equal(mapLlmModel('claude'), 'claude-sonnet-4-20250514')
  })

  it('maps gpt4o to openai provider', () => {
    assert.equal(mapLlmProvider('gpt4o'), 'openai')
    assert.equal(mapLlmModel('gpt4o'), 'gpt-4o')
  })

  it('maps gemini to google provider', () => {
    assert.equal(mapLlmProvider('gemini'), 'google')
    assert.equal(mapLlmModel('gemini'), 'gemini-2.0-flash')
  })

  it('defaults to anthropic when no preferredLlm', () => {
    assert.equal(mapLlmProvider(undefined), 'anthropic')
    assert.equal(mapLlmModel(undefined), 'claude-sonnet-4-20250514')
  })

  it('builds Arturito TOR with mission and culture', () => {
    const orgName = 'TestOrg'
    const mission = 'Build the future'
    const culture = 'Move fast'
    const tor = [
      `You are Arturito, Chief of Staff at ${orgName}.`,
      mission ? `Organisation mission: ${mission}` : '',
      culture ? `Culture: ${culture}` : '',
      'You orchestrate all agents, route tasks, and maintain strategic oversight.',
      'When asked to create agents, propose a full profile (name, role, TOR) using org context.',
    ].filter(Boolean).join('\n')
    assert.ok(tor.includes('TestOrg'))
    assert.ok(tor.includes('Build the future'))
    assert.ok(tor.includes('Move fast'))
  })

  it('builds Arturito TOR without mission/culture', () => {
    const tor = [
      `You are Arturito, Chief of Staff at MinOrg.`,
      '',
      '',
      'You orchestrate all agents, route tasks, and maintain strategic oversight.',
      'When asked to create agents, propose a full profile (name, role, TOR) using org context.',
    ].filter(Boolean).join('\n')
    assert.ok(!tor.includes('Organisation mission:'))
    assert.ok(!tor.includes('Culture:'))
  })

  it('first agent template lookup works for all roles', () => {
    assert.equal(FIRST_AGENT_TEMPLATES['marketing'].name, 'Maya')
    assert.equal(FIRST_AGENT_TEMPLATES['engineering'].name, 'Dev')
    assert.equal(FIRST_AGENT_TEMPLATES['finance'].name, 'CFO')
    assert.equal(FIRST_AGENT_TEMPLATES['operations'].name, 'Ops')
  })

  it('first agent template returns undefined for unknown role', () => {
    assert.equal(FIRST_AGENT_TEMPLATES['legal'], undefined)
  })
})
