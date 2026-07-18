# FIX-1 — mutation log

Every guard added by FIX-1, broken on purpose, with the tests that caught it. A green
suite is not evidence; this file is. Baseline before and after each mutation: **green**.

Convention (two-step per-test isolation): each mutation is applied alone, the suite is
run, the **failing test names** are recorded — not just a count — and the source is
restored and re-run to green before the next one. A mutation that turns the suite red on
tests unrelated to the guard it broke is a bad tripwire, not a good one.

---

## Finding 1 — the Inbox / Activity contradiction

Guards live in `web/lib/activityKinds.ts` and its hand-copy `apps/mobile/src/activityKinds.ts`.
Tests: `apps/mobile/src/activityKinds.test.ts`.

| # | Mutation | Failing tests | Red |
|---|---|---|---|
| A | `OUTCOME_LABEL.pending` back to `AWAITING_DECISION` — **the shipped bug, restored verbatim** | `a QUEUED task does not claim to want a decision`, `"Awaiting decision" is reachable by EXACTLY ONE kind/outcome pair`, `awaitsOperator agrees with the badge, over the WHOLE cross product` | 3 |
| B | Delete the `approval_filed: { pending: AWAITING_DECISION }` grant | `a pending APPROVAL still says exactly what it always said`, `…EXACTLY ONE kind/outcome pair`, `awaitsOperator agrees with the badge…` | 3 |
| C | Widen `awaitsOperator` to `outcome === 'pending'` for any kind | `a QUEUED task does not claim to want a decision`, `awaitsOperator agrees with the badge…` | 2 |

**A and B are the two directions of the same invariant** and neither alone is sufficient:
A proves the phrase is not handed out to routine rows, B proves the fix did not solve the
contradiction by muting the real obligation. C proves the predicate that drives the badge
TONE cannot drift from the badge TEXT.

> The one-member assertion in `…EXACTLY ONE kind/outcome pair` is what rejected the first
> implementation. Defaulting to "Awaiting decision" and overriding `task` passed every
> hand-written case and still left four other kinds inheriting the operator's phrase. The
> test failed; the design was inverted to grant-not-withhold. Recorded because the test
> did work a review would not have.

## Finding 2 — the empty memory graph

Guards in `backend/src/services/vault-graph.ts`. Tests: `backend/src/tests/vault-graph.test.ts`.

| # | Mutation | Failing tests | Red |
|---|---|---|---|
| M1 | Delete the root-relative retry | `a vault-root-relative graph.json resolves against the root` | 1 |
| M2 | Make the retry unconditional (`collect('')` always) | `the retry does NOT fire when the root scoping kept anything`, plus the pre-existing `[M1] parseGraphifyGraph normalizes nodes/links and scopes to the vault root` | 2 |
| M3 | Drop the `..` traversal guard in `inVault` | `the retry widens the PREFIX, never the traversal escape` | 1 |
| M4 | Accept a zero-node parse — **the shipped bug, restored verbatim** | `an EMPTY graphify graph.json does NOT satisfy the loop`, `an empty FIRST candidate does not stop a good SECOND one`, `the fallback yields a REAL native graph, not another empty one` | 3 |
| M5 | Never accept graphify at all (`if (true) continue`) | `a NON-empty graphify graph is still preferred, and reports its path`, `an empty FIRST candidate does not stop a good SECOND one` | 2 |

**M1/M2 are the two directions of the tolerance** — M1 proves it fires when it must, M2
proves it does NOT fire when scoping kept something, which is the only thing standing
between "tolerate a differently-rooted graph" and "silently stop scoping at all". M2
also turning the *pre-existing* scoping test red is the intended signal: that test is the
out-of-vault guard, and it is still doing its job.

**M4/M5 are the two directions of the fallback.** M4 restores the production failure. M5
proves the fix did not overshoot into "always ignore graphify", which would have retired
the fast path while every empty-case test stayed green.

## Finding 4 — the audit trail

Guards in the shared vocabulary module. Tests: `apps/mobile/src/activityKinds.test.ts`.

| # | Mutation | Failing tests | Red |
|---|---|---|---|
| D | Collapsed runs carry `items: []` (summarise instead of retain) | `a run of audit rows collapses into ONE line, and keeps every item`, `collapsing never drops an event and never reorders one` | 2 |
| E | `collapse` forced to `true` (ignore the option) | `collapse:false is a strict pass-through — the Audit filter shows them all` | 1 |
| F | Stop eliding id segments | `an audit target loses the uuid and the org prefix, keeps the resource`, `auditPhrase replaces the machine title, and never renders empty`, `the `orgs` COLLECTION is kept — only the org id elides it` | 3 |

**D is the one that matters most.** The owner explicitly asked for activity logs; a
"collapse" that quietly discards rows would be a worse bug than the noise it fixes, and it
would look identical on screen until someone expanded a run. E proves the kind filter
still reaches every raw row, which is the escape hatch the whole design leans on.

---

## What is NOT covered

- **No rendered-DOM assertions.** Both surfaces follow the repo's existing convention
  (pure logic tested directly, components asserted by source text). The clipped picker
  (Finding 3) and the `color-scheme` declaration are therefore **not** guarded by a test —
  they are CSS geometry, and nothing in this repo can currently observe them. They were
  found by a human looking at the deployed app, and that is still the only way they would
  be found again.
- **No route-level HTTP test** for `GET /api/orgs/:orgId/memory/graph`. `selectGraphifyGraph`
  makes the *decision* testable; that the route calls it is structural, not asserted.
