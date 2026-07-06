import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOOGLE_CONNECTOR_CONFIG_KEY, GOOGLE_SERVICE_BY_ID,
  defaultGoogleConnectorConfig, parseGoogleConnectorConfig, mergeGoogleConnectorConfig,
} from '../services/connectors'
import { buildAuthUrl } from '../services/google-auth'

// ─── parseGoogleConnectorConfig ──────────────────────────────────────────────

test('[MCA-81] defaults: all services on, primary calendar, whole drive', () => {
  const d = defaultGoogleConnectorConfig()
  assert.deepEqual(d.services, { gmail: true, calendar: true, drive: true })
  assert.equal(d.calendarId, 'primary')
  assert.equal(d.driveScope, 'all')
  assert.equal(d.driveFolderId, undefined)
})

test('[MCA-81] parse: null/undefined/empty → defaults', () => {
  assert.deepEqual(parseGoogleConnectorConfig(null), defaultGoogleConnectorConfig())
  assert.deepEqual(parseGoogleConnectorConfig(undefined), defaultGoogleConnectorConfig())
  assert.deepEqual(parseGoogleConnectorConfig(''), defaultGoogleConnectorConfig())
})

test('[MCA-81] parse: bad json → defaults, no throw', () => {
  assert.deepEqual(parseGoogleConnectorConfig('{nope'), defaultGoogleConnectorConfig())
  assert.deepEqual(parseGoogleConnectorConfig('42'), defaultGoogleConnectorConfig())
})

test('[MCA-81] parse: roundtrip preserves every field', () => {
  const cfg = {
    services: { gmail: false, calendar: true, drive: false },
    calendarId: 'team@group.calendar.google.com',
    driveScope: 'folder' as const,
    driveFolderId: '1AbC',
  }
  assert.deepEqual(parseGoogleConnectorConfig(JSON.stringify(cfg)), cfg)
})

test('[MCA-81] parse: partial blob → defaults fill the gaps', () => {
  const p = parseGoogleConnectorConfig(JSON.stringify({ services: { gmail: false } }))
  assert.deepEqual(p.services, { gmail: false, calendar: true, drive: true })
  assert.equal(p.calendarId, 'primary')
  assert.equal(p.driveScope, 'all')
})

test('[MCA-81] parse: wrong types are ignored in favour of defaults', () => {
  const p = parseGoogleConnectorConfig(JSON.stringify({
    services: { gmail: 'no', calendar: 0 }, calendarId: 7, driveScope: 'everything', driveFolderId: '  ',
  }))
  assert.deepEqual(p, defaultGoogleConnectorConfig())
})

// ─── mergeGoogleConnectorConfig ──────────────────────────────────────────────

test('[MCA-81] merge: partial service toggle keeps the other services', () => {
  const next = mergeGoogleConnectorConfig(defaultGoogleConnectorConfig(), { services: { drive: false } })
  assert.deepEqual(next.services, { gmail: true, calendar: true, drive: false })
  assert.equal(next.calendarId, 'primary')
})

test('[MCA-81] merge: calendarId and drive scope replace, blanks are ignored', () => {
  const cur = defaultGoogleConnectorConfig()
  const next = mergeGoogleConnectorConfig(cur, { calendarId: '  work@x.com  ', driveScope: 'folder', driveFolderId: ' 1AbC ' })
  assert.equal(next.calendarId, 'work@x.com')
  assert.equal(next.driveScope, 'folder')
  assert.equal(next.driveFolderId, '1AbC')
  const blank = mergeGoogleConnectorConfig(next, { calendarId: '   ', driveFolderId: '' })
  assert.equal(blank.calendarId, 'work@x.com') // blank calendarId → keep current
  assert.equal(blank.driveFolderId, undefined) // explicit empty folder id → cleared
})

test('[MCA-81] merge: empty patch is a no-op', () => {
  const cur = parseGoogleConnectorConfig(JSON.stringify({
    services: { gmail: false, calendar: true, drive: true }, calendarId: 'c1', driveScope: 'folder', driveFolderId: 'f1',
  }))
  assert.deepEqual(mergeGoogleConnectorConfig(cur, {}), cur)
})

// ─── registry glue ───────────────────────────────────────────────────────────

test('[MCA-81] connector id → service map covers exactly the google trio', () => {
  assert.deepEqual(GOOGLE_SERVICE_BY_ID, { gmail: 'gmail', gcal: 'calendar', gdrive: 'drive' })
  assert.equal(GOOGLE_SERVICE_BY_ID['github'], undefined)
})

test('[MCA-81] config secret key is stable', () => {
  assert.equal(GOOGLE_CONNECTOR_CONFIG_KEY, 'GOOGLE_CONNECTOR_CONFIG')
})

// ─── switch-account auth URL ─────────────────────────────────────────────────

test('[MCA-81] buildAuthUrl: switchAccount adds select_account, default unchanged', () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client'
  process.env.PUBLIC_URL = 'https://api.example.com'
  const plain = buildAuthUrl('org-1')
  assert.match(plain, /prompt=consent/)
  assert.ok(!plain.includes('select_account'))
  const sw = buildAuthUrl('org-1', { switchAccount: true })
  assert.match(sw, /prompt=select_account\+consent/)
  assert.match(sw, /state=org-1/)
})
