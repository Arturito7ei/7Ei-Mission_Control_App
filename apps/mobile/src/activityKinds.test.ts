// ACT-1 — the activity-vocabulary DRIFT TRIPWIRE (backend ⇄ web ⇄ phone).
//
// `activityKinds.ts` hand-copies ACTIVITY_KINDS / ACTIVITY_OUTCOMES / OWNER_ONLY_KINDS
// from backend/src/services/activity.ts, because Metro cannot import backend source.
// A copy without a tripwire is silent drift, and drift here is not cosmetic: a kind the
// phone doesn't know renders as a blank row, and an OWNER_ONLY_KINDS copy that drifts
// would have the phone promise a filter the server refuses to honour.
//
// The BACKEND side is TEXT-READ rather than imported. backend/src/services/activity.ts
// happens to be import-free TODAY, so a direct import would work — and that is exactly
// the trap: the day someone adds one import to it, Mobile CI (which installs ONLY
// apps/mobile's dependencies) would drop this ENTIRE file silently while it still passed
// on a dev machine with the full monorepo installed. Reading the source as text is
// immune to that. The WEB side is imported directly, which is safe only because
// web/lib/activityKinds.ts is deliberately import-free — asserted below, so the
// safety of that shortcut is checked rather than assumed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ACTIVITY_KINDS, ACTIVITY_OUTCOMES, OWNER_ONLY_KINDS, KIND_LABEL, OUTCOME_LABEL,
  isActivityKind, activityAgo, activityQuery,
} from './activityKinds.ts'
import {
  ACTIVITY_KINDS as WEB_KINDS,
  ACTIVITY_OUTCOMES as WEB_OUTCOMES,
  OWNER_ONLY_KINDS as WEB_OWNER_ONLY,
  activityQuery as WEB_QUERY,
  activityAgo as WEB_AGO,
} from '../../../web/lib/activityKinds.ts'

const BACKEND_SRC = new URL('../../../backend/src/services/activity.ts', import.meta.url)
const WEB_SRC = new URL('../../../web/lib/activityKinds.ts', import.meta.url)

/** Pull a `export const NAME[: type] = [ ... ]` string array out of the backend source.
 *
 *  Anchored on `export const` deliberately: these names also appear in the prose comments
 *  of that file, and a looser anchor would happily parse an array out of a comment and
 *  then compare against it. `[^=]*` skips an optional type annotation (OWNER_ONLY_KINDS
 *  carries `: readonly ActivityKind[]`) without being able to cross an `=`. */
function backendArray(name: string): string[] {
  const src = readFileSync(BACKEND_SRC, 'utf8')
  const m = new RegExp('export const ' + name + '[^=]*=\\s*\\[([\\s\\S]*?)\\]').exec(src)
  assert.ok(m, `could not locate ${name} in the backend source — re-anchor this regex, do not delete the test`)
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

const sorted = (a: readonly string[]) => [...a].sort()

test('[ACT-1] the phone’s activity KINDS equal the backend’s', () => {
  const backend = backendArray('ACTIVITY_KINDS')
  assert.ok(backend.length > 0, 'backend set parsed empty — the check would be vacuous')
  assert.deepEqual(
    sorted(ACTIVITY_KINDS), sorted(backend),
    'apps/mobile/src/activityKinds.ts drifted from backend/src/services/activity.ts — ' +
      'reconcile before merging (an unknown kind renders as a blank row in the feed)',
  )
})

test('[ACT-1] the phone’s activity OUTCOMES equal the backend’s', () => {
  const backend = backendArray('ACTIVITY_OUTCOMES')
  assert.ok(backend.length > 0, 'backend set parsed empty — the check would be vacuous')
  assert.deepEqual(
    sorted(ACTIVITY_OUTCOMES), sorted(backend),
    'outcome vocabulary drifted — a status the phone cannot label renders with no badge',
  )
})

test('[ACT-1] the phone’s OWNER-ONLY kinds equal the backend’s', () => {
  const backend = backendArray('OWNER_ONLY_KINDS')
  assert.ok(backend.length > 0, 'backend set parsed empty — the check would be vacuous')
  assert.deepEqual(
    sorted(OWNER_ONLY_KINDS), sorted(backend),
    'OWNER_ONLY_KINDS drifted — the phone would offer a filter the server refuses, ' +
      'or hide one it would happily serve',
  )
})

test('[ACT-1] the phone’s vocabulary equals the WEB’s — the parity rule, both directions', () => {
  assert.ok(WEB_KINDS.length > 0, 'web set imported empty — the check would be vacuous')
  assert.deepEqual(sorted(ACTIVITY_KINDS), sorted(WEB_KINDS), 'kinds differ between web and phone')
  assert.deepEqual(sorted(ACTIVITY_OUTCOMES), sorted(WEB_OUTCOMES), 'outcomes differ between web and phone')
  assert.deepEqual(sorted(OWNER_ONLY_KINDS), sorted(WEB_OWNER_ONLY), 'owner-only kinds differ between web and phone')
})

test('[ACT-1] the web copy stays IMPORT-FREE — otherwise this whole file vanishes in CI', () => {
  const src = readFileSync(WEB_SRC, 'utf8')
  const offending = src.split('\n').filter((l) => /^\s*import\s/.test(l) || /^\s*(export\s+)?.*\brequire\(/.test(l))
  assert.deepEqual(
    offending, [],
    'web/lib/activityKinds.ts gained an import. Mobile CI installs only apps/mobile, so ' +
      'the direct import at the top of THIS file would fail to resolve and node --test would ' +
      'drop the entire file — every assertion above would stop running while CI stayed green. ' +
      'Move the dependency out, or convert the web side to a TEXT-READ like the backend side.',
  )
})

test('[ACT-1] every kind and outcome has a human label — no blank chip', () => {
  for (const k of ACTIVITY_KINDS) {
    assert.ok(KIND_LABEL[k] && KIND_LABEL[k].length > 0, `no label for kind ${k}`)
  }
  for (const o of ACTIVITY_OUTCOMES) {
    assert.ok(OUTCOME_LABEL[o] && OUTCOME_LABEL[o].length > 0, `no label for outcome ${o}`)
  }
})

test('[ACT-1] isActivityKind accepts the vocabulary and refuses everything else', () => {
  for (const k of ACTIVITY_KINDS) assert.equal(isActivityKind(k), true)
  for (const junk of ['', 'nonsense', 'APPROVAL_FILED', null, undefined, 7, {}]) {
    assert.equal(isActivityKind(junk), false, `accepted junk: ${String(junk)}`)
  }
})

test('[ACT-1] activityAgo reads as an age, and never as a negative or NaN', () => {
  const now = 1_000_000_000
  assert.equal(activityAgo(now, now), 'just now')
  assert.equal(activityAgo(now - 30_000, now), 'just now')
  assert.equal(activityAgo(now - 90_000, now), '1m ago')
  assert.equal(activityAgo(now - 3 * 3600_000, now), '3h ago')
  assert.equal(activityAgo(now - 50 * 3600_000, now), '2d ago')
  // A clock-skewed row from the future must not render "-3m ago".
  assert.equal(activityAgo(now + 60_000, now), 'just now')
})

// ─── AUDIT-ACT1 H-2 — the BEHAVIOUR parity the vocabulary tripwire did not cover ────
//
// `ACTIVITY_KINDS` and friends were pinned three ways; `activityQuery` and `activityAgo`
// are hand-copied the same way and were pinned NOT AT ALL. The only guard was three
// source-text greps for the literal `activityQuery(`, which prove each surface calls a
// function of that NAME — never that the two functions ask the server the same question.
// An audit drifted the phone's copy on two axes at once (limit clamp 100 -> 5000,
// `agentId=` -> `agent=`) and all 327 mobile tests still passed: the phone would send a
// filter the backend silently ignores, which is precisely the "two surfaces that look
// identical but silently ask different questions" bug this module's docstring claims to
// prevent. These compare OUTPUT, so any drift in clamping, defaults, param names or
// ordering fails here.

test('[AUDIT-ACT1] activityQuery: phone and web build the SAME query string', () => {
  const cases: Parameters<typeof activityQuery>[0][] = [
    {},
    { limit: 40 },
    { limit: 0 },
    { limit: 999 },
    { limit: -1 },
    { kind: 'task' },
    { kind: 'connector_execution' },
    { agentId: 'agent-1' },
    { cursor: '1700000000000.task:abc' },
    { limit: 25, kind: 'approval_filed', agentId: 'agent-2', cursor: '1.apf:x' },
  ]
  for (const input of cases) {
    assert.equal(
      activityQuery(input), WEB_QUERY(input as any),
      'activityQuery DRIFTED for ' + JSON.stringify(input) +
      ' — the phone and the desk would ask the server different questions',
    )
  }
  // Not vacuous: the builder must actually emit something for a non-trivial input.
  assert.ok(activityQuery({ limit: 25, kind: 'task' }).length > 0, 'activityQuery returned nothing')
})

test('[AUDIT-ACT1] activityAgo: phone and web render the SAME age', () => {
  const now = 1_700_000_000_000
  const deltas = [0, 1_000, 59_000, 60_000, 61_000, 3_599_000, 3_600_000, 7_200_000,
                  86_399_000, 86_400_000, 172_800_000, 864_000_000, -5_000]
  for (const d of deltas) {
    assert.equal(
      activityAgo(now - d, now), WEB_AGO(now - d, now),
      'activityAgo DRIFTED at delta ' + d + 'ms',
    )
  }
  assert.ok(activityAgo(now - 60_000, now).length > 0, 'activityAgo returned nothing')
})
