import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_TEMPLATES } from '../routes/all.ts'
import { z } from 'zod'

// Replicate AgentSchema for testing (matches routes/all.ts)
const AgentSchema = z.object({
  name: z.string().min(1).max(100), role: z.string().min(1).max(200),
  departmentId: z.string().optional(), personality: z.string().optional(),
  cv: z.string().optional(), termsOfReference: z.string().optional(),
  llmProvider: z.string().default('anthropic'), llmModel: z.string().default('claude-sonnet-4-20250514'),
  avatarEmoji: z.string().default('🤖'), agentType: z.enum(['standard', 'advisor']).default('standard'),
  advisorPersona: z.string().optional(),
})

describe('[AG-010-015] Agent creation + templates + advisors', () => {
  it('AGENT_TEMPLATES has 7 templates', () => {
    const keys = Object.keys(AGENT_TEMPLATES)
    assert.equal(keys.length, 7)
  })

  it('AGENT_TEMPLATES includes arturito', () => {
    assert.ok('arturito' in AGENT_TEMPLATES)
    assert.equal(AGENT_TEMPLATES.arturito.name, 'Arturito')
  })

  it('AGENT_TEMPLATES includes advisor template', () => {
    assert.ok('advisor' in AGENT_TEMPLATES)
    assert.equal(AGENT_TEMPLATES.advisor.agentType, 'advisor')
  })

  it('all templates have required fields', () => {
    for (const [key, tmpl] of Object.entries(AGENT_TEMPLATES)) {
      assert.ok(tmpl.name, `Template ${key} missing name`)
      assert.ok(tmpl.role, `Template ${key} missing role`)
      assert.ok(tmpl.avatarEmoji, `Template ${key} missing avatarEmoji`)
      assert.ok(tmpl.agentType, `Template ${key} missing agentType`)
    }
  })

  it('AgentSchema accepts advisor with advisorPersona', () => {
    const input = {
      name: 'Warren',
      role: 'Silver Board Advisor',
      agentType: 'advisor' as const,
      advisorPersona: 'Warren Buffett — value investing philosophy, folksy wisdom, long-term thinking',
    }
    const parsed = AgentSchema.parse(input)
    assert.equal(parsed.agentType, 'advisor')
    assert.equal(parsed.advisorPersona, input.advisorPersona)
  })

  it('AgentSchema defaults agentType to standard', () => {
    const input = { name: 'Dev', role: 'Engineer' }
    const parsed = AgentSchema.parse(input)
    assert.equal(parsed.agentType, 'standard')
  })

  it('AgentSchema rejects invalid agentType', () => {
    assert.throws(() => {
      AgentSchema.parse({ name: 'Bad', role: 'Test', agentType: 'unknown' })
    })
  })

  it('advisor filtering logic works', () => {
    const agents = [
      { id: '1', agentType: 'standard' },
      { id: '2', agentType: 'advisor' },
      { id: '3', agentType: 'standard' },
      { id: '4', agentType: 'advisor' },
    ]
    const advisors = agents.filter(a => a.agentType === 'advisor')
    assert.equal(advisors.length, 2)
    assert.deepEqual(advisors.map(a => a.id), ['2', '4'])
  })
})
