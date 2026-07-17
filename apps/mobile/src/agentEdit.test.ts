// MOB-7d — the phone's agent-settings EDITOR is a mirror of the web's, so the
// thing worth testing is that it stays one AND that it validates a form the same
// way the backend will. Two kinds of test live here:
//
//   1. PARITY TRIPWIRES — import the real (dep-free) sources and assert the phone's
//      copies agree: backend/src/services/agent-config.ts (CONFIG_FIELDS, RUNTIMES,
//      wouldCycle, and validateConfigPatch's verdicts), web/lib/agentSkills.ts (the
//      whole-selection toggle logic), web/lib/trust.ts (TRUST_MODES). If a cap, an
//      enum value, or a message drifts on either side, one of these fails.
//
//   2. BEHAVIOUR — the client-only decisions (owner gating, body building) that have
//      no server peer to pin against.
//
// Zero-dep, matching the repo convention: node --test --experimental-strip-types.
// Every imported source is React-free / dep-free, which is what makes it loadable
// here at all — Mobile CI installs only apps/mobile, so a source that pulled a real
// dependency would SILENTLY drop this whole file (see the memory on cross-workspace
// test imports). agent-config.ts, agentSkills.ts and trust.ts are all import-free.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONFIG_FIELDS as WEB_CONFIG_FIELDS,
  RUNTIMES as BE_RUNTIMES,
  wouldCycle as beWouldCycle,
  validateConfigPatch,
} from '../../../backend/src/services/agent-config.ts'
import {
  nextSelection as webNextSelection,
  selectionOf as webSelectionOf,
  optimisticSplit as webOptimisticSplit,
  type SkillsPayload as WebSkillsPayload,
} from '../../../web/lib/agentSkills.ts'
import { TRUST_MODES as WEB_TRUST_MODES } from '../../../web/lib/trust.ts'

import {
  ADAPTER_LABEL,
  AVATAR_EMOJI_MAX_CODEPOINTS,
  CONFIG_CAPS,
  CONFIG_FIELDS,
  REASONING_EFFORTS,
  RUNTIMES,
  TRUST_MODES,
  buildConfigBody,
  buildModelProfileBody,
  buildTrustBody,
  isOwnerRole,
  nextSelection,
  optimisticSplit,
  parseTrustMode,
  selectionOf,
  trustConfirm,
  validateConfigForm,
  validateModelProfileForm,
  wouldCycle,
  type ConfigForm,
  type ModelProfileForm,
  type SkillsPayload,
} from './agentEdit.ts'

// ─── Parity: config fields, runtimes, caps ──────────────────────────────────────

test('CONFIG_FIELDS mirrors the backend allow-list exactly', () => {
  assert.deepEqual([...CONFIG_FIELDS], [...WEB_CONFIG_FIELDS])
})

test('RUNTIMES mirrors the backend runtime enum exactly', () => {
  assert.deepEqual([...RUNTIMES], [...BE_RUNTIMES])
})

test('every runtime has an adapter label — no runtime ships label-less', () => {
  assert.deepEqual(Object.keys(ADAPTER_LABEL).sort(), [...RUNTIMES].sort())
})

test('REASONING_EFFORTS is the backend literal (model-profile.ts is not dep-free to import)', () => {
  assert.deepEqual([...REASONING_EFFORTS], ['low', 'medium', 'high'])
})

test('TRUST_MODES mirrors web/lib/trust.ts', () => {
  assert.deepEqual([...TRUST_MODES], [...WEB_TRUST_MODES])
})

// ─── Parity: wouldCycle is a verbatim mirror ─────────────────────────────────────

test('wouldCycle agrees with the backend across the interesting shapes', () => {
  const roster = [
    { id: 'a', reportsTo: null },
    { id: 'b', reportsTo: 'a' },
    { id: 'c', reportsTo: 'b' },
  ]
  const cases: [string, string][] = [
    ['a', 'a'], // self
    ['a', 'b'], // a is above b → cycle
    ['a', 'c'], // a is above c (via b) → cycle
    ['b', 'a'], // ok
    ['c', 'a'], // ok
    ['b', 'c'], // b is above c → cycle
  ]
  for (const [agentId, managerId] of cases) {
    assert.equal(
      wouldCycle(roster, agentId, managerId),
      beWouldCycle(roster, agentId, managerId),
      `wouldCycle drift on ${agentId}→${managerId}`,
    )
  }
})

// ─── Parity: validateConfigForm accepts iff validateConfigPatch accepts ──────────
// The phone validates a whole FORM; the backend validates a PATCH. To compare, we
// turn the form into the same body the phone sends and run the backend validator on
// it. Same accept/reject verdict, same error text = no drift.

const baseForm = (over: Partial<ConfigForm> = {}): ConfigForm => ({
  name: 'Aria',
  title: '',
  role: 'Engineer',
  jobDescription: '',
  avatarEmoji: '',
  contactChannel: '',
  reportsTo: '',
  runtime: 'internal',
  model: '',
  ...over,
})

const roster = [{ id: 'self', reportsTo: null }, { id: 'mgr', reportsTo: null }]

function backendVerdict(form: ConfigForm) {
  return validateConfigPatch(buildConfigBody(form), { agentId: 'self', agents: roster })
}

test('a valid form passes both the phone and the backend', () => {
  const form = baseForm({ reportsTo: 'mgr' })
  assert.deepEqual(validateConfigForm(form, { agentId: 'self', agents: roster }), { ok: true })
  assert.equal(backendVerdict(form).ok, true)
})

test('empty name is rejected with the backend’s exact message', () => {
  const form = baseForm({ name: '   ' })
  const v = validateConfigForm(form)
  assert.equal(v.ok, false)
  assert.equal(v.ok === false && v.field, 'name')
  assert.equal(v.ok === false && v.error, 'Name is required.')
  assert.equal(backendVerdict(form).ok, false)
})

test('over-long name: phone and backend agree on rejection and wording', () => {
  const form = baseForm({ name: 'x'.repeat(101) })
  const v = validateConfigForm(form)
  const b = backendVerdict(form)
  assert.equal(v.ok, false)
  assert.equal(b.ok, false)
  assert.equal(v.ok === false && v.error, b.ok === false ? b.error : '')
})

test('empty role is rejected', () => {
  const v = validateConfigForm(baseForm({ role: '' }))
  assert.equal(v.ok === false && v.field, 'role')
  assert.equal(v.ok === false && v.error, 'Role is required.')
})

test('an unknown runtime is rejected by both, same wording', () => {
  const form = baseForm({ runtime: 'skynet' })
  const v = validateConfigForm(form)
  const b = backendVerdict(form)
  assert.equal(v.ok === false && v.error, 'Unknown adapter "skynet".')
  assert.equal(b.ok, false)
})

test('a reports-to cycle is caught client-side before the call', () => {
  // self → mgr, and mgr already reports to self ⇒ making self report to mgr loops.
  const cyclic = [{ id: 'self', reportsTo: null }, { id: 'mgr', reportsTo: 'self' }]
  const v = validateConfigForm(baseForm({ reportsTo: 'mgr' }), { agentId: 'self', agents: cyclic })
  assert.equal(v.ok === false && v.field, 'reportsTo')
  assert.match(v.ok === false ? v.error : '', /reporting loop/)
})

test('reports-to an unknown agent is rejected', () => {
  const v = validateConfigForm(baseForm({ reportsTo: 'ghost' }), { agentId: 'self', agents: roster })
  assert.equal(v.ok === false && v.field, 'reportsTo')
})

test('avatarEmoji over 4 code points is rejected; a ZWJ emoji within 4 passes', () => {
  assert.equal(validateConfigForm(baseForm({ avatarEmoji: '🤖🤖🤖🤖🤖' })).ok, false)
  // 👩‍💻 is 3 code points (woman + ZWJ + laptop) — within the cap, like the backend.
  assert.equal(validateConfigForm(baseForm({ avatarEmoji: '👩‍💻' })).ok, true)
})

// ─── buildConfigBody ─────────────────────────────────────────────────────────────

test('buildConfigBody writes the model to BOTH llmModel and primaryModel, and omits it when blank', () => {
  const withModel = buildConfigBody(baseForm({ model: 'claude-opus-4-8' }))
  assert.equal(withModel.llmModel, 'claude-opus-4-8')
  assert.equal(withModel.primaryModel, 'claude-opus-4-8')

  const blank = buildConfigBody(baseForm({ model: '' }))
  assert.equal('llmModel' in blank, false)
  assert.equal('primaryModel' in blank, false)
})

test('buildConfigBody only carries config-allow-listed keys (never a stray column)', () => {
  const body = buildConfigBody(baseForm({ model: 'm' }))
  for (const key of Object.keys(body)) {
    assert.ok((CONFIG_FIELDS as readonly string[]).includes(key), `unexpected key in config body: ${key}`)
  }
})

// ─── Model profile ───────────────────────────────────────────────────────────────

const mpForm = (over: Partial<ModelProfileForm> = {}): ModelProfileForm => ({
  primaryModel: '',
  cheapModel: '',
  cheapModelEnabled: false,
  reasoningEffort: '',
  ...over,
})

test('a blank reasoning effort is allowed (provider default); an unknown one is not', () => {
  assert.equal(validateModelProfileForm(mpForm({ reasoningEffort: '' })).ok, true)
  assert.equal(validateModelProfileForm(mpForm({ reasoningEffort: 'high' })).ok, true)
  assert.equal(validateModelProfileForm(mpForm({ reasoningEffort: 'ludicrous' })).ok, false)
})

test('buildModelProfileBody always sends the four keys (backend 400s an empty patch)', () => {
  const body = buildModelProfileBody(mpForm({ cheapModel: 'haiku', cheapModelEnabled: true, reasoningEffort: 'Low' }))
  assert.deepEqual(Object.keys(body).sort(), ['cheapModel', 'cheapModelEnabled', 'primaryModel', 'reasoningEffort'])
  assert.equal(body.cheapModelEnabled, true)
  assert.equal(body.reasoningEffort, 'low') // normalised lower-case
})

// ─── Trust ───────────────────────────────────────────────────────────────────────

test('parseTrustMode never silently lowers containment on garbage', () => {
  assert.equal(parseTrustMode('nonsense'), 'standard')
  assert.equal(parseTrustMode('  LOW_TRUST_REVIEW '), 'low_trust_review')
  assert.equal(parseTrustMode(null), 'standard')
})

test('buildTrustBody carries the chosen mode', () => {
  assert.deepEqual(buildTrustBody('low_trust_review'), { trustMode: 'low_trust_review' })
})

test('trustConfirm names the direction — raising vs removing containment read differently', () => {
  assert.match(trustConfirm('standard', 'low_trust_review'), /require approval/)
  assert.match(trustConfirm('low_trust_review', 'standard'), /REMOVE that containment/)
})

// ─── Owner gating ────────────────────────────────────────────────────────────────

test('only the owner role may edit; everything else fails closed', () => {
  assert.equal(isOwnerRole('owner'), true)
  assert.equal(isOwnerRole('member'), false)
  assert.equal(isOwnerRole('admin'), false) // no such role in this model — fail closed
  assert.equal(isOwnerRole(null), false)
  assert.equal(isOwnerRole(undefined), false)
  assert.equal(isOwnerRole(''), false)
})

// ─── Skills: parity with web/lib/agentSkills.ts ──────────────────────────────────

const payload = (): SkillsPayload => ({
  installed: [{ id: '1', name: 'search', installed: true }],
  other: [{ id: '2', name: 'browse', installed: false }, { id: '3', name: 'email', installed: false }],
  orphaned: ['legacy'],
  selectedCount: 2,
  adapter: 'internal',
  model: 'claude',
})

test('selectionOf mirrors the web (installed names + orphans)', () => {
  const p = payload()
  assert.deepEqual(selectionOf(p), webSelectionOf(p as unknown as WebSkillsPayload))
})

test('nextSelection toggles the same way as the web', () => {
  const cur = ['search', 'legacy']
  assert.deepEqual(nextSelection(cur, 'browse'), webNextSelection(cur, 'browse'))
  assert.deepEqual(nextSelection(cur, 'search'), webNextSelection(cur, 'search'))
})

test('optimisticSplit predicts the exact same split as the web', () => {
  const p = payload()
  const selection = ['browse', 'legacy'] // install browse, uninstall search, keep orphan
  const mine = optimisticSplit(p, selection)
  const theirs = webOptimisticSplit(p as unknown as WebSkillsPayload, selection)
  assert.deepEqual(mine.installed.map((s) => s.name), theirs.installed.map((s) => s.name))
  assert.deepEqual(mine.other.map((s) => s.name), theirs.other.map((s) => s.name))
  assert.deepEqual(mine.orphaned, theirs.orphaned)
  assert.equal(mine.selectedCount, theirs.selectedCount)
})

test('CONFIG_CAPS match the backend messages they mirror', () => {
  // A cheap guard that the cap numbers didn't drift from the wording the messages use.
  assert.equal(CONFIG_CAPS.name, 100)
  assert.equal(CONFIG_CAPS.role, 200)
  assert.equal(CONFIG_CAPS.jobDescription, 4000)
  assert.equal(CONFIG_CAPS.contactChannel, 200)
  assert.equal(CONFIG_CAPS.model, 200)
  assert.equal(AVATAR_EMOJI_MAX_CODEPOINTS, 4)
})
