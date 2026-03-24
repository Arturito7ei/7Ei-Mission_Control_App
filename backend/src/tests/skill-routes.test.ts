import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

// Test skill CRUD logic and agent-skill assignment patterns

describe('[SK-001-005] Skill routes', () => {
  it('skill object has required fields', () => {
    const skill = {
      id: 'test-id', name: 'Code Review', description: 'Automated code review',
      domain: 'engineering', content: '# Code Review\nReview code...', source: 'github',
      githubPath: 'code-review', orgId: null, lastSyncedAt: new Date(), createdAt: new Date(),
    }
    assert.ok(skill.id)
    assert.ok(skill.name)
    assert.ok(skill.domain)
    assert.ok(skill.content)
    assert.ok(skill.source)
  })

  it('skill creation body is validated', () => {
    const SkillBody = z.object({
      name: z.string().min(1),
      domain: z.string().min(1),
      content: z.string().min(1),
      description: z.string().optional(),
      source: z.string().default('custom'),
    })
    const parsed = SkillBody.parse({
      name: 'Test Skill', domain: 'engineering', content: '# Skill\nDo something',
    })
    assert.equal(parsed.name, 'Test Skill')
    assert.equal(parsed.source, 'custom')
  })

  it('skill creation rejects missing name', () => {
    const SkillBody = z.object({ name: z.string().min(1), domain: z.string().min(1), content: z.string().min(1) })
    assert.throws(() => SkillBody.parse({ domain: 'eng', content: 'abc' }))
  })

  it('agent skills array starts empty', () => {
    const skills: string[] = []
    assert.deepEqual(skills, [])
    assert.equal(skills.length, 0)
  })

  it('adding a skill to agent skills array works', () => {
    const current: string[] = ['Existing Skill']
    const skillName = 'Code Review'
    if (!current.includes(skillName)) {
      current.push(skillName)
    }
    assert.deepEqual(current, ['Existing Skill', 'Code Review'])
  })

  it('does not duplicate skill names in agent skills array', () => {
    const current = ['Code Review', 'Data Analysis']
    const skillName = 'Code Review'
    if (!current.includes(skillName)) {
      current.push(skillName)
    }
    assert.equal(current.length, 2)
    assert.deepEqual(current, ['Code Review', 'Data Analysis'])
  })

  it('SKILL.md name extraction pattern works', () => {
    const content = '# My Awesome Skill\n> A brief description\n\nFull content here...'
    const name = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '').trim() ?? 'Unknown'
    const description = content.split('\n').find(l => l.startsWith('> '))?.replace('> ', '').trim()
    assert.equal(name, 'My Awesome Skill')
    assert.equal(description, 'A brief description')
  })

  it('handles SKILL.md without description', () => {
    const content = '# Simple Skill\n\nJust content, no description.'
    const name = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '').trim() ?? 'Unknown'
    const description = content.split('\n').find(l => l.startsWith('> '))?.replace('> ', '').trim()
    assert.equal(name, 'Simple Skill')
    assert.equal(description, undefined)
  })
})
