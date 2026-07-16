// MOB-6f — tripwires for Governance.
//
// `governance.ts` MIRRORS the web's trust vocabulary, so the thing worth testing
// is that it stays a mirror. These tests import BOTH and assert they agree — the
// pattern navModel.test.ts / attach.test.ts / org.test.ts already use.
//
// The failure this prevents: someone changes what counts as "contained" on the
// web (or the backend changes `trustMode` semantics under both), and the phone
// quietly keeps the old rules — so an agent reads as Standard on the handset and
// Low-trust on the desk. On this surface that is not cosmetic drift: the badge
// is the operator's answer to "is this thing still fenced in?".
//
// Zero-dep: node --test --experimental-strip-types. `web/lib/trust.ts` is pure
// (no React, no DOM), which is what makes it loadable outside Metro.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TRUST_MODES as WEB_TRUST_MODES,
  isContainedToNothing as webIsContainedToNothing,
  isLowTrust as webIsLowTrust,
  parseTrustMode as webParseTrustMode,
  trustBadge as webTrustBadge,
} from '../../../web/lib/trust.ts'
import {
  CAP_HINTS,
  GOVERNANCE_READONLY_NOTE,
  REVISION_DISPLAY_LIMIT,
  TRUST_MODES,
  boundaryCount,
  boundaryLine,
  capsLabel,
  isContainedToNothing,
  isLowTrust,
  parseBoundary,
  parseCaps,
  parseTrustMode,
  policyBadge,
  relTime,
  revisionRows,
  revisionSubtitle,
  revisionTitle,
  trustBadge,
  type PolicyLite,
  type RevisionLite,
} from './governance.ts'

// Every value the trust helpers could plausibly meet, including the garbage a
// TEXT column can hold. If the phone and the web disagree on ANY of these, the
// two clients disagree about containment.
const MODES = [
  'standard',
  'low_trust_review',
  'LOW_TRUST_REVIEW',
  '  low_trust_review  ',
  'Standard',
  'lowtrust',
  'low-trust-review',
  '',
  '   ',
  null,
  undefined,
  'nonsense',
]

test('[MOB-6f] the phone parses trust mode exactly as the web does', () => {
  for (const m of MODES) {
    assert.equal(parseTrustMode(m), webParseTrustMode(m), `parseTrustMode(${JSON.stringify(m)})`)
    assert.equal(isLowTrust(m), webIsLowTrust(m), `isLowTrust(${JSON.stringify(m)})`)
  }
})

test('[MOB-6f] the trust mode list is the web’s', () => {
  assert.deepEqual([...TRUST_MODES], [...WEB_TRUST_MODES])
})

test('[MOB-6f] the trust badge is the web’s badge — icon, label and tone', () => {
  for (const m of MODES) {
    assert.deepEqual(trustBadge(m), webTrustBadge(m), `trustBadge(${JSON.stringify(m)})`)
  }
})

test('[MOB-6f] "contained to nothing" means the same on both clients', () => {
  const boundaries = [
    null,
    undefined,
    {},
    { projects: [], tasks: [], agents: [] },
    { projects: ['p1'], tasks: [], agents: [] },
    { projects: [], tasks: ['t1'], agents: [] },
    { projects: [], tasks: [], agents: ['a1'] },
    { projects: ['p1'], tasks: ['t1'], agents: ['a1'] },
  ]
  for (const m of MODES) {
    for (const b of boundaries) {
      assert.equal(
        isContainedToNothing(m, b),
        webIsContainedToNothing(m, b),
        `isContainedToNothing(${JSON.stringify(m)}, ${JSON.stringify(b)})`,
      )
    }
  }
})

// ─── Permissions: the allow-all trap ─────────────────────────────────────────

test('[MOB-6f] an EMPTY permission list reads as "Allow all", never as "none"', () => {
  // The backend treats null/[] as legacy allow-all (services/code-executor.ts)
  // and the web's hint says "Empty = allow all". A read-only list that showed
  // "none" here would tell the operator an agent is locked down while it is in
  // fact unrestricted — the worst thing this screen could get backwards.
  for (const p of [null, undefined, '', '[]', 'not json at all', '{}']) {
    const r = capsLabel(p)
    assert.equal(r.allowAll, true, `capsLabel(${JSON.stringify(p)}).allowAll`)
    assert.equal(r.label, 'Allow all')
    assert.deepEqual(r.caps, [])
  }
})

test('[MOB-6f] a non-empty permission list is listed verbatim', () => {
  const r = capsLabel(JSON.stringify(['memory:write', 'connector:*']))
  assert.equal(r.allowAll, false)
  assert.deepEqual(r.caps, ['memory:write', 'connector:*'])
  assert.equal(r.label, 'memory:write · connector:*')
})

test('[MOB-6f] parseCaps survives garbage without throwing', () => {
  assert.deepEqual(parseCaps('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseCaps('{"not":"an array"}'), [])
  assert.deepEqual(parseCaps('<html>'), [])
  assert.deepEqual(parseCaps(null), [])
})

test('[MOB-6f] the capability hints are a copy of the web’s CAP_HINTS', () => {
  // Not import-tripwirable: the web's CAP_HINTS lives inside GovernancePanel.tsx
  // (a JSX component module). Pinned as a literal so a drift is at least a
  // deliberate edit here. It's a hint string, not a rule the backend enforces.
  assert.deepEqual(CAP_HINTS, ['memory:write', 'attachment:write', 'connector:*', '*'])
})

// ─── Boundaries ──────────────────────────────────────────────────────────────

test('[MOB-6f] parseBoundary tolerates a garbled trustBoundary column', () => {
  assert.deepEqual(parseBoundary(null), { projects: [], tasks: [], agents: [] })
  assert.deepEqual(parseBoundary('nope'), { projects: [], tasks: [], agents: [] })
  assert.deepEqual(parseBoundary('{"projects":"p1"}'), { projects: [], tasks: [], agents: [] })
  assert.deepEqual(parseBoundary('{"projects":["p1"],"tasks":["t1"],"agents":[]}'), {
    projects: ['p1'],
    tasks: ['t1'],
    agents: [],
  })
})

test('[MOB-6f] boundaryCount + boundaryLine describe the set honestly', () => {
  assert.equal(boundaryCount({ projects: ['a'], tasks: ['b', 'c'], agents: [] }), 3)
  assert.equal(boundaryLine({ projects: [], tasks: [], agents: [] }), 'No boundary set')
  assert.equal(boundaryLine({ projects: ['a'], tasks: [], agents: [] }), '1 project')
  assert.equal(
    boundaryLine({ projects: ['a', 'b'], tasks: ['t'], agents: ['x'] }),
    '2 projects · 1 task · 1 agent',
  )
})

// ─── Policies ────────────────────────────────────────────────────────────────

test('[MOB-6f] the policy badge mirrors the web’s two-tone pill (and adds a glyph)', () => {
  const req: PolicyLite = { id: '1', action: 'memory.write', requiresApproval: 1 }
  const free: PolicyLite = { id: '2', action: 'task.read', requiresApproval: 0 }
  assert.deepEqual(policyBadge(req), { icon: '⏸', label: 'requires approval', tone: 'warn' })
  assert.deepEqual(policyBadge(free), { icon: '▸', label: 'allowed', tone: 'muted' })
  // SQLite hands back integers, but a boolean or a null must not flip the reading.
  assert.equal(policyBadge({ id: '3', action: 'x', requiresApproval: true }).tone, 'warn')
  assert.equal(policyBadge({ id: '4', action: 'x', requiresApproval: null }).tone, 'muted')
})

// ─── Revisions ───────────────────────────────────────────────────────────────

test('[MOB-6f] a revision row names its entity and its actor honestly', () => {
  const r: RevisionLite = {
    id: 'rev-1',
    entity: 'agent',
    entityId: 'abcdef0123456789',
    actor: 'arturito@7ei.ai',
    createdAt: 1_000_000,
  }
  assert.equal(revisionTitle(r), 'agent · abcdef01')
  assert.equal(revisionSubtitle(r, 1_000_000 + 5_000), 'arturito@7ei.ai · 5s ago')
  // No actor → say so, rather than inventing a system user.
  assert.equal(revisionSubtitle({ ...r, actor: null }, 1_000_000), 'unknown actor · 0s ago')
  assert.equal(revisionSubtitle({ ...r, actor: '   ' }, 1_000_000), 'unknown actor · 0s ago')
})

test('[MOB-6f] relTime is deterministic and never renders a negative age', () => {
  const now = 10_000_000
  assert.equal(relTime(now, now), '0s ago')
  assert.equal(relTime(now - 30_000, now), '30s ago')
  assert.equal(relTime(now - 5 * 60_000, now), '5m ago')
  assert.equal(relTime(now - 3 * 3_600_000, now), '3h ago')
  assert.equal(relTime(now - 2 * 86_400_000, now), '2d ago')
  // A clock skew must not produce "-4s ago".
  assert.equal(relTime(now + 4_000, now), '0s ago')
})

test('[MOB-6f] the revision feed is capped for display, newest-first order kept', () => {
  const many: RevisionLite[] = Array.from({ length: 120 }, (_, i) => ({
    id: `r${i}`,
    entity: 'agent',
    entityId: `e${i}`,
    createdAt: i,
  }))
  const rows = revisionRows(many)
  assert.equal(rows.length, REVISION_DISPLAY_LIMIT)
  // A slice, not a sort: the backend already orders newest-first.
  assert.equal(rows[0].id, 'r0')
  assert.equal(rows.at(-1)!.id, `r${REVISION_DISPLAY_LIMIT - 1}`)
})

// ─── The read-only promise ───────────────────────────────────────────────────

test('[MOB-6f] the screen carries a note explaining where writes live', () => {
  assert.match(GOVERNANCE_READONLY_NOTE, /read-only/i)
  assert.match(GOVERNANCE_READONLY_NOTE, /desktop/i)
})
