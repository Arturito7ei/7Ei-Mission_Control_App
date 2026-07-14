import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── Audit ONB2 — the LOW findings this audit fixed, locked ─────────────────
//
// Everything of consequence in ONB2 is already covered by onboarding-doc.test.ts
// (the generator, the flat 404, the closed states) and log-redaction.test.ts (H2,
// end to end). These two tests hold the two small things the audit changed, so a
// later edit cannot quietly reintroduce them. The audit's HIGH findings — the
// no-op audit hook, the unauthenticated audit-log query route, and sanitizeBody's
// non-recursion — are NOT fixed here: they are wiring/operator calls, and they are
// written up in docs/AUDIT-ONB2.md.

import { buildAuditRow } from '../middleware/audit-log'
import { baseUrlCandidates } from '../routes/agent-invites'

test('[ONB2-audit LOW-1] a collection POST /api/orgs classifies as org.create', () => {
  // The old guard (`includes('/api/orgs') && !includes('/')`) was unsatisfiable, so
  // an org create was never labelled — it fell through to the generic `post.orgs`.
  assert.equal(buildAuditRow({ method: 'POST', url: '/api/orgs', statusCode: 201, durationMs: 1 }).action, 'org.create')

  // A nested org path is still NOT a create — this must not over-match.
  assert.notEqual(buildAuditRow({ method: 'POST', url: '/api/orgs/o1/agents', statusCode: 201, durationMs: 1 }).action, 'org.create')
  assert.equal(buildAuditRow({ method: 'DELETE', url: '/api/orgs/o1', statusCode: 200, durationMs: 1 }).action, 'org.delete')
})

test('[ONB2-audit LOW-2] MC_BASE_URL_CANDIDATES only ever prints http(s) origins into the doc', () => {
  const prev = process.env.MC_BASE_URL_CANDIDATES
  const prevPublic = process.env.PUBLIC_URL
  process.env.PUBLIC_URL = 'https://7ei-backend.fly.dev'
  process.env.MC_BASE_URL_CANDIDATES =
    'http://localhost:3001/, https://mc.example.internal, file:///etc/passwd, javascript:alert(1), not a url'

  const candidates = baseUrlCandidates()

  assert.deepEqual(candidates, [
    'https://7ei-backend.fly.dev',
    'http://localhost:3001',
    'https://mc.example.internal',
  ], 'only http(s) candidates may be printed — the document tells an agent to REQUEST each one')

  // The server never fetches these (print-only, so no SSRF); the point is that a
  // non-http scheme must never become an instruction to a runtime that honours it.
  for (const c of candidates) assert.match(c, /^https?:\/\//)

  if (prev === undefined) delete process.env.MC_BASE_URL_CANDIDATES
  else process.env.MC_BASE_URL_CANDIDATES = prev
  if (prevPublic === undefined) delete process.env.PUBLIC_URL
  else process.env.PUBLIC_URL = prevPublic
})
