import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseReasoningEffort, cheapUsable, tierBadge, effortBadge,
  routingSummary, effectivePrimary,
} from './modelProfile.ts'

test('[P2/web] parseReasoningEffort: known → value, unknown/empty → "" (default)', () => {
  assert.equal(parseReasoningEffort('high'), 'high')
  assert.equal(parseReasoningEffort('  LOW '), 'low')
  assert.equal(parseReasoningEffort('ultra'), '')
  assert.equal(parseReasoningEffort(null), '')
})

test('[P2/web] cheapUsable: needs both enabled AND a model', () => {
  assert.equal(cheapUsable({ cheapModel: 'x', cheapModelEnabled: true }), true)
  assert.equal(cheapUsable({ cheapModel: '', cheapModelEnabled: true }), false)
  assert.equal(cheapUsable({ cheapModel: 'x', cheapModelEnabled: false }), false)
  assert.equal(cheapUsable({ cheapModel: '   ', cheapModelEnabled: true }), false)
})

test('[P2/web] tierBadge: icon + word carry meaning (colorblind-safe), tone is redundant', () => {
  const cheap = tierBadge('cheap')
  assert.equal(cheap.label, 'Cheap')
  assert.ok(cheap.icon.length > 0)
  const primary = tierBadge('primary')
  assert.equal(primary.label, 'Primary')
  // words differ so meaning survives without color
  assert.notEqual(cheap.label, primary.label)
})

test('[P2/web] effortBadge: each level has a distinct word', () => {
  const labels = new Set([
    effortBadge('').label, effortBadge('low').label, effortBadge('medium').label, effortBadge('high').label,
  ])
  assert.equal(labels.size, 4)
  assert.equal(effortBadge('high').tone, 'warn')
})

test('[P2/web] routingSummary: reflects whether cheap tier is usable', () => {
  assert.match(routingSummary({ cheapModel: 'x', cheapModelEnabled: true }), /cheap model/)
  assert.match(routingSummary({ cheapModel: '', cheapModelEnabled: false }), /Single model/)
})

test('[P2/web] effectivePrimary: override, else fallback, else dash', () => {
  assert.equal(effectivePrimary({ primaryModel: 'claude-opus-4-6' }, 'claude-sonnet-4-20250514'), 'claude-opus-4-6')
  assert.equal(effectivePrimary({ primaryModel: '' }, 'claude-sonnet-4-20250514'), 'claude-sonnet-4-20250514')
  assert.equal(effectivePrimary({ primaryModel: '' }, null), '—')
})
