import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DANGEROUS_APPROVAL_TYPES, isDangerousType, requiresStepUp,
  formatBytes, renderActionSummary, evaluateStepUp,
} from '../services/dangerous-approvals'
import { decideApproval } from '../services/approvals'

// ─── Type classification ─────────────────────────────────────────────────────

test('[A2] the four dangerous types are recognized; others are not', () => {
  for (const t of DANGEROUS_APPROVAL_TYPES) assert.equal(isDangerousType(t), true)
  assert.equal(isDangerousType('file_destructive'), true)
  assert.equal(isDangerousType('File Destructive'), true) // normalized
  assert.equal(isDangerousType('WALLET_TX'), true)
  assert.equal(isDangerousType('spend'), false)           // existing non-dangerous type
  assert.equal(isDangerousType('hire'), false)
  assert.equal(isDangerousType(null), false)
  assert.equal(isDangerousType(''), false)
  assert.equal(requiresStepUp('machine_exec'), true)
  assert.equal(requiresStepUp('memory.write'), false)
})

// ─── Byte formatting ─────────────────────────────────────────────────────────

test('[A2] formatBytes renders human sizes; guards non-positive', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(null), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1288490188), '1.2 GB')
})

// ─── file_destructive ────────────────────────────────────────────────────────

test('[A2] file_destructive renders a verbatim manifest per op', () => {
  const move = renderActionSummary('file_destructive', { op: 'move', count: 42, bytes: 1288490188, dest: '~/Archive/2026-07', root: '~/Downloads' })
  assert.equal(move.ok, true)
  assert.equal(move.summary, 'Move 42 items (1.2 GB) from ~/Downloads → ~/Archive/2026-07')

  const del = renderActionSummary('file_destructive', { op: 'delete', count: 1, root: '~/tmp' })
  assert.equal(del.summary, 'Delete 1 item from ~/tmp')
  assert.ok(del.warnings!.some(w => /undo journal/i.test(w)))

  const trash = renderActionSummary('file_destructive', { op: 'trash', count: 3 })
  assert.equal(trash.summary, 'Move 3 items → Trash')
})

test('[A2] file_destructive fails closed on bad/missing fields', () => {
  assert.equal(renderActionSummary('file_destructive', { op: 'frobnicate', count: 1 }).ok, false)
  assert.equal(renderActionSummary('file_destructive', { op: 'move', count: 1 }).ok, false) // no dest
  assert.equal(renderActionSummary('file_destructive', { op: 'delete' }).ok, false)          // no count
  assert.equal(renderActionSummary('file_destructive', {}).ok, false)
})

// ─── wallet_tx ───────────────────────────────────────────────────────────────

test('[A2] wallet_tx formats the decoded summary + surfaces scam warnings', () => {
  const r = renderActionSummary('wallet_tx', {
    chain: 'ethereum', decoded: 'Swap 0.5 ETH → ~1,180 USDC on Uniswap v3',
    to: '0xE592...1564', contractLabel: 'Uniswap V3 Router',
    unlimitedApproval: true, unknownContract: false,
  })
  assert.equal(r.ok, true)
  assert.equal(r.summary, '[ethereum] Swap 0.5 ETH → ~1,180 USDC on Uniswap v3 → 0xE592...1564 · Uniswap V3 Router')
  assert.ok(r.warnings!.some(w => /unlimited/i.test(w)))
})

test('[A2] wallet_tx flags setApprovalForAll, new address, drain pattern, over-cap', () => {
  const r = renderActionSummary('wallet_tx', {
    chain: 'polygon', decoded: 'setApprovalForAll on BoredApes',
    newAddress: true, setApprovalForAll: true, drainPattern: true, overCap: true,
  })
  assert.equal(r.ok, true)
  const w = r.warnings!.join(' | ')
  assert.match(w, /never-before-seen/i)
  assert.match(w, /setApprovalForAll/i)
  assert.match(w, /drain/i)
  assert.match(w, /cap/i)
})

test('[A2] wallet_tx fails closed without chain or decoded summary', () => {
  assert.equal(renderActionSummary('wallet_tx', { decoded: 'x' }).ok, false)
  assert.equal(renderActionSummary('wallet_tx', { chain: 'ethereum' }).ok, false)
})

// ─── email_send ──────────────────────────────────────────────────────────────

test('[A2] email_send renders recipients + subject + size; flags external/reply-all/attachments', () => {
  const r = renderActionSummary('email_send', {
    to: ['a@b.com', 'c@d.com'], subject: 'Re: Fly invoice', bodyBytes: 1300,
    external: true, replyAll: true, attachments: 2,
  })
  assert.equal(r.ok, true)
  assert.equal(r.summary, 'Send email to a@b.com, c@d.com — "Re: Fly invoice" (1.3 KB body)')
  const w = r.warnings!.join(' | ')
  assert.match(w, /external/i)
  assert.match(w, /reply-all/i)
  assert.match(w, /2 attachments/i)
})

test('[A2] email_send collapses long recipient lists and refuses secret bodies', () => {
  const r = renderActionSummary('email_send', {
    to: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'], subject: 'Hi', secretPattern: true,
  })
  assert.match(r.summary!, /\+2 more/)
  assert.ok(r.warnings!.some(w => /secret pattern/i.test(w)))
})

test('[A2] email_send fails closed without recipient or subject', () => {
  assert.equal(renderActionSummary('email_send', { subject: 'x' }).ok, false)
  assert.equal(renderActionSummary('email_send', { to: 'a@b.com' }).ok, false)
})

// ─── machine_exec ────────────────────────────────────────────────────────────

test('[A2] machine_exec shows argv verbatim (never a shell string)', () => {
  const r = renderActionSummary('machine_exec', { argv: ['git', 'status', '--porcelain'], cwd: '~/proj' })
  assert.equal(r.ok, true)
  assert.equal(r.summary, 'Run: git status --porcelain (cwd: ~/proj)')

  const off = renderActionSummary('machine_exec', { argv: ['rm', '-rf', 'build'], allowlisted: false })
  assert.ok(off.warnings!.some(w => /NOT on the allowlist/i.test(w)))
})

test('[A2] machine_exec fails closed on empty argv', () => {
  assert.equal(renderActionSummary('machine_exec', { argv: [] }).ok, false)
  assert.equal(renderActionSummary('machine_exec', {}).ok, false)
})

test('[A2] renderActionSummary rejects a non-dangerous type', () => {
  assert.equal(renderActionSummary('spend', { amount: 5 }).ok, false)
})

// ─── Step-up gate ────────────────────────────────────────────────────────────

test('[A2] evaluateStepUp: dangerous approve needs a fresh session', () => {
  assert.equal(evaluateStepUp({ type: 'wallet_tx', decision: 'approved', sessionFresh: true }).ok, true)
  assert.equal(evaluateStepUp({ type: 'wallet_tx', decision: 'approved', sessionFresh: false }).ok, false)
  // reject / revision never gated
  assert.equal(evaluateStepUp({ type: 'wallet_tx', decision: 'rejected', sessionFresh: false }).ok, true)
  assert.equal(evaluateStepUp({ type: 'wallet_tx', decision: 'revision_requested', sessionFresh: false }).ok, true)
  // non-dangerous never gated
  assert.equal(evaluateStepUp({ type: 'spend', decision: 'approved', sessionFresh: false }).ok, true)
})

// ─── decideApproval step-up integration ──────────────────────────────────────

test('[A2] decideApproval enforces step-up on approve; backward compatible without it', () => {
  // Backward compatible: no requireStepUp → unchanged behavior.
  assert.equal(decideApproval({ decision: 'approved', actor: 'u' }).ok, true)

  // Dangerous approve without step-up → blocked.
  const blocked = decideApproval({ decision: 'approved', actor: 'u', requireStepUp: true, stepUpSatisfied: false })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error!, /step-up required/i)

  // Dangerous approve WITH step-up → allowed.
  assert.equal(decideApproval({ decision: 'approved', actor: 'u', requireStepUp: true, stepUpSatisfied: true }).ok, true)

  // Reject a dangerous approval never needs step-up.
  assert.equal(decideApproval({ decision: 'rejected', actor: 'u', requireStepUp: true, stepUpSatisfied: false }).ok, true)

  // Revision still needs its note, independent of step-up.
  assert.equal(decideApproval({ decision: 'revision_requested', actor: 'u', requireStepUp: true, stepUpSatisfied: true }).ok, false)
  assert.equal(decideApproval({ decision: 'revision_requested', note: 'narrow it', actor: 'u', requireStepUp: true, stepUpSatisfied: true }).ok, true)
})
