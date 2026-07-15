// Epic ONB / audit finding H-1 — the audit trail is ENABLED (operator decision).
//
// docs/AUDIT-ONB2.md H-1 proved the audit hook recorded ZERO rows for any sibling
// route, because it was added inside an encapsulated `app.register()` child. The
// operator has taken the H-1 decision and enabled it for the SENSITIVE half only
// (writes + onboarding/invite/join/approval surfaces), with N-day retention.
//
// These tests prove the enablement is real AND safe:
//   1. HOIST      — the hook now fires for a SIBLING route (the thing H-1 proved it did not).
//   2. REDACTION  — a real sensitive request carrying a NESTED secret + a token in the
//                   path, driven through the now-live hook, persists a row with the path
//                   redacted and NO secret/token anywhere.
//   3. SCOPE      — the read-only GET flood is skipped; sensitive surfaces are kept.
//   4. READS GATED— enabling writes did not open the audit/trace READ routes.
//   5. RETENTION  — the prune window, cutoff math, daily gate, and executor.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { auditLogPlugin, auditLogQueryRoutes, shouldAudit, type AuditRow } from '../middleware/audit-log'
import { telemetryQueryRoutes } from '../services/telemetry'
import { createClerkAuth } from '../middleware/clerk-auth'
import {
  auditRetentionDays, auditRetentionCutoff, auditRetentionDue, pruneAuditLogs,
  DEFAULT_AUDIT_RETENTION_DAYS,
} from '../services/audit-retention'

// ─── 1 + 2 + 3 — the hoisted hook fires for a SIBLING, and every row is redacted ──

/**
 * Boot an app EXACTLY as `src/index.ts` now wires it: the audit hook installed on
 * the ROOT instance (not via register), then the real routes registered inside a
 * child scope — i.e. as SIBLINGS of nothing, descendants of the root the hook lives
 * on. This is the wiring H-1 said records zero; here we prove it records.
 */
async function bootWithHoistedAudit(rows: AuditRow[]) {
  const app = Fastify({ logger: false })
  await auditLogPlugin(app, { sink: (r) => rows.push(r) })   // HOISTED on root, like index.ts
  await app.register(async (child) => {
    child.post('/api/agent-invites/:token/join', async () => ({ ok: true }))
    child.get('/api/agent-invites/:token/onboarding.txt', async () => 'doc')
    child.get('/api/orgs/:orgId/agents', async () => ({ agents: [] }))
  })
  await app.ready()
  return app
}

test('[ONB-H1] the hoisted hook RECORDS for a sibling route — the no-op H-1 found is gone', async () => {
  const rows: AuditRow[] = []
  const app = await bootWithHoistedAudit(rows)

  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-invites/mci_inv_eeeeeeeeeeeeeeeeeeee/join',
    payload: { agentName: 'scout' },
  })
  await app.close()

  assert.equal(res.statusCode, 200)
  assert.equal(rows.length, 1, 'the hoisted hook must fire for a SIBLING route (H-1: it fired for zero)')
  assert.equal(rows[0].method, 'POST')
})

test('[ONB-H1] END-TO-END REDACTION: a nested secret + a path token never reach the persisted row', async () => {
  const rows: AuditRow[] = []
  const app = await bootWithHoistedAudit(rows)

  // The exact body ONB3's join route receives: the onboarding doc tells the agent to
  // put its adapter secrets inside `agentDefaultsPayload` — here a registry-declared
  // secret whose NAME matches none of the shape list (`webhookAuthHeader`), plus an
  // obviously-secret `apiKey`, plus a token echoed in free text.
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent-invites/mci_inv_ffffffffffffffffffff/join?trace=1',
    payload: {
      adapterId: 'http_webhook',
      agentDefaultsPayload: {
        externalEndpoint: 'https://agent.example.com/work',
        apiKey: 'sk-live-MUST-NOT-PERSIST',
        webhookAuthHeader: 'Bearer live-bearer-MUST-NOT-PERSIST',
      },
      note: 'callback https://host/api/agent-invites/mci_inv_ffffffffffffffffffff/join failed',
    },
  })
  await app.close()

  assert.equal(res.statusCode, 200)
  assert.equal(rows.length, 1, 'the sensitive write must be recorded')
  const row = rows[0]
  const serialized = JSON.stringify(row)

  // The whole persisted row — path, action, and metadata — carries no live credential.
  assert.equal(row.path, '/api/agent-invites/:token/join', 'the invite token must be redacted out of the path')
  assert.ok(!serialized.includes('mci_inv_ffff'), 'the raw invite token reached the audit row')
  assert.ok(!serialized.includes('sk-live-MUST-NOT-PERSIST'), 'a plaintext apiKey reached the audit row')
  assert.ok(!serialized.includes('live-bearer-MUST-NOT-PERSIST'),
    'the registry-declared webhookAuthHeader bearer reached the audit row')
  // The nested secrets are present-but-redacted; the innocuous sibling survives.
  const payload = (row.metadata!.agentDefaultsPayload as any)
  assert.equal(payload.apiKey, '[REDACTED]')
  assert.equal(payload.webhookAuthHeader, '[REDACTED]')
  assert.equal(payload.externalEndpoint, 'https://agent.example.com/work')
})

test('[ONB-H1] SCOPE: the GET read-flood is NOT recorded, the onboarding GET is', async () => {
  const rows: AuditRow[] = []
  const app = await bootWithHoistedAudit(rows)

  await app.inject({ method: 'GET', url: '/api/orgs/o1/agents' })                              // flood → skip
  await app.inject({ method: 'GET', url: '/api/agent-invites/mci_inv_gggggggggggggggggggg/onboarding.txt' }) // keep
  await app.close()

  assert.equal(rows.length, 1, 'exactly the onboarding read is kept; the dashboard poll is dropped')
  assert.equal(rows[0].path, '/api/agent-invites/:token/onboarding.txt')
})

test('[ONB-H1] shouldAudit is a pure method/route filter', () => {
  for (const m of ['POST', 'put', 'Patch', 'DELETE']) {
    assert.equal(shouldAudit(m, '/api/orgs/o1/agents'), true, `${m} is a sensitive method`)
  }
  assert.equal(shouldAudit('GET', '/api/orgs/o1/audit-log'), false, 'a plain org read is not audited')
  assert.equal(shouldAudit('GET', '/api/agent-invites/:token/onboarding'), true)
  assert.equal(shouldAudit('GET', '/api/agent-join-requests/j1'), true)
  assert.equal(shouldAudit('GET', '/api/orgs/o1/approvals'), true)
  assert.equal(shouldAudit('GET', '/health'), false)
  assert.equal(shouldAudit('GET', '/ready'), false)
  assert.equal(shouldAudit('GET', '/api/health'), false)
})

// ─── 4 — enabling WRITES did not open the READ routes ─────────────────────────

test('[ONB-H1] enabling the trail did not open the reads: both query routes refuse without a session', async () => {
  for (const routes of [auditLogQueryRoutes, telemetryQueryRoutes]) {
    const app = Fastify({ logger: false })
    await app.register(async (secured) => {
      secured.addHook('onRequest', createClerkAuth(async () => { throw new Error('no session') }))
      await secured.register(routes)
    })
    await app.ready()

    const audit = await app.inject({ method: 'GET', url: '/api/orgs/other-tenant/audit-log' })
    const traces = await app.inject({ method: 'GET', url: '/api/orgs/other-tenant/traces' })
    await app.close()

    // Whichever route this scope registered, the unauthenticated read is refused (401).
    const reached = [audit, traces].filter(r => r.statusCode !== 404)
    assert.ok(reached.length >= 1, 'expected one of the query routes to be registered')
    for (const r of reached) {
      assert.equal(r.statusCode, 401, 'an audit/trace READ must still refuse an unauthenticated caller')
    }
  }
})

// ─── 5 — retention ────────────────────────────────────────────────────────────

test('[ONB-H1] auditRetentionDays defaults to 90 and rejects junk/zero/negative', () => {
  assert.equal(auditRetentionDays({}), DEFAULT_AUDIT_RETENTION_DAYS)
  assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: '30' }), 30)
  assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: '365' }), 365)
  assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: '0' }), 90, 'a 0 typo must not delete everything next tick')
  assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: '-5' }), 90)
  assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: 'abc' }), 90)
  assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: '45.9' }), 45, 'floored')
  // AUDIT (audit-trail enablement) — a FRACTIONAL value below one day must not
  // floor to 0. `0.5`/`.5`/`1e-9` pass a naive `> 0` gate but `Math.floor` to 0,
  // which makes the cutoff `now` and the daily prune WIPE THE WHOLE TABLE. The guard
  // is `>= 1`, so any accepted value is at least one whole day.
  for (const junk of ['0.5', '.5', '0.9', '1e-9', '0.0001']) {
    assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: junk }), 90,
      `a sub-one-day retention (${junk}) must fall back to 90, never collapse to 0 and wipe the table`)
  }
  assert.equal(auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: '1' }), 1, 'exactly one whole day is the accepted minimum')
})

test('[ONB-H1] no accepted retention env can make the cutoff wipe every row', () => {
  // Belt-and-braces on the invariant that matters: for a spread of env values —
  // valid, junk, and the fractional near-zero typos — the resolved cutoff is always
  // strictly in the past, so `DELETE ... WHERE created_at < cutoff` can never match
  // a row created "now". This is the property the retention guard exists to hold.
  const now = new Date('2026-07-15T12:00:00.000Z')
  for (const v of ['90', '1', '0', '-5', 'abc', '0.5', '.5', '1e-9', '0.0001', '45.9', '365']) {
    const days = auditRetentionDays({ MC_AUDIT_RETENTION_DAYS: v })
    const cutoff = auditRetentionCutoff(now, days)
    assert.ok(cutoff < now, `env=${v} -> ${days}d yields cutoff ${cutoff.toISOString()} which is not strictly before now (would risk wiping current rows)`)
  }
})

test('[ONB-H1] auditRetentionCutoff is now minus N days', () => {
  const now = new Date('2026-07-15T12:00:00.000Z')
  const cutoff = auditRetentionCutoff(now, 90)
  assert.equal(cutoff.toISOString(), '2026-04-16T12:00:00.000Z')
  // A row created before the cutoff is prunable; one after is kept.
  assert.ok(new Date('2026-04-15T00:00:00Z') < cutoff)
  assert.ok(new Date('2026-07-14T00:00:00Z') > cutoff)
})

test('[ONB-H1] auditRetentionDue fires once per UTC day at/after the hour', () => {
  const before = new Date('2026-07-15T02:59:00Z')
  const after  = new Date('2026-07-15T03:00:00Z')
  const later  = new Date('2026-07-15T20:00:00Z')
  assert.equal(auditRetentionDue(before, null), false, 'before the hour → not due')
  assert.equal(auditRetentionDue(after, null), true, 'at/after the hour, not yet run today → due')
  assert.equal(auditRetentionDue(after, '2026-07-15'), false, 'already run today → not due')
  assert.equal(auditRetentionDue(later, '2026-07-14'), true, 'a new day → due again')
})

test('[ONB-H1] pruneAuditLogs deletes below the cutoff and returns the count', async () => {
  let whereCalled = false
  const fakeDb = {
    delete: () => ({ where: async (_cond: unknown) => { whereCalled = true; return { rowsAffected: 7 } } }),
  } as any

  const pruned = await pruneAuditLogs({ now: new Date('2026-07-15T03:00:00Z'), retentionDays: 90, database: fakeDb })
  assert.equal(pruned, 7)
  assert.ok(whereCalled, 'the prune must issue a bounded DELETE ... WHERE created_at < cutoff')
})
