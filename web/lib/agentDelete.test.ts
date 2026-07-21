import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DELETE_CONSEQUENCES, agentDeletePath, canDeleteAgent, isDeleteConfirmed,
} from './agentDelete.ts'

test('[AAD-2] canDeleteAgent is owner-only and fails closed', () => {
  assert.equal(canDeleteAgent('owner'), true)
  assert.equal(canDeleteAgent('member'), false)
  // 'admin' is NOT a role in this model — an unknown role must never grant delete.
  assert.equal(canDeleteAgent('admin'), false)
  assert.equal(canDeleteAgent('OWNER'), false) // the wire value is lowercase; no fuzzy match
  assert.equal(canDeleteAgent(''), false)
  assert.equal(canDeleteAgent(null), false)
  assert.equal(canDeleteAgent(undefined), false)
})

test('[AAD-2] the delete path is ORG-SCOPED — the owner gate and the audit orgId depend on it', () => {
  assert.equal(agentDeletePath('org-1', 'agent-9'), '/api/orgs/org-1/agents/agent-9')
  // The legacy top-level shape (retired to 410 by AAD-1) must never be produced:
  // `requireOrgRole` silently no-ops on a path with no `:orgId`.
  assert.ok(agentDeletePath('org-1', 'agent-9').startsWith('/api/orgs/'))
})

test('[AAD-2] typed-name confirmation: trims + case-insensitive, never empty, never partial', () => {
  assert.equal(isDeleteConfirmed('Ops', 'Ops'), true)
  assert.equal(isDeleteConfirmed('  ops  ', 'Ops'), true)
  assert.equal(isDeleteConfirmed('OPS', 'Ops'), true)
  assert.equal(isDeleteConfirmed('O', 'Ops'), false)
  assert.equal(isDeleteConfirmed('Ops2', 'Ops'), false)
  assert.equal(isDeleteConfirmed('', 'Ops'), false)
  assert.equal(isDeleteConfirmed('   ', 'Ops'), false)
  // An unnamed agent must not become deletable by typing nothing.
  assert.equal(isDeleteConfirmed('', ''), false)
  assert.equal(isDeleteConfirmed('  ', '   '), false)
})

test('[AAD-2] the dialog names credential revocation — the load-bearing consequence', () => {
  const all = DELETE_CONSEQUENCES.join(' ').toLowerCase()
  assert.ok(all.includes('token'))
  assert.ok(all.includes('revoke'))
  assert.ok(all.includes('secret'))
  assert.ok(all.includes('connector'))
})
