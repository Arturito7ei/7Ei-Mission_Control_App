import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { organisations } from '../db/schema'

describe('[DB-001] organisations onboarding columns', () => {
  it('schema has mission column', () => {
    assert.ok(organisations.mission, 'mission column should exist')
  })

  it('schema has culture column', () => {
    assert.ok(organisations.culture, 'culture column should exist')
  })

  it('schema has deployMode column', () => {
    assert.ok(organisations.deployMode, 'deployMode column should exist')
  })

  it('schema has cloudProvider column', () => {
    assert.ok(organisations.cloudProvider, 'cloudProvider column should exist')
  })

  it('schema has preferredLlm column', () => {
    assert.ok(organisations.preferredLlm, 'preferredLlm column should exist')
  })

  it('schema has deployConfig column', () => {
    assert.ok(organisations.deployConfig, 'deployConfig column should exist')
  })
})
