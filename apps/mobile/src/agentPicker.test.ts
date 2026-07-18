// GC-1 — the phone's agent picker, and the PARITY TRIPWIRE that keeps it honest.
//
// Metro cannot import from `web/`, so `agentPicker.ts` hand-copies the desk's decisions.
// A hand-copy without a tripwire is silent drift — the standing rule in the root
// CLAUDE.md — so this file imports the WEB module and asserts the two agree. If someone
// changes the sentinel, the wire mapping, or the marking rule on one surface only, this
// goes red.
//
// NOTE on the cross-workspace import: `web/app/dashboard/assistant.logic.ts` must stay
// dependency-free for this to work. Mobile CI installs only `apps/mobile`, so a web
// module that grew a real import would resolve locally and silently drop this whole file
// in CI — the exact failure recorded in the mobile-CI memory note. `assistant.logic.ts`
// is pure today; `attach.test.ts` already depends on that same property.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ARTURITA_CHOICE as WEB_SENTINEL,
  toWireAgentId as webToWire,
  toConverseRequest as webToRequest,
  toArturitaMessage as webToMessage,
} from '../../../web/app/dashboard/assistant.logic.ts'

import {
  ARTURITA_CHOICE, ARTURITA_IDENTITY, toWireAgentId, pickableAgents,
  resolveRecipient, historyMarker,
} from './agentPicker.ts'

// ── PARITY with the desk ──────────────────────────────────────────────────────

test('[GC-1 parity] the Arturita sentinel is the same string on both surfaces', () => {
  assert.equal(ARTURITA_CHOICE, WEB_SENTINEL,
    'the phone and the desk disagree on the default-recipient sentinel')
})

test('[GC-1 parity] the wire mapping decides identically on both surfaces', () => {
  for (const input of [null, undefined, '', ARTURITA_CHOICE, 'agent-123', 'x'] as const) {
    assert.equal(toWireAgentId(input as any), webToWire(input as any),
      `phone and desk disagree on toWireAgentId(${JSON.stringify(input)})`)
  }
})

test('[GC-1 parity] the default turn sends NO agentId on either surface', () => {
  const web = webToRequest({ message: 'hi', history: [] })
  assert.equal('agentId' in web, false, 'the desk default grew an agentId')
  assert.equal(toWireAgentId(ARTURITA_CHOICE), null, 'the phone default would send an agentId')
})

test('[GC-1 parity] only a mode:agent reply is marked untrusted, on both surfaces', () => {
  // Desk
  const deskAgent = webToMessage({ id: 'a', resp: { mode: 'agent', reply: { text: 'x' }, agent: { id: '1', name: 'Bruno' } } })
  const deskArturita = webToMessage({ id: 'b', resp: { mode: 'answer', reply: { text: 'x' }, agent: { id: '2', name: 'Arturita' } } })
  assert.equal(deskAgent.fromAgent, 'Bruno')
  assert.equal(deskArturita.fromAgent, null)

  // Phone — same rule, expressed as historyMarker
  assert.equal(historyMarker({ role: 'assistant', mode: 'agent', agentName: 'Bruno' }), 'Bruno')
  assert.equal(historyMarker({ role: 'assistant', mode: 'answer', agentName: 'Arturita' }), null,
    'the phone would fence ARTURITA\'S replies — every existing thread would change')
})

// ── The phone's own decisions ─────────────────────────────────────────────────

test('[GC-1] a USER turn can never be marked agent-authored', () => {
  assert.equal(historyMarker({ role: 'user', mode: 'agent', agentName: 'Bruno' }), null,
    'a crafted USER turn could smuggle itself in as "an agent said this"')
})

test('[GC-1] the picker excludes Arturita and terminated agents', () => {
  const out = pickableAgents([
    { id: '1', agentType: 'arturita', status: 'idle' },
    { id: '2', agentType: 'standard', status: 'idle' },
    { id: '3', agentType: 'standard', status: 'terminated' },
  ])
  assert.deepEqual(out.map(a => a.id), ['2'],
    'the picker offers a duplicate Arturita entry or an agent that cannot run')
  assert.deepEqual(pickableAgents(null).length, 0, 'a null roster must not throw')
})

test('[GC-1] an unknown or absent id resolves to Arturita, never to a blank', () => {
  const roster = [{ id: 'a1', name: 'Bruno', role: 'Eng' }]
  assert.equal(resolveRecipient('a1', roster).name, 'Bruno')
  assert.equal(resolveRecipient('deleted-agent', roster).id, ARTURITA_IDENTITY.id,
    'a deleted agent left the bar showing a raw id or a blank')
  assert.equal(resolveRecipient(null, roster).name, 'Arturita')
  assert.equal(resolveRecipient(ARTURITA_CHOICE, []).name, 'Arturita')
  // The fallback must be renderable — the bar always shows a face and a name.
  assert.ok(resolveRecipient('nope', []).avatarEmoji, 'the fallback identity has no avatar')
})

// ── AUDIT LOW-1 — the delegate ack is Arturita's, the assignee is separate ────
//
// PARITY: the desk pins the same property in assistant.picker.test.ts. Mirrored here
// because the phone renders its own bubble, so the desk's fix does not carry over.

test('[GC-1 audit] a delegate ack is NOT marked agent-authored', () => {
  // `historyMarker` is the phone's expression of "who wrote this". A delegate ack is
  // Arturita's, so it must not be marked — which is also what keeps the bold agent
  // name off that bubble (the attribution block is keyed on the same flag).
  assert.equal(historyMarker({ role: 'assistant', mode: 'delegate', agentName: 'Bruno the Builder' }), null,
    'a delegate ack was marked as written by the ASSIGNEE — the transcript names the wrong speaker')
  // …while a real agent turn still is.
  assert.equal(historyMarker({ role: 'assistant', mode: 'agent', agentName: 'Bruno the Builder' }), 'Bruno the Builder')
})

test('[GC-1 audit] the screen keys attribution on fromAgent and renders the assignee apart', () => {
  // No renderer under `node --test`, so the wiring is pinned against the source — the
  // technique activityScreen.test.ts already uses. Without this a future edit could
  // re-key the author off `m.agent` and silently restore the bug on the phone only.
  const src = readFileSync(new URL('./screens/CommandCenterScreen.tsx', import.meta.url).pathname, 'utf-8')
  assert.match(src, /\{m\.fromAgent && m\.agent \?/,
    'the bubble author is not keyed on fromAgent — a delegate ack would render under the assignee')
  assert.match(src, /m\.assignedTo \?/, 'the assignee is not rendered')
  assert.match(src, /assigned to \$\{m\.assignedTo\.name\}/, 'the assignee chip does not name the assignee')
})
