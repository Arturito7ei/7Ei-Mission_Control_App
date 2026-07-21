// AAD-2 (mobile) — the parity tripwire for the create-invite decisions.
//
// The cross-workspace import is safe here for the same reason as elsewhere:
// `web/lib/invites.logic.ts` is dependency-free. Mobile CI installs ONLY
// apps/mobile's lockfile, so a web module that pulled in a dep would drop this
// file silently in CI while passing locally.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CREATE_INVITE_DEFAULTS, INVITE_MAX_TTL_HOURS, INVITE_MAX_USES,
  buildCreateInviteBody, inviteStatusChip, pickableAdapters, toggleAdapterType,
  unavailableAdapters, validateCreateInvite, type AdapterRegistryEntry,
} from './invites.ts'
import {
  CREATE_INVITE_DEFAULTS as WEB_DEFAULTS,
  INVITE_MAX_TTL_HOURS as WEB_MAX_TTL,
  INVITE_MAX_USES as WEB_MAX_USES,
  buildCreateInviteBody as webBuildCreateInviteBody,
  inviteStatusChip as webInviteStatusChip,
  pickableAdapters as webPickableAdapters,
  validateCreateInvite as webValidateCreateInvite,
} from '../../../web/lib/invites.logic.ts'

// A registry payload shaped like the real one: the four BUILT runtimes plus the
// five that are declared-but-unavailable, plus an internal one.
const REGISTRY: AdapterRegistryEntry[] = [
  { type: 'openclaw_local', label: 'OpenClaw (local)', kind: 'local', available: true, invitable: true },
  { type: 'claude_code', label: 'Claude Code', kind: 'local', available: true, invitable: true },
  { type: 'cursor', label: 'Cursor', kind: 'local', available: true, invitable: true },
  { type: 'openai_generic', label: 'OpenAI-compatible', kind: 'http', available: true, invitable: true },
  { type: 'openclaw_gateway', label: 'OpenClaw gateway', kind: 'gateway', available: false, invitable: true, note: 'No outbound WebSocket client yet.' },
  { type: 'http_webhook', label: 'HTTP webhook', kind: 'http', available: false, invitable: true, note: 'Push dispatch is unbuilt.' },
  { type: 'hermes_gateway', label: 'Hermes gateway', kind: 'gateway', available: false, invitable: true, note: 'No Hermes client.' },
  { type: 'hermes_local', label: 'Hermes (local)', kind: 'local', available: false, invitable: true, note: 'Requires spawning a host process.' },
  { type: 'grok_local', label: 'Grok (local)', kind: 'local', available: false, invitable: true, note: 'No xAI provider in the LLM router.' },
  { type: 'internal', label: 'Internal executor', kind: 'internal', available: true, invitable: false },
]

test('[AAD-2] the picker offers ONLY built runtimes — the five deferred ones are never selectable', () => {
  const picks = pickableAdapters(REGISTRY).map((a) => a.type)
  assert.deepEqual(picks, ['openclaw_local', 'claude_code', 'cursor', 'openai_generic'])
  for (const deferred of ['openclaw_gateway', 'http_webhook', 'hermes_gateway', 'hermes_local', 'grok_local']) {
    assert.ok(!picks.includes(deferred), `${deferred} must not be pickable`)
  }
  // …and `internal` is never invitable at all.
  assert.ok(!picks.includes('internal'))
})

test('[AAD-2] the phone and the desk pick the SAME runtimes from the same registry', () => {
  assert.deepEqual(
    pickableAdapters(REGISTRY).map((a) => a.type),
    webPickableAdapters(REGISTRY).map((a) => a.type),
  )
  assert.deepEqual(pickableAdapters(null), webPickableAdapters(null))
  assert.deepEqual(pickableAdapters([]), webPickableAdapters([]))
})

test('[AAD-2] unavailable runtimes are SHOWN as not-yet-available, not hidden — and never internal', () => {
  const shown = unavailableAdapters(REGISTRY).map((a) => a.type)
  assert.deepEqual(shown, ['openclaw_gateway', 'http_webhook', 'hermes_gateway', 'hermes_local', 'grok_local'])
  // The two sets are disjoint: nothing is both selectable and marked unavailable.
  const picks = new Set(pickableAdapters(REGISTRY).map((a) => a.type))
  for (const t of shown) assert.ok(!picks.has(t))
})

test('[AAD-2] the body omits defaults so the SERVER owns single-use + 72h', () => {
  assert.deepEqual(buildCreateInviteBody(CREATE_INVITE_DEFAULTS), {})
  assert.deepEqual(
    buildCreateInviteBody({ adapterTypes: ['cursor'], multiUse: true, uses: 3, ttlHours: 24, message: ' hi ' }),
    { allowedAdapterTypes: ['cursor'], maxUses: 3, expiresInHours: 24, message: 'hi' },
  )
  // Single-use never sends maxUses, whatever `uses` happens to hold.
  assert.deepEqual(buildCreateInviteBody({ ...CREATE_INVITE_DEFAULTS, uses: 9 }), {})
})

test('[AAD-2] the phone and the desk build the SAME body and refuse the same values', () => {
  const forms = [
    CREATE_INVITE_DEFAULTS,
    { adapterTypes: ['claude_code'], multiUse: true, uses: 5, ttlHours: 168, message: '' },
    { adapterTypes: [], multiUse: true, uses: 0, ttlHours: 0, message: 'x' },
    { adapterTypes: [], multiUse: true, uses: 51, ttlHours: 169, message: '' },
  ]
  for (const f of forms) {
    assert.deepEqual(buildCreateInviteBody(f), webBuildCreateInviteBody(f))
    assert.deepEqual(validateCreateInvite(f), webValidateCreateInvite(f))
  }
  assert.equal(INVITE_MAX_USES, WEB_MAX_USES)
  assert.equal(INVITE_MAX_TTL_HOURS, WEB_MAX_TTL)
  assert.deepEqual(CREATE_INVITE_DEFAULTS, WEB_DEFAULTS)
})

test('[AAD-2] status chips are colorblind-safe and agree with the desk', () => {
  for (const s of ['active', 'accepted', 'expired', 'revoked', 'weird', '']) {
    const chip = inviteStatusChip(s)
    assert.ok(chip.icon.length > 0 && chip.label.length > 0)
    assert.deepEqual(chip, webInviteStatusChip(s))
  }
})

test('[AAD-2] toggling the allow-list adds then removes', () => {
  assert.deepEqual(toggleAdapterType([], 'cursor'), ['cursor'])
  assert.deepEqual(toggleAdapterType(['cursor'], 'cursor'), [])
  assert.deepEqual(toggleAdapterType(['cursor'], 'claude_code'), ['cursor', 'claude_code'])
})
