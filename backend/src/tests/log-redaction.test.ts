import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

// ─── ONB2 / audit finding H2 — an invite token must never reach a log ────────
//
// ONB2 ships the first TOKEN-ADDRESSED route (`/api/agent-invites/<mci_inv_…>/onboarding.txt`).
// The invite token in that path is a bearer credential, and `middleware/audit-log.ts`
// persists `req.url` verbatim into `audit_logs.path`. Without redaction, the first
// doc fetch writes a WORKING invite link, in plaintext, into a queryable table —
// undoing the whole point of storing only `sha256(token)` in `agent_invites`.
//
// These tests lock the boundary: the pure helper, and then the real hook, through
// real Fastify routing, with a real token in the URL.

import { redactPath, redactTokensInText, isTokenSegment } from '../services/log-redaction'
import { buildAuditRow, auditLogPlugin, type AuditRow } from '../middleware/audit-log'
import { agentInviteDocRoutes } from '../routes/agent-invites'
import { generateInviteToken } from '../services/agent-invites'

test('[ONB2-H2] redactPath replaces invite/agent/session token segments with :token', () => {
  const token = generateInviteToken()
  assert.match(token, /^mci_inv_[0-9a-f]{32}$/)

  assert.equal(
    redactPath(`/api/agent-invites/${token}/onboarding.txt`),
    '/api/agent-invites/:token/onboarding.txt',
  )
  assert.equal(redactPath(`/api/agent-invites/${token}/onboarding`), '/api/agent-invites/:token/onboarding')
  assert.equal(redactPath(`/api/agent-invites/${token}`), '/api/agent-invites/:token')

  // The other credentials we mint, and the one ONB4 will mint.
  assert.equal(redactPath('/api/agents/mca_abcdef0123456789/x'), '/api/agents/:token/x')
  assert.equal(redactPath('/api/arturita/art_abcdef0123456789'), '/api/arturita/:token')
  assert.equal(redactPath('/api/agent-join-requests/mcc_abcdef0123456789/claim-api-key'), '/api/agent-join-requests/:token/claim-api-key')

  // The query string is dropped, as before — and a token hiding in it goes with it.
  assert.equal(redactPath(`/api/x?invite=${token}`), '/api/x')

  // Ordinary paths are untouched: this must not mangle real URLs.
  assert.equal(redactPath('/api/orgs/org_123/agent-invites'), '/api/orgs/org_123/agent-invites')
  assert.equal(redactPath('/api/adapters'), '/api/adapters')
  assert.equal(redactPath('/api/health'), '/api/health')
  assert.equal(redactPath(undefined), '')
})

test('[ONB2-H2] isTokenSegment matches whole segments only — a prefix in a longer word is not a token', () => {
  assert.equal(isTokenSegment('mci_inv_' + 'a'.repeat(32)), true)
  assert.equal(isTokenSegment('mci_inv_short'), false)          // too short to be one of ours
  assert.equal(isTokenSegment('agent-invites'), false)
  assert.equal(isTokenSegment('mca_'), false)
  assert.equal(isTokenSegment(''), false)
})

test('[ONB2-H2] redactTokensInText scrubs a token embedded in free text (error messages, echoed URLs)', () => {
  const token = generateInviteToken()
  const msg = `GET https://7ei-backend.fly.dev/api/agent-invites/${token}/onboarding.txt failed`
  const out = redactTokensInText(msg)
  assert.ok(!out.includes(token), 'the raw token must not survive')
  assert.ok(out.includes('mci_inv_[REDACTED]'))
})

test('[ONB2-H2] buildAuditRow never carries a raw token — not in path, not in the derived action', () => {
  const token = generateInviteToken()
  const row = buildAuditRow({
    method: 'GET',
    url: `/api/agent-invites/${token}/onboarding.txt?trace=1`,
    statusCode: 200,
    durationMs: 3,
  })
  assert.equal(row.path, '/api/agent-invites/:token/onboarding.txt')
  const serialized = JSON.stringify(row)
  assert.ok(!serialized.includes(token), 'the raw token appears in the audit row')
  assert.ok(!serialized.includes('mci_inv_'), 'not even the token prefix should survive into the row')
})

test('[ONB2-H2] end to end: a real request to the token-addressed doc route logs :token, never the token', async () => {
  // Pin the posture so the route is closed and the request never reaches the DB —
  // this test is about the LOG BOUNDARY, not about the document.
  const prevProfile = process.env.MC_DEPLOYMENT_PROFILE
  const prevEnable = process.env.MC_ENABLE_REMOTE_ONBOARDING
  process.env.MC_DEPLOYMENT_PROFILE = 'hosted'
  delete process.env.MC_ENABLE_REMOTE_ONBOARDING

  const rows: AuditRow[] = []
  const app = Fastify({ logger: false })
  // The audit hook must be an ANCESTOR of the routes it records — a Fastify hook
  // added inside an encapsulated plugin does not fire for that plugin's siblings.
  // (See docs/AUDIT-ONB1 follow-up: on `src/index.ts` today it *is* a sibling, so
  // the hook never fires in production. That is a separate, pre-existing wiring
  // bug — flagged, not fixed here. This test locks what the hook PERSISTS, which is
  // what must be safe the moment the wiring is corrected.)
  await app.register(async (scope) => {
    await auditLogPlugin(scope, { sink: (row: AuditRow) => { rows.push(row) } })
    await scope.register(agentInviteDocRoutes)
  })
  await app.ready()

  const token = generateInviteToken()
  const res = await app.inject({ method: 'GET', url: `/api/agent-invites/${token}/onboarding.txt` })

  // Hosted profile (the test env's default) with remote onboarding not enabled →
  // the doc route is closed, and a closed doc is the SAME flat 404 as an unknown
  // invite. Either way the request was routed and the hook ran — which is the point.
  assert.equal(res.statusCode, 404)

  assert.equal(rows.length, 1, 'the audit hook must have fired for this request')
  const row = rows[0]
  assert.equal(row.path, '/api/agent-invites/:token/onboarding.txt')
  assert.ok(!JSON.stringify(row).includes(token), 'a raw invite token reached the audit row — H2 has regressed')

  await app.close()
  if (prevProfile === undefined) delete process.env.MC_DEPLOYMENT_PROFILE
  else process.env.MC_DEPLOYMENT_PROFILE = prevProfile
  if (prevEnable !== undefined) process.env.MC_ENABLE_REMOTE_ONBOARDING = prevEnable
})
