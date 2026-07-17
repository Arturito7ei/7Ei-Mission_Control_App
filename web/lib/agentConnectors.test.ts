import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CONNECTOR_GROUPS, AVAILABLE_CONNECTOR_IDS, MCP_CONNECTOR_ID,
  isAvailableConnector, findDisplayConnector, isConfigured,
  parseArgs, validateMcpConfig, mcpConfigToForm,
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

test('[CONN-2] only the custom MCP server is available in v1; everything else is disabled', () => {
  assert.deepEqual(AVAILABLE_CONNECTOR_IDS, [MCP_CONNECTOR_ID])
  assert.equal(isAvailableConnector('mcp'), true)
  assert.equal(isAvailableConnector('github'), false)
  assert.equal(isAvailableConnector('telegram'), false)
  // Signal is the only one flagged out-of-scope (vs merely coming-soon).
  assert.equal(findDisplayConnector('signal')?.availability, 'out_of_scope')
  assert.equal(findDisplayConnector('github')?.availability, 'coming_soon')
})

test('[CONN-2] every non-available connector carries an honest note pointing at its stage', () => {
  for (const c of CONNECTOR_GROUPS.flatMap(g => g.connectors)) {
    if (c.availability === 'available') assert.equal(c.note, undefined, `${c.id} should have no note`)
    else assert.ok(c.note && c.note.length > 0, `${c.id} must explain why it is not configurable`)
  }
})

// ─── Parity tripwire: the client "available" set == backend AGENT_CONNECTORS ──
//
// The client catalog is hand-copied (Next.js can't import backend source that
// pulls in drizzle). Read the backend source as TEXT (dep-free) and assert the
// two catalogs agree — the standing rule for any list copied across the boundary.

test('[CONN-2] AVAILABLE_CONNECTOR_IDS matches the backend AGENT_CONNECTORS catalog', () => {
  const src = readFileSync(new URL('../../backend/src/services/agent-connectors.ts', import.meta.url), 'utf8')
  const block = /AGENT_CONNECTORS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(src)
  assert.ok(block, 'could not locate the AGENT_CONNECTORS array in the backend source')
  const backendIds = [...block![1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1])
  assert.ok(backendIds.length > 0, 'backend catalog parsed empty — parity check would be vacuous')
  assert.deepEqual([...AVAILABLE_CONNECTOR_IDS].sort(), [...backendIds].sort(),
    'client "available" connectors drifted from the backend catalog — reconcile before merging')
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
