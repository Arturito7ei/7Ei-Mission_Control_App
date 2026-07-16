// MOB-6b — Task Log formatting, mirrored from the web's `tasks` tab
// (web/app/dashboard/page.tsx, `{tab === 'tasks' && …}`).
//
// The web renders these decisions inline inside JSX, so there is no web module
// to import and compare against — which is precisely why they are lifted out
// here as pure functions with tests. The numbers an operator reads off the phone
// must be the numbers on the desk: a cost shown to 2dp on one client and 5dp on
// the other is the same task telling two stories.
//
// The rules ported, each pinned by a test:
//   * the list is capped at 100 rows (the web's `tasks.slice(0, 100)`),
//   * a title longer than 60 chars is cut at 60 and given an ellipsis,
//   * cost is $ + 5dp, and a null cost is an em-dash — never a fake $0.00000,
//   * tokens are locale-grouped, and null is an em-dash — never a fake 0,
//   * the agent cell is "emoji name", em-dash when the agent is unknown.

/** The em-dash the web uses for "no value recorded". Never render 0 instead. */
export const NONE = '—'

/** The web renders at most this many rows (`tasks.slice(0, 100)`). */
export const TASK_LOG_LIMIT = 100

/** The web truncates a title past this many characters. */
export const TITLE_MAX = 60

export interface TaskLite {
  id: string
  title: string
  status: string
  agentId?: string | null
  costUsd?: number | null
  tokensUsed?: number | null
  createdAt?: number | string | null
}

export interface AgentLite {
  id: string
  name: string
  avatarEmoji?: string | null
}

/** The rows the log shows: newest first as the backend returns them, capped. */
export function taskLogRows<T>(tasks: readonly T[]): T[] {
  return tasks.slice(0, TASK_LOG_LIMIT)
}

/** "A very long title…" — the web's cut at 60 with an ellipsis. */
export function taskTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title
}

/** "$0.01234" — 5dp, matching the web. Null cost is NOT $0. */
export function formatCost(costUsd: number | null | undefined): string {
  return costUsd != null ? `$${costUsd.toFixed(5)}` : NONE
}

/** "12,345" — locale-grouped, matching the web. Null tokens are NOT 0. */
export function formatTokens(tokensUsed: number | null | undefined): string {
  return tokensUsed != null ? tokensUsed.toLocaleString() : NONE
}

/** "🤖 Arturita" — the web's agent cell. An unknown agent is an em-dash. */
export function agentLabel(agent: AgentLite | undefined): string {
  if (!agent) return NONE
  return `${agent.avatarEmoji ?? ''} ${agent.name}`.trim()
}

/**
 * The approvals affordance the web puts above the log: Tasks and the approvals
 * they feed are one area, so the log says what is waiting rather than making the
 * operator go and look. Same two wordings, same threshold.
 */
export function approvalsLabel(pending: number): string {
  return pending > 0
    ? `⏳ ${pending} approval${pending > 1 ? 's' : ''} pending — review →`
    : '✓ No approvals pending — open Inbox →'
}
