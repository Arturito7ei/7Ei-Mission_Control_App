// GC-2 — Command Center thread persistence
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'

process.env.DATABASE_URL = ':memory:'
process.env.SECRETS_ENC_KEY = 'gc2-thread-key'

import {
  targetAgentKey, buildUserBubbleText, turnsToConverseHistory,
  appendTurns, loadThread, parseJiraProjectKey,
} from '../services/command-center-thread'

test('[GC-2] targetAgentKey: Arturita default is empty string', () => {
  assert.equal(targetAgentKey(null, 'art-1'), '')
  assert.equal(targetAgentKey(undefined, 'art-1'), '')
  assert.equal(targetAgentKey('art-1', 'art-1'), '')
  assert.equal(targetAgentKey('bruno', 'art-1'), 'bruno')
})

test('[GC-2] buildUserBubbleText mirrors attachment/image chip labels', () => {
  assert.equal(buildUserBubbleText('hi', { name: 'spec.pdf' }, { name: 'shot.png' }), 'hi\n\n📎 spec.pdf\n\n🖼 shot.png')
})

test('[GC-2] turnsToConverseHistory marks agent replies with fromAgent', () => {
  const h = turnsToConverseHistory([
    { id: '1', role: 'user', content: 'q', createdAt: 1 },
    { id: '2', role: 'assistant', content: 'a', createdAt: 2, meta: { fromAgent: 'Bruno' } },
  ])
  assert.equal(h.length, 2)
  assert.equal(h[1].fromAgent, 'Bruno')
})

test('[GC-2] appendTurns + loadThread round-trip', { concurrency: false }, async () => {
  const ORG = `gc2-org-${randomUUID()}`
  const { db, schema } = await import('../db/client')
  await (await import('../db/setup')).setupDatabase()
  await db.insert(schema.organisations).values({ id: ORG, name: 'GC2 Org', ownerId: 'u1', createdAt: new Date() })
  await appendTurns({
    orgId: ORG,
    targetAgentKey: '',
    authorUser: 'u1',
    user: { content: 'Hello' },
    assistant: { role: 'arturita', content: 'Hi there', meta: { mode: 'answer' } },
    taskThreadId: 'task-1',
  })
  const loaded = await loadThread(ORG, '')
  assert.equal(loaded.turns.length, 2)
  assert.equal(loaded.turns[0].content, 'Hello')
  assert.equal(loaded.turns[1].content, 'Hi there')
  assert.equal(loaded.taskThreadId, 'task-1')
})

test('[GC-3] setOrgJiraProjectKey persists on the Arturita default thread row', { concurrency: false }, async () => {
  const ORG = `gc3-org-${randomUUID()}`
  const { db, schema } = await import('../db/client')
  await (await import('../db/setup')).setupDatabase()
  await db.insert(schema.organisations).values({ id: ORG, name: 'GC3 Org', ownerId: 'u1', createdAt: new Date() })
  const { setOrgJiraProjectKey, getOrgJiraProjectKey } = await import('../services/command-center-thread')
  assert.equal(await getOrgJiraProjectKey(ORG), null)
  await setOrgJiraProjectKey(ORG, 'MCA')
  assert.equal(await getOrgJiraProjectKey(ORG), 'MCA')
  await setOrgJiraProjectKey(ORG, null)
  assert.equal(await getOrgJiraProjectKey(ORG), null)
})

test('[GC-3] parseJiraProjectKey rejects malformed keys', () => {
  assert.throws(() => parseJiraProjectKey('bad key'), /invalid/)
  assert.equal(parseJiraProjectKey('  MCA  '), 'MCA')
  assert.equal(parseJiraProjectKey(null), null)
})
