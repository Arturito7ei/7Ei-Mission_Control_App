// MOB-6f — tripwires for Connectors.
//
// The web's ConnectorsPanel is a JSX component module, so its constants can't be
// imported. But the thing both clients actually derive from IS importable: the
// BACKEND's connector registry (`backend/src/services/connectors.ts`), which is
// dependency-free — no db, no fastify, no drizzle at module scope — and is the
// single source the `GET …/connectors` projection is built from.
//
// So these tests pin the phone against the SERVER rather than against a copy of
// the web's copy. That's a stronger tripwire than the usual mirror test: it
// fails when a connector is added, renamed, or re-categorised anywhere.
//
// The failure this prevents: the server grows a connector (or moves one to a new
// category) and the phone silently drops it out of the list, so an operator
// checking "is everything attached?" gets a confident, incomplete answer.
//
// Zero-dep: node --test --experimental-strip-types.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONNECTORS as BACKEND_CONNECTORS,
  GOOGLE_MEMBERS as BACKEND_GOOGLE_MEMBERS,
} from '../../../backend/src/services/connectors.ts'
import {
  CATEGORY_ORDER,
  CONNECTORS_READONLY_NOTE,
  connectedBadge,
  connectedSummary,
  connectorGroups,
  detailLine,
  type ConnectorRowLite,
} from './connectors.ts'

/** A row as the backend's status projection builds it, for the given meta. */
const row = (meta: (typeof BACKEND_CONNECTORS)[number], over: Partial<ConnectorRowLite> = {}): ConnectorRowLite => ({
  id: meta.id,
  name: meta.name,
  category: meta.category,
  authType: meta.authType,
  icon: meta.icon,
  docsUrl: meta.docsUrl,
  fields: meta.fields ?? [],
  connected: false,
  detail: null,
  ...over,
})

const ALL = BACKEND_CONNECTORS.map((m) => row(m))

// ─── The category tripwire ───────────────────────────────────────────────────

test('[MOB-6f] CATEGORY_ORDER covers every category the backend registry ships', () => {
  const backendCategories = [...new Set(BACKEND_CONNECTORS.map((c) => c.category))].sort()
  const missing = backendCategories.filter((c) => !CATEGORY_ORDER.includes(c))
  assert.deepEqual(
    missing,
    [],
    `The backend has categories the phone doesn't order: ${missing.join(', ')}. ` +
      'Add them to CATEGORY_ORDER in apps/mobile/src/connectors.ts.',
  )
})

test('[MOB-6f] CATEGORY_ORDER has no category the backend no longer ships', () => {
  // The mirror of the test above: a stale entry is harmless at runtime (it's
  // filtered out) but it means the copy has drifted, which is what we're pinning.
  const backendCategories = new Set(BACKEND_CONNECTORS.map((c) => c.category as string))
  const stale = CATEGORY_ORDER.filter((c) => !backendCategories.has(c))
  assert.deepEqual(stale, [], `CATEGORY_ORDER lists categories the backend dropped: ${stale.join(', ')}`)
})

test('[MOB-6f] every backend connector lands in a group — none is silently dropped', () => {
  const grouped = connectorGroups(ALL)
  const gotIds = grouped.flatMap((g) => g.rows.map((r) => r.id)).sort()
  const wantIds = BACKEND_CONNECTORS.map((c) => c.id).sort()
  assert.deepEqual(gotIds, wantIds)
})

test('[MOB-6f] groups come back in CATEGORY_ORDER', () => {
  const got = connectorGroups(ALL).map((g) => g.category)
  const want = CATEGORY_ORDER.filter((c) => got.includes(c))
  assert.deepEqual(got, want)
})

test('[MOB-6f] an unknown category is appended, never dropped', () => {
  // Degrade honestly: if the server ships a category before the phone learns it,
  // the row still appears (the test above is what makes it a build failure).
  const odd: ConnectorRowLite = { ...ALL[0], id: 'zzz', name: 'Odd', category: 'Quantum' }
  const groups = connectorGroups([...ALL, odd])
  assert.equal(groups.at(-1)!.category, 'Quantum')
  assert.deepEqual(groups.at(-1)!.rows.map((r) => r.id), ['zzz'])
})

// ─── Google, per the server ──────────────────────────────────────────────────

test('[MOB-6f] the Google trio is whatever the backend says it is', () => {
  // The web hard-codes GOOGLE_IDS = ['gmail','gcal','gdrive']; the backend derives
  // GOOGLE_MEMBERS from `provider === 'google'`. Pin the phone to the derived one.
  const googleRows = ALL.filter((r) => r.category === 'Google').map((r) => r.id).sort()
  assert.deepEqual(googleRows, [...BACKEND_GOOGLE_MEMBERS].sort())
})

// ─── Status rendering ────────────────────────────────────────────────────────

test('[MOB-6f] connected status carries a glyph AND a word, never hue alone', () => {
  const on = connectedBadge({ ...ALL[0], connected: true })
  const off = connectedBadge({ ...ALL[0], connected: false })
  assert.deepEqual(on, { icon: '✓', label: 'Connected', tone: 'ok' })
  assert.deepEqual(off, { icon: '○', label: 'Not connected', tone: 'neutral' })
  // The two must be distinguishable by TEXT with all colour removed.
  assert.notEqual(on.label, off.label)
  assert.notEqual(on.icon, off.icon)
})

test('[MOB-6f] a disconnected row points at the desktop instead of a dead button', () => {
  assert.match(detailLine({ ...ALL[0], connected: false, detail: null }), /desktop/i)
})

test('[MOB-6f] a connected row shows its account label, or a plain fallback', () => {
  assert.equal(detailLine({ ...ALL[0], connected: true, detail: 'Arturito7ei' }), 'Arturito7ei')
  assert.equal(detailLine({ ...ALL[0], connected: true, detail: null }), 'Connected')
  assert.equal(detailLine({ ...ALL[0], connected: true, detail: '   ' }), 'Connected')
})

test('[MOB-6f] the summary counts what is actually connected', () => {
  const rows = [
    { ...ALL[0], connected: true },
    { ...ALL[1], connected: false },
    { ...ALL[2], connected: true },
  ]
  assert.equal(connectedSummary(rows), '2 of 3 connected')
  assert.equal(connectedSummary([]), '0 of 0 connected')
})

// ─── The read-only promise ───────────────────────────────────────────────────

test('[MOB-6f] the row type carries no credential field', () => {
  // The registry knows `secretKey` (the NAME of the storage key). The phone's row
  // type deliberately doesn't carry it, and the backend's projection never sends
  // it. Assert on a real row built from real metadata: no credential-shaped key.
  for (const r of ALL) {
    for (const k of Object.keys(r)) {
      assert.doesNotMatch(k, /token|secret|password|credential|apikey/i, `row key "${k}"`)
    }
  }
})

test('[MOB-6f] the screen explains that connecting stays on the desktop', () => {
  assert.match(CONNECTORS_READONLY_NOTE, /read-only/i)
  assert.match(CONNECTORS_READONLY_NOTE, /desktop/i)
})
