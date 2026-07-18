// APPR-1 — regression tripwire on the desk's approval-decide path.
//
// The shipped defect was not a missing feature but a LYING UI: `decide()` in
// CockpitPanel.tsx removed the approval card BEFORE awaiting the request and then
// swallowed every failure with a bare `catch {}`. Combined with the missing
// `x-arturita-session` header, approving a dangerous action on the desk produced a
// backend 403 that rendered as success — the operator believed a connector action,
// wallet transaction or file deletion had been approved when the server had refused it.
//
// The fix is an ORDERING + ERROR-HANDLING property of one function, and the web
// workspace has no React renderer (node --test, zero deps — see the root CLAUDE.md),
// so it cannot be asserted by mounting the component. It is asserted here against the
// SOURCE, the same text-read pattern the connector-catalog and dangerous-type
// tripwires use. Narrowly scoped to the `decide` function body so unrelated edits to
// CockpitPanel don't produce false failures.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function decideBody(): string {
  const src = readFileSync(new URL('./CockpitPanel.tsx', import.meta.url), 'utf8')
  // From `const decide = async (` to the closing brace at the same indent level.
  const m = /const decide = async \([\s\S]*?\n  \}/.exec(src)
  assert.ok(m, 'could not locate the decide() function in CockpitPanel.tsx — did it move? The tripwire must be re-anchored, not deleted.')
  return m![0]
}

test('[APPR-1] decide() clears the card only AFTER the request resolves', () => {
  const body = decideBody()
  const removal = body.indexOf('setApprovals(')
  const send = body.indexOf('await api(')
  assert.notEqual(removal, -1, 'decide() no longer removes the approval — did the success path change?')
  assert.notEqual(send, -1, 'decide() no longer issues the decide request')
  assert.ok(
    removal > send,
    'REGRESSION: decide() removes the approval card BEFORE awaiting the request. ' +
      'That is the APPR-1 defect: a rejected decision (e.g. the backend 403 on a dangerous ' +
      'approve without step-up) would look exactly like success. Clear the card only on a 2xx.',
  )
})

test('[APPR-1] decide() does not swallow failures', () => {
  const body = decideBody()
  assert.doesNotMatch(
    body,
    /catch\s*\{\s*\}/,
    'REGRESSION: decide() swallows errors with a bare `catch {}`. A failed decision must be ' +
      'surfaced to the operator, not discarded — that is how the dangerous-approve 403 stayed invisible.',
  )
  assert.match(body, /setDecideErr/, 'decide() must record a per-approval error so the card can show it')
})

test('[APPR-1] a dangerous approve is routed to step-up, never sent bare', () => {
  const body = decideBody()
  assert.match(
    body,
    /approvalNeedsStepUp\(/,
    'decide() must consult approvalNeedsStepUp — otherwise a dangerous approve is sent with no ' +
      'x-arturita-session header and 403s at the backend',
  )
  // The step-up branch must return BEFORE the plain decide call, so a dangerous
  // approve can never fall through to the headerless request.
  const gate = body.indexOf('approvalNeedsStepUp(')
  const send = body.indexOf('await api(')
  assert.ok(gate < send, 'the step-up gate must precede the plain decide request')
  assert.match(body.slice(gate, send), /return/, 'the step-up branch must return, not fall through to the headerless send')
})

test('[APPR-1 audit nit a] a missing approval row never falls through to the headerless send', () => {
  const body = decideBody()
  // If `approvals.find()` misses we cannot know whether the row is dangerous.
  // Guessing "safe" would send a bare approve the server correctly 403s — a dead
  // end for the operator. The miss must be handled and returned on explicitly.
  const miss = /!approval/.exec(body)
  assert.ok(miss, 'decide() must handle the approvals.find() miss explicitly')
  const send = body.indexOf('await api(')
  assert.ok(miss!.index < send, 'the miss check must precede the decide request')
  assert.match(
    body.slice(miss!.index, send),
    /return/,
    'the miss branch must RETURN — otherwise a dangerous approve whose row is not in view is sent with no step-up header',
  )
})

test('[APPR-1 audit nit b] a mint failure is not reported as an expired step-up', () => {
  const src = readFileSync(new URL('./cockpit/StepUpDialog.tsx', import.meta.url), 'utf8')
  // The mint and the decide are separate legs with separate catches: a 403 from
  // the MINT is an authorization problem (retrying never helps); a 403 from the
  // DECIDE is a stale session (retrying re-mints and usually works). Conflating
  // them told an operator without permission to keep typing APPROVE at a wall.
  const catches = src.match(/catch \(e: any\)/g) ?? []
  assert.ok(catches.length >= 2, 'the mint and decide legs must be caught separately, not under one catch')
  const mintIdx = src.indexOf('arturita/session')
  const decideIdx = src.indexOf('/decide')
  assert.ok(mintIdx !== -1 && decideIdx !== -1 && mintIdx < decideIdx)
  // The mint's own catch must not claim the step-up expired.
  const mintLeg = src.slice(mintIdx, decideIdx)
  assert.doesNotMatch(mintLeg, /expired/i,
    'the mint failure path must not say "expired" — that is the decide leg\'s diagnosis')
  assert.match(mintLeg, /not allowed|authoriz/i, 'the mint failure path should name it as an authorization problem')
})

test('[APPR-1] the step-up dialog sends the header and is the only bare-approve path', () => {
  const src = readFileSync(new URL('./cockpit/StepUpDialog.tsx', import.meta.url), 'utf8')
  assert.match(src, /'x-arturita-session'/, 'the step-up dialog must send the x-arturita-session header')
  assert.match(src, /arturita\/session/, 'the step-up dialog must mint a fresh session')
  assert.match(src, /typedConfirmationOk/, 'the dialog must require an explicit human confirmation before minting')

  // The mint must NOT happen before the human gate: submit() bails on an
  // unconfirmed input. This is what stops the desk from silently auto-minting a
  // step-up session on the operator's behalf, which would satisfy the server while
  // defeating the purpose of the gate.
  const submit = /const submit = useCallback\([\s\S]*?\n  \}, \[/.exec(src)
  assert.ok(submit, 'could not locate submit() in StepUpDialog')
  const gate = submit![0].indexOf('typedConfirmationOk')
  const mint = submit![0].indexOf('arturita/session')
  assert.ok(gate !== -1 && mint !== -1 && gate < mint, 'submit() must check the typed confirmation BEFORE minting a step-up session')
})
