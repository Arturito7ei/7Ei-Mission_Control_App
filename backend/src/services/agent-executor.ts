import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { getMemory, formatMemoryForPrompt, extractMemoryInstructions, bulkSetMemory, compressMemoryIfNeeded } from './memory'
import { checkDailyBudget, recordUsage, acquireTaskSlot, releaseTaskSlot } from '../middleware/ratelimit'
import { streamLLM, calcCost } from './llm-router'

export interface ExecuteResult {
  output: string; tokensUsed: number; costUsd: number; durationMs: number
  memorySaved?: Record<string, string>; provider?: string
}

export async function executeAgentTask(opts: {
  agentId: string; taskId: string; input: string
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  onToken?: (t: string) => void; onDone?: (r: ExecuteResult) => void
}): Promise<ExecuteResult> {
  const { agentId, taskId, input, conversationHistory = [], onToken, onDone } = opts

  const agent = await db.query.agents.findFirst({ where: eq(schema.agents.id, agentId) })
  if (!agent) throw new Error('Agent not found')

  const budget = checkDailyBudget(agent.orgId, 2000)
  if (!budget.allowed) throw new Error(`Daily budget exceeded. Remaining: $${budget.remaining.cost.toFixed(4)}`)
  if (!acquireTaskSlot(agent.orgId)) throw new Error('Too many concurrent tasks. Please wait.')

  try {
    await db.update(schema.tasks).set({ status: 'in_progress' }).where(eq(schema.tasks.id, taskId))
    await db.update(schema.agents).set({ status: 'active' }).where(eq(schema.agents.id, agentId))

    const memory = await getMemory(agentId)
    const memoryBlock = formatMemoryForPrompt(memory)
    const systemPrompt = buildSystemPrompt(agent, memoryBlock)
    const model    = agent.llmModel    ?? 'claude-sonnet-4-20250514'
    const provider = agent.llmProvider ?? 'anthropic'
    const messages = [...conversationHistory, { role: 'user' as const, content: input }]
    const start = Date.now()
    let output = ''

    const result = await streamLLM({
      provider, model, system: systemPrompt, messages,
      onToken: (chunk) => { output += chunk; onToken?.(chunk) },
    })

    const tokensUsed = result.usage.inputTokens + result.usage.outputTokens
    const costUsd    = calcCost(model, result.usage.inputTokens, result.usage.outputTokens)
    const durationMs = Date.now() - start

    const { toSave, cleanedOutput } = extractMemoryInstructions(result.output)
    if (Object.keys(toSave).length > 0) await bulkSetMemory(agentId, toSave)
    await compressMemoryIfNeeded(agentId)
    recordUsage(agent.orgId, tokensUsed, costUsd)

    await db.update(schema.tasks).set({
      output: cleanedOutput, status: 'done', tokensUsed, costUsd,
      durationMs, llmModel: model, completedAt: new Date(),
    }).where(eq(schema.tasks.id, taskId))
    await db.update(schema.agents).set({ status: 'idle' }).where(eq(schema.agents.id, agentId))

    const execResult: ExecuteResult = { output: cleanedOutput, tokensUsed, costUsd, durationMs, provider,
      memorySaved: Object.keys(toSave).length > 0 ? toSave : undefined }
    onDone?.(execResult)
    return execResult
  } finally {
    releaseTaskSlot(agent.orgId)
  }
}

function buildSystemPrompt(agent: typeof schema.agents.$inferSelect, memoryBlock: string): string {
  const lines: string[] = []
  if (agent.agentType === 'advisor' && agent.advisorPersona) {
    lines.push(`You are ${agent.name}, a Silver Board Advisor.`, `Persona: ${agent.advisorPersona}`, '', 'Embody this persona fully. Speak with their voice, wisdom, and philosophy.', '')
  } else {
    lines.push(`You are ${agent.name}, ${agent.role} at 7Ei.`, '')
  }
  if (agent.personality)      lines.push(`Communication style: ${agent.personality}`, '')
  if (agent.cv)               lines.push(`Background: ${agent.cv}`, '')
  if (agent.termsOfReference) lines.push(`Terms of Reference: ${agent.termsOfReference}`, '')
  const skills = (agent.skills as string[]) ?? []
  if (skills.length > 0) lines.push(`Active skills: ${skills.join(', ')}`, '')
  if (memoryBlock) lines.push(memoryBlock)
  lines.push(
    'Operating principles:',
    '\u2022 Simplicity first \u2014 the clearest answer that works',
    '\u2022 Be direct and actionable, no filler',
    '\u2022 Ask one focused question when clarification is needed',
    '\u2022 Flag risks and irreversible actions',
    '',
    'Memory: to save something to long-term memory, include [REMEMBER: key = value] in your response.',
  )
  return lines.join('\n')
}
