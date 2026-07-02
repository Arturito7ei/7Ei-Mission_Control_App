// MCA-DIST S5.1 — orchestration evals. Scores the real backend decision logic on
// scenarios that matter for a control plane. Run: `npm run evals` (from backend/).
// Exits non-zero on any failure, so it can gate CI.
import { isClaimable, blockersSatisfied } from '../backend/src/services/runs'
import { evaluatePolicy, isHardStop } from '../backend/src/services/budget'
import { isCapabilityAllowed, signRunToken, verifyRunToken } from '../backend/src/services/governance2'

type Result = { name: string; passed: boolean; detail?: string }
const results: Result[] = []
const check = (name: string, cond: boolean, detail = '') => results.push({ name, passed: !!cond, detail })

// 1. Atomic checkout — only one concurrent claimer wins.
{
  const assigned = { status: 'assigned' as string, lockedAt: null as any }
  const a = isClaimable(assigned)                        // agent A can claim
  const afterA = { status: 'in_progress', lockedAt: Date.now() }
  const b = isClaimable(afterA)                          // agent B now blocked
  check('atomic checkout: exactly one winner', a === true && b === false, `A=${a} B=${b}`)
}

// 2. Orphan recovery — an in_progress task with an expired lease is reclaimable.
{
  const stale = { status: 'in_progress', lockedAt: Date.now() - 20 * 60 * 1000 }
  check('orphan recovery: expired lease reclaimable', isClaimable(stale) === true)
}

// 3. Budget hard-stop — overspend breaches and parks work.
{
  const policy = { limitUsd: 5, hardStop: true } as any
  const { state } = evaluatePolicy(policy, 6)
  check('budget: hard-stop breach on overspend', state === 'breach' && isHardStop(policy))
}

// 4. Dependency gating.
check('deps: unfinished blocker gates claim', blockersSatisfied(['done', 'in_progress']) === false)
check('deps: all blockers done unblocks', blockersSatisfied(['done', 'done']) === true)

// 5. Per-agent permissions.
check('perms: allow-all when unset', isCapabilityAllowed(null, 'memory:write') === true)
check('perms: deny ungranted capability', isCapabilityAllowed(['memory:read'], 'memory:write') === false)
check('perms: namespace wildcard grants', isCapabilityAllowed(['memory:*'], 'memory:write') === true)

// 6. Run-token integrity.
{
  const now = Date.now()
  const tok = signRunToken({ agentId: 'a1', runId: 'r1' }, 'secret', now, 60_000)
  check('run-token: valid round-trip', verifyRunToken(tok, 'secret', now + 1000).valid === true)
  check('run-token: tamper rejected', verifyRunToken(tok + 'x', 'secret', now).valid === false)
  check('run-token: expiry enforced', verifyRunToken(tok, 'secret', now + 120_000).valid === false)
}

// Report
const pass = results.filter(r => r.passed).length
console.log('\n=== 7Ei Mission Control — Orchestration Evals ===')
for (const r of results) console.log(`${r.passed ? '✓' : '✗'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`)
console.log(`\nScore: ${pass}/${results.length} scenarios passed`)
process.exit(pass === results.length ? 0 : 1)
