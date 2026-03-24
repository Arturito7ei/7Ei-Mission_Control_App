import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { getMemory, formatMemoryForPrompt, extractMemoryInstructions, bulkSetMemory, compressMemoryIfNeeded } from './memory'
import { checkDailyBudget, recordUsage, acquireTaskSlot, releaseTaskSlot, checkMonthlyBudget } from '../middleware/ratelimit'
import { streamLLM, calcCost } from './llm-router'
import { searchKnowledge } from './vector-search'
import { parseDelegateDirectives, stripDelegateDirectives, executeDelegations, buildSynthesisPrompt } from './orchestrator'
import { parseAgentWebhooks, stripAgentWebhooks, executeAgentWebhooks } from './outbound-webhooks'
import { fireWebhook } from './outbound-webhooks'
import { ensureFreshToken, searchDriveFiles } from './google-auth'

export interface ExecuteResult {
  output: string; tokensUsed: number; costUsd: number; durationMs: number
  memorySaved?: Record<string, string>; provider?: string
  delegations?: string[]  // names of agents delegated to
  budgetWarning?: { percentUsed: number; remaining: number }
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

    const org = await db.query.organisations.findFirst({
      where: eq(schema.organisations.id, agent.orgId)
    })

    let ragContext = ''
    if (process.env.PINECONE_API_KEY) {
      try {
        const results = await searchKnowledge(input, agent.orgId, 5)
        if (results.length > 0) {
          ragContext = '=== RELEVANT KNOWLEDGE ===\n' +
            results.map(r => `[${r.name}] (relevance: ${r.score.toFixed(2)})`).join('\n') +
            '\n=== END RELEVANT KNOWLEDGE ==='
        }
      } catch (err) {
        console.warn('RAG retrieval failed (non-critical):', err)
        // Never throw — agent still works without RAG
      }
    }

    const memory = await getMemory(agentId)
    const memoryBlock = formatMemoryForPrompt(memory)
    const isOrchestrator = agent.role.toLowerCase().includes('orchestrator') ||
                           agent.role.toLowerCase().includes('chief of staff')

    // Fetch available agents list for orchestrator system prompt
    let availableAgents: Array<{ name: string; role: string }> = []
    if (isOrchestrator) {
      const orgAgents = await db.select({ name: schema.agents.name, role: schema.agents.role })
        .from(schema.agents)
        .where(and(eq(schema.agents.orgId, agent.orgId)))
      availableAgents = orgAgents.filter(a => a.name !== agent.name)
    }

    // Fetch Drive context if Google is connected for this org
    let driveContext = ''
    try {
      const oauthToken = await db.query.oauthTokens.findFirst({
        where: and(eq(schema.oauthTokens.orgId, agent.orgId), eq(schema.oauthTokens.provider, 'google'))
      })
      if (oauthToken?.refreshToken) {
        const fresh = await ensureFreshToken(oauthToken)
        if (fresh.accessToken !== oauthToken.accessToken) {
          await db.update(schema.oauthTokens)
            .set({ accessToken: fresh.accessToken, expiresAt: fresh.expiresAt })
            .where(eq(schema.oauthTokens.id, oauthToken.id))
        }
        const driveResults = await searchDriveFiles(fresh.accessToken, input, 3)
        if (driveResults.length > 0) {
          driveContext = '=== GOOGLE DRIVE DOCUMENTS ===\n' +
            driveResults.map(r => `[${r.name}]: ${r.snippet}`).join('\n') +
            '\n=== END DRIVE DOCS ==='
        }
      }
    } catch (err) {
      console.warn('Drive context fetch failed (non-critical):', err)
    }

    const systemPrompt = buildSystemPrompt(agent, memoryBlock, isOrchestrator, org, ragContext, driveContext, availableAgents)
    const model    = agent.llmModel    ?? 'claude-sonnet-4-20250514'
    const provider = agent.llmProvider ?? 'anthropic'
    const orgApiKey = org?.deployConfig?.[`${provider}_api_key`] as string | undefined
    const messages = [...conversationHistory, { role: 'user' as const, content: input }]
    const start = Date.now()
    let rawOutput = ''

    const result = await streamLLM({
      provider, model, system: systemPrompt, messages, orgApiKey,
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
            orgApiKey, onToken: (chunk) => onToken?.(chunk),
          })
          cleanedOutput = synthResult.output
        }
      }
    }

    recordUsage(agent.orgId, tokensUsed, costUsd)

    const budgetCheck = await checkMonthlyBudget(agent.orgId)
    const budgetWarning = budgetCheck.percentUsed > 80
      ? { percentUsed: budgetCheck.percentUsed, remaining: budgetCheck.remaining }
      : undefined

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
      budgetWarning,
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

export function buildSystemPrompt(
  agent: typeof schema.agents.$inferSelect,
  memoryBlock: string,
  isOrchestrator: boolean,
  org?: typeof schema.organisations.$inferSelect | null,
  ragContext?: string,
  driveContext?: string,
  availableAgents?: Array<{ name: string; role: string }>,
): string {
  const lines: string[] = []

  // Organisation context — at the very top
  if (org?.mission || org?.culture) {
    lines.push('=== ORGANISATION CONTEXT ===')
    if (org.mission) lines.push(`Mission & Vision: ${org.mission}`)
    if (org.culture)  lines.push(`Culture & Principles: ${org.culture}`)
    lines.push('=== END ORGANISATION CONTEXT ===', '')
  }
  if (ragContext) {
    lines.push(ragContext, '')
  }
  if (driveContext) {
    lines.push(driveContext, '')
  }

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
    if (availableAgents && availableAgents.length > 0) {
      lines.push('', 'Available agents you can delegate to:')
      availableAgents.forEach(a => lines.push(`• ${a.name} — ${a.role}`))
    }
    lines.push(
      '',
      'Orchestration: include [DELEGATE: AgentName | task description] in your response.',
      'Example: [DELEGATE: Dev | Write a TypeScript function to validate email addresses]',
      'Example: [DELEGATE: Maya | Draft a tweet announcing our new feature]',
      'Results are synthesised automatically. Delegate to max 3 agents per response.',
    )
  }
  return lines.join('\n')
}
