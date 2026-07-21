// AAD-2 (mobile) — the parity tripwire for the delete decisions.
//
// TWO JOBS:
//   1. CROSS-PLATFORM PARITY — import the web module directly and assert the
//      phone's hand-copy agrees. Safe to import ONLY because
//      `web/lib/agentDelete.ts` is dependency-free (no react, no next, no
//      drizzle): Mobile CI installs ONLY apps/mobile's lockfile, so a web module
//      that pulled in a dep would silently drop this whole test file in CI while
//      passing locally (the known cross-workspace-import trap).
//   2. BEHAVIOUR — the fail-closed rules, tested here and not only compared.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DELETE_CONSEQUENCES, agentDeletePath, canDeleteAgent, isDeleteConfirmed,
} from './agentDelete.ts'
import {
  DELETE_CONSEQUENCES as WEB_CONSEQUENCES,
  agentDeletePath as webAgentDeletePath,
  canDeleteAgent as webCanDeleteAgent,
  isDeleteConfirmed as webIsDeleteConfirmed,
} from '../../../web/lib/agentDelete.ts'

test('[AAD-2] canDeleteAgent is owner-only and fails closed', () => {
  assert.equal(canDeleteAgent('owner'), true)
  assert.equal(canDeleteAgent('member'), false)
  assert.equal(canDeleteAgent('admin'), false) // no such role in this model
  assert.equal(canDeleteAgent(null), false)
  assert.equal(canDeleteAgent(undefined), false)
  assert.equal(canDeleteAgent(''), false)
})

test('[AAD-2] the phone and the desk agree on WHO may be offered delete', () => {
  for (const role of ['owner', 'member', 'admin', 'Owner', '', 'viewer', null, undefined]) {
    assert.equal(canDeleteAgent(role), webCanDeleteAgent(role), `role=${String(role)}`)
  }
})

test('[AAD-2] the phone and the desk call the SAME org-scoped route', () => {
  assert.equal(agentDeletePath('o1', 'a1'), '/api/orgs/o1/agents/a1')
  assert.equal(agentDeletePath('o1', 'a1'), webAgentDeletePath('o1', 'a1'))
})

test('[AAD-2] the phone and the desk agree on the typed-name confirmation', () => {
  const cases: [string, string][] = [
    ['Ops', 'Ops'], ['  ops ', 'Ops'], ['OPS', 'Ops'], ['O', 'Ops'],
    ['Ops2', 'Ops'], ['', 'Ops'], ['   ', 'Ops'], ['', ''], ['  ', '  '],
  ]
  for (const [typed, name] of cases) {
    assert.equal(isDeleteConfirmed(typed, name), webIsDeleteConfirmed(typed, name), `${typed}|${name}`)
  }
  assert.equal(isDeleteConfirmed('Ops', 'Ops'), true)
  assert.equal(isDeleteConfirmed('Op', 'Ops'), false)
})

test('[AAD-2] both surfaces name credential revocation, in the same words', () => {
  assert.deepEqual([...DELETE_CONSEQUENCES], [...WEB_CONSEQUENCES])
  const all = DELETE_CONSEQUENCES.join(' ').toLowerCase()
  assert.ok(all.includes('revoke'))
  assert.ok(all.includes('secret'))
  assert.ok(all.includes('connector'))
})
