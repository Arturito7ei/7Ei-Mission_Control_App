import { db, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { getMemory, formatMemoryForPrompt, extractMemoryInstructions, bulkSetMemory, compressMemoryIfNeeded } from './memory'
import { checkDailyBudget, recordUsage, acquireTaskSlot, releaseTaskSlot } from '../middleware/ratelimit'
import { streamLLM, calcCost } from './llm-router'
import { parseDelegateDirectives, stripDelegateDirectives, executeDelegations, buildSynthesisPrompt } from './orchestrator'
import { parseAgentWebhooks, stripAgentWebhooks, executeAgentWebhooks } from './outbound-webhooks'
import { fireWebhook } from './outbound-webhooks'

export interface ExecuteResult {
  output: string; tokensUsed: number; costUsd: number; durationMs: number
  memorySaved?: Record<string, string>; provider?: string
  delegations?: string[]  // names of agents delegated to
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
    await fireWebhook('agent.active', agent.orgId, { agentId, agentName: agent.name })

    const memory = await getMemory(agentId)
    const memoryBlock = formatMemoryForPrompt(memory)
    const isOrchestrator = agent.role.toLowerCase().includes('orchestrator') ||
                           agent.role.toLowerCase().includes('chief of staff')
    const systemPrompt = buildSystemPrompt(agent, memoryBlock, isOrchestrator)
    const model    = agent.llmModel    ?? 'claude-sonnet-4-20250514'
    const provider = agent.llmProvider ?? 'anthropic'
    const messages = [...conversationHistory, { role: 'user' as const, content: input }]
    const start = Date.now()
    let rawOutput = ''

    const result = await streamLLM({
      provider, model, system: systemPrompt, messages,
      onToken: (chunk) => { rawOutput += chunk; onToken?.(chunk) },
    })

    const tokensUsed = result.usage.inputTokens + result.usage.outputTokens
    const costUsd    = calcCost(model, result.usage.inputTokens, result.usage.outputTokens)
    const durationMs = Date.now() - start

    // Extract memory
    const { toSave, cleanedOutput: afterMemory } = extractMemoryInstructions(result.output)
    if (Object.keys(toSave).length > 0) await bulkSetMemory(agentId, toSave)
    await compressMemoryIfNeeded(agentId)

    // Extract + execute outbound webhooks
    const webhookCalls = parseAgentWebhooks(afterMemory)
    let cleanedOutput = stripAgentWebhooks(afterMemory)
    if (webhookCalls.length > 0) executeAgentWebhooks(webhookCalls).catch(() => {})

    // Extract + execute delegations (orchestrator only)
    let delegatedAgentNames: string[] = []
    if (isOrchestrator) {
      const directives = parseDelegateDirectives(cleanedOutput)
      cleanedOutput = stripDelegateDirectives(cleanedOutput)
      if (directives.length > 0) {
        const delegations = await executeDelegations(agent.orgId, agentId, directives, taskId)
        delegatedAgentNames = delegations.map(d => d.agentName)
        // Synthesise results into final response
        if (delegations.length > 0) {
          const synthesisInput = buildSynthesisPrompt(input, cleanedOutput, delegations)
          const synthResult = await streamLLM({
            provider, model, system: systemPrompt, messages: [{ role: 'user', content: synthesisInput }],
            onToken: (chunk) => onToken?.(chunk),
          })
          cleanedOutput = synthResult.output
        }
      }
    }

    recordUsage(agent.orgId, tokensUsed, costUsd)

    await db.update(schema.tasks).set({
      output: cleanedOutput, status: 'done', tokensUsed, costUsd,
      durationMs, llmModel: model, completedAt: new Date(),
    }).where(eq(schema.tasks.id, taskId))
    await db.update(schema.agents).set({ status: 'idle' }).where(eq(schema.agents.id, agentId))

    // Fire outbound webhooks
    await fireWebhook('task.done', agent.orgId, { taskId, agentId, agentName: agent.name, tokensUsed, costUsd })
    await fireWebhook('agent.idle', agent.orgId, { agentId, agentName: agent.name })
    await fireWebhook('message.created', agent.orgId, { agentId, taskId, role: 'assistant', contentLength: cleanedOutput.length })

    const execResult: ExecuteResult = {
      output: cleanedOutput, tokensUsed, costUsd, durationMs, provider,
      memorySaved: Object.keys(toSave).length > 0 ? toSave : undefined,
      delegations: delegatedAgentNames.length > 0 ? delegatedAgentNames : undefined,
    }
    onDone?.(execResult)
    return execResult
  } catch (err: any) {
    await db.update(schema.tasks).set({ status: 'failed' } as any).where(eq(schema.tasks.id, taskId))
    await db.update(schema.agents).set({ status: 'idle' }).where(eq(schema.agents.id, agentId))
    await fireWebhook('task.failed', agent.orgId, { taskId, agentId, error: err.message })
    throw err
  } finally {
    releaseTaskSlot(agent.orgId)
  }
}

function buildSystemPrompt(agent: typeof schema.agents.$inferSelect, memoryBlock: string, isOrchestrator: boolean): string {
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
    'Memory: include [REMEMBER: key = value] to save to long-term memory (stripped from visible output).',
    'Outbound webhooks: include [WEBHOOK: https://url | {"json":"payload"}] to call external APIs (stripped from visible output).',
  )
  if (isOrchestrator) {
    lines.push(
      '',
      'Orchestration: you can delegate tasks to specialist agents. Include [DELEGATE: AgentName | task description] in your response.',
      'Example: [DELEGATE: Dev | Write a TypeScript function to validate email addresses]',
      'Example: [DELEGATE: Maya | Draft a tweet announcing our new feature]',
      'Results are synthesised automatically. Delegate to max 3 agents per response.',
    )
  }
  return lines.join('\n')
}
