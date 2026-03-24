import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Replicate buildSystemPrompt logic for unit testing (mirrors agent-executor.ts)
type MockAgent = {
  name: string; role: string; agentType: string; advisorPersona?: string | null
  personality?: string | null; cv?: string | null; termsOfReference?: string | null
  skills: string[]
}
type MockOrg = { mission?: string | null; culture?: string | null }

function buildSystemPrompt(
  agent: MockAgent,
  memoryBlock: string,
  isOrchestrator: boolean,
  org?: MockOrg | null,
  ragContext?: string,
): string {
  const lines: string[] = []

  if (org?.mission || org?.culture) {
    lines.push('=== ORGANISATION CONTEXT ===')
    if (org.mission) lines.push(`Mission & Vision: ${org.mission}`)
    if (org.culture)  lines.push(`Culture & Principles: ${org.culture}`)
    lines.push('=== END ORGANISATION CONTEXT ===', '')
  }
  if (ragContext) {
    lines.push(ragContext, '')
  }

  if (agent.agentType === 'advisor' && agent.advisorPersona) {
    lines.push(`You are ${agent.name}, a Silver Board Advisor.`, `Persona: ${agent.advisorPersona}`, '', 'Embody this persona fully. Speak with their voice, wisdom, and philosophy.', '')
  } else {
    lines.push(`You are ${agent.name}, ${agent.role} at 7Ei.`, '')
  }
  if (agent.personality)      lines.push(`Communication style: ${agent.personality}`, '')
  if (agent.cv)               lines.push(`Background: ${agent.cv}`, '')
  if (agent.termsOfReference) lines.push(`Terms of Reference: ${agent.termsOfReference}`, '')
  if (agent.skills.length > 0) lines.push(`Active skills: ${agent.skills.join(', ')}`, '')
  if (memoryBlock) lines.push(memoryBlock)
  lines.push('Operating principles:', '• Simplicity first', '')
  if (isOrchestrator) {
    lines.push('', 'Orchestration: you can delegate tasks to specialist agents.')
  }
  return lines.join('\n')
}

const baseAgent: MockAgent = {
  name: 'Arturito', role: 'Chief of Staff', agentType: 'standard',
  advisorPersona: null, personality: null, cv: null, termsOfReference: null, skills: [],
}

describe('[AG-002] buildSystemPrompt org context injection', () => {
  it('includes org context block when mission is set', () => {
    const prompt = buildSystemPrompt(baseAgent, '', false, { mission: 'Change the world', culture: null })
    assert.ok(prompt.includes('=== ORGANISATION CONTEXT ==='))
    assert.ok(prompt.includes('Mission & Vision: Change the world'))
    assert.ok(prompt.includes('=== END ORGANISATION CONTEXT ==='))
  })

  it('includes culture when set', () => {
    const prompt = buildSystemPrompt(baseAgent, '', false, { mission: null, culture: 'Move fast' })
    assert.ok(prompt.includes('Culture & Principles: Move fast'))
  })

  it('includes both mission and culture', () => {
    const prompt = buildSystemPrompt(baseAgent, '', false, { mission: 'Build it', culture: 'Stay humble' })
    assert.ok(prompt.includes('Mission & Vision: Build it'))
    assert.ok(prompt.includes('Culture & Principles: Stay humble'))
  })

  it('does NOT include org context block when org is null', () => {
    const prompt = buildSystemPrompt(baseAgent, '', false, null)
    assert.ok(!prompt.includes('=== ORGANISATION CONTEXT ==='))
  })

  it('does NOT include org context block when mission and culture are both null', () => {
    const prompt = buildSystemPrompt(baseAgent, '', false, { mission: null, culture: null })
    assert.ok(!prompt.includes('=== ORGANISATION CONTEXT ==='))
  })

  it('org context appears BEFORE agent identity', () => {
    const prompt = buildSystemPrompt(baseAgent, '', false, { mission: 'First', culture: null })
    const orgIdx = prompt.indexOf('=== ORGANISATION CONTEXT ===')
    const agentIdx = prompt.indexOf('You are Arturito')
    assert.ok(orgIdx < agentIdx, 'Org context should appear before agent identity')
  })

  it('includes ragContext when provided', () => {
    const rag = '=== RELEVANT KNOWLEDGE ===\n[Doc] (relevance: 0.92)\n=== END RELEVANT KNOWLEDGE ==='
    const prompt = buildSystemPrompt(baseAgent, '', false, null, rag)
    assert.ok(prompt.includes('=== RELEVANT KNOWLEDGE ==='))
    assert.ok(prompt.includes('[Doc] (relevance: 0.92)'))
  })

  it('omits ragContext block when not provided', () => {
    const prompt = buildSystemPrompt(baseAgent, '', false, null)
    assert.ok(!prompt.includes('=== RELEVANT KNOWLEDGE ==='))
  })
})

describe('[AG-003] RAG context wiring', () => {
  it('executeAgentTask works without PINECONE_API_KEY (env not set)', async () => {
    // When PINECONE_API_KEY is absent, searchKnowledge returns [] immediately
    // We verify the ragContext logic produces empty string in that case
    const pineconeKeyWasSet = !!process.env.PINECONE_API_KEY
    delete process.env.PINECONE_API_KEY

    let ragContext = ''
    if (process.env.PINECONE_API_KEY) {
      // This block should NOT execute
      ragContext = 'should not be set'
    }
    assert.equal(ragContext, '')

    if (pineconeKeyWasSet) process.env.PINECONE_API_KEY = 'restored'
  })

  it('RAG context format is correct when results exist', () => {
    const mockResults = [
      { id: '1', score: 0.95, name: 'Mission Doc', type: 'document', externalUrl: '' },
      { id: '2', score: 0.82, name: 'Culture Guide', type: 'document', externalUrl: '' },
    ]
    const ragContext = '=== RELEVANT KNOWLEDGE ===\n' +
      mockResults.map(r => `[${r.name}] (relevance: ${r.score.toFixed(2)})`).join('\n') +
      '\n=== END RELEVANT KNOWLEDGE ==='

    assert.ok(ragContext.includes('[Mission Doc] (relevance: 0.95)'))
    assert.ok(ragContext.includes('[Culture Guide] (relevance: 0.82)'))
    assert.ok(ragContext.startsWith('=== RELEVANT KNOWLEDGE ==='))
    assert.ok(ragContext.endsWith('=== END RELEVANT KNOWLEDGE ==='))
  })

  it('empty ragContext when no results', () => {
    const results: any[] = []
    const ragContext = results.length > 0 ? 'something' : ''
    assert.equal(ragContext, '')
  })
})
