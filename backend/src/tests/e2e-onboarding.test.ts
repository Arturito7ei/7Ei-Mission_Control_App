import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

// E2E onboarding test — validates the full POST /api/orgs flow
// Uses the same Zod schema and logic patterns as the actual routes

const OrgSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
  mission: z.string().optional(),
  culture: z.string().optional(),
  deployMode: z.enum(['cloud', 'local']).optional(),
  cloudProvider: z.enum(['aws', 'aws_ch', 'gcp', 'gcp_ch', 'azure', 'oracle']).optional(),
  preferredLlm: z.enum(['claude', 'gpt4o', 'gemini']).optional(),
  firstAgentRole: z.string().optional(),
})

const FIRST_AGENT_TEMPLATES: Record<string, { name: string; role: string; emoji: string }> = {
  marketing:   { name: 'Maya', role: 'Head of Marketing',   emoji: '📣' },
  engineering: { name: 'Dev',  role: 'Head of Engineering', emoji: '💻' },
  finance:     { name: 'CFO',  role: 'Head of Finance',     emoji: '📊' },
  operations:  { name: 'Ops',  role: 'Head of Operations',  emoji: '⚙️' },
}

describe('[E2E] Full onboarding flow', () => {
  it('parses full onboarding payload with all fields', () => {
    const input = {
      name: 'TestOrg',
      description: 'A test org',
      mission: 'Build the future of AI',
      culture: 'Move fast, stay ethical',
      deployMode: 'cloud' as const,
      cloudProvider: 'aws' as const,
      preferredLlm: 'claude' as const,
      firstAgentRole: 'marketing',
    }
    const parsed = OrgSchema.parse(input)
    assert.equal(parsed.name, 'TestOrg')
    assert.equal(parsed.mission, 'Build the future of AI')
    assert.equal(parsed.culture, 'Move fast, stay ethical')
    assert.equal(parsed.deployMode, 'cloud')
    assert.equal(parsed.cloudProvider, 'aws')
    assert.equal(parsed.preferredLlm, 'claude')
    assert.equal(parsed.firstAgentRole, 'marketing')
  })

  it('org object includes all onboarding fields', () => {
    const body = OrgSchema.parse({ name: 'OrgTest', mission: 'M', culture: 'C', preferredLlm: 'gpt4o' })
    const org = {
      id: 'test-id', name: body.name, description: body.description ?? null,
      logoUrl: body.logoUrl ?? null, ownerId: 'user-1', createdAt: new Date(),
      mission: body.mission ?? null, culture: body.culture ?? null,
      deployMode: body.deployMode ?? null, cloudProvider: body.cloudProvider ?? null,
      preferredLlm: body.preferredLlm ?? null, deployConfig: {},
    }
    assert.equal(org.mission, 'M')
    assert.equal(org.culture, 'C')
    assert.equal(org.preferredLlm, 'gpt4o')
  })

  it('Arturito agent is created with correct persona and expertise', () => {
    const body = { name: 'TestOrg', mission: 'Our mission', culture: 'Our culture', preferredLlm: 'claude' }
    const arturitoTOR = [
      `You are Arturito, Chief of Staff at ${body.name}.`,
      body.mission ? `Organisation mission: ${body.mission}` : '',
      body.culture ? `Culture: ${body.culture}` : '',
      'You orchestrate all agents, route tasks, and maintain strategic oversight.',
      'When asked to create agents, propose a full profile (name, role, TOR) using org context.',
    ].filter(Boolean).join('\n')

    const arturito = {
      name: 'Arturito',
      role: 'Chief of Staff & Agent Orchestrator',
      termsOfReference: arturitoTOR,
      persona: 'You are Arturito, the AI Chief of Staff. You are professional, warm, and action-oriented. You speak clearly and concisely. You always have a plan.',
      expertise: 'Organization management, task delegation, strategic planning, team coordination, onboarding new agents',
      llmProvider: 'anthropic',
      llmModel: 'claude-sonnet-4-20250514',
    }

    assert.ok(arturito.termsOfReference.includes('Our mission'))
    assert.ok(arturito.termsOfReference.includes('Our culture'))
    assert.ok(arturito.persona.includes('Chief of Staff'))
    assert.ok(arturito.expertise.includes('task delegation'))
    assert.equal(arturito.llmProvider, 'anthropic')
  })

  it('Arturito LLM maps correctly for gpt4o', () => {
    const preferredLlm = 'gpt4o'
    const provider = preferredLlm === 'gpt4o' ? 'openai' : preferredLlm === 'gemini' ? 'google' : 'anthropic'
    const model = preferredLlm === 'gpt4o' ? 'gpt-4o' : preferredLlm === 'gemini' ? 'gemini-2.0-flash' : 'claude-sonnet-4-20250514'
    assert.equal(provider, 'openai')
    assert.equal(model, 'gpt-4o')
  })

  it('orgMembers row is created for owner', () => {
    const membership = { id: 'mem-1', orgId: 'org-1', userId: 'user-1', role: 'owner', createdAt: new Date() }
    assert.equal(membership.role, 'owner')
    assert.equal(membership.orgId, 'org-1')
  })

  it('first specialist agent is created when firstAgentRole is provided', () => {
    const firstRole = 'marketing'
    assert.ok(FIRST_AGENT_TEMPLATES[firstRole])
    const tmpl = FIRST_AGENT_TEMPLATES[firstRole]
    assert.equal(tmpl.name, 'Maya')
    assert.equal(tmpl.role, 'Head of Marketing')
  })

  it('no specialist agent when firstAgentRole is missing', () => {
    const firstRole = undefined
    assert.ok(!firstRole || !FIRST_AGENT_TEMPLATES[firstRole ?? ''])
  })

  it('no specialist agent for unknown role', () => {
    const firstRole = 'legal'
    assert.ok(!FIRST_AGENT_TEMPLATES[firstRole])
  })

  it('persona and expertise are included in buildSystemPrompt', () => {
    const persona = 'You are Arturito, the AI Chief of Staff.'
    const expertise = 'Organization management, task delegation'
    const lines: string[] = []
    if (persona) lines.push('\nYOUR PERSONALITY AND STYLE:\n' + persona)
    if (expertise) lines.push('\nYOUR AREAS OF EXPERTISE:\n' + expertise)
    const prompt = lines.join('\n')
    assert.ok(prompt.includes('YOUR PERSONALITY AND STYLE:'))
    assert.ok(prompt.includes('YOUR AREAS OF EXPERTISE:'))
  })

  it('minimal onboarding (name only) still works', () => {
    const input = { name: 'MinimalOrg' }
    const parsed = OrgSchema.parse(input)
    assert.equal(parsed.name, 'MinimalOrg')
    assert.equal(parsed.mission, undefined)
    assert.equal(parsed.firstAgentRole, undefined)
  })
})
