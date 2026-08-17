import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideConverseMode, buildConverseSystemPrompt } from '../services/arturita-converse'

// ─── Default = answer directly ───────────────────────────────────────────────

test('[J1] plain questions are answered directly (the default)', () => {
  for (const t of [
    "what's on my calendar Thursday",
    'how are the agents doing',
    'summarize what shipped this week',
    'what do you think of this plan',
    'write me a haiku about mission control',
    'give me a status update',
  ]) {
    const d = decideConverseMode({ transcript: t })
    assert.equal(d.mode, 'answer', `expected answer for: ${t}`)
    assert.equal(d.trigger, 'default_answer')
    assert.equal(d.destructive, false)
  }
})

// ─── Destructive → delegate (task + approval gate), safety first ─────────────

test('[J1] destructive intents route to the agent flow regardless of phrasing', () => {
  const del = decideConverseMode({ transcript: 'delete the old logs' })
  assert.equal(del.mode, 'delegate')
  assert.equal(del.trigger, 'destructive_intent')
  assert.equal(del.destructive, true)
  assert.equal(del.approvalType, 'file_destructive')

  const send = decideConverseMode({ transcript: 'send that email to the vendor' })
  assert.equal(send.mode, 'delegate')
  assert.equal(send.approvalType, 'email_send')

  const sign = decideConverseMode({ transcript: 'sign the transaction' })
  assert.equal(sign.mode, 'delegate')
  assert.equal(sign.approvalType, 'wallet_tx')
})

test('[J1] conversational "run" stays a direct answer (not machine exec)', () => {
  for (const t of [
    'what llm you run on?',
    'what llm do you run on and what skills and access do you have?',
    'how do you run tests in CI?',
    'run me through the onboarding flow',
    'which models do you run in production?',
  ]) {
    const d = decideConverseMode({ transcript: t })
    assert.equal(d.mode, 'answer', `expected answer for: ${t}`)
    assert.equal(d.trigger, 'default_answer')
    assert.equal(d.destructive, false)
  }
})

test('[J1] imperative exec still delegates (safety wins)', () => {
  for (const t of [
    'run the deploy script',
    'execute the migration now',
    'can you run this command for me?',
  ]) {
    const d = decideConverseMode({ transcript: t })
    assert.equal(d.mode, 'delegate', `expected delegate for: ${t}`)
    assert.equal(d.trigger, 'destructive_intent')
    assert.equal(d.approvalType, 'machine_exec')
  }
})

test('[J1] a destructive request phrased as a question still delegates (safety wins)', () => {
  const d = decideConverseMode({ transcript: 'can you delete the downloads folder?' })
  assert.equal(d.mode, 'delegate')
  assert.equal(d.destructive, true)
})

// ─── Explicit delegation language → delegate ─────────────────────────────────

test('[J1] explicit delegation phrases route to the agent flow', () => {
  for (const t of [
    'have the team draft the Q3 report',
    'delegate this research to an agent',
    'spin up an agent to monitor the deploy',
    'open a task to investigate the latency',
    'kick off the onboarding flow',
  ]) {
    const d = decideConverseMode({ transcript: t })
    assert.equal(d.mode, 'delegate', `expected delegate for: ${t}`)
    assert.ok(d.trigger === 'delegation_phrase' || d.trigger === 'build_order')
  }
})

// ─── Build / engineering work orders → delegate ──────────────────────────────

test('[J1] concrete build orders route to the board', () => {
  for (const t of [
    'build a landing page for the new product',
    'implement the webhook retry logic',
    'scaffold a new service for billing',
    'refactor the pricing module',
  ]) {
    const d = decideConverseMode({ transcript: t })
    assert.equal(d.mode, 'delegate', `expected delegate for: ${t}`)
    assert.equal(d.trigger, 'build_order')
  }
})

test('[J1] conversational "write/make" stays a direct answer (not a build order)', () => {
  for (const t of ['write me a poem', 'make a quick list of ideas', 'draft a tweet about this']) {
    const d = decideConverseMode({ transcript: t })
    assert.equal(d.mode, 'answer', `expected answer for: ${t}`)
  }
})

// ─── Explicit opt-in flag forces delegation ──────────────────────────────────

test('[J1] the explicit-delegate flag forces the agent flow for an otherwise-chat turn', () => {
  const d = decideConverseMode({ transcript: 'look into the pricing page', explicitDelegate: true })
  assert.equal(d.mode, 'delegate')
  assert.equal(d.trigger, 'explicit_flag')

  // …but destructive still takes precedence over the flag (approvalType preserved).
  const d2 = decideConverseMode({ transcript: 'delete the temp files', explicitDelegate: true })
  assert.equal(d2.trigger, 'destructive_intent')
  assert.equal(d2.approvalType, 'file_destructive')
})

test('[J1] every decision carries a human-readable reason', () => {
  for (const t of ['hello there', 'delete everything', 'build the app', 'have the team ship it']) {
    const d = decideConverseMode({ transcript: t })
    assert.ok(typeof d.reason === 'string' && d.reason.length > 0)
  }
})

test('[J1] empty / blank transcript answers directly (never guesses an action)', () => {
  assert.equal(decideConverseMode({ transcript: '' }).mode, 'answer')
  assert.equal(decideConverseMode({ transcript: '   ' }).mode, 'answer')
  assert.equal(decideConverseMode({ transcript: null }).mode, 'answer')
})

// ─── System prompt builder ───────────────────────────────────────────────────

test('[J1] converse system prompt is identity + answer-directly + no-action', () => {
  const p = buildConverseSystemPrompt({ agentName: 'Arturita', orgName: '7Ei', orgMission: 'ship agents' })
  assert.match(p, /You are Arturita/)
  assert.match(p, /Answer the operator directly/)
  assert.match(p, /take no actions in this turn/)
  assert.match(p, /ship agents/)
})

test('[J1] converse system prompt defaults name + org when unset', () => {
  const p = buildConverseSystemPrompt({})
  assert.match(p, /You are Arturita/)
  assert.match(p, /7Ei/)
})

test('[J1] converse system prompt includes a provided context block', () => {
  const p = buildConverseSystemPrompt({ contextBlock: '=== SYSTEM AWARENESS ===\n3 agents active' })
  assert.match(p, /SYSTEM AWARENESS/)
  assert.match(p, /3 agents active/)
})
