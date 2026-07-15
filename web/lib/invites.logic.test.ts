// Epic ONB / ONB6 — pure invite-logic tests. Node 22 runner + type-stripping
// (see web/package.json `test`); no test-runner dependency.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickableAdapters, inviteStatusChip, buildCreateInviteBody, validateCreateInvite,
  CREATE_INVITE_DEFAULTS, isJoinRequestApproval, joinRequestChip,
  type AdapterRegistryEntry,
} from './invites.logic.ts'

const REG: AdapterRegistryEntry[] = [
  { type: 'openclaw_local', label: 'OpenClaw', kind: 'local', available: true, invitable: true },
  { type: 'claude_code', label: 'Claude Code', kind: 'local', available: true, invitable: true },
  { type: 'openclaw_gateway', label: 'Gateway', kind: 'gateway', available: false, invitable: true }, // declared, not available
  { type: 'internal', label: 'Internal', kind: 'internal', available: true, invitable: false },       // not invitable
]

test('[ONB6] pickableAdapters keeps only invitable+available, never internal', () => {
  const picks = pickableAdapters(REG).map((a) => a.type)
  assert.deepEqual(picks, ['openclaw_local', 'claude_code'])
  assert.deepEqual(pickableAdapters(null), [])
})

test('[ONB6] inviteStatusChip is colorblind-safe (icon + label, not colour alone)', () => {
  for (const s of ['active', 'accepted', 'expired', 'revoked']) {
    const chip = inviteStatusChip(s)
    assert.ok(chip.icon.length > 0 && chip.label.length > 0)
  }
  assert.equal(inviteStatusChip('revoked').tone, 'fail')
  assert.equal(inviteStatusChip('active').tone, 'ok')
  assert.equal(inviteStatusChip('weird').label, 'weird') // unknown falls through with the raw value
})

test('[ONB6] buildCreateInviteBody omits defaults so the backend applies its own', () => {
  assert.deepEqual(buildCreateInviteBody(CREATE_INVITE_DEFAULTS), {}) // single-use, 72h, any adapter, no message
  assert.deepEqual(
    buildCreateInviteBody({ adapterTypes: ['claude_code'], multiUse: true, uses: 5, ttlHours: 48, message: '  hi  ' }),
    { allowedAdapterTypes: ['claude_code'], maxUses: 5, expiresInHours: 48, message: 'hi' },
  )
  // single-use never sends maxUses even if `uses` is set
  assert.deepEqual(buildCreateInviteBody({ adapterTypes: [], multiUse: false, uses: 9, ttlHours: 72, message: '' }), {})
})

test('[ONB6] validateCreateInvite mirrors the backend bounds', () => {
  assert.deepEqual(validateCreateInvite(CREATE_INVITE_DEFAULTS), [])
  assert.equal(validateCreateInvite({ ...CREATE_INVITE_DEFAULTS, multiUse: true, uses: 99 }).length, 1)
  assert.equal(validateCreateInvite({ ...CREATE_INVITE_DEFAULTS, ttlHours: 9999 }).length, 1)
  assert.equal(validateCreateInvite({ ...CREATE_INVITE_DEFAULTS, ttlHours: 0 }).length, 1)
})

test('[ONB6] join-request approvals are recognised and get their own chip', () => {
  assert.equal(isJoinRequestApproval('agent_join_request'), true)
  assert.equal(isJoinRequestApproval('agent_create'), false)
  assert.equal(isJoinRequestApproval(null), false)
  assert.ok(joinRequestChip().icon && joinRequestChip().label.includes('join'))
})
