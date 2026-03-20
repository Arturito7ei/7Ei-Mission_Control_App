import Anthropic from '@anthropic-ai/sdk'
import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { getMemory, formatMemoryForPrompt, extractMemoryInstructions, bulkSetMemory } from './memory'
import { checkDailyBudget, recordUsage, acquireTaskSlot, releaseTaskSlot } from '../middleware/ratelimit'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const COST_RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 0.000015, output: 0.000075 },
  'claude-sonnet-4-20250514': { input: 0.000003, output: 0.000015 },
  'claude-haiku-4-5-20251001': { input: 0.00000025, output: 0.00000125 },
}

export interface ExecuteResult {
  output: string; tokensUsed: number; costUsd: number; durationMs: number; memorySaved?: Record<string, string>
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
    const model = agent.llmModel ?? 'claude-sonnet-4-20250514'
    const messages = [...conversationHistory, { role: 'user' as const, content: input }]
    const start = Date.now()
    let output = ''

    const stream = anthropic.messages.stream({ model, max_tokens: 4096, system: systemPrompt, messages })
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        output += event.delta.text
        onToken?.(event.delta.text)
      }
    }

    const final = await stream.finalMessage()
    const tokensUsed = final.usage.input_tokens + final.usage.output_tokens
    const rates = COST_RATES[model] ?? COST_RATES['claude-sonnet-4-20250514']
    const costUsd = final.usage.input_tokens * rates.input + final.usage.output_tokens * rates.output
    const durationMs = Date.now() - start

    const { toSave, cleanedOutput } = extractMemoryInstructions(output)
    if (Object.keys(toSave).length > 0) await bulkSetMemory(agentId, toSave)
    recordUsage(agent.orgId, tokensUsed, costUsd)

    await db.update(schema.tasks).set({
      output: cleanedOutput, status: 'done', tokensUsed, costUsd,
      durationMs, llmModel: model, completedAt: new Date(),
    }).where(eq(schema.tasks.id, taskId))
    await db.update(schema.agents).set({ status: 'idle' }).where(eq(schema.agents.id, agentId))

    const result: ExecuteResult = { output: cleanedOutput, tokensUsed, costUsd, durationMs, memorySaved: Object.keys(toSave).length > 0 ? toSave : undefined }
    onDone?.(result)
    return result
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
  if (agent.personality) lines.push(`Communication style: ${agent.personality}`, '')
  if (agent.cv) lines.push(`Background: ${agent.cv}`, '')
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
    'Memory: to save something to long-term memory, include [REMEMBER: key = value] in your response. These tags are stripped from visible output.',
  )
  return lines.join('\n')
}
