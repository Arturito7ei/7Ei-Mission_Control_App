// ACT-1 — the phone's Activity/Inbox invariants, as SOURCE-TEXT assertions.
//
// The screens are .tsx and import react-native, so they cannot be rendered under
// `node --test`. What matters here is structural anyway — what runs before what, what
// refresh is allowed to cost, and whether the phone asks the endpoint the same question
// the desk does. Same technique as web/app/dashboard/activityFeed.test.ts and
// dangerousApprovals.test.ts: read the source, assert the shape, anchor every regex to a
// named function so a refactor RE-ANCHORS rather than silently stops checking.
//
// The three properties under protection:
//   1. FRESHNESS — the decided tail is READ from the server after a CONFIRMED decision,
//      never appended locally (the APPR-1 lesson, one list over).
//   2. CHEAP REFRESH — pull-to-refresh is a bounded read, never a rebuild (the MEM-1
//      lesson: MEM-1 bound an expensive re-crawl to pull-to-refresh and made the phone
//      pay for a graph rebuild on every idle tug).
//   3. PARITY — the phone and the desk hit the same endpoint through the same shared
//      query builder, so they cannot silently diverge on params or limits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const ACTIVITY = read('./screens/ActivityScreen.tsx')
const APPROVALS = read('./screens/ApprovalsPane.tsx')
const WEB_FEED = read('../../../web/app/dashboard/cockpit/ActivityLogSection.tsx')

/** Strip comments before any "this token must NOT appear" assertion.
 *
 *  Necessary, not cosmetic: the very files under test explain their own invariants in
 *  prose ("Deliberately NOT `onEndReached`", "No rebuild, no re-crawl"), so a naive
 *  source search finds the word in the comment that PROMISES its absence and fails the
 *  file for documenting itself. Absence assertions run against code only. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function body(src: string, anchor: RegExp, what: string): string {
  const m = anchor.exec(src)
  assert.ok(m, `could not locate ${what} — RE-ANCHOR this regex, do not delete the test`)
  return m![0]
}

/** `Api.activity(...)` / `api<T>(...)` — index of the awaited send. A literal
 *  'await Api.' would miss a generic form, which is how a sibling test once passed three
 *  assertions vacuously. */
function sendIndex(fn: string, callee: string): number {
  const m = new RegExp('await ' + callee + '\\s*(<[^>]*>)?\\s*\\(').exec(fn)
  return m ? m.index : -1
}

// ─── 1. Freshness ──────────────────────────────────────────────────────────────

test('[ACT-1] the phone refreshes the decided tail only AFTER a confirmed decision', () => {
  const decide = body(APPROVALS, /const decide = useCallback\([\s\S]*?\n  \)/, 'decide() in ApprovalsPane.tsx')
  const send = sendIndex(decide, 'Api\\.decideApproval')
  const clear = decide.indexOf('setItems(')
  const refresh = decide.indexOf('loadDecisions()')
  assert.ok(send > -1, 'decide() no longer sends the decision')
  assert.ok(clear > send, 'APPR-1 REGRESSION: the card is cleared before the response is awaited')
  assert.ok(refresh > send, 'the decided tail is refreshed before the decision is confirmed')
})

test('[ACT-1] the step-up path refreshes the tail too — both paths, or the tail lies', () => {
  const modal = body(APPROVALS, /onApproved=\{\([\s\S]*?\n        \}\}/, 'the StepUpModal onApproved handler')
  assert.ok(
    modal.includes('loadDecisions()'),
    'a DANGEROUS approval approved via step-up would not appear in "Recently decided" — the one path where the operator most wants confirmation',
  )
})

test('[ACT-1] the decided tail is never appended to optimistically', () => {
  const calls = [...APPROVALS.matchAll(/setDecisions\(/g)].length
  assert.equal(calls, 1, 'setDecisions is called more than once — the extra call is almost certainly an optimistic insert')
  const loader = body(APPROVALS, /const loadDecisions = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/, 'loadDecisions()')
  assert.ok(sendIndex(loader, 'Api\\.activity') > -1, 'loadDecisions no longer reads from the server')
  assert.ok(
    /setDecisions\(r\.events \?\? \[\]\)/.test(loader),
    'loadDecisions no longer REPLACES the tail with the server response — merging accumulates duplicates',
  )
  const c = loader.indexOf('catch')
  assert.ok(c > -1 && !/setDecisions\(\s*\[\s*\]\s*\)/.test(loader.slice(c)),
    'the catch blanks the decided list — a transient failure would read as "you have decided nothing"')
})

test('[ACT-1] a decided row on the phone offers no decision buttons', () => {
  const i = APPROVALS.indexOf('Recently decided')
  assert.ok(i > -1, 'the Recently decided block is gone')
  const block = APPROVALS.slice(i)
  assert.ok(!/decide\(/.test(block), 'a decided approval still offers a decision — it could be decided twice')
  assert.ok(!/onPress=\{\(\) => setStepUp/.test(block), 'a decided approval can still be stepped up')
})

// ─── 2. Cheap refresh, bounded feed ────────────────────────────────────────────

test('[ACT-1] pull-to-refresh is a CHEAP bounded read, not a rebuild (the MEM-1 lesson)', () => {
  for (const [name, src] of [['ActivityScreen', ACTIVITY], ['ApprovalsPane', APPROVALS]] as const) {
    const m = /onRefresh=\{([A-Za-z]+)\}/.exec(src)
    assert.ok(m, `${name}: no onRefresh handler found — re-anchor this test`)
    const handler = m![1]
    assert.ok(
      handler === 'load' || handler === 'onRefresh',
      `${name}: pull-to-refresh calls "${handler}" — it must call the ordinary bounded page-one read`,
    )
    // Nothing that rebuilds, re-crawls or re-indexes may hang off a refresh.
    assert.ok(
      !/rebuild|recrawl|reindex|\bcrawl\(/i.test(code(src)),
      `${name}: an expensive rebuild-shaped call appeared on a refresh path`,
    )
  }
})

test('[ACT-1] the phone feed is BOUNDED — a flick must not page the whole ledger', () => {
  assert.ok(!/onEndReached/.test(code(ACTIVITY)), 'onEndReached was added — a fast flick would page the entire ledger over a phone connection')
  assert.ok(/Load \$\{PAGE\} more|Load .* more/.test(ACTIVITY), 'the explicit "Load more" control is gone')
  const more = body(ACTIVITY, /const more = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/, 'more() in ActivityScreen.tsx')
  const send = sendIndex(more, 'Api\\.activity')
  const append = more.indexOf('setEvents(')
  assert.ok(send > -1 && append > send, 'a page is appended before the response arrives')
  assert.ok(more.includes('setError('), 'a failed "Load more" is swallowed — the button would just do nothing')
})

test('[ACT-1] every activity read goes through the SHARED query builder', () => {
  for (const [name, src] of [['ActivityScreen', ACTIVITY], ['ApprovalsPane', APPROVALS]] as const) {
    const calls = [...src.matchAll(/Api\.activity\(([\s\S]*?)\)\n/g)].map((m) => m[1])
    assert.ok(calls.length > 0, `${name}: no Api.activity call found — re-anchor this test`)
    for (const c of calls) {
      assert.ok(c.includes('activityQuery('), `${name}: an activity read hand-builds its query instead of using activityQuery — params and the clamped limit would drift from the desk`)
    }
  }
})

// ─── 3. Parity with the desk ───────────────────────────────────────────────────

test('[ACT-1] the phone and the desk read the SAME endpoint', () => {
  assert.ok(/\/api\/orgs\/\$\{orgId\}\/activity/.test(WEB_FEED), 'the desk no longer reads /activity — re-anchor')
  // The phone reaches it through Api.activity, which owns the path; assert the call
  // exists on both sides rather than duplicating the literal here.
  assert.ok(/Api\.activity\(/.test(ACTIVITY), 'the phone no longer reads the activity feed')
  const api = read('./api.ts')
  assert.ok(
    /\/api\/orgs\/\$\{orgId\}\/activity\?\$\{query\}/.test(api),
    'Api.activity no longer points at /api/orgs/:orgId/activity — the surfaces have diverged',
  )
})

test('[ACT-1] both surfaces use the shared builder, so neither can drift on params', () => {
  assert.ok(WEB_FEED.includes('activityQuery('), 'the desk stopped using the shared query builder')
  assert.ok(ACTIVITY.includes('activityQuery('), 'the phone stopped using the shared query builder')
})

test('[ACT-1] neither surface tries to widen what the server allows', () => {
  // The kind filters must be built from the SERVER's availableKinds, never from the full
  // local ACTIVITY_KINDS — otherwise a member is offered owner-only filters that always
  // return nothing, which reads as "the office did nothing" rather than "not yours to
  // see". Asserted per surface with the surface's own idiom rather than one clever
  // shared regex: the desk builds a plain array, the phone a useMemo, and a single
  // anchor that stretched to cover both matched the memo's DEPENDENCY list — so it kept
  // passing against a mutant that offered every owner-only chip.
  assert.ok(
    /const ks = availableKinds/.test(ACTIVITY),
    "the phone's kind filters are no longer built from the server's availableKinds",
  )
  assert.ok(
    /\.\.\.availableKinds\.map/.test(WEB_FEED),
    "the desk's kind filters are no longer built from the server's availableKinds",
  )
  // Neither client may assert its own ownership; it is read from the response.
  for (const [name, src] of [['ActivityScreen', ACTIVITY], ['ActivityLogSection', WEB_FEED]] as const) {
    assert.ok(
      /setIsOwner\(!!r\.isOwner\)/.test(src),
      `${name}: isOwner is no longer taken from the server response`,
    )
  }
})

// AUDIT-ACT1 UX-2, mirrored: the phone's decided tail must be quieter than the queue.
// Worse on a phone than on the desk — there is no peripheral vision, the screen IS the
// list — so if the tail reads as a peer, the operator scrolls past what wants them.
test('[AUDIT-ACT1] the phone de-emphasises the decided tail', () => {
  assert.ok(/decidedCard:/.test(APPROVALS), 'the decided tail lost its own card style')
  assert.ok(
    /backgroundColor: 'transparent'/.test(APPROVALS),
    'the decided card is back on the default filled Card chrome — a peer of a pending approval',
  )
  assert.ok(/already handled/.test(APPROVALS), 'the tail heading no longer says the rows are answered')
})
