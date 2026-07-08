import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuestion, routeVoiceCommand } from '../services/voice-routing'

// ─── Question detection ──────────────────────────────────────────────────────

test('[B3] isQuestion recognizes interrogatives + trailing ?', () => {
  assert.equal(isQuestion('what is on my calendar Thursday'), true)
  assert.equal(isQuestion("what's my ETH balance"), true)
  assert.equal(isQuestion('do I have any meetings today'), true)
  assert.equal(isQuestion('is the deploy done?'), true)
  assert.equal(isQuestion('move the files'), false)
  assert.equal(isQuestion('summarize this PDF'), false)
  assert.equal(isQuestion(''), false)
})

// ─── Routing ─────────────────────────────────────────────────────────────────

test('[B3] questions route to a single-turn ask', () => {
  const r = routeVoiceCommand({ transcript: 'what is on my calendar Thursday' })
  assert.equal(r.workMode, 'ask')
  assert.equal(r.intent.tier, 'safe')
  assert.match(r.reason, /single-turn/)
})

test('[B3] work orders route to the execute loop', () => {
  const r = routeVoiceCommand({ transcript: 'summarize this PDF and save it' })
  assert.equal(r.workMode, 'execute')
})

test('[B3] destructive intents ALWAYS execute, even phrased as a question', () => {
  // "can you delete the downloads?" is phrased as a question but is an action.
  const r = routeVoiceCommand({ transcript: 'can you delete the downloads?' })
  assert.equal(r.workMode, 'execute')
  assert.equal(r.intent.tier, 'critical')
  assert.match(r.reason, /destructive/)
})

test('[B3] a wallet transfer is a work order (execute), never an ask', () => {
  const r = routeVoiceCommand({ transcript: 'transfer 0.5 ETH to Bob' })
  assert.equal(r.workMode, 'execute')
  assert.equal(r.intent.approvalType, 'wallet_tx')
})

test('[B3] a follow-up utterance re-enters the same thread', () => {
  const fresh = routeVoiceCommand({ transcript: 'what about Friday' })
  assert.equal(fresh.isFollowUp, false)

  const follow = routeVoiceCommand({ transcript: 'what about Friday', existingThreadId: 'task_123' })
  assert.equal(follow.isFollowUp, true)
  assert.equal(follow.workMode, 'ask') // still a question, continues the ask thread
})

test('[B3] read-only question about the wallet routes to ask (no tx)', () => {
  const r = routeVoiceCommand({ transcript: 'what is my ETH balance and the gas price' })
  assert.equal(r.workMode, 'ask')
  assert.equal(r.intent.destructive, false)
})
