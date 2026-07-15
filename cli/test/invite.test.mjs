import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseInviteCreate, inviteCreateRequest,
  parseAgentOnboard, joinRequestPlan, claimRequestPlan, mcEnvLines,
} from '../invite.mjs'

// ─── invite create (operator) ────────────────────────────────────────────────

test('parseInviteCreate requires --org and defaults to "any adapter, single-use, default TTL"', () => {
  const cfg = parseInviteCreate(['--org', 'org_1'])
  assert.equal(cfg.orgId, 'org_1')
  assert.equal(cfg.allowedAdapterTypes, null) // omitted → any invitable adapter
  assert.equal(cfg.maxUses, undefined)        // backend default (1)
  assert.equal(cfg.expiresInHours, undefined) // backend default (72)
  assert.throws(() => parseInviteCreate([]), /provide --org/)
})

test('parseInviteCreate parses a comma-separated adapter allow-list and bounds', () => {
  const cfg = parseInviteCreate(['--org', 'o1', '--adapter', 'claude_code,openclaw_local', '--uses', '5', '--ttl-hours', '48', '--message', 'hi'])
  assert.deepEqual(cfg.allowedAdapterTypes, ['claude_code', 'openclaw_local'])
  assert.equal(cfg.maxUses, 5)
  assert.equal(cfg.expiresInHours, 48)
  assert.equal(cfg.message, 'hi')
})

test('parseInviteCreate rejects bad --uses and --ttl-hours', () => {
  assert.throws(() => parseInviteCreate(['--org', 'o1', '--uses', '0']), /--uses must be a positive integer/)
  assert.throws(() => parseInviteCreate(['--org', 'o1', '--ttl-hours', '-1']), /--ttl-hours must be a positive number/)
})

test('inviteCreateRequest targets the owner-gated route and omits unset fields', () => {
  const req = inviteCreateRequest(parseInviteCreate(['--org', 'org_42']))
  assert.deepEqual(req, { method: 'POST', path: '/api/orgs/org_42/agent-invites', body: {} })
  const req2 = inviteCreateRequest(parseInviteCreate(['--org', 'org_42', '--adapter', 'claude_code', '--uses', '3']))
  assert.deepEqual(req2.body, { allowedAdapterTypes: ['claude_code'], maxUses: 3 })
})

// ─── onboard --invite (agent-side) ───────────────────────────────────────────

test('parseAgentOnboard requires --invite, --adapter, --name; defaults capability + out', () => {
  const cfg = parseAgentOnboard(['--invite', 'mci_inv_abc', '--adapter', 'claude_code', '--name', 'Scout'])
  assert.equal(cfg.invite, 'mci_inv_abc')
  assert.equal(cfg.adapterType, 'claude_code')
  assert.equal(cfg.agentName, 'Scout')
  assert.deepEqual(cfg.capabilities, ['machine_exec'])
  assert.equal(cfg.out, 'mc.env')
  assert.throws(() => parseAgentOnboard(['--adapter', 'x', '--name', 'y']), /--invite/)
  assert.throws(() => parseAgentOnboard(['--invite', 'i', '--name', 'y']), /--adapter/)
  assert.throws(() => parseAgentOnboard(['--invite', 'i', '--adapter', 'x']), /--name/)
})

test('joinRequestPlan builds the public, strictly-typed join body with mcApiUrl in the payload', () => {
  const cfg = parseAgentOnboard(['--invite', 'mci_inv_abc', '--adapter', 'openclaw_local', '--name', 'Nova', '--capability', 'memory:write,machine_exec', '--workdir', '/w', '--mc-url', 'https://mc.example/'])
  const plan = joinRequestPlan(cfg)
  assert.equal(plan.method, 'POST')
  assert.equal(plan.path, '/api/agent-invites/mci_inv_abc/join')
  assert.equal(plan.public, true)
  assert.deepEqual(plan.body, {
    agentName: 'Nova', adapterType: 'openclaw_local', capabilities: ['memory:write', 'machine_exec'],
    agentDefaultsPayload: { workdir: '/w', mcApiUrl: 'https://mc.example' },
  })
})

test('claimRequestPlan targets the public one-time claim', () => {
  assert.deepEqual(claimRequestPlan('req_1', 'mcc_secret'), {
    method: 'POST', path: '/api/agent-join-requests/req_1/claim-api-key', public: true, body: { claimSecret: 'mcc_secret' },
  })
})

test('mcEnvLines writes only base/token/workdir — never an LLM key', () => {
  const cfg = parseAgentOnboard(['--invite', 'i', '--adapter', 'claude_code', '--name', 'S', '--workdir', '/w'])
  const env = mcEnvLines(cfg, 'https://mc.example', 'mca_TOKEN')
  assert.match(env, /^MC_BASE_URL=https:\/\/mc\.example$/m)
  assert.match(env, /^MC_AGENT_TOKEN=mca_TOKEN$/m)
  assert.match(env, /^MC_WORKDIR=\/w$/m)
  assert.doesNotMatch(env, /LLM|API_KEY/i) // the standing adapters/CLAUDE.md rule
})
