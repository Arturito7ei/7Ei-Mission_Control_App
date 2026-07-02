import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSessionBlocks, partitionByAge, rebuildRecent, buildArchiveAppend,
  countLessonEntries, isOrchestratorRole, buildConsolidationReport,
} from '../services/consolidation.ts'

const NOW = new Date('2026-07-08T04:00:00.000Z')

const RECENT = [
  '---',
  'agent: maya',
  '---',
  '# Recent sessions — Maya',
  '',
  'Intro line.',
  '',
  '## Session: 2026-06-20 — Maya',
  '- **Focus:** old work',
  '',
  '## Session: 2026-07-07 — Maya',
  '- **Focus:** fresh work',
].join('\n')

// ─ parseSessionBlocks ────────────────────────────────────────────────────────

test('[MCA-76] parseSessionBlocks: preamble (frontmatter + intro) preserved verbatim', () => {
  const { preamble, blocks } = parseSessionBlocks(RECENT)
  assert.equal(preamble, '---\nagent: maya\n---\n# Recent sessions — Maya\n\nIntro line.\n')
  assert.equal(blocks.length, 2)
})

test('[MCA-76] parseSessionBlocks: multiple blocks with dates and bodies', () => {
  const { blocks } = parseSessionBlocks(RECENT)
  assert.deepEqual(blocks[0], { date: '2026-06-20', heading: '## Session: 2026-06-20 — Maya', body: '- **Focus:** old work' })
  assert.deepEqual(blocks[1], { date: '2026-07-07', heading: '## Session: 2026-07-07 — Maya', body: '- **Focus:** fresh work' })
})

test('[MCA-76] parseSessionBlocks: dateless heading → date null', () => {
  const { blocks } = parseSessionBlocks('## Session: kickoff — Maya\n- **Focus:** x')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].date, null)
})

test('[MCA-76] parseSessionBlocks: empty file and no-blocks file', () => {
  assert.deepEqual(parseSessionBlocks(''), { preamble: '', blocks: [] })
  assert.deepEqual(parseSessionBlocks('# Title\nno sessions here'), { preamble: '# Title\nno sessions here', blocks: [] })
})

// ─ partitionByAge ────────────────────────────────────────────────────────────

test('[MCA-76] partitionByAge: strictly older than maxAgeDays → stale; exactly 7 days → keep', () => {
  const blocks = [
    { date: '2026-07-01', heading: '## Session: 2026-07-01', body: 'exactly 7 days old' },
    { date: '2026-06-30', heading: '## Session: 2026-06-30', body: '8 days old' },
    { date: '2026-07-07', heading: '## Session: 2026-07-07', body: 'fresh' },
  ]
  const { keep, stale } = partitionByAge(blocks, NOW)
  assert.deepEqual(keep.map(b => b.date), ['2026-07-01', '2026-07-07'])
  assert.deepEqual(stale.map(b => b.date), ['2026-06-30'])
})

test('[MCA-76] partitionByAge: undated blocks are always kept', () => {
  const { keep, stale } = partitionByAge([{ date: null, heading: '## Session: kickoff', body: 'x' }], NOW)
  assert.equal(keep.length, 1)
  assert.equal(stale.length, 0)
})

// ─ rebuildRecent ─────────────────────────────────────────────────────────────

test('[MCA-76] rebuildRecent: single blank line between sections + trailing newline', () => {
  const { preamble, blocks } = parseSessionBlocks(RECENT)
  const rebuilt = rebuildRecent(preamble, blocks)
  assert.equal(rebuilt, RECENT + '\n')   // RECENT already single-blank-line separated; rebuild adds the trailing newline
  assert.equal(rebuilt.includes('\n\n\n'), false)
  assert.equal(rebuilt.endsWith('work\n'), true)
})

test('[MCA-76] rebuildRecent: parse → rebuild round-trip is stable (idempotent)', () => {
  const once = rebuildRecent(parseSessionBlocks(RECENT).preamble, parseSessionBlocks(RECENT).blocks)
  const p2 = parseSessionBlocks(once)
  assert.equal(rebuildRecent(p2.preamble, p2.blocks), once)
})

test('[MCA-76] rebuildRecent: empty preamble and no blocks → empty string', () => {
  assert.equal(rebuildRecent('', []), '')
  assert.equal(rebuildRecent('', [{ date: null, heading: '## Session: x', body: '' }]), '## Session: x\n')
})

// ─ buildArchiveAppend ────────────────────────────────────────────────────────

test('[MCA-76] buildArchiveAppend: archived-comment line + blocks verbatim', () => {
  const out = buildArchiveAppend([
    { date: '2026-06-30', heading: '## Session: 2026-06-30 — Maya', body: '- **Focus:** old' },
  ], NOW)
  assert.equal(out, '<!-- archived 2026-07-08 by weekly consolidation -->\n## Session: 2026-06-30 — Maya\n- **Focus:** old')
})

// ─ countLessonEntries ────────────────────────────────────────────────────────

test('[MCA-76] countLessonEntries: 0 for preamble-only, N for entries', () => {
  assert.equal(countLessonEntries(''), 0)
  assert.equal(countLessonEntries('---\nagent: maya\n---\n# Lessons — Maya\nintro'), 0)
  assert.equal(countLessonEntries('# Lessons\n\n## Lesson: retry writes\nbody\n\n## Lesson: pin versions\nbody'), 2)
})

// ─ isOrchestratorRole ────────────────────────────────────────────────────────

test('[MCA-76] isOrchestratorRole matches the agent-executor heuristic', () => {
  assert.equal(isOrchestratorRole('Chief of Staff & Agent Orchestrator'), true)
  assert.equal(isOrchestratorRole('chief of staff'), true)
  assert.equal(isOrchestratorRole('Head of Marketing'), false)
  assert.equal(isOrchestratorRole(null), false)
})

// ─ buildConsolidationReport ──────────────────────────────────────────────────

test('[MCA-76] buildConsolidationReport: per-agent table rows + protocol instructions', () => {
  const report = buildConsolidationReport({
    orgName: '7Ei', date: '2026-07-08',
    perAgent: [
      { agent: 'arturito', archivedCount: 3, keptCount: 2, lessonCount: 6 },
      { agent: 'maya', archivedCount: 0, keptCount: 4, lessonCount: 1 },
    ],
  })
  assert.equal(report.startsWith('# Weekly memory consolidation — 2026-07-08'), true)
  assert.equal(report.includes('Org: 7Ei'), true)
  assert.equal(report.includes('| Agent | Archived sessions | Kept sessions | Lessons |'), true)
  assert.equal(report.includes('| arturito | 3 | 2 | 6 |'), true)
  assert.equal(report.includes('| maya | 0 | 4 | 1 |'), true)
  assert.equal(report.includes('**3+ times**, or stable for **7+ days** → promote it to `long-term.md`'), true)
  assert.equal(report.includes('recurring **3+ times** → propose a rule'), true)
  assert.equal(report.includes('gated memory endpoints'), true)
})

test('[MCA-76] buildConsolidationReport: org name line omitted when absent', () => {
  const report = buildConsolidationReport({ date: '2026-07-08', perAgent: [] })
  assert.equal(report.includes('Org:'), false)
})
