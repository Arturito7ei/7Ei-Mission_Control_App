import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CONNECTOR_GROUPS, AVAILABLE_CONNECTOR_IDS, MCP_CONNECTOR_ID,
  GITHUB_CONNECTOR_ID, JIRA_CONNECTOR_ID, GOOGLE_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_ID, WHATSAPP_CONNECTOR_ID, GOOGLE_CHAT_CONNECTOR_ID,
  isAvailableConnector, findDisplayConnector, isConfigured,
  parseArgs, validateMcpConfig, mcpConfigToForm,
  validateGithubConfig, githubConfigToForm,
  validateJiraConfig, jiraConfigToForm,
  validateTelegramConfig, telegramConfigToForm,
  validateWhatsappConfig, whatsappConfigToForm,
  validateGoogleChatConfig, googleChatConfigToForm,
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
  // CONN-5: the three Google services became ONE OAuth connection (a single per-agent
  // Google grant covering Calendar/Gmail/Drive), so the Google group is one row now.
  assert.deepEqual(byTitle['Google Services'], ['Google Workspace'])
  assert.deepEqual(byTitle['Custom MCP servers'], ['Custom MCP Server'])
})

test('[CONN-6] the comms connectors join github/jira/google/mcp as available; only Signal is out', () => {
  // CONN-6 makes the three Communication connectors real for STORAGE (Telegram,
  // WhatsApp, Google Chat), alongside CONN-5 google, CONN-4a github/jira and the CONN-1
  // mcp pilot. Order follows the groups: Communication (google_chat, telegram, whatsapp),
  // IT/Project (github, jira), Google, Custom.
  assert.deepEqual(AVAILABLE_CONNECTOR_IDS, [
    GOOGLE_CHAT_CONNECTOR_ID, TELEGRAM_CONNECTOR_ID, WHATSAPP_CONNECTOR_ID,
    GITHUB_CONNECTOR_ID, JIRA_CONNECTOR_ID, GOOGLE_CONNECTOR_ID, MCP_CONNECTOR_ID,
  ])
  for (const id of ['mcp', 'github', 'jira', 'google', 'telegram', 'whatsapp', 'google_chat']) {
    assert.equal(isAvailableConnector(id), true, `${id} must be available`)
    assert.equal(findDisplayConnector(id)?.availability, 'available')
  }
  // Signal is the only one flagged out-of-scope (nothing left merely coming-soon).
  assert.equal(isAvailableConnector('signal'), false)
  assert.equal(findDisplayConnector('signal')?.availability, 'out_of_scope')
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

// ─── Communication connectors validation (CONN-6) — mirror the backend zod ────

test('[CONN-6] validateTelegramConfig: botUsername/chatId optional + length-capped', () => {
  assert.deepEqual(validateTelegramConfig({ botUsername: '', chatId: '' }), { ok: true, config: {} })
  assert.deepEqual(validateTelegramConfig({ botUsername: '  bot  ', chatId: '  42  ' }), { ok: true, config: { botUsername: 'bot', chatId: '42' } })
  assert.equal(validateTelegramConfig({ botUsername: 'x'.repeat(121), chatId: '' }).ok, false)
  assert.equal(validateTelegramConfig({ botUsername: '', chatId: 'x'.repeat(65) }).ok, false)
})

test('[CONN-6] validateWhatsappConfig: ids optional + length-capped', () => {
  assert.deepEqual(validateWhatsappConfig({ phoneNumberId: '', businessAccountId: '' }), { ok: true, config: {} })
  assert.deepEqual(validateWhatsappConfig({ phoneNumberId: ' 111 ', businessAccountId: ' 222 ' }), { ok: true, config: { phoneNumberId: '111', businessAccountId: '222' } })
  assert.equal(validateWhatsappConfig({ phoneNumberId: 'x'.repeat(65), businessAccountId: '' }).ok, false)
})

test('[CONN-6] validateGoogleChatConfig: space optional + length-capped', () => {
  assert.deepEqual(validateGoogleChatConfig({ space: '' }), { ok: true, config: {} })
  assert.deepEqual(validateGoogleChatConfig({ space: '  spaces/AAA  ' }), { ok: true, config: { space: 'spaces/AAA' } })
  assert.equal(validateGoogleChatConfig({ space: 'x'.repeat(201) }).ok, false)
})

test('[CONN-6] comms config-to-form never surfaces a credential leaked into config', () => {
  const tg = telegramConfigToForm({ botUsername: 'bot', chatId: '42', TELEGRAM_BOT_TOKEN: 'SECRET', secret: 'nope' } as any)
  assert.deepEqual(tg, { botUsername: 'bot', chatId: '42' })
  assert.equal(JSON.stringify(tg).includes('SECRET'), false)
  const wa = whatsappConfigToForm({ phoneNumberId: '111', WHATSAPP_ACCESS_TOKEN: 'SECRET' } as any)
  assert.deepEqual(wa, { phoneNumberId: '111', businessAccountId: '' })
  assert.equal(JSON.stringify(wa).includes('SECRET'), false)
  const gc = googleChatConfigToForm({ space: 'spaces/A', GOOGLE_CHAT_WEBHOOK_URL: 'https://secret' } as any)
  assert.deepEqual(gc, { space: 'spaces/A' })
  assert.equal(JSON.stringify(gc).includes('secret'), false)
})
