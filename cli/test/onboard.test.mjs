import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFlags, parseOnboard, orgRequest, agentRequest, RUNTIMES } from '../onboard.mjs'

test('parseFlags handles --key value, --key=value, and bare --flag', () => {
  assert.deepEqual(parseFlags(['--org-name', 'Acme Inc', '--dry-run']), { 'org-name': 'Acme Inc', 'dry-run': true })
  assert.deepEqual(parseFlags(['--name=Scout', '--role', 'Researcher']), { name: 'Scout', role: 'Researcher' })
  assert.deepEqual(parseFlags([]), {})
  assert.throws(() => parseFlags(['positional']), /unexpected argument/)
})

test('parseOnboard defaults the agent and requires an org target', () => {
  const cfg = parseOnboard(['--org-name', 'Acme'])
  assert.equal(cfg.orgName, 'Acme')
  assert.equal(cfg.orgId, null)
  assert.deepEqual(cfg.agent, { name: 'Scout', role: 'External Agent', runtime: 'custom', llmProvider: 'minimax', llmModel: 'minimax' })
  assert.equal(cfg.dryRun, false)
})

test('parseOnboard threads through explicit agent flags', () => {
  const cfg = parseOnboard(['--org', 'org_1', '--name', 'Nova', '--role', 'Analyst', '--runtime', 'openclaw', '--provider', 'openai', '--model', 'gpt-4o', '--dry-run'])
  assert.equal(cfg.orgId, 'org_1')
  assert.equal(cfg.orgName, null)
  assert.equal(cfg.dryRun, true)
  assert.deepEqual(cfg.agent, { name: 'Nova', role: 'Analyst', runtime: 'openclaw', llmProvider: 'openai', llmModel: 'gpt-4o' })
})

test('parseOnboard validates org selection and runtime', () => {
  assert.throws(() => parseOnboard([]), /provide --org/)
  assert.throws(() => parseOnboard(['--org', 'o1', '--org-name', 'Acme']), /either --org or --org-name/)
  assert.throws(() => parseOnboard(['--org-name', 'Acme', '--runtime', 'bogus']), /--runtime must be one of/)
  for (const r of RUNTIMES) assert.equal(parseOnboard(['--org', 'o1', '--runtime', r]).agent.runtime, r)
})

test('request builders target the mint endpoints with the right bodies', () => {
  const cfg = parseOnboard(['--org-name', 'Acme', '--name', 'Scout'])
  assert.deepEqual(orgRequest(cfg), { method: 'POST', path: '/api/orgs', body: { name: 'Acme' } })
  const ar = agentRequest(cfg, 'org_42')
  assert.equal(ar.method, 'POST')
  assert.equal(ar.path, '/api/orgs/org_42/agents/external')
  assert.equal(ar.body.name, 'Scout')
  assert.equal(ar.body.runtime, 'custom')
})
