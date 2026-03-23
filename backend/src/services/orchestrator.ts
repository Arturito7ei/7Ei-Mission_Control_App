// ─── Agent Orchestration Protocol ─────────────────────────────────────────────────────
// Arturito (or any orchestrator agent) can delegate tasks to other agents.
// Protocol:
//   1. User sends message to Arturito
//   2. Arturito includes [DELEGATE: agentName | task description] in its response
//   3. Orchestrator parses the directive, finds the target agent, creates a sub-task
//   4. Sub-task runs asynchronously, result posted back as a follow-up message
//   5. Arturito synthesises results into a final response

import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { executeAgentTask } from './agent-executor'

export interface DelegateDirective {
  targetName: string    // Agent name or role keyword
  task: string          // Task description to send
}

export interface OrchestrationResult {
  agentId: string
  agentName: string
  output: string
  taskId: string
}

// Parse [DELEGATE: agentName | task] tags from orchestrator output
export function parseDelegateDirectives(output: string): DelegateDirective[] {
  const directives: DelegateDirective[] = []
  const pattern = /\[DELEGATE:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]/gi
  let match
  while ((match = pattern.exec(output)) !== null) {
    const targetName = match[1].trim()
    const task       = match[2].trim()
    if (targetName && task) directives.push({ targetName, task })
  }
  return directives
}

// Strip [DELEGATE:...] tags from visible output
export function stripDelegateDirectives(output: string): string {
  return output.replace(/\[DELEGATE:\s*[^\]]+\]/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

// Resolve agent by name or role keyword within an org
async function resolveAgent(orgId: string, nameOrRole: string): Promise<typeof schema.agents.$inferSelect | null> {
  const agents = await db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId))
  const lower = nameOrRole.toLowerCase()

  // Exact name match first
  const exact = agents.find(a => a.name.toLowerCase() === lower)
  if (exact) return exact

  // Role keyword match (e.g. "dev", "marketing", "finance")
  const byRole = agents.find(a =>
    a.role.toLowerCase().includes(lower) ||
    a.name.toLowerCase().includes(lower)
  )
  return byRole ?? null
}

// Execute all delegate directives from an orchestrator response
export async function executeDelegations(
  orgId: string,
  orchestratorAgentId: string,
  directives: DelegateDirective[],
  parentTaskId?: string,
): Promise<OrchestrationResult[]> {
  const results: OrchestrationResult[] = []

  await Promise.allSettled(
    directives.map(async (directive) => {
      const agent = await resolveAgent(orgId, directive.targetName)
      if (!agent) {
        console.warn(`Orchestrator: could not find agent '${directive.targetName}' in org ${orgId}`)
        return
      }

      const taskId = randomUUID()
      await db.insert(schema.tasks).values({
        id: taskId,
        orgId,
        agentId: agent.id,
        title: directive.task.slice(0, 120),
        input: directive.task,
        status: 'pending',
        priority: 'medium',
        createdAt: new Date(),
      })

      // Store delegation context as a user message
      await db.insert(schema.messages).values({
        id: randomUUID(),
        agentId: agent.id,
        taskId,
        role: 'user',
        content: `[Delegated by orchestrator]: ${directive.task}`,
        createdAt: new Date(),
      })

      const result = await executeAgentTask({ agentId: agent.id, taskId, input: directive.task })

      // Store agent's response
      await db.insert(schema.messages).values({
        id: randomUUID(),
        agentId: agent.id,
        taskId,
        role: 'assistant',
        content: result.output,
        createdAt: new Date(),
      })

      results.push({
        agentId: agent.id,
        agentName: agent.name,
        output: result.output,
        taskId,
      })
    })
  )

  return results
}

// Build a synthesis prompt for Arturito to summarise delegate results
export function buildSynthesisPrompt(
  originalInput: string,
  orchestratorDraft: string,
  delegateResults: OrchestrationResult[],
): string {
  const resultSection = delegateResults
    .map(r => `**${r.agentName}**:\n${r.output}`)
    .join('\n\n---\n\n')

  return [
    `Original request: ${originalInput}`,
    '',
    `Your initial draft: ${orchestratorDraft}`,
    '',
    `Results from delegated agents:`,
    resultSection,
    '',
    'Please synthesise the above into a single, clear response. Be concise. Integrate the agents\' findings naturally.',
  ].join('\n')
}
