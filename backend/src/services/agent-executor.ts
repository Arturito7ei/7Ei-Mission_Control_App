import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { getMemory, formatMemoryForPrompt, extractMemoryInstructions, bulkSetMemory, compressMemoryIfNeeded } from './memory'
import { checkDailyBudget, recordUsage, acquireTaskSlot, releaseTaskSlot, checkMonthlyBudget } from '../middleware/ratelimit'
import { streamLLM, calcCost } from './llm-router'
import { searchKnowledge } from './vector-search'
import { parseDelegateDirectives, stripDelegateDirectives, executeDelegations, buildSynthesisPrompt } from './orchestrator'
import { parseAgentWebhooks, stripAgentWebhooks, executeAgentWebhooks } from './outbound-webhooks'
import { sendPushNotification } from '../routes/notifications'
import { fireWebhook } from './outbound-webhooks'
import { ensureFreshToken, searchDriveFiles } from './google-auth'
import { isExternalAgent, notifyExternalAgent } from './agent-runtime'
import { goalAncestry, formatGoalContext } from './goals'
import { canAgentRun } from './governance'
import { enforceAgentBudget } from './budget'

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

  // MCA-PC B2: governance gate — paused/terminated agents do not execute.
  if (!canAgentRun(agent.status)) {
    await db.update(schema.tasks).set({ status: agent.status === 'terminated' ? 'failed' : 'pending' }).where(eq(schema.tasks.id, taskId))
    const r: ExecuteResult = { output: `Agent is ${agent.status}; task not executed.`, tokensUsed: 0, costUsd: 0, durationMs: 0, provider: 'governance' }
    onDone?.(r); return r
  }

  // MCA-PC C2: scoped budget hard-stop — pause the agent and block on breach.
  {
    const t0 = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
    const budget = await enforceAgentBudget(agent.orgId, agent.id, { projectId: t0?.projectId, goalId: t0?.goalId })
    if (budget.blocked) {
      await db.update(schema.tasks).set({ status: 'blocked', inboxState: 'needs_attention', output: budget.reason } as any).where(eq(schema.tasks.id, taskId))
      const r: ExecuteResult = { output: budget.reason ?? 'Budget hard-stop.', tokensUsed: 0, costUsd: 0, durationMs: 0, provider: 'budget' }
      onDone?.(r); return r
    }
  }

  // MCA-EXT: external / bring-your-own runtimes are not driven by the LLM here.
  // Assign the task and notify the runtime; it claims + posts results via the
  // agent API. The internal executor path below is skipped entirely.
  if (isExternalAgent(agent)) {
    await db.update(schema.tasks)
      .set({ status: 'assigned', assignedTo: agent.id })
      .where(eq(schema.tasks.id, taskId))
    await notifyExternalAgent(agent, { taskId, input })
    const r: ExecuteResult = {
      output: `Task assigned to external runtime "${agent.name}" (${agent.runtime}). Awaiting result.`,
      tokensUsed: 0, costUsd: 0, durationMs: 0, provider: 'external',
    }
    onDone?.(r)
    return r
  }

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

    // Org chart context (MCA-PC A1): manager + direct reports for the reporting line.
    const hierAgents = await db.select({ id: schema.agents.id, name: schema.agents.name, reportsTo: schema.agents.reportsTo })
      .from(schema.agents).where(eq(schema.agents.orgId, agent.orgId))
    const hierarchy = {
      title: agent.title,
      manager: agent.reportsTo ? (hierAgents.find(a => a.id === agent.reportsTo)?.name ?? null) : null,
      reports: hierAgents.filter(a => a.reportsTo === agent.id).map(a => a.name),
    }

    // Goal alignment (MCA-PC B1): inject the task's goal ancestry as the "why".
    let goalContext = ''
    try {
      const taskRow = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) })
      if (taskRow?.goalId) {
        const goalRows = await db.select().from(schema.goals).where(eq(schema.goals.orgId, agent.orgId))
        goalContext = formatGoalContext(goalAncestry(goalRows as any, taskRow.goalId), org?.mission)
      }
    } catch { /* non-critical */ }

    const systemPrompt = buildSystemPrompt(agent, memoryBlock, isOrchestrator, org, ragContext, driveContext, availableAgents, hierarchy, goalContext)
    const model    = agent.llmModel    ?? 'claude-sonnet-4-20250514'
    const provider = agent.llmProvider ?? 'anthropic'
    const orgApiKey = org?.deployConfig?.[`${provider}_api_key`] as string | undefined
    const baseURL   = org?.deployConfig?.[`${provider}_base_url`] as string | undefined
    const messages = [...conversationHistory, { role: 'user' as const, content: input }]
    const start = Date.now()
    let rawOutput = ''

    const result = await streamLLM({
      provider, model, system: systemPrompt, messages, orgApiKey, baseURL,
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
            orgApiKey, baseURL, onToken: (chunk) => onToken?.(chunk),
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

    // Push notifications (fire-and-forget)
    if (org?.ownerId) {
      sendPushNotification(org.ownerId, `${agent.name} completed a task`, cleanedOutput.slice(0, 100), { agentId, taskId }).catch(() => {})
      if (budgetWarning) {
        sendPushNotification(org.ownerId, `Budget alert: ${budgetWarning.percentUsed}% used`, `$${budgetWarning.remaining.toFixed(2)} remaining this month`, { type: 'budget_warning' }).catch(() => {})
      }
    }

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
  hierarchy?: { title?: string | null; manager?: string | null; reports?: string[] },
  goalContext?: string,
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
  if (goalContext) {
    lines.push(goalContext, '')
  }

  if (agent.agentType === 'advisor' && agent.advisorPersona) {
    lines.push(`You are ${agent.name}, a Silver Board Advisor.`, `Persona: ${agent.advisorPersona}`, '', 'Embody this persona fully. Speak with their voice, wisdom, and philosophy.', '')
  } else {
    lines.push(`You are ${agent.name}, ${agent.role} at 7Ei.`, '')
  }
  if (hierarchy && (hierarchy.title || hierarchy.manager || (hierarchy.reports && hierarchy.reports.length))) {
    lines.push('=== YOUR PLACE IN THE ORG ===')
    if (hierarchy.title)   lines.push(`Title: ${hierarchy.title}`)
    if (hierarchy.manager) lines.push(`Reports to: ${hierarchy.manager}`)
    if (hierarchy.reports && hierarchy.reports.length) lines.push(`Direct reports: ${hierarchy.reports.join(', ')}`)
    lines.push('Escalate to your manager; delegate to your reports.', '=== END ORG ===', '')
  }
  if (agent.personality)      lines.push(`Communication style: ${agent.personality}`, '')
  if (agent.persona)          lines.push('\nYOUR PERSONALITY AND STYLE:\n' + agent.persona, '')
  if (agent.expertise)        lines.push('\nYOUR AREAS OF EXPERTISE:\n' + agent.expertise, '')
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
