// ACT-1 — the desk's Inbox/Activity invariants, pinned as SOURCE-TEXT assertions.
//
// Same technique and the same reason as approvalDecide.test.ts next door: these
// components can't be rendered under `node --test` (React + JSX + Next aliases), but the
// properties that matter here are structural — what runs BEFORE what, and what is
// allowed to touch state. Source-text is a blunt instrument, so each assertion below
// says what it is really protecting, and every regex is anchored to a named function so
// a refactor RE-ANCHORS rather than silently stops checking.
//
// The property under protection is the ACT-1 restatement of the APPR-1 lesson: the desk
// must never show a decision it has not confirmed. APPR-1 fixed the queue (a card clears
// only on a 2xx). ACT-1 adds a "Recently decided" list, which is a second, subtler chance
// to lie — appending a row locally would render a decision the server may have refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const PANEL = read('./CockpitPanel.tsx')
const FEED = read('./cockpit/ActivityLogSection.tsx')
const INBOX = read('./cockpit/InboxSection.tsx')

/** Slice out a function body by anchor, so assertions are scoped to it rather than the
 *  whole file (where an unrelated match would make them vacuous). */
function body(src: string, anchor: RegExp, what: string): string {
  const m = anchor.exec(src)
  assert.ok(m, `could not locate ${what} — RE-ANCHOR this regex, do not delete the test`)
  return m![0]
}

/** Index of the awaited api() send. `api` is often called with a type argument
 *  (`await api<FeedResponse>(...)`), so a literal 'await api(' silently misses — which
 *  is how the first draft of this file passed three assertions vacuously. */
function sendIndex(fn: string): number {
  const m = /await api\s*(<[^>]*>)?\s*\(/.exec(fn)
  return m ? m.index : -1
}

// ─── Freshness: the decided tail is READ, never guessed ────────────────────────

test('[ACT-1] decide() refreshes the decided tail only AFTER the awaited call succeeds', () => {
  const decide = body(PANEL, /const decide = async \([\s\S]*?\n  \}/, 'decide() in CockpitPanel.tsx')
  const send = sendIndex(decide)
  const clear = decide.indexOf('setApprovals(')
  const refresh = decide.indexOf('loadDecisions()')
  assert.ok(send > -1, 'decide() no longer sends the decision')
  assert.ok(clear > send, 'APPR-1 REGRESSION: the card is cleared before the response is awaited')
  assert.ok(refresh > -1, 'decide() does not refresh the decided tail — the Inbox will show a stale list')
  assert.ok(
    refresh > send,
    'the decided tail is refreshed before the decision is confirmed — it would show a decision that may have been refused',
  )
})

test('[ACT-1] the decided tail is never appended to optimistically', () => {
  // setDecisions must be called ONLY from loadDecisions (i.e. from a server response).
  // A local `setDecisions(d => [row, ...d])` anywhere would reintroduce exactly the
  // class of bug APPR-1 fixed, one list over.
  const calls = [...PANEL.matchAll(/setDecisions\(/g)].length
  assert.equal(calls, 1, 'setDecisions is called more than once — the extra call is almost certainly an optimistic insert')
  const loader = body(PANEL, /const loadDecisions = useCallback\([\s\S]*?\n  \}, \[/, 'loadDecisions()')
  assert.ok(loader.includes('setDecisions('), 'setDecisions moved out of loadDecisions — re-anchor this test')
  assert.ok(sendIndex(loader) > -1, 'loadDecisions no longer reads from the server')
  // REPLACE, never merge. Merging the fresh page into the previous one duplicates rows
  // on every refresh and lets an already-superseded decision linger at the bottom.
  assert.ok(
    /setDecisions\(\s*r\.events \?\? \[\]\s*\)/.test(loader),
    'loadDecisions no longer REPLACES the tail with the server response — merging accumulates duplicates',
  )
})

test('[ACT-1] loadDecisions swallowing a failure must not blank the list', () => {
  const loader = body(PANEL, /const loadDecisions = useCallback\([\s\S]*?\n  \}, \[/, 'loadDecisions()')
  const c = loader.indexOf('catch')
  assert.ok(c > -1, 'loadDecisions has no catch — a failed tail read would break the whole panel')
  const tail = loader.slice(c)
  assert.ok(
    !/setDecisions\(\s*\[\s*\]\s*\)/.test(tail),
    'the catch clears the decided list — a transient failure would read as "you have decided nothing"',
  )
})

// ─── The feed: bounded, and honest about failure ───────────────────────────────

test('[ACT-1] the feed APPENDS a page only after the awaited call succeeds', () => {
  const more = body(FEED, /const more = async \([\s\S]*?\n  \}/, 'more() in ActivityLogSection.tsx')
  const send = sendIndex(more)
  const append = more.indexOf('setEvents(')
  assert.ok(send > -1 && append > send, 'a page is appended before the response arrives')
  assert.ok(more.includes('setErr('), 'a failed "Load more" is swallowed — the button would just do nothing')
  assert.ok(!/catch\s*\{\s*\}/.test(more), 'bare catch {} — a failure must be stated, not eaten')
})

test('[ACT-1] the feed is bounded: no infinite scroll, and every read carries a limit', () => {
  assert.ok(!/IntersectionObserver|onScroll/.test(FEED), 'an unbounded auto-loading feed was introduced')
  // Every api() call in this section must go through the shared query builder, which
  // always emits a clamped `limit`.
  const calls = [...FEED.matchAll(/api<[^>]*>\(`([^`]*)`/g)].map((m) => m[1])
  assert.ok(calls.length > 0, 'no api() calls found — re-anchor this test')
  for (const c of calls) {
    assert.ok(c.includes('${qs('), `an activity read bypasses the shared query builder: ${c}`)
  }
})

test('[ACT-1] a filter change resets paging — a cursor from another query is meaningless', () => {
  const load = body(FEED, /const load = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/, 'load() in ActivityLogSection.tsx')
  assert.ok(load.includes('qs(null)'), 'load() reuses a cursor — page one of a new filter would start mid-feed')
  assert.ok(/\}, \[orgId, getToken, qs\]\)/.test(load), 'load() no longer re-runs when the filter (qs) changes')
})

// ─── The Inbox: decided rows are read-only, and pending is distinguishable ──────

test('[ACT-1] a decided row offers no decision buttons', () => {
  const i = INBOX.indexOf('Recently decided')
  assert.ok(i > -1, 'the Recently decided block is gone')
  const block = INBOX.slice(i)
  assert.ok(!block.includes('onDecide('), 'a decided approval still offers a decision — it could be decided twice')
})

test('[ACT-1] the Inbox distinguishes "awaiting you" from decided, and has a real empty state', () => {
  assert.ok(INBOX.includes('awaiting you'), 'the heading no longer says what is actually waiting')
  assert.ok(INBOX.includes('Nothing needs a decision right now'), 'the empty state is gone')
  // The pre-ACT-1 behaviour (collapse inside the full stack) must survive, or Mission
  // Control grows a permanent empty box.
  assert.ok(
    /if \(pendingCount \+ decisions\.length === 0 && !focused\) return null/.test(INBOX),
    'the collapse-when-empty-and-unfocused rule changed — Mission Control would show an empty Inbox card',
  )
})

test('[ACT-1] the step-up affordance survives on the queue (APPR-1 must not regress)', () => {
  // Assert the gate is USED, not merely imported: `const dangerous = false` would keep
  // the identifier in the file while silently un-marking every dangerous approval.
  assert.ok(
    /const dangerous = approvalNeedsStepUp\(a\)/.test(INBOX),
    'APPR-1 REGRESSION: `dangerous` is no longer derived from approvalNeedsStepUp — dangerous approvals would render as routine one-click approves',
  )
  assert.ok(INBOX.includes('✓ Approve…'), 'the ellipsis that warns a confirmation is coming was removed')
  assert.ok(INBOX.includes('needs step-up confirmation'), 'the step-up hint line is gone')
})
