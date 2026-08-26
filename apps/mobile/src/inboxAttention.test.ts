// S6 — mobile Inbox attention queue tripwires.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { INBOX_KIND_LABEL, inboxKindLabel } from './inboxAttention.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const WEB_SHARED = read('../../../web/app/dashboard/cockpit/shared.tsx')
const INBOX_SCREEN = read('./screens/InboxScreen.tsx')
const SEGMENT = read('./screens/InboxSegmentPane.tsx')
const QUEUE = read('./screens/AttentionQueue.tsx')
const APPROVALS = read('./screens/ApprovalsPane.tsx')
const API = read('./api.ts')

test('[S6] kind labels match the web inbox chip copy', () => {
  for (const kind of ['blocked', 'failed', 'review', 'attention'] as const) {
    const web = new RegExp(`${kind}:\\s*'([^']+)'`).exec(WEB_SHARED)
    assert.ok(web, `web KIND_LABEL missing ${kind}`)
    assert.equal(INBOX_KIND_LABEL[kind], web![1], `label drift for ${kind}`)
    assert.equal(inboxKindLabel(kind), web![1])
  }
})

test('[S6] the Inbox segment loads GET /inbox for attention rows', () => {
  assert.ok(SEGMENT.includes('Api.inbox('), 'InboxSegmentPane must call Api.inbox')
  assert.ok(SEGMENT.includes('AttentionQueue'), 'attention rows must render through AttentionQueue')
  assert.ok(INBOX_SCREEN.includes('InboxSegmentPane'), 'InboxScreen must host InboxSegmentPane')
  assert.ok(!INBOX_SCREEN.includes('<ApprovalsPane'), 'InboxScreen must not mount ApprovalsPane directly')
})

test('[S6] dismiss and retry use the same endpoints as the desk', () => {
  assert.ok(SEGMENT.includes('Api.dismissInboxItem('), 'dismiss must hit /inbox/dismiss')
  assert.ok(SEGMENT.includes('Api.retryTask('), 'retry must hit POST /tasks/:id/execute')
  assert.ok(QUEUE.includes('onDismiss'), 'AttentionQueue must expose dismiss')
  assert.ok(QUEUE.includes('onRetry'), 'AttentionQueue must expose retry')
})

test('[S6] MOB-4 step-up handlers in ApprovalsPane are untouched', () => {
  assert.ok(APPROVALS.includes('function onApprove(a: Approval)'), 'onApprove must remain')
  assert.ok(APPROVALS.includes('setStepUp(a)'), 'step-up modal routing must remain')
  assert.ok(APPROVALS.includes('<StepUpModal'), 'StepUpModal wiring must remain')
  assert.ok(APPROVALS.includes('Api.decideApproval'), 'decide path must remain')
})

test('[S6] attention queue sits above approvals via layout hook only', () => {
  assert.ok(APPROVALS.includes('header?: React.ReactNode'), 'ApprovalsPane must accept header prop')
  assert.ok(/{\s*header\s*}/.test(APPROVALS), 'header must render inside the scroll content')
  assert.ok(APPROVALS.includes('onRefreshExtra'), 'pull-to-refresh must reload attention rows too')
})

test('[S6] Api.inbox is typed and hits the unified inbox route', () => {
  assert.ok(API.includes('`/api/orgs/${orgId}/inbox`'), 'Api.inbox must call GET /inbox')
  assert.ok(API.includes('items: InboxItem[]'), 'Api.inbox must type attention rows')
})
