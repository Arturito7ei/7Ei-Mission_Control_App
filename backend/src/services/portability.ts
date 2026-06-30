// Company portability (MCA-PC D3). Export an org as a portable, secret-scrubbed
// template; import remaps every id and reference into a fresh org.

export interface ExportBundle {
  version: number
  org: Record<string, any>
  agents: any[]
  goals: any[]
  budgets: any[]
  routines: any[]
}

// Agent fields that are safe to carry between deployments (NO secrets/runtime state).
const AGENT_FIELDS = ['name', 'role', 'title', 'jobDescription', 'personality', 'cv',
  'termsOfReference', 'llmProvider', 'llmModel', 'skills', 'avatarEmoji', 'agentType',
  'runtime', 'persona', 'expertise', 'advisorPersona', 'heartbeatEverySec'] as const

const pick = (o: any, keys: readonly string[]) => Object.fromEntries(keys.filter(k => o?.[k] != null).map(k => [k, o[k]]))

/** Build a portable bundle. Secrets (apiTokenHash, webhookToken, oauth, heartbeat
 *  state, external endpoints) are omitted by construction. refId = original id. */
export function buildExport(data: { org: any; agents: any[]; goals: any[]; budgets: any[]; routines: any[] }): ExportBundle {
  return {
    version: 1,
    org: pick(data.org, ['name', 'description', 'mission', 'culture', 'deployMode', 'cloudProvider', 'preferredLlm']),
    agents: data.agents.map(a => ({ refId: a.id, reportsTo: a.reportsTo ?? null, ...pick(a, AGENT_FIELDS) })),
    goals: data.goals.map(g => ({ refId: g.id, title: g.title, description: g.description ?? null, metric: g.metric ?? null, status: g.status ?? 'active', parentGoalId: g.parentGoalId ?? null, ownerAgentId: g.ownerAgentId ?? null })),
    budgets: data.budgets.map(b => ({ scope: b.scope, scopeId: b.scopeId ?? null, limitUsd: b.limitUsd, warnPct: b.warnPct ?? 0.8, hardStop: b.hardStop ?? true })),
    routines: data.routines.map(r => ({ refId: r.id, title: r.title, input: r.input ?? null, cronExpression: r.cronExpression, triggerType: r.triggerType ?? 'cron', agentId: r.agentId, enabled: r.enabled ?? true })),
  }
}

export interface RemapResult { agents: any[]; goals: any[]; budgets: any[]; routines: any[] }

/** Remap a bundle into a new org: fresh ids, references rewired, collisions avoided.
 *  genId supplies new ids (and webhook tokens); pure for deterministic testing. */
export function remapImport(bundle: ExportBundle, newOrgId: string, genId: () => string): RemapResult {
  const agentMap = new Map<string, string>()
  for (const a of bundle.agents) agentMap.set(a.refId, genId())
  const goalMap = new Map<string, string>()
  for (const g of bundle.goals) goalMap.set(g.refId, genId())

  const agents = bundle.agents.map(a => {
    const { refId, reportsTo, ...rest } = a
    return { id: agentMap.get(refId)!, orgId: newOrgId, ...rest, status: 'idle', reportsTo: reportsTo ? (agentMap.get(reportsTo) ?? null) : null, createdAt: new Date() }
  })
  const goals = bundle.goals.map(g => ({
    id: goalMap.get(g.refId)!, orgId: newOrgId, title: g.title, description: g.description, metric: g.metric,
    status: g.status ?? 'active', parentGoalId: g.parentGoalId ? (goalMap.get(g.parentGoalId) ?? null) : null,
    ownerAgentId: g.ownerAgentId ? (agentMap.get(g.ownerAgentId) ?? null) : null, createdAt: new Date(),
  }))
  const budgets = bundle.budgets.map(b => ({
    id: genId(), orgId: newOrgId, scope: b.scope,
    scopeId: b.scope === 'agent' ? (agentMap.get(b.scopeId) ?? null) : b.scope === 'goal' ? (goalMap.get(b.scopeId) ?? null) : null,
    limitUsd: b.limitUsd, warnPct: b.warnPct ?? 0.8, hardStop: b.hardStop ?? true, createdAt: new Date(),
  }))
  const routines = bundle.routines.map(r => {
    const tt = r.triggerType ?? 'cron'
    return { id: genId(), orgId: newOrgId, agentId: agentMap.get(r.agentId) ?? null, title: r.title, input: r.input ?? r.title,
      cronExpression: r.cronExpression, triggerType: tt, webhookToken: tt === 'cron' ? null : genId(),
      enabled: r.enabled ?? true, nextRunAt: null, lastRunAt: null, lastTriggeredAt: null, createdAt: new Date() }
  })
  return { agents, goals, budgets, routines }
}
