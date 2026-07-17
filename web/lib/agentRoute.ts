// Epic AG / AG1 — agent detail routing (pure, no React).
//
// The dashboard is a single Next.js route with a `tab` state (see navModel.ts),
// so the agent detail page lives inside the `agents` area and deep-links through
// the URL hash: `#agents/<agentId>/<tab>`. Keeping parse/serialize pure means the
// routing contract is unit-testable under `node --test` (web has no jest/vitest)
// and the page only wires it to `location.hash`.

export const AGENT_TABS = ['dashboard', 'instructions', 'skills', 'configuration', 'connectors', 'runs', 'budget'] as const

export type AgentTab = (typeof AGENT_TABS)[number]

/** Tab bar labels, in render order (mirrors the Paperclip agent page). */
export const AGENT_TAB_LABEL: Record<AgentTab, string> = {
  dashboard: 'Dashboard',
  instructions: 'Instructions',
  skills: 'Skills',
  configuration: 'Configuration',
  connectors: 'Connectors',
  runs: 'Runs',
  budget: 'Budget',
}

/**
 * Where opening an agent lands. Configuration, not Dashboard: an operator who
 * clicks an agent is nearly always going to its settings, and the fleet already
 * shows the at-a-glance state the Dashboard tab repeats. Every tab stays
 * reachable from the tab bar; only the default destination changed.
 */
export const DEFAULT_AGENT_TAB: AgentTab = 'configuration'

export interface AgentRoute {
  agentId: string
  tab: AgentTab
}

export function isAgentTab(value: string): value is AgentTab {
  return (AGENT_TABS as readonly string[]).includes(value)
}

/**
 * Parse a location hash into an agent route. Returns null when the hash does not
 * address an agent (so the caller falls back to the agent list). An unknown or
 * missing tab segment resolves to the default tab rather than failing — a stale
 * bookmark should still land on the agent.
 */
export function parseAgentRoute(hash: string | null | undefined): AgentRoute | null {
  const raw = (hash ?? '').replace(/^#/, '')
  const parts = raw.split('/').filter(Boolean)
  if (parts[0] !== 'agents') return null
  const agentId = parts[1]
  if (!agentId) return null
  const tab = parts[2]
  return { agentId: decodeURIComponent(agentId), tab: tab && isAgentTab(tab) ? tab : DEFAULT_AGENT_TAB }
}

/** Serialize an agent route back to a location hash (inverse of parseAgentRoute). */
export function agentRouteHash(agentId: string, tab: AgentTab = DEFAULT_AGENT_TAB): string {
  return `#agents/${encodeURIComponent(agentId)}/${tab}`
}
