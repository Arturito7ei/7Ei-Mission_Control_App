// MOB-6d — tripwires for the Cost Centre arithmetic.
//
// The web computes these inline inside JSX (web/app/dashboard/page.tsx), so —
// exactly as with taskLog.ts — there is no web module to import and diff against.
// What these tests pin instead is the set of decisions that must not drift: the
// precision, the roster ordering, the null handling, and the one rule the phone
// deliberately does NOT share with the Task Log (4dp vs 5dp).
//
// Zero-dep: node --test --experimental-strip-types.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COST_DP,
  budgetAmountLabel,
  budgetChip,
  budgetScopeLabel,
  costsByAgent,
  doneCount,
  formatShare,
  formatSpend,
  formatTokensK,
  totalCost,
  totalTokens,
  type CostAgentLite,
  type CostTaskLite,
} from './costs.ts'
import { formatCost } from './taskLog.ts'

const AGENTS: CostAgentLite[] = [
  { id: 'a1', name: 'Arturita', avatarEmoji: '🤖' },
  { id: 'a2', name: 'Scribe', avatarEmoji: '📝' },
  // Spends nothing — the web still gives it a row.
  { id: 'a3', name: 'Idle Hands', avatarEmoji: '🫥' },
]

const TASKS: CostTaskLite[] = [
  { agentId: 'a1', status: 'done', costUsd: 0.03, tokensUsed: 1000 },
  { agentId: 'a1', status: 'done', costUsd: 0.01, tokensUsed: 500 },
  { agentId: 'a2', status: 'in_progress', costUsd: 0.06, tokensUsed: 2000 },
  // Unrecorded cost/tokens — contributes 0 to a total, per the web's `?? 0`.
  { agentId: 'a2', status: 'pending', costUsd: null, tokensUsed: null },
]

test('[MOB-6d] totals sum the web’s way, and a null contributes 0', () => {
  assert.ok(Math.abs(totalCost(TASKS) - 0.1) < 1e-9)
  assert.equal(totalTokens(TASKS), 3500)
  // The null-cost task must not poison the sum into NaN.
  assert.ok(Number.isFinite(totalCost(TASKS)))
  assert.equal(totalCost([]), 0)
  assert.equal(totalTokens([]), 0)
})

test('[MOB-6d] "Done" counts only the exact status, not everything finished-ish', () => {
  assert.equal(doneCount(TASKS), 2)
  // The web compares `t.status === 'done'` verbatim — no aliasing, so a
  // 'succeeded' run-word must NOT be counted here even though status.ts would
  // canonicalise other words elsewhere.
  assert.equal(doneCount([{ status: 'succeeded' }, { status: 'done' }]), 1)
})

test('[MOB-6d] the Cost Centre renders 4dp — and the Task Log still renders 5dp', () => {
  assert.equal(formatSpend(0.1), '$0.1000')
  assert.equal(formatSpend(0), '$0.0000')
  assert.equal(COST_DP, 4)
  // The two web views genuinely disagree; this pins that we mirrored BOTH rather
  // than tidying them into one and silently changing a number on one screen.
  assert.equal(formatCost(0.1), '$0.10000')
  assert.notEqual(formatSpend(0.1), formatCost(0.1))
})

test('[MOB-6d] tokens render as thousands to 1dp', () => {
  assert.equal(formatTokensK(3500), '3.5K')
  assert.equal(formatTokensK(0), '0.0K')
  assert.equal(formatTokensK(1_234_567), '1234.6K')
})

test('[MOB-6d] the breakdown keeps ROSTER order and keeps $0 agents', () => {
  const rows = costsByAgent(TASKS, AGENTS)
  assert.deepEqual(rows.map((r) => r.agent.id), ['a1', 'a2', 'a3'])
  // Not sorted by spend: a2 outspends a1 but a1 stays first, as on the desk.
  assert.ok(rows[1].cost > rows[0].cost)
  assert.equal(rows[2].cost, 0, 'a silent agent must still have a row')
})

test('[MOB-6d] per-agent spend sums to the total', () => {
  const rows = costsByAgent(TASKS, AGENTS)
  const summed = rows.reduce((s, r) => s + r.cost, 0)
  assert.ok(Math.abs(summed - totalCost(TASKS)) < 1e-9)
  const pcts = rows.reduce((s, r) => s + r.pct, 0)
  assert.ok(Math.abs(pcts - 100) < 1e-9)
})

test('[MOB-6d] zero spend divides by nothing', () => {
  const rows = costsByAgent([{ agentId: 'a1', status: 'pending', costUsd: null }], AGENTS)
  for (const r of rows) {
    assert.equal(r.cost, 0)
    assert.equal(r.pct, 0, 'a 0/0 share must be 0, never NaN')
    assert.ok(!Number.isNaN(r.pct))
  }
  assert.equal(formatShare(0), '0%')
})

test('[MOB-6d] a share is the true percentage — no 1% bar-width floor', () => {
  assert.equal(formatShare(40), '40%')
  // The web floors the BAR at 1% so a hairline stays visible. Printing that floor
  // would round a real 0.2% up to 1% — the number must stay true.
  assert.equal(formatShare(0.2), '0%')
})

test('[MOB-6d] a task for an unknown agent is not attributed to anyone', () => {
  // It still counts toward the org total (the web sums all tasks) but matches no
  // roster row — so the per-agent column can legitimately sum to less than total.
  const orphan: CostTaskLite[] = [{ agentId: 'ghost', status: 'done', costUsd: 0.5 }]
  assert.equal(totalCost(orphan), 0.5)
  assert.deepEqual(costsByAgent(orphan, AGENTS).map((r) => r.cost), [0, 0, 0])
})

// ─── Budgets ─────────────────────────────────────────────────────────────────

test('[MOB-6d] budget labels mirror the web’s cells', () => {
  assert.equal(budgetScopeLabel({ id: 'b', scope: 'company', scopeId: null, limitUsd: 50, spend: 1, state: 'ok', pct: 0.02 }), 'company')
  assert.equal(
    budgetScopeLabel({ id: 'b', scope: 'agent', scopeId: 'abcdef123456', limitUsd: 50, spend: 1, state: 'ok', pct: 0.02 }),
    'agent · abcdef',
    'the web cuts the scope id at 6 chars',
  )
  assert.equal(
    budgetAmountLabel({ id: 'b', scope: 'company', scopeId: null, limitUsd: 50, spend: 12.4, state: 'ok', pct: 0.248 }),
    '$12.40 / $50',
  )
})

test('[MOB-6d] every budget state is distinguishable without colour', () => {
  const states = ['ok', 'warn', 'breach']
  const glyphs = states.map((s) => budgetChip(s).glyph)
  assert.equal(new Set(glyphs).size, states.length, 'two states share a glyph — colour would be the only signal')
  assert.equal(budgetChip('breach').tone, 'danger')
  assert.equal(budgetChip('warn').tone, 'warn')
  assert.equal(budgetChip('ok').tone, 'ok')
})

test('[MOB-6d] an unknown budget state degrades quietly, and never reads as OK', () => {
  const chip = budgetChip('something-new')
  assert.equal(chip.tone, 'neutral')
  assert.notEqual(chip.tone, 'ok', 'an unknown state must not claim the budget is fine')
  assert.deepEqual(budgetChip(null), { tone: 'neutral', glyph: '○' })
  assert.deepEqual(budgetChip(undefined), { tone: 'neutral', glyph: '○' })
})
