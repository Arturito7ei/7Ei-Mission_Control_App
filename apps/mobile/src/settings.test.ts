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
// ⚠ WHY THIS SCANS THE SCHEMA'S SOURCE INSTEAD OF IMPORTING IT.
//
// The obvious version of this test — `import { organisations } from
// '../../../backend/src/db/schema.ts'` — passes locally and FAILS IN CI, which
// is the worst way for a test to be wrong. The Mobile job runs `npm ci` **inside
// `apps/mobile`** (.github/workflows/ci.yml), so only this workspace's deps are
// installed. A local run resolves `drizzle-orm/sqlite-core` from the hoisted
// root `node_modules` and the import works; CI has no drizzle, the module fails
// to LOAD, and the whole file's tests silently don't run (they don't fail — the
// file exits 1 and the count just drops).
//
// So the rule this file exists to record: a cross-workspace tripwire may IMPORT
// another workspace's source only if that source is DEPENDENCY-FREE.
// `web/lib/trust.ts` and `backend/src/services/connectors.ts` are (hence
// governance.test.ts and connectors.test.ts import them happily); `schema.ts`
// imports drizzle, so it isn't.
//
// Reading the source as TEXT keeps the tripwire and drops the dependency: it
// still goes red if `telegramBotToken` is renamed or if a rendered field stops
// being a column. It's the source-scan idiom `status.test.ts` already
// established here — and it carries that idiom's mandatory guard: assert the
// scan actually FOUND something, because a scan that silently matches nothing
// passes forever.
//
// Zero-dep: node --test --experimental-strip-types. No import beyond node:*.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CREDENTIAL_BEARING_FIELDS,
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

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../backend/src/db/schema.ts',
)

/**
 * The column identifiers of one `sqliteTable(...)` block, read out of the
 * schema's SOURCE. Brace-matched from the table's opening `{` so a later table
 * in the file can't leak its columns into this one.
 */
function tableColumns(source: string, table: string): string[] {
  const start = source.indexOf(`export const ${table} = sqliteTable(`)
  assert.notEqual(start, -1, `schema.ts no longer declares a "${table}" table — re-check what Settings reads.`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `Could not find the column block for "${table}".`)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.notEqual(end, -1, `Unbalanced braces walking the "${table}" column block.`)
  const body = source.slice(open, end)
  // `  someColumn: text('some_column')` → someColumn. Only at a property
  // position followed by a drizzle column builder, so nested option objects
  // (`{ onDelete: 'cascade' }`) don't register as columns.
  return [...body.matchAll(/(\w+)\s*:\s*(?:text|integer|real|blob|numeric)\s*\(/g)].map((m) => m[1])
}

/** The live column list of the table Settings reads (`organisations`). */
const ORG_COLUMNS = tableColumns(readFileSync(SCHEMA_PATH, 'utf8'), 'organisations')

test('[MOB-6f] the schema scan actually found columns', () => {
  // The guard the source-scan idiom requires: a regex that quietly matches
  // nothing would make every assertion below vacuously true, forever.
  assert.ok(ORG_COLUMNS.length > 5, `Scanned only ${ORG_COLUMNS.length} columns — the scan is broken, not the schema.`)
})

test('[MOB-6f] the scan reads the real table, not a neighbouring one', () => {
  // The other half of the idiom: prove the scanner BITES, on input we control.
  // A scan that quietly grabbed the next table's columns would report
  // `apiToken` as an org column and make the exclusion test meaningless.
  const SRC = `
export const organisations = sqliteTable('organisations', {
  id: text('id').primaryKey(),
  mission: text('mission'),
  telegramBotToken: text('telegram_bot_token'),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
})

export const secrets = sqliteTable('secrets', {
  apiToken: text('api_token'),
})
`
  assert.deepEqual(tableColumns(SRC, 'organisations'), [
    'id',
    'mission',
    'telegramBotToken',
    'ownerId',
  ])
  // `onDelete: 'cascade'` is not a column, and `secrets.apiToken` is not ours.
  assert.ok(!tableColumns(SRC, 'organisations').includes('apiToken'))
  assert.ok(!tableColumns(SRC, 'organisations').includes('onDelete'))
  assert.deepEqual(tableColumns(SRC, 'secrets'), ['apiToken'])
  // A table that isn't there must fail loudly, not return [].
  assert.throws(() => tableColumns(SRC, 'nonexistent'), /no longer declares/)
})

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

test('[MOB-6f] the guard catches a credential-BEARING column whose name does not smell', () => {
  // The audit nit (#293), and the sharper half of this guard. `deployConfig`
  // stores LLM API keys — org creation writes `<provider>_api_key` into it in
  // PLAINTEXT (backend/src/routes/orgs.ts) — but the name sails straight past a
  // regex looking for "key"/"token"/"secret". A name-based check alone would let
  // it onto the screen.
  assert.throws(
    () => assertNoSensitiveField([{ key: 'deployConfig', label: 'Deploy config' }]),
    /CARRIES a credential/,
  )
  // And the regex must NOT be what caught it — otherwise the deny-list is
  // decorative and would rot without anyone noticing.
  assert.doesNotMatch('deployConfig', SENSITIVE_NAME_RE)
})

test('[MOB-6f] every credential-bearing column named in the deny-list still exists', () => {
  // A deny-list entry that no longer matches a real column is a dead guard
  // pointing at nothing — and, worse, hides that the credential moved somewhere
  // this screen isn't checking.
  for (const key of CREDENTIAL_BEARING_FIELDS) {
    assert.ok(
      ORG_COLUMNS.includes(key),
      `CREDENTIAL_BEARING_FIELDS names "${key}", which is no longer an organisations column. ` +
        `Find where that credential moved before deleting the entry. Columns: ${ORG_COLUMNS.join(', ')}`,
    )
  }
})

test('[MOB-6f] Settings renders none of the credential-bearing columns', () => {
  for (const f of SETTINGS_FIELDS) {
    assert.ok(!CREDENTIAL_BEARING_FIELDS.has(f.key), `Settings must not render "${f.key}"`)
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
