import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyIntent, confirmationPhraseFor, isConfirmed, isGenericAffirmative,
  shouldReprompt, MIN_STT_CONFIDENCE,
} from '../services/intent'

// ─── classifyIntent: tier + approval-type mapping ────────────────────────────

const CASES: Array<{ t: string; tier: string; primary: string; approvalType?: string }> = [
  // critical (top tier)
  { t: 'delete last week\'s downloads', tier: 'critical', primary: 'delete', approvalType: 'file_destructive' },
  { t: 'permanently remove these files', tier: 'critical', primary: 'delete', approvalType: 'file_destructive' },
  { t: 'transfer 0.5 ETH to Alice', tier: 'critical', primary: 'transfer', approvalType: 'wallet_tx' },
  { t: 'swap 100 USDC for ETH', tier: 'critical', primary: 'transfer', approvalType: 'wallet_tx' },
  { t: 'sign the transaction', tier: 'critical', primary: 'sign', approvalType: 'wallet_tx' },
  // destructive
  { t: 'move the screenshots into the Q3 folder', tier: 'destructive', primary: 'move', approvalType: 'file_destructive' },
  { t: 'archive last month\'s invoices', tier: 'destructive', primary: 'move', approvalType: 'file_destructive' },
  { t: 'overwrite the config file', tier: 'destructive', primary: 'overwrite', approvalType: 'file_destructive' },
  { t: 'send that reply to the Fly invoice', tier: 'destructive', primary: 'send', approvalType: 'email_send' },
  { t: 'run the deploy script', tier: 'destructive', primary: 'exec', approvalType: 'machine_exec' },
  // informational "run" — not machine exec (regression: S3-B smoke / Thierry)
  { t: 'what llm you run on?', tier: 'safe', primary: 'read' },
  { t: 'what llm do you run on and what skills and access do you have?', tier: 'safe', primary: 'read' },
  { t: 'how do you run tests in CI?', tier: 'safe', primary: 'read' },
  { t: 'run me through the onboarding flow', tier: 'safe', primary: 'read' },
  { t: 'which models do you run in production?', tier: 'safe', primary: 'read' },
  // safe / read-only
  { t: 'what\'s on my calendar Thursday', tier: 'safe', primary: 'read' },
  { t: 'what is my ETH balance and gas price', tier: 'safe', primary: 'read' },
  { t: 'summarize this PDF', tier: 'safe', primary: 'read' },
  { t: '', tier: 'safe', primary: 'read' },
]

for (const c of CASES) {
  test(`[A3] classifyIntent: "${c.t.slice(0, 40)}" → ${c.tier}/${c.primary}`, () => {
    const r = classifyIntent(c.t)
    assert.equal(r.tier, c.tier, `tier for "${c.t}"`)
    assert.equal(r.primary, c.primary, `primary for "${c.t}"`)
    assert.equal(r.approvalType, c.approvalType, `approvalType for "${c.t}"`)
    assert.equal(r.destructive, c.tier !== 'safe')
  })
}

test('[A3] imperative exec still routes destructive (question phrasing with object)', () => {
  for (const t of [
    'run the deploy script',
    'execute the migration',
    'can you run this command for me?',
    'please launch the worker',
  ]) {
    const r = classifyIntent(t)
    assert.equal(r.tier, 'destructive', `expected destructive for: ${t}`)
    assert.equal(r.primary, 'exec', `expected exec for: ${t}`)
  }
})

test('[A3] critical outranks destructive when both present (delete + move)', () => {
  const r = classifyIntent('move these to trash then delete the originals')
  assert.equal(r.tier, 'critical')
  assert.equal(r.primary, 'delete')
  assert.ok(r.kinds.includes('move'))
  assert.ok(r.kinds.includes('delete'))
})

// ─── confirmationPhraseFor ───────────────────────────────────────────────────

test('[A3] confirmation phrase restates the action, never a bare yes', () => {
  assert.equal(confirmationPhraseFor(classifyIntent('delete the files')), 'confirm delete')
  assert.equal(confirmationPhraseFor(classifyIntent('move them')), 'confirm move')
  assert.equal(confirmationPhraseFor(classifyIntent('send the email')), 'confirm send')
  assert.equal(confirmationPhraseFor(classifyIntent('transfer 1 ETH')), 'confirm transfer')
  assert.equal(confirmationPhraseFor('sign'), 'confirm sign')
})

// ─── generic-affirmative detection ───────────────────────────────────────────

test('[A3] generic affirmatives are recognized (and rejected as confirmations)', () => {
  for (const y of ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'confirm', 'Confirmed!', 'do it', 'go ahead', 'yes please']) {
    assert.equal(isGenericAffirmative(y), true, `"${y}" should be generic`)
  }
  assert.equal(isGenericAffirmative('confirm delete'), false)
  assert.equal(isGenericAffirmative('yes delete them'), false)
})

// ─── STT-confidence reprompt ─────────────────────────────────────────────────

test('[A3] shouldReprompt fires below threshold; unknown confidence does not', () => {
  assert.equal(shouldReprompt(MIN_STT_CONFIDENCE - 0.01), true)
  assert.equal(shouldReprompt(MIN_STT_CONFIDENCE), false)
  assert.equal(shouldReprompt(0.95), false)
  assert.equal(shouldReprompt(null), false)      // provider gave no score → don't force reprompt
  assert.equal(shouldReprompt(undefined), false)
})

// ─── two-phase confirmation ──────────────────────────────────────────────────

test('[A3] safe intents need no confirmation', () => {
  assert.equal(isConfirmed({ intent: classifyIntent('what is on my calendar') }).ok, true)
})

test('[A3] a tap always confirms a destructive action', () => {
  assert.equal(isConfirmed({ intent: classifyIntent('delete the files'), tapped: true }).ok, true)
})

test('[A3] a bare generic yes never confirms the top tier', () => {
  const del = classifyIntent('delete the files')
  const r = isConfirmed({ intent: del, utterance: 'yes', confidence: 0.99 })
  assert.equal(r.ok, false)
  assert.match(r.reason!, /confirm delete/)
})

test('[A3] restating the action verb confirms; unrelated speech does not', () => {
  const del = classifyIntent('delete the files')
  assert.equal(isConfirmed({ intent: del, utterance: 'confirm delete', confidence: 0.9 }).ok, true)
  assert.equal(isConfirmed({ intent: del, utterance: 'yes, delete them', confidence: 0.9 }).ok, true)
  assert.equal(isConfirmed({ intent: del, utterance: 'actually never mind', confidence: 0.9 }).ok, false)
})

test('[A3] low-confidence confirmation re-prompts, never guesses', () => {
  const send = classifyIntent('send the reply')
  const r = isConfirmed({ intent: send, utterance: 'confirm send', confidence: 0.3 })
  assert.equal(r.ok, false)
  assert.equal(r.reprompt, true)
})

test('[A3] empty confirmation is not ok (preview shown, awaiting confirm)', () => {
  const mv = classifyIntent('move the files')
  const r = isConfirmed({ intent: mv, utterance: '', confidence: 0.9 })
  assert.equal(r.ok, false)
  assert.equal(r.reprompt, undefined)
})

test('[A3] wallet transfer needs the transfer verb restated', () => {
  const tx = classifyIntent('transfer 0.5 ETH to Bob')
  assert.equal(isConfirmed({ intent: tx, utterance: 'yes', confidence: 0.99 }).ok, false)
  assert.equal(isConfirmed({ intent: tx, utterance: 'confirm transfer', confidence: 0.99 }).ok, true)
})
