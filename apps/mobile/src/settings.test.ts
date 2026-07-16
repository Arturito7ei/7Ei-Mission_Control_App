// MOB-6f — tripwires for Settings.
//
// The web's Settings tab is inline JSX inside `web/app/dashboard/page.tsx`, so
// its labels and its `Org` type can't be imported — there is no pure module to
// mirror. What IS importable is the thing both clients ultimately read: the
// BACKEND's `orgs` table (`backend/src/db/schema.ts`). So these tests pin the
// phone against the SCHEMA rather than against a copy of the web's copy.
//
// The failure this prevents: a field this screen renders stops being a real
// column (renamed, dropped), and the phone shows a permanently empty section
// with a confident label above it.
//
// And the one that matters more: a CREDENTIAL-shaped field drifting onto this
// screen. `assertNoSensitiveField` is called here against the real field list,
// so adding one fails CI rather than rendering a secret on a handset.
//
// Zero-dep: node --test --experimental-strip-types.

import assert from 'node:assert/strict'
import { test } from 'node:test'
// The SCHEMA module, not `db/client.ts` — client.ts instantiates a Turso
// connection at module scope, which a unit test must not do. schema.ts imports
// only drizzle's table builders, so it loads standalone.
import { organisations } from '../../../backend/src/db/schema.ts'
import {
  SENSITIVE_NAME_RE,
  SETTINGS_FIELDS,
  SETTINGS_READONLY_NOTE,
  SETTINGS_SCOPE_NOTE,
  assertNoSensitiveField,
  fieldValue,
  findOrg,
  type OrgSettingsLite,
} from './settings.ts'

const ORG: OrgSettingsLite = {
  id: 'org-1',
  name: '7Ei',
  description: 'The agent organisation.',
  mission: 'Build the mesh.',
  culture: '',
}

// ─── The schema tripwire ─────────────────────────────────────────────────────

/** The live column list of the table Settings reads (`organisations`). */
const ORG_COLUMNS = Object.keys(organisations)

test('[MOB-6f] every field the screen renders is a real organisations column', () => {
  for (const f of SETTINGS_FIELDS) {
    assert.ok(
      ORG_COLUMNS.includes(f.key),
      `Settings renders "${f.key}", which is not a column on the organisations table. ` +
        `Columns: ${ORG_COLUMNS.join(', ')}`,
    )
  }
})

test('[MOB-6f] the org identity fields the screen leans on exist too', () => {
  assert.ok(ORG_COLUMNS.includes('id'))
  assert.ok(ORG_COLUMNS.includes('name'))
})

test('[MOB-6f] the organisations table HAS a credential column — and Settings excludes it', () => {
  // This is the whole reason the guard exists rather than being theatre. The org
  // row carries `telegramBotToken` (schema.ts) — a live credential sitting one
  // property away from the prose this screen renders. If Settings ever grew to
  // "just show the whole org", it would put a bot token on a phone screen.
  //
  // Assert the hazard is REAL (so this test starts failing loudly if the column
  // is renamed and someone should re-check what else moved), and that the
  // rendered field list does not contain it or any sibling like it.
  const sensitive = ORG_COLUMNS.filter((c) => SENSITIVE_NAME_RE.test(c))
  assert.ok(
    sensitive.includes('telegramBotToken'),
    `Expected organisations.telegramBotToken to still exist (found: ${sensitive.join(', ') || 'none'}). ` +
      'If it was renamed or removed, re-check what Settings is allowed to render.',
  )
  for (const f of SETTINGS_FIELDS) {
    assert.ok(!sensitive.includes(f.key), `Settings must not render the credential column "${f.key}"`)
  }
})

// ─── The secret guard ────────────────────────────────────────────────────────

test('[MOB-6f] Settings renders NO credential-shaped field', () => {
  // The real assertion, against the real list. If someone later adds llmApiKey
  // (a field that IS on the web's org-creation form) to this screen, this fails.
  assert.doesNotThrow(() => assertNoSensitiveField(SETTINGS_FIELDS))
})

test('[MOB-6f] the sensitive-field guard actually catches a credential', () => {
  // A guard that never fires is indistinguishable from no guard. Prove it bites.
  for (const bad of [
    { key: 'llmApiKey', label: 'LLM API key' },
    { key: 'token', label: 'Token' },
    { key: 'x', label: 'Secret sauce' },
    { key: 'adminPassword', label: 'Admin' },
  ]) {
    assert.throws(() => assertNoSensitiveField([bad]), /must not render a credential-shaped field/)
  }
})

test('[MOB-6f] the field list is exactly the web’s three, in the web’s order', () => {
  // Not import-tripwirable (inline JSX). Pinned as literals so a drift is at
  // least a deliberate edit here, next to the comment saying where they came from.
  assert.deepEqual(SETTINGS_FIELDS.map((f) => f.key), ['description', 'mission', 'culture'])
  assert.deepEqual(SETTINGS_FIELDS.map((f) => f.label), [
    'Description',
    'Mission & Vision',
    'Culture & Principles',
  ])
})

test('[MOB-6f] SENSITIVE_NAME_RE is broad enough to be worth having', () => {
  for (const s of ['apiToken', 'SECRET', 'valueEncrypted_key', 'password', 'credential', 'authHeader'])
    assert.match(s, SENSITIVE_NAME_RE)
  for (const s of ['description', 'mission', 'culture', 'name']) assert.doesNotMatch(s, SENSITIVE_NAME_RE)
})

// ─── Reading ─────────────────────────────────────────────────────────────────

test('[MOB-6f] an unset field reads as null so the screen can show its empty line', () => {
  assert.equal(fieldValue(ORG, 'description'), 'The agent organisation.')
  assert.equal(fieldValue(ORG, 'culture'), null) // '' → null
  assert.equal(fieldValue({ ...ORG, mission: null }, 'mission'), null)
  assert.equal(fieldValue({ ...ORG, mission: '   ' }, 'mission'), null)
})

test('[MOB-6f] findOrg picks the session’s org, and admits when it can’t', () => {
  assert.equal(findOrg([ORG], 'org-1')?.id, 'org-1')
  assert.equal(findOrg([ORG], 'org-2'), null)
  assert.equal(findOrg([ORG], null), null)
  assert.equal(findOrg([], 'org-1'), null)
})

// ─── The read-only promise ───────────────────────────────────────────────────

test('[MOB-6f] the screen says where editing lives, and that secrets aren’t here', () => {
  assert.match(SETTINGS_READONLY_NOTE, /read-only/i)
  assert.match(SETTINGS_READONLY_NOTE, /desktop/i)
  assert.match(SETTINGS_SCOPE_NOTE, /secret/i)
})
