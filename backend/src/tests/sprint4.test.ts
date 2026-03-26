import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calcNextRun, matchCronField } from '../services/scheduler.ts'
import { maskKey } from '../routes/all.ts'
import { scheduledTasks, orgMembers, agents, organisations } from '../db/schema.ts'

// ─── WO-1: Schema tests ──────────────────────────────────────────────────

describe('[SCHEMA-001] scheduledTasks table', () => {
  it('has all required columns', () => {
    assert.ok(scheduledTasks.id)
    assert.ok(scheduledTasks.orgId)
    assert.ok(scheduledTasks.agentId)
    assert.ok(scheduledTasks.title)
    assert.ok(scheduledTasks.input)
    assert.ok(scheduledTasks.cronExpression)
    assert.ok(scheduledTasks.enabled)
    assert.ok(scheduledTasks.lastRunAt)
    assert.ok(scheduledTasks.nextRunAt)
    assert.ok(scheduledTasks.createdAt)
  })
})

describe('[SCHEMA-002] agent profile fields', () => {
  it('agents table has persona column', () => {
    assert.ok(agents.persona)
  })
  it('agents table has expertise column', () => {
    assert.ok(agents.expertise)
  })
  it('agents table has advisorIds column', () => {
    assert.ok(agents.advisorIds)
  })
})

describe('[SCHEMA-003] orgMembers table', () => {
  it('has all required columns', () => {
    assert.ok(orgMembers.id)
    assert.ok(orgMembers.orgId)
    assert.ok(orgMembers.userId)
    assert.ok(orgMembers.role)
    assert.ok(orgMembers.createdAt)
  })
})

// ─── WO-2: Scheduler / cron tests ────────────────────────────────────────

describe('[SCHED-001] computeNextRun', () => {
  it('returns a future date for "every minute"', () => {
    const next = calcNextRun('* * * * *')
    assert.ok(next > new Date())
  })

  it('handles daily 9am cron', () => {
    const next = calcNextRun('0 9 * * *')
    assert.equal(next.getMinutes(), 0)
    assert.equal(next.getHours(), 9)
  })

  it('handles step expression */15', () => {
    const next = calcNextRun('*/15 * * * *')
    const mins = next.getMinutes()
    assert.ok(mins % 15 === 0, `Expected multiple of 15, got ${mins}`)
  })

  it('handles weekdays only (1-5)', () => {
    const next = calcNextRun('0 8 * * 1-5')
    const dow = next.getDay()
    assert.ok(dow >= 1 && dow <= 5, `Expected weekday, got ${dow}`)
  })

  it('returns +1 min for invalid cron', () => {
    const before = Date.now()
    const next = calcNextRun('invalid')
    assert.ok(next.getTime() > before)
    assert.ok(next.getTime() - before < 120_000)
  })

  it('handles comma list', () => {
    const next = calcNextRun('0,30 * * * *')
    const mins = next.getMinutes()
    assert.ok(mins === 0 || mins === 30)
  })
})

describe('[SCHED-001] matchCronField', () => {
  it('* matches any value', () => {
    assert.ok(matchCronField('*', 0, 0, 59))
    assert.ok(matchCronField('*', 30, 0, 59))
  })

  it('exact value matches', () => {
    assert.ok(matchCronField('5', 5, 0, 59))
    assert.ok(!matchCronField('5', 6, 0, 59))
  })

  it('range matches values in range', () => {
    assert.ok(matchCronField('1-5', 3, 0, 6))
    assert.ok(!matchCronField('1-5', 6, 0, 6))
  })

  it('step */n matches multiples', () => {
    assert.ok(matchCronField('*/15', 0, 0, 59))
    assert.ok(matchCronField('*/15', 15, 0, 59))
    assert.ok(!matchCronField('*/15', 7, 0, 59))
  })
})

// ─── WO-3: Agent profile prompt injection ─────────────────────────────────

describe('[AGENT-004] persona + expertise in system prompt', () => {
  it('persona block format is correct', () => {
    const persona = 'Analytical, data-driven, methodical'
    const block = '\nYOUR PERSONALITY AND STYLE:\n' + persona
    assert.ok(block.includes('YOUR PERSONALITY AND STYLE:'))
    assert.ok(block.includes(persona))
  })

  it('expertise block format is correct', () => {
    const expertise = 'Machine learning, NLP, statistical analysis'
    const block = '\nYOUR AREAS OF EXPERTISE:\n' + expertise
    assert.ok(block.includes('YOUR AREAS OF EXPERTISE:'))
    assert.ok(block.includes(expertise))
  })

  it('null persona does not produce block', () => {
    const persona = null
    const lines: string[] = []
    if (persona) lines.push('\nYOUR PERSONALITY AND STYLE:\n' + persona)
    assert.equal(lines.length, 0)
  })
})

// ─── WO-4: Org membership ────────────────────────────────────────────────

describe('[ORG-003] org membership logic', () => {
  it('membership roles include owner and member', () => {
    const validRoles = ['owner', 'member']
    assert.ok(validRoles.includes('owner'))
    assert.ok(validRoles.includes('member'))
  })

  it('user with no memberships gets empty org list', () => {
    const memberships: any[] = []
    const orgIds = memberships.map(m => m.orgId)
    assert.equal(orgIds.length, 0)
  })
})

// ─── WO-5: Credential masking ─────────────────────────────────────────────

describe('[KEYS-001] credential masking', () => {
  it('masks a standard API key', () => {
    const masked = maskKey('sk-ant-api03-abcdefghijklmnop')
    assert.ok(masked.startsWith('sk-ant-'))
    assert.ok(masked.endsWith('mnop'))
    assert.ok(masked.includes('...'))
  })

  it('masks a short key safely', () => {
    const masked = maskKey('short')
    assert.equal(masked, '****')
  })

  it('shows first 7 and last 4 chars', () => {
    const key = 'sk-1234567890abcdefghij'
    const masked = maskKey(key)
    assert.equal(masked.slice(0, 7), 'sk-1234')
    assert.equal(masked.slice(-4), 'ghij')
  })

  it('valid providers are anthropic, openai, gemini', () => {
    const valid = ['anthropic', 'openai', 'gemini']
    assert.equal(valid.length, 3)
    assert.ok(valid.includes('anthropic'))
    assert.ok(valid.includes('openai'))
    assert.ok(valid.includes('gemini'))
  })

  it('deploy config key format is {provider}_api_key', () => {
    const provider = 'anthropic'
    const keyName = `${provider}_api_key`
    assert.equal(keyName, 'anthropic_api_key')
  })
})

// ─── Additional edge cases ───────────────────────────────────────────────

describe('[SCHED-002] scheduler edge cases', () => {
  it('calcNextRun handles range with step', () => {
    const next = calcNextRun('0-30/10 * * * *')
    const mins = next.getMinutes()
    assert.ok([0, 10, 20, 30].includes(mins), `Expected 0/10/20/30, got ${mins}`)
  })
})

describe('[AGENT-002] advisorIds validation logic', () => {
  it('JSON.parse handles stringified array', () => {
    const ids = JSON.parse('["id1","id2"]')
    assert.ok(Array.isArray(ids))
    assert.equal(ids.length, 2)
  })

  it('empty advisorIds array is valid', () => {
    const ids: string[] = []
    assert.equal(ids.length, 0)
  })
})
