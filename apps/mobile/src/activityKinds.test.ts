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
  outcomeLabel, awaitsOperator, auditTarget, auditPhrase, buildFeedRows, auditRunLabel,
  AWAITING_DECISION,
  type ActivityEvent,
} from './activityKinds.ts'
import {
  ACTIVITY_KINDS as WEB_KINDS,
  ACTIVITY_OUTCOMES as WEB_OUTCOMES,
  OWNER_ONLY_KINDS as WEB_OWNER_ONLY,
  activityQuery as WEB_QUERY,
  activityAgo as WEB_AGO,
  outcomeLabel as WEB_OUTCOME_LABEL,
  auditPhrase as WEB_AUDIT_PHRASE,
  buildFeedRows as WEB_FEED_ROWS,
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

// ─── FIX-1 · the Inbox / Activity CONTRADICTION ───────────────────────────────
//
// Live, the Inbox read "Nothing needs a decision right now" while the Activity feed, one
// click away, showed SIX rows badged "Awaiting decision". Neither surface was wrong: the
// Inbox lists PENDING APPROVALS (routes/tasks.ts filters approvalRequests.status =
// 'pending'), whereas those six rows were TASKS, and `tasks.status` DEFAULTS to
// 'pending' — which means QUEUED, waiting for an agent, not for the operator. One shared
// label was rendering both, so routine queue depth read as six phantom obligations.

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
  id: 'e1', kind: 'task', at: 1, title: 't', outcome: 'pending',
  agentId: null, agentName: null, target: null, error: null, ...over,
})

test('[FIX-1] a QUEUED task does not claim to want a decision', () => {
  const label = outcomeLabel('task', 'pending')
  assert.notEqual(label, AWAITING_DECISION,
    'a pending TASK still reads with the operator’s phrase — this is the shipped bug')
  assert.equal(label, 'Queued')
  assert.equal(awaitsOperator(ev({ kind: 'task', outcome: 'pending' })), false)
})

test('[FIX-1] a pending APPROVAL still says exactly what it always said', () => {
  // The fix must not have solved the contradiction by muting the real obligation.
  assert.equal(outcomeLabel('approval_filed', 'pending'), AWAITING_DECISION)
  assert.equal(awaitsOperator(ev({ kind: 'approval_filed', outcome: 'pending' })), true)
})

test('[FIX-1] "Awaiting decision" is reachable by EXACTLY ONE kind/outcome pair', () => {
  // The invariant behind the whole finding: whatever the feed badges with the
  // operator's phrase must be the same set the Inbox offers buttons for. If a second
  // pair ever earns that phrase, the two surfaces can disagree again.
  const pairs: string[] = []
  for (const k of ACTIVITY_KINDS) {
    for (const o of ACTIVITY_OUTCOMES) {
      if (outcomeLabel(k, o) === AWAITING_DECISION) pairs.push(k + '/' + o)
    }
  }
  assert.deepEqual(pairs, ['approval_filed/pending'],
    'more than one row shape claims to await the operator — the Inbox cannot match that set')
})

test('[FIX-1] awaitsOperator agrees with the badge, over the WHOLE cross product', () => {
  let sawTrue = false
  for (const k of ACTIVITY_KINDS) {
    for (const o of ACTIVITY_OUTCOMES) {
      const badged = outcomeLabel(k, o) === AWAITING_DECISION
      const awaits = awaitsOperator(ev({ kind: k, outcome: o }))
      assert.equal(badged, awaits, `badge and predicate disagree for ${k}/${o}`)
      if (awaits) sawTrue = true
    }
  }
  assert.ok(sawTrue, 'nothing ever awaits the operator — the check would be vacuous')
})

test('[FIX-1] the other two collisions read as themselves, not as a refusal', () => {
  assert.equal(outcomeLabel('task', 'rejected'), 'Blocked')       // tasks.status 'blocked'
  assert.equal(outcomeLabel('agent_run', 'rejected'), 'Cancelled') // agent_runs 'cancelled'
  assert.equal(outcomeLabel('approval_decided', 'rejected'), 'Refused') // genuinely refused
})

test('[FIX-1] outcomeLabel is TOTAL and never blank, over the whole cross product', () => {
  for (const k of ACTIVITY_KINDS) {
    for (const o of ACTIVITY_OUTCOMES) {
      const l = outcomeLabel(k, o)
      assert.ok(typeof l === 'string' && l.length > 0, `blank badge for ${k}/${o}`)
    }
  }
})

test('[FIX-1] outcomeLabel: phone and web render the SAME badge, every pair', () => {
  for (const k of ACTIVITY_KINDS) {
    for (const o of ACTIVITY_OUTCOMES) {
      assert.equal(outcomeLabel(k, o), WEB_OUTCOME_LABEL(k, o),
        `outcomeLabel DRIFTED at ${k}/${o} — the desk and the phone would disagree`)
    }
  }
  assert.ok(outcomeLabel('task', 'pending').length > 0, 'outcomeLabel returned nothing')
})

// ─── FIX-1 · the audit trail is legible, and still all there ──────────────────

test('[FIX-1] an audit target loses the uuid and the org prefix, keeps the resource', () => {
  const t = auditTarget('POST /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/arturita/converse')
  assert.equal(t.method, 'POST')
  assert.equal(t.resource, 'arturita › converse')
  assert.ok(!/be18b025/.test(String(t.resource)), 'the uuid survived into the visible label')
  assert.ok(!/api/.test(String(t.resource)), 'the /api/ prefix survived')
})

test('[FIX-1] auditPhrase replaces the machine title, and never renders empty', () => {
  assert.equal(
    auditPhrase('post.orgs', 'POST /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/arturita/converse'),
    'POST arturita › converse',
  )
  // No target, or an unparseable one: fall back to the row's own title rather than blank.
  assert.equal(auditPhrase('post.orgs', null), 'post.orgs')
  assert.equal(auditPhrase('post.orgs', ''), 'post.orgs')
  for (const junk of ['nonsense', 'GET', '/no/method']) {
    assert.ok(auditPhrase('fallback.title', junk).length > 0, `blank phrase for ${junk}`)
  }
})

test('[FIX-1] the `orgs` COLLECTION is kept — only the org id elides it', () => {
  // `orgs` followed by an id is noise in an org-scoped feed; `orgs` on its own is the
  // route that creates an org, which is exactly the event an owner wants to see.
  assert.equal(auditTarget('POST /api/orgs').resource, 'orgs')
  assert.equal(auditTarget('GET /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/agents').resource, 'agents')
})

test('[FIX-1] auditPhrase: phone and web render the SAME text', () => {
  const cases: [string, string | null][] = [
    ['post.orgs', 'POST /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/arturita/converse'],
    ['get.orgs', 'GET /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/activity'],
    ['patch.tasks', 'PATCH /api/tasks/7f3a2b1c-0000-4000-8000-0123456789ab'],
    ['weird', null], ['weird', ''], ['weird', 'not a target'],
  ]
  for (const [title, target] of cases) {
    assert.equal(auditPhrase(title, target), WEB_AUDIT_PHRASE(title, target),
      `auditPhrase DRIFTED for ${title} / ${target}`)
  }
})

// ─── FIX-1 · collapsing the plumbing without losing it ────────────────────────

const audit = (n: number) => ev({ id: 'a' + n, kind: 'audit_event', outcome: 'ok', at: n })
const real = (n: number) => ev({ id: 'r' + n, kind: 'task', outcome: 'ok', at: n })

test('[FIX-1] a run of audit rows collapses into ONE line, and keeps every item', () => {
  const rows = buildFeedRows([real(1), audit(2), audit(3), audit(4), real(5)])
  assert.equal(rows.length, 3, 'the run did not collapse')
  assert.equal(rows[1].row, 'auditRun')
  const run = (rows[1] as any).run
  assert.equal(run.count, 3)
  assert.deepEqual(run.items.map((e: ActivityEvent) => e.id), ['a2', 'a3', 'a4'],
    'collapsing DROPPED rows — the owner asked for the audit log, not a summary of it')
})

test('[FIX-1] collapsing never drops an event and never reorders one', () => {
  const input = [real(1), audit(2), audit(3), real(4), audit(5), real(6), audit(7), audit(8)]
  const flat: string[] = []
  for (const r of buildFeedRows(input)) {
    if (r.row === 'event') flat.push(r.event.id)
    else for (const e of r.run.items) flat.push(e.id)
  }
  assert.deepEqual(flat, input.map(e => e.id),
    'the feed is chronological — reordering it would be a worse lie than the noise')
})

test('[FIX-1] a LONE audit row is left alone — collapsing one row saves nothing', () => {
  const rows = buildFeedRows([real(1), audit(2), real(3)])
  assert.deepEqual(rows.map(r => r.row), ['event', 'event', 'event'])
})

test('[FIX-1] collapse:false is a strict pass-through — the Audit filter shows them all', () => {
  const input = [real(1), audit(2), audit(3), audit(4)]
  const rows = buildFeedRows(input, { collapse: false })
  assert.equal(rows.length, input.length, 'asking for audit rows explicitly still hid some')
  assert.ok(rows.every(r => r.row === 'event'), 'a run collapsed despite collapse:false')
})

test('[FIX-1] only audit_event ever collapses — real events are never hidden', () => {
  const rows = buildFeedRows([real(1), real(2), real(3),
    ev({ id: 'p', kind: 'approval_filed', outcome: 'pending', at: 4 })])
  assert.ok(rows.every(r => r.row === 'event'), 'a non-audit kind was collapsed away')
  assert.equal(rows.length, 4)
})

test('[FIX-1] buildFeedRows: phone and web build the SAME rows', () => {
  const input = [real(1), audit(2), audit(3), real(4), audit(5), audit(6), audit(7)]
  for (const collapse of [true, false]) {
    const mine = buildFeedRows(input, { collapse })
    const theirs = WEB_FEED_ROWS(input as any, { collapse })
    assert.equal(JSON.stringify(mine), JSON.stringify(theirs),
      `buildFeedRows DRIFTED at collapse=${collapse}`)
  }
  assert.ok(buildFeedRows(input).length > 0, 'buildFeedRows returned nothing')
})

test('[FIX-1] the collapsed line says how many, and pluralises', () => {
  assert.equal(auditRunLabel(1), '1 routine audit event')
  assert.equal(auditRunLabel(12), '12 routine audit events')
})
