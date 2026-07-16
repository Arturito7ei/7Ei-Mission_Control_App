// MOB-6d — Cost Centre arithmetic, mirrored from the web's `costs` tab
// (web/app/dashboard/page.tsx, `{tab === 'costs' && …}`).
//
// THE CONTRACT WORTH KNOWING: the web's Cost Centre calls no costs endpoint at
// all. It sums the SAME `tasks` array its Task Log already loaded
// (GET /api/orgs/:orgId/tasks) and joins it against GET /api/orgs/:orgId/agents.
// The backend *does* have a purpose-built `/api/orgs/:orgId/costs` (server-side
// aggregation, groupBy=agent|day, period=7d|30d|90d) and it is tempting on a
// phone — but it is WINDOWED and the web's sum is not, so the two answer
// different questions. An operator reading "$0.4213" on the desk and "$0.3887"
// on the phone has been told the same org spent two different amounts, which is
// exactly the drift the parity rule exists to stop. So the phone sums the same
// array the web sums. Same call, same math, same number.
//
// The one honest caveat, and it is the WEB's, not ours: `/tasks` is capped at
// 200 rows server-side (backend/src/routes/tasks.ts `.limit(200)`), so "Total
// Spend" on BOTH clients means "across the 200 most recent tasks", not all time.
// The phone says so on screen (`SPEND_SCOPE_NOTE`) rather than letting a capped
// number read as a lifetime total — the web doesn't, and that is a web bug to
// fix on the web, not a reason for the phone to invent a different number.
//
// The rules ported, each pinned by a test in costs.test.ts:
//   * total spend is the sum of `costUsd`, rendered $ + 4dp (the Cost Centre's
//     own precision — NOT the Task Log's 5dp; the two web views really do differ,
//     so `taskLog.formatCost` is deliberately not reused here),
//   * total tokens is the sum of `tokensUsed`, rendered as thousands to 1dp + K,
//   * "Done" counts tasks whose status is exactly 'done',
//   * the per-agent breakdown iterates the AGENT roster (so a $0 agent still has
//     a row, as on the web) — it is not derived from, or sorted by, spend,
//   * a null cost/token contributes 0 to a sum (`?? 0`), which is the web's own
//     `(t.costUsd ?? 0)`. Note this differs from the Task Log, where a null cost
//     renders as an em-dash: a missing cost is unknown for ONE task but
//     contributes nothing to a TOTAL. Both are the web's behaviour.

/** A task as the Cost Centre reads it — the four fields the web's sums touch. */
export interface CostTaskLite {
  agentId?: string | null
  status?: string | null
  costUsd?: number | null
  tokensUsed?: number | null
}

/** An agent as the breakdown reads it. */
export interface CostAgentLite {
  id: string
  name: string
  avatarEmoji?: string | null
}

/**
 * What "Total Spend" actually covers on both clients. The backend caps `/tasks`
 * at 200 rows, so this is a recent-window total, not a lifetime one. Shown under
 * the spend figure — an unqualified number here would be a quiet lie.
 */
export const SPEND_SCOPE_NOTE = 'Across the 200 most recent tasks — not an all-time total.'

/** The Cost Centre renders money to 4dp (the Task Log's is 5dp — see the header). */
export const COST_DP = 4

/** Sum of `costUsd`; a null cost contributes 0, as the web's `?? 0` does. */
export function totalCost(tasks: readonly CostTaskLite[]): number {
  return tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
}

/** Sum of `tokensUsed`; a null count contributes 0. */
export function totalTokens(tasks: readonly CostTaskLite[]): number {
  return tasks.reduce((sum, t) => sum + (t.tokensUsed ?? 0), 0)
}

/** The web's `tasks.filter(t => t.status === 'done').length` — exact match only. */
export function doneCount(tasks: readonly CostTaskLite[]): number {
  return tasks.filter((t) => t.status === 'done').length
}

/** "$0.4213" — the Cost Centre's 4dp. A zero total is $0.0000, not an em-dash. */
export function formatSpend(usd: number): string {
  return `$${usd.toFixed(COST_DP)}`
}

/** "12.3K" — the web's `(total / 1000).toFixed(1)` + K. */
export function formatTokensK(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}K`
}

/** One row of the By Agent breakdown. */
export interface AgentCostRow {
  agent: CostAgentLite
  cost: number
  /** This agent's share of total spend, 0–100. 0 when nothing has been spent. */
  pct: number
}

/**
 * The By Agent breakdown, in ROSTER order — deliberately not sorted by spend.
 * The web iterates `agents.map(...)`, so the desk shows the roster's order and
 * includes agents that have spent nothing; re-ranking here would make the same
 * org read as a different league table on the two clients.
 */
export function costsByAgent(
  tasks: readonly CostTaskLite[],
  agents: readonly CostAgentLite[],
): AgentCostRow[] {
  const total = totalCost(tasks)
  return agents.map((agent) => {
    const cost = totalCost(tasks.filter((t) => t.agentId === agent.id))
    return { agent, cost, pct: total > 0 ? (cost / total) * 100 : 0 }
  })
}

/**
 * "34%" — the share the web draws as a proportional bar. The phone renders the
 * number instead (see CostsScreen for why the bar stayed on the desk), so unlike
 * the web's `Math.max(pct, 1)` bar-width floor there is no floor here: that 1%
 * exists to keep a hairline bar visible, and applying it to a printed number
 * would round a genuine 0.2% up to "1%" — a rendering hack turned into a lie.
 */
export function formatShare(pct: number): string {
  return `${Math.round(pct)}%`
}

// ─── Budgets (the web's hosted tab under Costs) ───────────────────────────────
//
// GET /api/orgs/:orgId/budgets returns each policy already evaluated server-side
// (`spend`, `state`, `pct`) — the phone renders that verdict and never re-derives
// it, so a breach means the same thing on both clients.

/** A budget policy as the web's BudgetsSection renders it. */
export interface BudgetLite {
  id: string
  scope: string
  scopeId?: string | null
  limitUsd: number
  spend: number
  /** The server's verdict: 'ok' | 'warn' | 'breach'. */
  state: string
  /** Fraction of the limit used — 0–1, NOT 0–100. */
  pct: number
}

/** "company" / "agent · a1b2c3" — the web's scope cell, same 6-char id cut. */
export function budgetScopeLabel(b: BudgetLite): string {
  return b.scopeId ? `${b.scope} · ${b.scopeId.slice(0, 6)}` : b.scope
}

/** "$12.40 / $50" — the web's spend-over-limit cell (2dp over 0dp). */
export function budgetAmountLabel(b: BudgetLite): string {
  return `$${b.spend.toFixed(2)} / $${b.limitUsd.toFixed(0)}`
}

/**
 * The budget state as a chip tone + glyph. `state` is its own vocabulary
 * (ok/warn/breach) — none of those words are in status.ts's table, so routing it
 * through `statusTone` would silently collapse all three onto 'idle' and a
 * BREACH would render identically to a healthy budget. This is the same trap
 * heartbeats have (see status.ts's note), so it gets the same treatment: an
 * explicit mapping, right here, onto the canonical vocabulary.
 *
 * The web colours these red/accent/green; we keep the meaning and pair it with a
 * glyph, because red-vs-green is precisely the pair the operator cannot see.
 */
export const BUDGET_STATE: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; glyph: string }> = {
  ok: { tone: 'ok', glyph: '✓' },
  warn: { tone: 'warn', glyph: '⚠' },
  breach: { tone: 'danger', glyph: '⛔' },
}

export function budgetChip(state: string | undefined | null): {
  tone: 'ok' | 'warn' | 'danger' | 'neutral'
  glyph: string
} {
  return BUDGET_STATE[(state ?? '').toLowerCase()] ?? { tone: 'neutral', glyph: '○' }
}
