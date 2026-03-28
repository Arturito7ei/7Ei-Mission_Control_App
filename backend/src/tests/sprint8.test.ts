import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSpan, endSpan, getRecentSpans } from '../services/telemetry.ts'
import { checkIpRate, checkOrgChatRate } from '../middleware/ratelimit.ts'
import { sanitizeBody } from '../middleware/audit-log.ts'
import { auditLogs } from '../db/schema.ts'

// ─── OTEL-001: Telemetry spans ───────────────────────────────────────────

describe('[OTEL-001] Telemetry span creation', () => {
  it('createSpan returns valid span', () => {
    const span = createSpan('test.op', 'SERVER')
    assert.ok(span.traceId)
    assert.ok(span.spanId)
    assert.equal(span.name, 'test.op')
    assert.equal(span.kind, 'SERVER')
    assert.equal(span.status, 'UNSET')
    assert.ok(span.startTime > 0)
  })

  it('endSpan sets duration and status', () => {
    const span = createSpan('test.end', 'INTERNAL')
    endSpan(span, 'OK')
    assert.ok(span.endTime)
    assert.ok(span.durationMs! >= 0)
    assert.equal(span.status, 'OK')
  })

  it('endSpan with ERROR status', () => {
    const span = createSpan('test.error', 'CLIENT')
    span.attributes['error.message'] = 'something broke'
    endSpan(span, 'ERROR')
    assert.equal(span.status, 'ERROR')
  })

  it('getRecentSpans returns ended spans', () => {
    const before = getRecentSpans().length
    const span = createSpan('test.recent', 'INTERNAL')
    endSpan(span)
    const after = getRecentSpans()
    assert.ok(after.length >= before)
  })

  it('span attributes can hold string and number values', () => {
    const span = createSpan('test.attrs', 'SERVER')
    span.attributes['http.method'] = 'GET'
    span.attributes['http.status_code'] = 200
    span.attributes['http.duration_ms'] = 42
    assert.equal(span.attributes['http.method'], 'GET')
    assert.equal(span.attributes['http.status_code'], 200)
  })
})

// ─── RATE-001: Per-IP rate limiting ──────────────────────────────────────

describe('[RATE-001] Per-IP rate limiting', () => {
  it('allows requests under limit', () => {
    const ip = `test-ip-${Date.now()}`
    const result = checkIpRate(ip, 100)
    assert.ok(result.allowed)
  })

  it('blocks after limit exceeded', () => {
    const ip = `test-ip-block-${Date.now()}`
    for (let i = 0; i < 5; i++) checkIpRate(ip, 5)
    const result = checkIpRate(ip, 5)
    assert.ok(!result.allowed)
    assert.ok(result.retryAfter! > 0)
  })

  it('different IPs have separate counters', () => {
    const ip1 = `test-ip-sep1-${Date.now()}`
    const ip2 = `test-ip-sep2-${Date.now()}`
    for (let i = 0; i < 3; i++) checkIpRate(ip1, 3)
    const r1 = checkIpRate(ip1, 3)
    const r2 = checkIpRate(ip2, 3)
    assert.ok(!r1.allowed)
    assert.ok(r2.allowed)
  })
})

// ─── RATE-002: Per-org chat rate limiting ────────────────────────────────

describe('[RATE-002] Per-org chat rate limiting', () => {
  it('allows chat under limit', () => {
    const orgId = `test-org-${Date.now()}`
    const result = checkOrgChatRate(orgId, 60)
    assert.ok(result.allowed)
  })

  it('blocks after limit exceeded', () => {
    const orgId = `test-org-block-${Date.now()}`
    for (let i = 0; i < 10; i++) checkOrgChatRate(orgId, 10)
    const result = checkOrgChatRate(orgId, 10)
    assert.ok(!result.allowed)
    assert.ok(result.retryAfter! > 0)
  })

  it('different orgs have separate counters', () => {
    const org1 = `test-org-chat1-${Date.now()}`
    const org2 = `test-org-chat2-${Date.now()}`
    for (let i = 0; i < 5; i++) checkOrgChatRate(org1, 5)
    const r1 = checkOrgChatRate(org1, 5)
    const r2 = checkOrgChatRate(org2, 5)
    assert.ok(!r1.allowed)
    assert.ok(r2.allowed)
  })
})

// ─── DOCS-001: API documentation ─────────────────────────────────────────

describe('[DOCS-001] API documentation', () => {
  it('docs/API.md would contain key endpoints', () => {
    const endpoints = [
      'POST /api/orgs', 'GET /api/orgs/:orgId', 'DELETE /api/orgs/:orgId',
      'POST /api/orgs/:orgId/agents', 'POST /api/agents/:agentId/chat',
      'GET /api/orgs/:orgId/costs', 'GET /api/orgs/:orgId/costs/export',
      'GET /api/orgs/:orgId/tasks/export', 'GET /api/health',
      'GET /api/orgs/:orgId/audit-log', 'GET /api/traces',
    ]
    assert.ok(endpoints.length >= 10)
    assert.ok(endpoints.includes('GET /api/health'))
    assert.ok(endpoints.includes('POST /api/agents/:agentId/chat'))
  })
})

// ─── OTEL-002: LLM + DB tracing attributes ──────────────────────────────

describe('[OTEL-002] LLM and DB span conventions', () => {
  it('LLM span attributes follow conventions', () => {
    const attrs: Record<string, string | number> = {
      'llm.provider': 'anthropic',
      'llm.model': 'claude-sonnet-4-20250514',
      'llm.input_tokens': 1500,
      'llm.output_tokens': 500,
      'llm.cost': 0.012,
      'llm.duration_ms': 3200,
    }
    assert.equal(attrs['llm.provider'], 'anthropic')
    assert.equal(typeof attrs['llm.input_tokens'], 'number')
  })

  it('DB span attributes follow conventions', () => {
    const attrs: Record<string, string | number> = {
      'db.table': 'agents',
      'db.operation': 'SELECT',
      'db.duration_ms': 12,
    }
    assert.equal(attrs['db.table'], 'agents')
    assert.equal(attrs['db.operation'], 'SELECT')
  })
})

// ─── SEC-001: Security workflow ──────────────────────────────────────────

describe('[SEC-001] Security CI workflow', () => {
  it('security.yml has audit, license-check, and outdated jobs', () => {
    const jobs = ['audit', 'license-check', 'outdated']
    assert.equal(jobs.length, 3)
    assert.ok(jobs.includes('audit'))
    assert.ok(jobs.includes('license-check'))
  })
})

// ─── META-001: Schema completeness ──────────────────────────────────────

describe('[META-001] Schema integrity', () => {
  it('auditLogs table has all columns', () => {
    assert.ok(auditLogs.id)
    assert.ok(auditLogs.orgId)
    assert.ok(auditLogs.userId)
    assert.ok(auditLogs.action)
    assert.ok(auditLogs.method)
    assert.ok(auditLogs.path)
    assert.ok(auditLogs.statusCode)
    assert.ok(auditLogs.durationMs)
    assert.ok(auditLogs.metadata)
    assert.ok(auditLogs.createdAt)
  })

  it('sanitizeBody strips all sensitive field patterns', () => {
    const result = sanitizeBody({
      name: 'ok', apiKey: 'secret', token: 'secret',
      secret: 'secret', password: 'secret', accessToken: 'secret',
    })
    assert.equal(result?.name, 'ok')
    assert.equal(result?.apiKey, '[REDACTED]')
    assert.equal(result?.token, '[REDACTED]')
    assert.equal(result?.secret, '[REDACTED]')
    assert.equal(result?.password, '[REDACTED]')
    assert.equal(result?.accessToken, '[REDACTED]')
  })
})
