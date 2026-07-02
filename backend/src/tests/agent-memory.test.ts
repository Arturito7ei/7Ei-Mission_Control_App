import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slugifyAgentName, agentMemoryDir, agentRecentPath, agentLongTermPath, agentKvPath, orgLongTermPath,
  formatSessionSummary, appendSection, formatKvExport, sharedMemoryBlock,
  sharedMemoryCacheKey, getCachedSharedMemory, setCachedSharedMemory, clearSharedMemoryCache,
} from '../services/agent-memory.ts'
import { isSafeVaultPath, isMarkdownPath } from '../services/vault-connector.ts'

// ─ slugifyAgentName ──────────────────────────────────────────────────────────

test('[MCA-75] slugify: spaces + caps', () => {
  assert.equal(slugifyAgentName('Arturito R2D2'), 'arturito-r2d2')
})

test('[MCA-75] slugify: dots collapse to single dashes', () => {
  assert.equal(slugifyAgentName('J.A.R.V.I.S.'), 'j-a-r-v-i-s')
})

test('[MCA-75] slugify: strips non-alphanumerics incl. unicode-ish chars', () => {
  assert.equal(slugifyAgentName('Café Ünit №7'), 'caf-nit-7')
})

test('[MCA-75] slugify: trims leading/trailing separators + handles empty', () => {
  assert.equal(slugifyAgentName('  Maya!  '), 'maya')
  assert.equal(slugifyAgentName(''), '')
})

// ─ path helpers ──────────────────────────────────────────────────────────────

test('[MCA-75] agentMemoryDir is root-relative', () => {
  assert.equal(agentMemoryDir('Arturito R2D2'), 'Memory/agents/arturito-r2d2')
})

test('[MCA-75] path helpers prefix the vault root and stay safe + markdown', () => {
  assert.equal(agentRecentPath('Arturito R2D2', 'vault'), 'vault/Memory/agents/arturito-r2d2/recent.md')
  assert.equal(agentLongTermPath('Maya', 'vault'), 'vault/Memory/agents/maya/long-term.md')
  assert.equal(agentKvPath('Maya', 'vault'), 'vault/Memory/agents/maya/kv.md')
  assert.equal(orgLongTermPath('vault'), 'vault/Memory/long-term.md')
  // Must pass the same guards PUT /api/agent/memory/file applies.
  assert.equal(isSafeVaultPath(agentRecentPath('Maya', 'vault'), 'vault'), true)
  assert.equal(isMarkdownPath(agentRecentPath('Maya', 'vault')), true)
})

// ─ formatSessionSummary ──────────────────────────────────────────────────────

test('[MCA-75] formatSessionSummary with all optionals', () => {
  const block = formatSessionSummary({
    date: '2026-07-02', focus: 'Ship MCA-75', completed: 'Service + route',
    blockers: 'None', next: 'Nightly export', agentName: 'Arturito R2D2',
  })
  assert.equal(block, [
    '## Session: 2026-07-02 — Arturito R2D2',
    '- **Focus:** Ship MCA-75',
    '- **Completed:** Service + route',
    '- **Blockers:** None',
    '- **Next:** Nightly export',
  ].join('\n'))
})

test('[MCA-75] formatSessionSummary omits empty optional lines', () => {
  const block = formatSessionSummary({ date: '2026-07-02', focus: 'Ship it', agentName: 'Maya' })
  assert.equal(block, '## Session: 2026-07-02 — Maya\n- **Focus:** Ship it')
  assert.equal(block.includes('Completed'), false)
  assert.equal(block.includes('Blockers'), false)
  assert.equal(block.includes('Next'), false)
})

// ─ appendSection ─────────────────────────────────────────────────────────────

test('[MCA-75] appendSection: missing/empty file returns block as-is', () => {
  assert.equal(appendSection(undefined, '## Session: x'), '## Session: x')
  assert.equal(appendSection('', '## Session: x'), '## Session: x')
})

test('[MCA-75] appendSection: exactly one blank line separator', () => {
  assert.equal(appendSection('# Recent\nold', '## new'), '# Recent\nold\n\n## new')
})

test('[MCA-75] appendSection: no double blank lines on trailing whitespace', () => {
  assert.equal(appendSection('# Recent\nold\n\n\n', '## new'), '# Recent\nold\n\n## new')
})

// ─ formatKvExport ────────────────────────────────────────────────────────────

test('[MCA-75] formatKvExport is deterministic (sorted keys, fixed timestamp)', () => {
  const at = new Date('2026-07-02T03:00:00.000Z')
  const kvs = [
    { key: 'b_key', value: 'two', updatedAt: new Date('2026-07-01T00:00:00.000Z') },
    { key: 'a_key', value: 'one', updatedAt: null },
  ]
  const a = formatKvExport('Maya', kvs, at)
  const b = formatKvExport('Maya', [...kvs].reverse(), at)
  assert.equal(a, b)  // input order must not matter
  assert.equal(a, [
    '# Memory KV export — Maya',
    '',
    '- **a_key:** one',
    '- **b_key:** two _(updated 2026-07-01)_',
    '',
    '_Generated: 2026-07-02T03:00:00.000Z_',
  ].join('\n'))
})

// ─ sharedMemoryBlock ─────────────────────────────────────────────────────────

test('[MCA-75] sharedMemoryBlock: empty when both parts are empty', () => {
  assert.equal(sharedMemoryBlock(null, null), '')
  assert.equal(sharedMemoryBlock('', '   '), '')
})

test('[MCA-75] sharedMemoryBlock: includes only non-empty parts', () => {
  const block = sharedMemoryBlock(null, 'agent notes')
  assert.equal(block, '=== AGENT LONG-TERM MEMORY ===\nagent notes\n=== END SHARED MEMORY ===')
  assert.equal(block.includes('org long-term'), false)
})

test('[MCA-75] sharedMemoryBlock: both parts in order with end marker', () => {
  const block = sharedMemoryBlock('org notes', 'agent notes')
  assert.equal(block, [
    '=== SHARED MEMORY (org long-term) ===', 'org notes',
    '=== AGENT LONG-TERM MEMORY ===', 'agent notes',
    '=== END SHARED MEMORY ===',
  ].join('\n'))
})

test('[MCA-75] sharedMemoryBlock: truncates each part to maxChars with marker', () => {
  const block = sharedMemoryBlock('x'.repeat(50), 'short', 10)
  assert.equal(block.includes('x'.repeat(10) + '\n[truncated]'), true)
  assert.equal(block.includes('x'.repeat(11)), false)
  assert.equal(block.includes('short'), true)  // under the cap → untouched
})

// ─ shared-memory TTL cache ───────────────────────────────────────────────────

test('[MCA-75] cache: fresh entries hit, key includes repo + agent', () => {
  clearSharedMemoryCache()
  const key = sharedMemoryCacheKey({ repo: 'org/vault', root: 'vault', branch: 'main' }, 'Maya')
  assert.equal(key, 'org/vault:Maya')
  assert.equal(getCachedSharedMemory(key), null)
  setCachedSharedMemory(key, 'block-1')
  assert.equal(getCachedSharedMemory(key), 'block-1')
})

test('[MCA-75] cache: entries expire after the 5-minute TTL', () => {
  clearSharedMemoryCache()
  const now = Date.now()
  setCachedSharedMemory('k', 'stale', now - 6 * 60_000)
  assert.equal(getCachedSharedMemory('k', now), null)
  setCachedSharedMemory('k', 'fresh', now - 4 * 60_000)
  assert.equal(getCachedSharedMemory('k', now), 'fresh')
})

test('[MCA-75] cache: clearSharedMemoryCache empties everything', () => {
  setCachedSharedMemory('k1', 'v1')
  setCachedSharedMemory('k2', 'v2')
  clearSharedMemoryCache()
  assert.equal(getCachedSharedMemory('k1'), null)
  assert.equal(getCachedSharedMemory('k2'), null)
})
