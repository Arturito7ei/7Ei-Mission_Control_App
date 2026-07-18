// FIX-1 audit — the WEB-SIDE peer of apps/mobile/src/activityKinds.test.ts.
//
// WHY THIS FILE EXISTS, and it is not redundancy. Every FIX-1 activity assertion lived
// in the MOBILE workspace, because that is where the cross-surface tripwire already sat
// (it imports the web module directly). The consequence was a hole in the CI topology
// rather than in the assertions: breaking `web/lib/activityKinds.ts` left the `Web (web)`
// job GREEN and only `Mobile (apps/mobile)` went red — and with no branch protection on
// `main`, a red job reports rather than blocks. A web-side regression could therefore be
// merged with the web suite passing. This file makes the web job answer for the web
// module.
//
// It asserts the same INVARIANTS against the web copy directly, so it fails on its own
// terms if the web module drifts, without waiting for the phone to notice. The
// phone-vs-web EQUALITY checks stay where they are (that comparison needs both, and the
// mobile job is the one that installs both).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVITY_KINDS, ACTIVITY_OUTCOMES, AWAITING_DECISION, KIND_LABEL, OUTCOME_LABEL,
  outcomeLabel, awaitsOperator, auditTarget, auditPhrase, buildFeedRows, auditRunLabel,
  isActivityKind, activityAgo, activityQuery, type ActivityEvent,
} from './activityKinds.ts'

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
  id: 'e1', kind: 'task', at: 1, title: 't', outcome: 'pending',
  agentId: null, agentName: null, target: null, error: null, ...over,
})

// ─── The Inbox / Activity contradiction, asserted against the WEB module ──────

test('[FIX-1][web] a QUEUED task does not claim to want a decision', () => {
  assert.notEqual(outcomeLabel('task', 'pending'), AWAITING_DECISION)
  assert.equal(outcomeLabel('task', 'pending'), 'Queued')
  assert.equal(awaitsOperator(ev({ kind: 'task', outcome: 'pending' })), false)
})

test('[FIX-1][web] a pending APPROVAL still says exactly what it always said', () => {
  assert.equal(outcomeLabel('approval_filed', 'pending'), AWAITING_DECISION)
  assert.equal(awaitsOperator(ev({ kind: 'approval_filed', outcome: 'pending' })), true)
})

test('[FIX-1][web] "Awaiting decision" is reachable by EXACTLY ONE kind/outcome pair', () => {
  const pairs: string[] = []
  for (const k of ACTIVITY_KINDS) {
    for (const o of ACTIVITY_OUTCOMES) {
      if (outcomeLabel(k, o) === AWAITING_DECISION) pairs.push(k + '/' + o)
    }
  }
  assert.deepEqual(pairs, ['approval_filed/pending'],
    'more than one row shape claims to await the operator — the Inbox cannot match that set')
})

test('[FIX-1][web] awaitsOperator agrees with the badge, over the WHOLE cross product', () => {
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

test('[FIX-1][web] the other two collisions read as themselves, not as a refusal', () => {
  assert.equal(outcomeLabel('task', 'rejected'), 'Blocked')
  assert.equal(outcomeLabel('agent_run', 'rejected'), 'Cancelled')
  assert.equal(outcomeLabel('approval_decided', 'rejected'), 'Refused')
})

test('[FIX-1][web] outcomeLabel is TOTAL and never blank', () => {
  for (const k of ACTIVITY_KINDS) {
    for (const o of ACTIVITY_OUTCOMES) {
      const l = outcomeLabel(k, o)
      assert.ok(typeof l === 'string' && l.length > 0, `blank badge for ${k}/${o}`)
    }
  }
})

// ─── The audit trail is legible, and still all there ──────────────────────────

test('[FIX-1][web] an audit target loses the uuid and the org prefix', () => {
  const t = auditTarget('POST /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/arturita/converse')
  assert.equal(t.method, 'POST')
  assert.equal(t.resource, 'arturita › converse')
  assert.ok(!/be18b025/.test(String(t.resource)), 'the uuid survived into the visible label')
})

test('[FIX-1][web] auditPhrase never renders empty', () => {
  assert.equal(
    auditPhrase('post.orgs', 'POST /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/arturita/converse'),
    'POST arturita › converse',
  )
  assert.equal(auditPhrase('post.orgs', null), 'post.orgs')
  for (const junk of ['nonsense', 'GET', '/no/method', '']) {
    assert.ok(auditPhrase('fallback.title', junk).length > 0, `blank phrase for ${junk}`)
  }
})

test('[FIX-1][web] the `orgs` COLLECTION is kept — only the org id elides it', () => {
  assert.equal(auditTarget('POST /api/orgs').resource, 'orgs')
  assert.equal(auditTarget('GET /api/orgs/be18b025-2ae2-415c-a2d3-b543f83c701e/agents').resource, 'agents')
})

const audit = (n: number) => ev({ id: 'a' + n, kind: 'audit_event', outcome: 'ok', at: n })
const real = (n: number) => ev({ id: 'r' + n, kind: 'task', outcome: 'ok', at: n })

test('[FIX-1][web] a run of audit rows collapses into ONE line, and keeps every item', () => {
  const rows = buildFeedRows([real(1), audit(2), audit(3), audit(4), real(5)])
  assert.equal(rows.length, 3, 'the run did not collapse')
  assert.equal(rows[1].row, 'auditRun')
  assert.deepEqual((rows[1] as any).run.items.map((e: ActivityEvent) => e.id), ['a2', 'a3', 'a4'],
    'collapsing DROPPED rows — the owner asked for the audit log, not a summary of it')
})

test('[FIX-1][web] collapsing never drops an event and never reorders one', () => {
  const input = [real(1), audit(2), audit(3), real(4), audit(5), real(6), audit(7), audit(8)]
  const flat: string[] = []
  for (const r of buildFeedRows(input)) {
    if (r.row === 'event') flat.push(r.event.id)
    else for (const e of r.run.items) flat.push(e.id)
  }
  assert.deepEqual(flat, input.map(e => e.id), 'the feed order changed')
})

test('[FIX-1][web] a LONE audit row is left alone, and collapse:false is a pass-through', () => {
  assert.deepEqual(buildFeedRows([real(1), audit(2), real(3)]).map(r => r.row),
    ['event', 'event', 'event'])
  const input = [real(1), audit(2), audit(3), audit(4)]
  const rows = buildFeedRows(input, { collapse: false })
  assert.equal(rows.length, input.length, 'asking for audit rows explicitly still hid some')
  assert.ok(rows.every(r => r.row === 'event'), 'a run collapsed despite collapse:false')
})

test('[FIX-1][web] only audit_event ever collapses', () => {
  const rows = buildFeedRows([real(1), real(2),
    ev({ id: 'p', kind: 'approval_filed', outcome: 'pending', at: 3 })])
  assert.ok(rows.every(r => r.row === 'event'), 'a non-audit kind was collapsed away')
})

test('[FIX-1][web] the collapsed line says how many, and pluralises', () => {
  assert.equal(auditRunLabel(1), '1 routine audit event')
  assert.equal(auditRunLabel(12), '12 routine audit events')
})

// ─── The pre-existing web vocabulary, previously only asserted from the phone ──

test('[FIX-1][web] every kind and outcome has a human label — no blank chip', () => {
  for (const k of ACTIVITY_KINDS) assert.ok(KIND_LABEL[k]?.length > 0, `no label for kind ${k}`)
  for (const o of ACTIVITY_OUTCOMES) assert.ok(OUTCOME_LABEL[o]?.length > 0, `no label for outcome ${o}`)
})

test('[FIX-1][web] isActivityKind accepts the vocabulary and refuses everything else', () => {
  for (const k of ACTIVITY_KINDS) assert.equal(isActivityKind(k), true)
  for (const junk of ['', 'nonsense', 'APPROVAL_FILED', null, undefined, 7, {}]) {
    assert.equal(isActivityKind(junk), false, `accepted junk: ${String(junk)}`)
  }
})

test('[FIX-1][web] activityQuery clamps its limit and omits "all"', () => {
  assert.equal(activityQuery({ limit: 999 }), 'limit=100')
  assert.equal(activityQuery({ limit: 0 }), 'limit=1')
  assert.equal(activityQuery({ kind: 'all', agentId: 'all' }), 'limit=40')
  assert.equal(activityQuery({ kind: 'task' }), 'limit=40&kind=task')
})

test('[FIX-1][web] activityAgo never renders a negative or NaN age', () => {
  const now = 1_000_000_000
  assert.equal(activityAgo(now, now), 'just now')
  assert.equal(activityAgo(now + 60_000, now), 'just now')
  assert.equal(activityAgo(now - 90_000, now), '1m ago')
})
