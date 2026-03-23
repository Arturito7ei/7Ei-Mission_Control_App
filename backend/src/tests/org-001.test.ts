import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

// Replicate the OrgSchema from routes/all.ts for isolated testing
const OrgSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
  mission: z.string().optional(),
  culture: z.string().optional(),
  deployMode: z.enum(['cloud', 'local']).optional(),
  cloudProvider: z.enum(['aws', 'aws_ch', 'gcp', 'gcp_ch', 'azure', 'oracle']).optional(),
  preferredLlm: z.enum(['claude', 'gpt4o', 'gemini']).optional(),
})

describe('[ORG-001] OrgSchema persists onboarding fields', () => {
  it('parses full payload with mission and culture', () => {
    const input = {
      name: 'TestOrg',
      mission: 'Build the future',
      culture: 'Move fast, stay ethical',
      deployMode: 'cloud' as const,
      cloudProvider: 'aws' as const,
      preferredLlm: 'claude' as const,
    }
    const parsed = OrgSchema.parse(input)
    assert.equal(parsed.name, 'TestOrg')
    assert.equal(parsed.mission, 'Build the future')
    assert.equal(parsed.culture, 'Move fast, stay ethical')
    assert.equal(parsed.deployMode, 'cloud')
    assert.equal(parsed.cloudProvider, 'aws')
    assert.equal(parsed.preferredLlm, 'claude')
  })

  it('works without optional onboarding fields', () => {
    const input = { name: 'MinimalOrg' }
    const parsed = OrgSchema.parse(input)
    assert.equal(parsed.name, 'MinimalOrg')
    assert.equal(parsed.mission, undefined)
    assert.equal(parsed.culture, undefined)
    assert.equal(parsed.deployMode, undefined)
  })

  it('rejects invalid deployMode', () => {
    assert.throws(() => {
      OrgSchema.parse({ name: 'Bad', deployMode: 'hybrid' })
    })
  })

  it('rejects invalid cloudProvider', () => {
    assert.throws(() => {
      OrgSchema.parse({ name: 'Bad', cloudProvider: 'digitalocean' })
    })
  })

  it('rejects invalid preferredLlm', () => {
    assert.throws(() => {
      OrgSchema.parse({ name: 'Bad', preferredLlm: 'llama' })
    })
  })
})
