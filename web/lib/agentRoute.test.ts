import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_TABS, AGENT_TAB_LABEL, DEFAULT_AGENT_TAB, agentRouteHash, isAgentTab, parseAgentRoute } from './agentRoute.ts'

test('[AG1] the six Paperclip agent tabs are exposed in render order, each with a label', () => {
  assert.deepEqual([...AGENT_TABS], ['dashboard', 'instructions', 'skills', 'configuration', 'runs', 'budget'])
  for (const t of AGENT_TABS) assert.ok(AGENT_TAB_LABEL[t], `missing label for ${t}`)
})

test('[AG1] isAgentTab accepts only known tabs', () => {
  assert.equal(isAgentTab('runs'), true)
  assert.equal(isAgentTab('memory'), false)
  assert.equal(isAgentTab(''), false)
})

test('[AG1] parseAgentRoute reads #agents/<id>/<tab>', () => {
  assert.deepEqual(parseAgentRoute('#agents/a-1/skills'), { agentId: 'a-1', tab: 'skills' })
  assert.deepEqual(parseAgentRoute('agents/a-1/budget'), { agentId: 'a-1', tab: 'budget' })
})

test('[AG1] a missing or unknown tab falls back to the default tab, never to null', () => {
  assert.deepEqual(parseAgentRoute('#agents/a-1'), { agentId: 'a-1', tab: DEFAULT_AGENT_TAB })
  assert.deepEqual(parseAgentRoute('#agents/a-1/'), { agentId: 'a-1', tab: DEFAULT_AGENT_TAB })
  assert.deepEqual(parseAgentRoute('#agents/a-1/nope'), { agentId: 'a-1', tab: DEFAULT_AGENT_TAB })
})

test('[AG1] a hash that does not address an agent parses to null (caller shows the list)', () => {
  assert.equal(parseAgentRoute('#tasks/t-1'), null)
  assert.equal(parseAgentRoute('#agents'), null)
  assert.equal(parseAgentRoute('#agents/'), null)
  assert.equal(parseAgentRoute(''), null)
  assert.equal(parseAgentRoute(null), null)
  assert.equal(parseAgentRoute(undefined), null)
})

test('[AG1] agentRouteHash round-trips through parseAgentRoute', () => {
  for (const tab of AGENT_TABS) {
    assert.deepEqual(parseAgentRoute(agentRouteHash('agent-42', tab)), { agentId: 'agent-42', tab })
  }
  assert.equal(agentRouteHash('agent-42'), '#agents/agent-42/dashboard')
})

test('[AG1] ids with URL-unsafe characters survive the round trip', () => {
  const id = 'agent/with spaces#and?chars'
  const hash = agentRouteHash(id, 'runs')
  assert.ok(!hash.includes(' '), 'hash must be encoded')
  assert.deepEqual(parseAgentRoute(hash), { agentId: id, tab: 'runs' })
})
