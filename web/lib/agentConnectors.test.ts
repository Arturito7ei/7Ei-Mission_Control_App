import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CONNECTOR_GROUPS, AVAILABLE_CONNECTOR_IDS, MCP_CONNECTOR_ID,
  GITHUB_CONNECTOR_ID, JIRA_CONNECTOR_ID,
  isAvailableConnector, findDisplayConnector, isConfigured,
  parseArgs, validateMcpConfig, mcpConfigToForm,
  validateGithubConfig, githubConfigToForm,
  validateJiraConfig, jiraConfigToForm,
  type McpFormInput,
} from './agentConnectors.ts'

// ─── Grouping: the operator's four categories, in order, with their connectors ─

test('[CONN-2] the accordion renders the operator’s four categories in order', () => {
  assert.deepEqual(CONNECTOR_GROUPS.map(g => g.title), [
    'Communication', 'IT / Project management', 'Google Services', 'Custom MCP servers',
  ])
})

test('[CONN-2] each category lists exactly the connectors the operator named, in order', () => {
  const byTitle = Object.fromEntries(CONNECTOR_GROUPS.map(g => [g.title, g.connectors.map(c => c.name)]))
  assert.deepEqual(byTitle['Communication'], ['Google Chat', 'Telegram', 'WhatsApp', 'Signal'])
  assert.deepEqual(byTitle['IT / Project management'], ['GitHub', 'Jira'])
  assert.deepEqual(byTitle['Google Services'], ['Google Calendar', 'Gmail', 'Google Drive'])
  assert.deepEqual(byTitle['Custom MCP servers'], ['Custom MCP Server'])
})

test('[CONN-4b] github, jira and the custom MCP server are available; the rest disabled', () => {
  // CONN-4b enables the two CONN-4a token/basic connectors alongside the CONN-1 mcp
  // pilot. Order follows the groups: IT/Project (github, jira) then Custom (mcp).
  assert.deepEqual(AVAILABLE_CONNECTOR_IDS, [GITHUB_CONNECTOR_ID, JIRA_CONNECTOR_ID, MCP_CONNECTOR_ID])
  assert.equal(isAvailableConnector('mcp'), true)
  assert.equal(isAvailableConnector('github'), true)
  assert.equal(isAvailableConnector('jira'), true)
  assert.equal(isAvailableConnector('telegram'), false)
  assert.equal(findDisplayConnector('github')?.availability, 'available')
  assert.equal(findDisplayConnector('jira')?.availability, 'available')
  // Signal is the only one flagged out-of-scope (vs merely coming-soon).
  assert.equal(findDisplayConnector('signal')?.availability, 'out_of_scope')
  assert.equal(findDisplayConnector('telegram')?.availability, 'coming_soon')
})

test('[CONN-2] every non-available connector carries an honest note pointing at its stage', () => {
  for (const c of CONNECTOR_GROUPS.flatMap(g => g.connectors)) {
    if (c.availability === 'available') assert.equal(c.note, undefined, `${c.id} should have no note`)
    else assert.ok(c.note && c.note.length > 0, `${c.id} must explain why it is not configurable`)
  }
})

// ─── Parity tripwire: the client "available" set ⊆ backend AGENT_CONNECTORS ───
//
// The client catalog is hand-copied (Next.js can't import backend source that
// pulls in drizzle). Read the backend source as TEXT (dep-free) and assert the
// client can only ever offer a connector the backend actually serves. The check is
// a SUBSET, not equality: the backend legitimately LEADS the client (a connector
// ships in the backend catalog at its CONN-Na stage and the client enables the row
// in the following CONN-Nb stage — e.g. github/jira land in the backend at CONN-4a,
// the client rows at CONN-4b). The dangerous drift is the other direction — a client
// offering a connectorId the backend lacks would POST to an unknown id and 404 —
// and THAT is what this fails on.
test('[CONN-2] AVAILABLE_CONNECTOR_IDS is a subset of the backend AGENT_CONNECTORS catalog', () => {
  const src = readFileSync(new URL('../../backend/src/services/agent-connectors.ts', import.meta.url), 'utf8')
  const block = /AGENT_CONNECTORS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(src)
  assert.ok(block, 'could not locate the AGENT_CONNECTORS array in the backend source')
  const backendIds = [...block![1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1])
  assert.ok(backendIds.length > 0, 'backend catalog parsed empty — parity check would be vacuous')
  const offeredButUnserved = [...AVAILABLE_CONNECTOR_IDS].filter(id => !backendIds.includes(id))
  assert.deepEqual(offeredButUnserved, [],
    'client offers a connector the backend catalog lacks — it would 404; reconcile before merging')
})

// ─── Masked-only display: the read state carries no credential ────────────────

test('[CONN-2] the public connector state has no secret field (masked-only display)', () => {
  // A read-state object as the tab builds it. TypeScript already forbids a secret
  // field on PublicConnectorState; this guards the runtime object too.
  const state = { connectorId: 'mcp', status: 'configured', config: { name: 'x', transport: 'http', url: 'https://a.b' }, accountLabel: 'x', useOrgConnection: false, lastTestedAt: null, lastError: null }
  const forbidden = ['secret', 'secretRef', 'token', 'apiKey', 'valueEncrypted', 'password']
  for (const k of forbidden) assert.equal(k in state, false, `read state must not carry ${k}`)
  assert.equal(isConfigured(state), true)
  assert.equal(isConfigured({ status: 'not_configured' }), false)
  assert.equal(isConfigured(null), false)
})

test('[CONN-2] mcpConfigToForm never surfaces a credential, even if one leaks into config', () => {
  const form = mcpConfigToForm({ name: 'srv', transport: 'http', url: 'https://a.b', secret: 'DO-NOT-SHOW', token: 'nope' } as any)
  assert.equal(JSON.stringify(form).includes('DO-NOT-SHOW'), false)
  assert.equal(JSON.stringify(form).includes('nope'), false)
  assert.deepEqual(form, { name: 'srv', transport: 'http', url: 'https://a.b', command: '', args: '' })
})

// ─── Custom MCP validation — mirrors the backend zod schema ───────────────────

const base: McpFormInput = { name: '', transport: 'http', url: '', command: '', args: '' }

test('[CONN-2] validateMcpConfig: name is required and capped at 120', () => {
  assert.equal(validateMcpConfig({ ...base, url: 'https://a.b' }).ok, false)
  const long = validateMcpConfig({ ...base, name: 'x'.repeat(121), url: 'https://a.b' })
  assert.equal(long.ok, false)
})

test('[CONN-2] validateMcpConfig: http requires a valid url; strips the command field', () => {
  assert.equal(validateMcpConfig({ ...base, name: 'srv', transport: 'http', url: '' }).ok, false)
  assert.equal(validateMcpConfig({ ...base, name: 'srv', transport: 'http', url: 'not-a-url' }).ok, false)
  const r = validateMcpConfig({ ...base, name: 'srv', transport: 'http', url: 'https://mcp.example.com', command: 'ignored' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.config, { name: 'srv', transport: 'http', url: 'https://mcp.example.com' })
})

test('[CONN-2] validateMcpConfig: stdio requires a command; carries parsed args, no url', () => {
  assert.equal(validateMcpConfig({ ...base, name: 'srv', transport: 'stdio', command: '' }).ok, false)
  const r = validateMcpConfig({ ...base, name: 'srv', transport: 'stdio', command: 'npx', args: 'server\n--port\n3000\n' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.config, { name: 'srv', transport: 'stdio', command: 'npx', args: ['server', '--port', '3000'] })
})

test('[CONN-2] validateMcpConfig: arg count and length limits mirror the backend', () => {
  const many = Array.from({ length: 51 }, (_, i) => `a${i}`).join('\n')
  assert.equal(validateMcpConfig({ ...base, name: 'srv', transport: 'stdio', command: 'x', args: many }).ok, false)
  const longArg = validateMcpConfig({ ...base, name: 'srv', transport: 'stdio', command: 'x', args: 'y'.repeat(513) })
  assert.equal(longArg.ok, false)
})

test('[CONN-2] parseArgs: one per line, trimmed, blanks dropped', () => {
  assert.deepEqual(parseArgs('  a \n\n b\nc  '), ['a', 'b', 'c'])
  assert.deepEqual(parseArgs(''), [])
})

// ─── GitHub config validation — mirrors the backend GithubConfigSchema ────────

test('[CONN-4b] validateGithubConfig: username optional, trimmed, capped at 120', () => {
  // Blank username is fine — it is optional and omitted from the config body.
  assert.deepEqual(validateGithubConfig({ username: '' }), { ok: true, config: {} })
  assert.deepEqual(validateGithubConfig({ username: '  octocat  ' }), { ok: true, config: { username: 'octocat' } })
  assert.equal(validateGithubConfig({ username: 'x'.repeat(121) }).ok, false)
})

test('[CONN-4b] githubConfigToForm never surfaces a credential, even if one leaks into config', () => {
  const form = githubConfigToForm({ username: 'octocat', GITHUB_TOKEN: 'ghp_SECRET', token: 'nope' } as any)
  assert.deepEqual(form, { username: 'octocat' })
  assert.equal(JSON.stringify(form).includes('ghp_SECRET'), false)
})

// ─── Jira config validation — mirrors the backend JiraConfigSchema ────────────

test('[CONN-4b] validateJiraConfig: baseUrl must be a valid URL, email required + valid', () => {
  assert.equal(validateJiraConfig({ baseUrl: '', email: 'a@b.co' }).ok, false)
  assert.equal(validateJiraConfig({ baseUrl: 'not-a-url', email: 'a@b.co' }).ok, false)
  assert.equal(validateJiraConfig({ baseUrl: 'https://x.atlassian.net', email: '' }).ok, false)
  assert.equal(validateJiraConfig({ baseUrl: 'https://x.atlassian.net', email: 'not-an-email' }).ok, false)
  const r = validateJiraConfig({ baseUrl: '  https://x.atlassian.net  ', email: '  me@x.co  ' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.config, { baseUrl: 'https://x.atlassian.net', email: 'me@x.co' })
})

test('[CONN-4b] validateJiraConfig: length caps mirror the backend (2048 url / 320 email)', () => {
  assert.equal(validateJiraConfig({ baseUrl: 'https://x.co/' + 'a'.repeat(2048), email: 'a@b.co' }).ok, false)
  assert.equal(validateJiraConfig({ baseUrl: 'https://x.atlassian.net', email: 'a'.repeat(320) + '@b.co' }).ok, false)
})

test('[CONN-4b] jiraConfigToForm never surfaces a credential, even if one leaks into config', () => {
  const form = jiraConfigToForm({ baseUrl: 'https://x.atlassian.net', email: 'me@x.co', JIRA_API_TOKEN: 'SECRET' } as any)
  assert.deepEqual(form, { baseUrl: 'https://x.atlassian.net', email: 'me@x.co' })
  assert.equal(JSON.stringify(form).includes('SECRET'), false)
})
