import { test } from 'node:test'
import assert from 'node:assert/strict'

// Replicate logic locally (mirrors orchestrator.ts + agent-executor.ts)

// Replicate parseDelegateDirectives from orchestrator.ts
function parseDelegateDirectives(output: string): Array<{ targetName: string; task: string }> {
  const directives: Array<{ targetName: string; task: string }> = []
  const pattern = /\[DELEGATE:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]/gi
  let match
  while ((match = pattern.exec(output)) !== null) {
    const targetName = match[1].trim()
    const task       = match[2].trim()
    if (targetName && task) directives.push({ targetName, task })
  }
  return directives
}

// Replicate buildSystemPrompt with availableAgents (mirrors agent-executor.ts)
type MockAgent = {
  name: string; role: string; agentType: string; advisorPersona?: string | null
  personality?: string | null; cv?: string | null; termsOfReference?: string | null
  skills: string[]
}

function buildSystemPrompt(
  agent: MockAgent,
  memoryBlock: string,
  isOrchestrator: boolean,
  org?: { mission?: string | null; culture?: string | null } | null,
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
  lines.push(`You are ${agent.name}, ${agent.role} at 7Ei.`, '')
  if (memoryBlock) lines.push(memoryBlock)
  lines.push('Operating principles:', '• Simplicity first', '')
  if (isOrchestrator) {
    if (availableAgents && availableAgents.length > 0) {
      lines.push('', 'Available agents you can delegate to:')
      availableAgents.forEach(a => lines.push(`• ${a.name} — ${a.role}`))
    }
    lines.push(
      '',
      'Orchestration: include [DELEGATE: AgentName | task description] in your response.',
      'Example: [DELEGATE: Dev | Write a TypeScript function to validate email addresses]',
    )
  }
  return lines.join('\n')
}

const arturito: MockAgent = {
  name: 'Arturito', role: 'Chief of Staff & Agent Orchestrator', agentType: 'standard',
  advisorPersona: null, personality: null, cv: null, termsOfReference: null, skills: [],
}

test('[ROUTE-001] buildSystemPrompt includes available agents for orchestrator', () => {
  const availableAgents = [
    { name: 'Dev', role: 'Head of Development' },
    { name: 'Maya', role: 'Head of Marketing' },
  ]
  const prompt = buildSystemPrompt(arturito, '', true, null, '', '', availableAgents)
  assert.ok(prompt.includes('Dev'), 'prompt should include Dev agent name')
  assert.ok(prompt.includes('Head of Development'), 'prompt should include Dev role')
  assert.ok(prompt.includes('Maya'), 'prompt should include Maya agent name')
  assert.ok(prompt.includes('Available agents you can delegate to'), 'should have delegate header')
})

test('[ROUTE-001] buildSystemPrompt with empty availableAgents still works', () => {
  const prompt = buildSystemPrompt(arturito, '', true, null, '', '', [])
  assert.ok(typeof prompt === 'string')
  assert.ok(prompt.includes('Orchestration'), 'should still include orchestration instructions')
  assert.ok(!prompt.includes('Available agents you can delegate to'), 'no agent list when empty')
})

test('[ROUTE-001] parseDelegateDirectives handles multiple delegates', () => {
  const input = '[DELEGATE: Dev | Write code] and [DELEGATE: Maya | Write copy]'
  const dirs = parseDelegateDirectives(input)
  assert.strictEqual(dirs.length, 2)
  assert.strictEqual(dirs[0].targetName, 'Dev')
  assert.strictEqual(dirs[1].targetName, 'Maya')
})

test('[ROUTE-001] orchestrator prompt lists each agent on separate line', () => {
  const availableAgents = [
    { name: 'Dev', role: 'Head of Development' },
    { name: 'CFO', role: 'Head of Finance' },
  ]
  const prompt = buildSystemPrompt(arturito, '', true, null, '', '', availableAgents)
  assert.ok(prompt.includes('• Dev — Head of Development'))
  assert.ok(prompt.includes('• CFO — Head of Finance'))
})

test('[ROUTE-001] orchestrator prompt does not list agents without availableAgents', () => {
  const prompt = buildSystemPrompt(arturito, '', true, null, '', '')
  assert.ok(!prompt.includes('Available agents you can delegate to'))
  assert.ok(prompt.includes('[DELEGATE:'))
})

test('[ROUTE-001] parseDelegateDirectives returns empty for no directives', () => {
  const dirs = parseDelegateDirectives('Normal response without delegation.')
  assert.strictEqual(dirs.length, 0)
})
