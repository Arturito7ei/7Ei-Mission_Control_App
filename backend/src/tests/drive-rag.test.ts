import { test } from 'node:test'
import assert from 'node:assert/strict'

// Replicate buildSystemPrompt logic with driveContext support (mirrors agent-executor.ts)
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
  driveContext?: string,
  availableAgents?: Array<{ name: string; role: string }>,
): string {
  const lines: string[] = []
  if (org?.mission || org?.culture) {
    lines.push('=== ORGANISATION CONTEXT ===')
    if (org.mission) lines.push(`Mission & Vision: ${org.mission}`)
    if (org.culture)  lines.push(`Culture & Principles: ${org.culture}`)
    lines.push('=== END ORGANISATION CONTEXT ===', '')
  }
  if (ragContext) lines.push(ragContext, '')
  if (driveContext) lines.push(driveContext, '')
  if (agent.agentType === 'advisor' && agent.advisorPersona) {
    lines.push(`You are ${agent.name}, a Silver Board Advisor.`, `Persona: ${agent.advisorPersona}`, '')
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
    if (availableAgents && availableAgents.length > 0) {
      lines.push('', 'Available agents you can delegate to:')
      availableAgents.forEach(a => lines.push(`• ${a.name} — ${a.role}`))
    }
    lines.push('', 'Orchestration: include [DELEGATE: AgentName | task description] in your response.')
  }
  return lines.join('\n')
}

const baseAgent: MockAgent = {
  name: 'Arturito', role: 'Chief of Staff', agentType: 'standard',
  advisorPersona: null, personality: null, cv: null, termsOfReference: null, skills: [],
}

test('[DRIVE-002] buildSystemPrompt works without driveContext', () => {
  const prompt = buildSystemPrompt(baseAgent, '', false, null, '')
  assert.ok(typeof prompt === 'string', 'prompt should be a string')
  assert.ok(!prompt.includes('GOOGLE DRIVE'), 'should not include Drive block when not provided')
})

test('[DRIVE-002] buildSystemPrompt includes driveContext when provided', () => {
  const driveContext = '=== GOOGLE DRIVE DOCUMENTS ===\n[Strategy.md]: # Q1 Goals\n=== END DRIVE DOCS ==='
  const prompt = buildSystemPrompt(baseAgent, '', false, null, '', driveContext)
  assert.ok(prompt.includes('GOOGLE DRIVE DOCUMENTS'), 'should include drive context header')
  assert.ok(prompt.includes('Strategy.md'), 'should include drive file name')
  assert.ok(prompt.includes('Q1 Goals'), 'should include drive file content')
})

test('[DRIVE-002] buildSystemPrompt places driveContext after ragContext', () => {
  const ragContext = '=== RELEVANT KNOWLEDGE ===\n[KB item]\n=== END RELEVANT KNOWLEDGE ==='
  const driveContext = '=== GOOGLE DRIVE DOCUMENTS ===\n[file]\n=== END DRIVE DOCS ==='
  const prompt = buildSystemPrompt(baseAgent, '', false, null, ragContext, driveContext)
  const ragPos = prompt.indexOf('RELEVANT KNOWLEDGE')
  const drivePos = prompt.indexOf('GOOGLE DRIVE DOCUMENTS')
  assert.ok(ragPos < drivePos, 'RAG context should appear before Drive context')
})

test('[DRIVE-002] buildSystemPrompt works with all params including org context', () => {
  const org = { mission: 'Build AI', culture: 'Swiss precision' }
  const prompt = buildSystemPrompt(baseAgent, 'memory: key=val', true, org, 'rag context', 'drive context')
  assert.ok(prompt.includes('Build AI'), 'should include mission')
  assert.ok(prompt.includes('Swiss precision'), 'should include culture')
  assert.ok(prompt.includes('drive context'), 'should include drive context')
  assert.ok(prompt.includes('Orchestration'), 'should include orchestration instructions for orchestrator')
})
