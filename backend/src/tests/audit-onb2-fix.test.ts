// Epic ONB — the ONB2-audit HARDENING fixes (docs/AUDIT-ONB2.md H-2, H-3, M-1).
//
// The audit trail is still DEAD by design (H-1: the hooks stay encapsulated, so
// they never fire — enabling them is an operator cost call). These tests lock the
// three things that had to be true BEFORE it can ever be enabled, so that the day
// the operator hoists the hooks, nothing leaks:
//
//   H-2  the audit-log + trace READ routes are no longer public.
//   H-3  sanitizeBody recurses, so a secret nested in `agentDefaultsPayload`
//        (which ONB2's onboarding doc TELLS agents to send) cannot reach a row.
//   M-1  the telemetry span carries a redacted path, not a raw invite token.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { sanitizeBody, buildAuditRow, auditLogQueryRoutes, shouldAudit } from '../middleware/audit-log'
import { telemetryPlugin, getRecentSpans } from '../services/telemetry'
import { createClerkAuth } from '../middleware/clerk-auth'

// ─── H-3 — sanitizeBody recurses ─────────────────────────────────────────────

test('[ONB2-H3] a secret nested inside agentDefaultsPayload is redacted, not copied through', () => {
  // This is the exact body ONB3's join route will receive: the onboarding document
  // instructs the joining agent to put its adapter secrets in `agentDefaultsPayload`,
  // a key that matches no SENSITIVE_KEYS entry. Before this fix the object went in
  // whole, un-walked, and the plaintext key landed in audit_logs.metadata.
  const body = {
    inviteToken: 'mci_inv_aaaaaaaaaaaaaaaaaaaa',
    adapterId: 'openclaw',
    agentDefaultsPayload: {
      baseUrl: 'https://agent.example.com',
      apiKey: 'sk-live-DEADBEEFDEADBEEF',
      headers: { 'x-openclaw-token': 'ocw_supersecret_value' },
    },
  }
  const out = sanitizeBody(body)!
  const serialized = JSON.stringify(out)

  assert.equal((out.agentDefaultsPayload as any).apiKey, '[REDACTED]')
  assert.equal((out.agentDefaultsPayload as any).headers['x-openclaw-token'], '[REDACTED]')
  assert.ok(!serialized.includes('sk-live-DEADBEEFDEADBEEF'), 'plaintext apiKey survived into the row')
  assert.ok(!serialized.includes('ocw_supersecret_value'), 'plaintext adapter token survived into the row')
  // Top-level `inviteToken` matches `token` and was already covered — still is.
  assert.equal(out.inviteToken, '[REDACTED]')
  // Non-secret nested values are preserved: this is a redaction, not a bulldozer.
  assert.equal((out.agentDefaultsPayload as any).baseUrl, 'https://agent.example.com')
})

test('[ONB2-H3] recursion reaches arrays and arbitrary depth, and caps runaway nesting', () => {
  const out = sanitizeBody({
    agents: [
      { name: 'a', config: { secret: 'shh' } },
      { name: 'b', config: { nested: { deeper: { accessToken: 'tok-123' } } } },
    ],
  })!
  const s = JSON.stringify(out)
  assert.ok(!s.includes('shh') && !s.includes('tok-123'), `secret survived: ${s}`)
  assert.equal((out.agents as any)[0].name, 'a')

  // Depth cap: a body nested past MAX_DEPTH is dropped, not walked forever.
  let deep: any = { apiKey: 'sk-too-deep' }
  for (let i = 0; i < 20; i++) deep = { level: deep }
  assert.ok(!JSON.stringify(sanitizeBody(deep)).includes('sk-too-deep'), 'a very deep secret must not survive')
})

test('[ONB2-H3/NIT-1] a token echoed inside a free-text string value is scrubbed', () => {
  // redactTokensInText existed but was never called in production code. It is now
  // applied to every surviving string, at every depth: an error message or an
  // echoed URL carrying an invite token is not a "safe" value just because its key
  // is innocuous.
  const out = sanitizeBody({
    error: 'GET https://api/agent-invites/mci_inv_ZZZZZZZZZZZZZZZZ/onboarding.txt failed',
    nested: { note: 'agent token mca_abcdefgh12345678 was rejected' },
  })!
  const s = JSON.stringify(out)
  assert.ok(!s.includes('mci_inv_ZZZZZZZZZZZZZZZZ'), 'invite token survived in free text')
  assert.ok(!s.includes('mca_abcdefgh12345678'), 'agent token survived in nested free text')
  assert.ok(s.includes('[REDACTED]'))
})

test('[ONB2-H3] the persisted row for an ONB3-shaped join body carries no secret at all', () => {
  const row = buildAuditRow({
    method: 'POST',
    url: '/api/agent-invites/mci_inv_bbbbbbbbbbbbbbbbbbbb/join',
    statusCode: 201,
    durationMs: 12,
    body: { agentDefaultsPayload: { apiKey: 'sk-live-SHOULD-NEVER-PERSIST' } },
  })
  const serialized = JSON.stringify(row)
  assert.ok(!serialized.includes('sk-live-SHOULD-NEVER-PERSIST'), 'plaintext secret reached the audit row')
  assert.ok(!serialized.includes('mci_inv_bbbb'), 'raw invite token reached the audit row')
  assert.equal(row.path, '/api/agent-invites/:token/join')
})

// ─── H-2 — the query routes are behind Clerk ─────────────────────────────────

test('[ONB2-H2] GET /api/orgs/:orgId/audit-log is not reachable without a session', async () => {
  const app = Fastify({ logger: false })
  await app.register(async (secured) => {
    secured.addHook('onRequest', createClerkAuth(async () => { throw new Error('no session') }))
    await secured.register(auditLogQueryRoutes)
  })
  await app.ready()

  const res = await app.inject({ method: 'GET', url: '/api/orgs/other-tenant/audit-log' })
  assert.equal(res.statusCode, 401, 'an unauthenticated caller must not be able to read another org’s audit log')
  await app.close()
})

// ─── M-1 — the telemetry span URL is redacted ────────────────────────────────

test('[ONB2-M1] the telemetry span carries a redacted path, never a raw invite token', async () => {
  const app = Fastify({ logger: false })
  // Registered as an ANCESTOR so the hook actually fires — production is the
  // opposite (H-1), but the assertion here is about what the span CONTAINS, which
  // must already be correct on the day the operator hoists the hook.
  await app.register(async (scope) => {
    await telemetryPlugin(scope)
    scope.get('/api/agent-invites/:token/onboarding.txt', async () => 'doc')
  })
  await app.ready()

  const token = 'mci_inv_cccccccccccccccccccc'
  const res = await app.inject({ method: 'GET', url: `/api/agent-invites/${token}/onboarding.txt?x=1` })
  assert.equal(res.statusCode, 200)
  await app.close()

  const span = getRecentSpans(5).find(s => s.name.includes('/api/agent-invites/'))
  assert.ok(span, 'expected a SERVER span for the doc request')
  const serialized = JSON.stringify(span)
  assert.ok(!serialized.includes(token), 'raw invite token reached the telemetry span (served by GET /api/traces)')
  assert.ok(!serialized.includes('mci_inv_'), 'not even the token prefix should survive')
  assert.equal(span!.attributes['http.url'], '/api/agent-invites/:token/onboarding.txt')
  assert.equal(span!.attributes['http.route'], '/api/agent-invites/:token/onboarding.txt')
  assert.equal(span!.name, 'GET /api/agent-invites/:token/onboarding.txt')
})

// ─── H-1 — the trail is now ENABLED, and the tripwire guards its safety ENVELOPE ─

test('[ONB2-H1] the AUDIT hook is hoisted (enabled) and TELEMETRY stays encapsulated (off)', async () => {
  // This tripwire used to hold the hook SHUT (it failed if the hook was hoisted).
  // The operator has taken the H-1 decision: enable the audit trail for sensitive
  // writes. So it now guards the SHAPE of that enablement, not its absence —
  //   • the audit hook must be HOISTED to the root (a bare `auditLogPlugin(app)`
  //     call, NOT `app.register(auditLogPlugin)` which re-encapsulates it into the
  //     original no-op), so it actually fires for sibling routes; and
  //   • telemetry must stay a plain encapsulated `register()` — enabling it is a
  //     separate concern the operator did NOT turn on here.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  assert.ok(/await auditLogPlugin\(app\)/.test(src),
    'the audit hook must be hoisted onto the root instance (auditLogPlugin(app)) so it fires for siblings')
  assert.ok(!/await app\.register\(auditLogPlugin\)/.test(src),
    're-encapsulating the audit hook via app.register(auditLogPlugin) reverts it to the H-1 no-op')
  assert.ok(/await app\.register\(telemetryPlugin\)/.test(src),
    'telemetry must stay encapsulated (off) — enabling it is a separate operator call')
})

test('[ONB2-H1] SAFETY ENVELOPE: enabling the hook is only safe because every recorded row is redacted', async () => {
  // The envelope, guarded behaviorally so it fails if a future change enables the
  // hook WITHOUT the prerequisites. Every row the (now-live) hook can persist is
  // built by `buildAuditRow`, which unconditionally redacts the path and recursively
  // sanitizes the body. If either prerequisite regresses, this fails — which is the
  // point: the hook must never persist an un-redacted row.
  const row = buildAuditRow({
    method: 'POST',
    url: '/api/agent-invites/mci_inv_dddddddddddddddddddd/join',
    statusCode: 201,
    durationMs: 3,
    body: { adapterId: 'http_webhook', agentDefaultsPayload: { webhookAuthHeader: 'Bearer envelope-canary' } },
  })
  const s = JSON.stringify(row)
  assert.equal(row.path, '/api/agent-invites/:token/join', 'path redaction is a precondition of enabling the hook')
  assert.ok(!s.includes('mci_inv_dddd'), 'a raw invite token in a persisted row means the redaction envelope is broken')
  assert.ok(!s.includes('envelope-canary'), 'a registry-declared secret in a persisted row means sanitize is broken')
})

test('[ONB2-H1] SCOPE: the hook records sensitive writes + onboarding surfaces, and SKIPS the GET flood', () => {
  // The enablement is scoped (operator recommendation): the read-only GET flood must
  // stay OUT of the trail, or "one INSERT per request" is back. This locks that scope.
  assert.equal(shouldAudit('POST', '/api/orgs/o1/agents'), true, 'a write must be audited')
  assert.equal(shouldAudit('DELETE', '/api/orgs/o1/credentials/c1'), true, 'a delete must be audited')
  assert.equal(shouldAudit('GET', '/api/agent-invites/:token/onboarding.txt'), true, 'onboarding doc reads are security-relevant')
  assert.equal(shouldAudit('GET', '/api/agent-join-requests/j1'), true, 'join-queue reads are security-relevant')
  assert.equal(shouldAudit('GET', '/api/orgs/o1/agents'), false, 'the dashboard GET flood must NOT be audited')
  assert.equal(shouldAudit('GET', '/api/health'), false, 'health probes are never audited')
})
