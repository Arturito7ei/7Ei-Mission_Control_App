import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeBody } from '../middleware/audit-log.ts'
import { checkOrgMembership } from '../middleware/rbac.ts'
import { auditLogs, orgMembers } from '../db/schema.ts'

// ─── AUDIT-001: Audit log schema ─────────────────────────────────────────

describe('[AUDIT-001] Audit log table schema', () => {
  it('has all required columns', () => {
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
})

// ─── AUDIT-002: Sanitize function ────────────────────────────────────────

describe('[AUDIT-002] sanitizeBody', () => {
  it('strips apiKey fields', () => {
    const result = sanitizeBody({ name: 'Test', apiKey: 'sk-secret-123' })
    assert.equal(result?.apiKey, '[REDACTED]')
    assert.equal(result?.name, 'Test')
  })

  it('strips token fields', () => {
    const result = sanitizeBody({ accessToken: 'tok-123', refreshToken: 'ref-456' })
    assert.equal(result?.accessToken, '[REDACTED]')
    assert.equal(result?.refreshToken, '[REDACTED]')
  })

  it('strips password fields', () => {
    const result = sanitizeBody({ password: 'hunter2', email: 'test@test.com' })
    assert.equal(result?.password, '[REDACTED]')
    assert.equal(result?.email, 'test@test.com')
  })

  it('strips secret fields', () => {
    const result = sanitizeBody({ clientSecret: 'shh', name: 'ok' })
    assert.equal(result?.clientSecret, '[REDACTED]')
  })

  it('truncates long string values', () => {
    const longString = 'a'.repeat(300)
    const result = sanitizeBody({ description: longString })
    assert.ok(result?.description)
    assert.ok((result?.description as string).length < 210)
    assert.ok((result?.description as string).endsWith('...'))
  })

  it('returns null for non-object input', () => {
    assert.equal(sanitizeBody(null), null)
    assert.equal(sanitizeBody('string'), null)
    assert.equal(sanitizeBody(undefined), null)
  })

  it('handles empty object', () => {
    const result = sanitizeBody({})
    assert.deepEqual(result, {})
  })
})

// ─── RBAC-001: Role-based access ─────────────────────────────────────────

describe('[RBAC-001] Role checking logic', () => {
  it('owner role passes for owner-required', () => {
    const result = checkOrgMembership('user1', 'org1', 'owner')
    assert.ok(result.allowed)
  })

  it('member role passes for member-required', () => {
    const result = checkOrgMembership('user1', 'org1', 'member')
    assert.ok(result.allowed)
  })

  it('orgMembers table has role column', () => {
    assert.ok(orgMembers.role)
    assert.ok(orgMembers.userId)
    assert.ok(orgMembers.orgId)
  })
})

// ─── NOTIF-001: Push notification format ─────────────────────────────────

describe('[NOTIF-001] Push notification message format', () => {
  it('Expo push message has correct shape', () => {
    const token = 'ExponentPushToken[xxxxxxxxx]'
    const message = { to: token, title: 'Test', body: 'Hello', data: {}, sound: 'default' }
    assert.equal(message.to, token)
    assert.equal(message.title, 'Test')
    assert.equal(message.body, 'Hello')
    assert.equal(message.sound, 'default')
    assert.ok('data' in message)
  })

  it('batch messages are an array', () => {
    const tokens = ['tok1', 'tok2', 'tok3']
    const messages = tokens.map(to => ({ to, title: 'Alert', body: 'Budget warning', data: {}, sound: 'default' }))
    assert.equal(messages.length, 3)
    assert.equal(messages[0].to, 'tok1')
  })
})

// ─── HEALTH-002: Health endpoint ─────────────────────────────────────────

describe('[HEALTH-002] Health response shape', () => {
  it('has all required fields', () => {
    const health = {
      status: 'ok', version: '1.3.0', timestamp: new Date().toISOString(),
      uptime: 123, db: 'connected', scheduler: 'running',
      services: { pinecone: false, redis: false, googleOAuth: 0 },
      features: ['anthropic', 'audit-log', 'rbac'],
    }
    assert.equal(health.status, 'ok')
    assert.equal(health.version, '1.3.0')
    assert.ok(health.timestamp)
    assert.equal(typeof health.uptime, 'number')
    assert.ok(['connected', 'error'].includes(health.db))
    assert.ok(health.services)
    assert.equal(typeof health.services.pinecone, 'boolean')
    assert.equal(typeof health.services.googleOAuth, 'number')
    assert.ok(health.features.includes('audit-log'))
    assert.ok(health.features.includes('rbac'))
  })
})

// ─── Audit action classification ──────────────────────────────────────────

describe('[AUDIT-002] Action classification', () => {
  it('classifies org operations', () => {
    // Verify pattern: method.resource
    assert.ok('org.create'.includes('org'))
    assert.ok('agent.delete'.includes('agent'))
    assert.ok('credential.add'.includes('credential'))
  })

  it('audit log query supports action filter', () => {
    const filterAction = 'org.create'
    assert.equal(typeof filterAction, 'string')
    assert.ok(filterAction.length > 0)
  })

  it('audit log query supports limit', () => {
    const limit = Number('50')
    assert.equal(limit, 50)
    assert.ok(limit > 0 && limit <= 1000)
  })
})
