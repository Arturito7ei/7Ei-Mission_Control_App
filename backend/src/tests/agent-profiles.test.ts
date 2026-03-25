import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

// Replicate PatchSchema for unit testing (mirrors routes/all.ts PATCH /api/agents/:agentId)
const PatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.string().min(1).max(200).optional(),
  persona: z.string().optional(),
  expertise: z.string().optional(),
  termsOfReference: z.string().optional(),
  cv: z.string().optional(),
  avatarEmoji: z.string().optional(),
  advisorIds: z.array(z.string()).optional(),
})

// Replicate buildSystemPrompt persona/expertise injection logic (mirrors agent-executor.ts)
function buildSystemPromptPersonaExpertise(agent: { persona?: string | null; expertise?: string | null }, lines: string[]): string[] {
  if (agent.persona) lines.push('\nYOUR PERSONALITY AND STYLE:\n' + agent.persona)
  if (agent.expertise) lines.push('\nYOUR AREAS OF EXPERTISE:\n' + agent.expertise)
  return lines
}

describe('[AGENT-002] PATCH /api/agents/:agentId schema validation', () => {
  it('accepts all optional fields', () => {
    const parsed = PatchSchema.parse({
      name: 'Updated',
      role: 'Lead Engineer',
      persona: 'Pragmatic and direct',
      expertise: 'TypeScript, distributed systems',
      termsOfReference: 'Focus on backend reliability',
      cv: 'MSc CS, 10 years experience',
      avatarEmoji: '👨‍💻',
      advisorIds: ['advisor-1', 'advisor-2'],
    })
    assert.equal(parsed.name, 'Updated')
    assert.equal(parsed.persona, 'Pragmatic and direct')
    assert.deepEqual(parsed.advisorIds, ['advisor-1', 'advisor-2'])
  })

  it('accepts empty body (all fields optional)', () => {
    const parsed = PatchSchema.parse({})
    assert.equal(parsed.name, undefined)
    assert.equal(parsed.advisorIds, undefined)
  })

  it('rejects name that is empty string', () => {
    assert.throws(() => PatchSchema.parse({ name: '' }))
  })

  it('rejects name over 100 chars', () => {
    assert.throws(() => PatchSchema.parse({ name: 'a'.repeat(101) }))
  })

  it('rejects advisorIds that is not an array', () => {
    assert.throws(() => PatchSchema.parse({ advisorIds: 'not-an-array' }))
  })

  it('advisorIds validation — rejects ID from different org', () => {
    const agents = [
      { id: 'advisor-1', orgId: 'org-1' },
      { id: 'advisor-2', orgId: 'org-2' },  // different org
    ]
    const requestedIds = ['advisor-1', 'advisor-2']
    const agentOrgId = 'org-1'
    const invalid = requestedIds.filter(id => {
      const found = agents.find(a => a.id === id)
      return !found || found.orgId !== agentOrgId
    })
    assert.deepEqual(invalid, ['advisor-2'])
  })

  it('advisorIds validation — accepts IDs from same org', () => {
    const agents = [
      { id: 'advisor-1', orgId: 'org-1' },
      { id: 'advisor-2', orgId: 'org-1' },
    ]
    const requestedIds = ['advisor-1', 'advisor-2']
    const agentOrgId = 'org-1'
    const invalid = requestedIds.filter(id => {
      const found = agents.find(a => a.id === id)
      return !found || found.orgId !== agentOrgId
    })
    assert.equal(invalid.length, 0)
  })

  it('updates object excludes advisorIds and serialises it separately', () => {
    const { advisorIds, ...rest } = PatchSchema.parse({
      name: 'Dev',
      advisorIds: ['a1'],
    })
    const updates: Record<string, any> = { ...rest }
    if (advisorIds !== undefined) updates.advisorIds = JSON.stringify(advisorIds)
    assert.equal(updates.name, 'Dev')
    assert.equal(updates.advisorIds, '["a1"]')
  })
})

describe('[AGENT-004] buildSystemPrompt persona + expertise injection', () => {
  it('includes persona in prompt when set', () => {
    const lines: string[] = []
    buildSystemPromptPersonaExpertise({ persona: 'Pragmatic, concise, no fluff' }, lines)
    const prompt = lines.join('\n')
    assert.ok(prompt.includes('YOUR PERSONALITY AND STYLE:'))
    assert.ok(prompt.includes('Pragmatic, concise, no fluff'))
  })

  it('includes expertise in prompt when set', () => {
    const lines: string[] = []
    buildSystemPromptPersonaExpertise({ expertise: 'TypeScript, distributed systems' }, lines)
    const prompt = lines.join('\n')
    assert.ok(prompt.includes('YOUR AREAS OF EXPERTISE:'))
    assert.ok(prompt.includes('TypeScript, distributed systems'))
  })

  it('includes both persona and expertise when both set', () => {
    const lines: string[] = []
    buildSystemPromptPersonaExpertise({ persona: 'Direct and bold', expertise: 'ML, Python' }, lines)
    const prompt = lines.join('\n')
    assert.ok(prompt.includes('YOUR PERSONALITY AND STYLE:'))
    assert.ok(prompt.includes('YOUR AREAS OF EXPERTISE:'))
  })

  it('omits persona block when persona is null', () => {
    const lines: string[] = []
    buildSystemPromptPersonaExpertise({ persona: null, expertise: 'Go' }, lines)
    const prompt = lines.join('\n')
    assert.ok(!prompt.includes('YOUR PERSONALITY AND STYLE:'))
    assert.ok(prompt.includes('YOUR AREAS OF EXPERTISE:'))
  })

  it('omits expertise block when expertise is null', () => {
    const lines: string[] = []
    buildSystemPromptPersonaExpertise({ persona: 'Bold', expertise: null }, lines)
    const prompt = lines.join('\n')
    assert.ok(prompt.includes('YOUR PERSONALITY AND STYLE:'))
    assert.ok(!prompt.includes('YOUR AREAS OF EXPERTISE:'))
  })

  it('adds nothing when both are null', () => {
    const lines: string[] = []
    buildSystemPromptPersonaExpertise({ persona: null, expertise: null }, lines)
    assert.equal(lines.length, 0)
  })

  it('persona appears after org context when stacked', () => {
    const lines: string[] = ['=== ORGANISATION CONTEXT ===', 'Mission: Transform finance', '=== END ORGANISATION CONTEXT ===', '']
    buildSystemPromptPersonaExpertise({ persona: 'Bold thinker', expertise: null }, lines)
    const prompt = lines.join('\n')
    const personaIdx = prompt.indexOf('YOUR PERSONALITY AND STYLE:')
    const orgIdx = prompt.indexOf('ORGANISATION CONTEXT')
    assert.ok(orgIdx < personaIdx, 'persona should appear after org context')
  })
})
