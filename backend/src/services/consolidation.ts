// Weekly memory consolidation (MCA-76) — pure helpers for pruning per-agent
// recent.md session logs. Session blocks older than 7 days move from
// Memory/agents/<slug>/recent.md into archive-recent.md, and the org's
// orchestrator gets a review task quoting the Memory-Protocol promotion rules.
// This module stays pure (no db/network) — the scheduler wires it to the vault.

export interface SessionBlock { date: string | null; heading: string; body: string }

const SESSION_HEADING = /^## Session: /
const ISO_DATE = /\d{4}-\d{2}-\d{2}/

/** Split recent.md on `## Session:` headings. Preamble (frontmatter + intro) is
 *  everything before the first block, preserved verbatim. `date` = first
 *  YYYY-MM-DD in the heading, null when absent. */
export function parseSessionBlocks(markdown: string): { preamble: string; blocks: SessionBlock[] } {
  const lines = String(markdown ?? '').split('\n')
  const headingIdx: number[] = []
  lines.forEach((line, i) => { if (SESSION_HEADING.test(line)) headingIdx.push(i) })
  if (headingIdx.length === 0) return { preamble: String(markdown ?? ''), blocks: [] }
  const preamble = lines.slice(0, headingIdx[0]).join('\n')
  const blocks = headingIdx.map((start, i) => {
    const end = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length
    const heading = lines[start]
    const body = lines.slice(start + 1, end).join('\n').replace(/\s+$/, '')
    return { date: heading.match(ISO_DATE)?.[0] ?? null, heading, body }
  })
  return { preamble, blocks }
}

/** Partition blocks by age in whole UTC days: strictly older than maxAgeDays →
 *  stale (exactly maxAgeDays old → keep). Session dates carry no time component,
 *  so `now` is truncated to its UTC day before comparing. Undated/unparseable
 *  blocks are always kept — never archive content we can't age. */
export function partitionByAge(blocks: SessionBlock[], now: Date, maxAgeDays = 7): { keep: SessionBlock[]; stale: SessionBlock[] } {
  const keep: SessionBlock[] = []
  const stale: SessionBlock[] = []
  const nowDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const cutoffMs = maxAgeDays * 86_400_000
  for (const b of blocks) {
    const t = b.date ? Date.parse(`${b.date}T00:00:00.000Z`) : NaN
    if (Number.isNaN(t) || nowDayMs - t <= cutoffMs) keep.push(b)
    else stale.push(b)
  }
  return { keep, stale }
}

const renderBlock = (b: SessionBlock): string => (b.body ? `${b.heading}\n${b.body}` : b.heading).replace(/\s+$/, '')

/** Recompose recent.md: preamble + kept blocks, one blank line between sections,
 *  trailing newline. Parse → rebuild round-trips are stable. */
export function rebuildRecent(preamble: string, keepBlocks: SessionBlock[]): string {
  const sections = [String(preamble ?? '').replace(/\s+$/, ''), ...keepBlocks.map(renderBlock)].filter(s => s !== '')
  return sections.length ? sections.join('\n\n') + '\n' : ''
}

/** Archive chunk for archive-recent.md: an `archived <date>` HTML comment line,
 *  then the stale blocks verbatim (blank-line separated). */
export function buildArchiveAppend(staleBlocks: SessionBlock[], archivedAt: Date = new Date()): string {
  const stamp = archivedAt.toISOString().slice(0, 10)
  return `<!-- archived ${stamp} by weekly consolidation -->\n` + staleBlocks.map(renderBlock).join('\n\n')
}

/** Count `## Lesson:`-style entries in lessons.md — every `^## ` heading after
 *  the title/frontmatter (which never use `## `). */
export function countLessonEntries(markdown: string): number {
  return (String(markdown ?? '').match(/^## /gm) ?? []).length
}

/** Same heuristic as agent-executor: the org's orchestrator is the agent whose
 *  role mentions 'orchestrator' or 'chief of staff'. */
export function isOrchestratorRole(role: string | null | undefined): boolean {
  const r = String(role ?? '').toLowerCase()
  return r.includes('orchestrator') || r.includes('chief of staff')
}

/** Review-task body for the orchestrator: per-agent table + the Memory-Protocol
 *  promotion rules it must apply via its gated memory endpoints. */
export function buildConsolidationReport(input: {
  orgName?: string
  date: string
  perAgent: Array<{ agent: string; archivedCount: number; keptCount: number; lessonCount: number }>
}): string {
  const lines = [`# Weekly memory consolidation — ${input.date}`, '']
  if (input.orgName) lines.push(`Org: ${input.orgName}`, '')
  lines.push(
    '| Agent | Archived sessions | Kept sessions | Lessons |',
    '| --- | ---: | ---: | ---: |',
  )
  for (const a of input.perAgent) {
    lines.push(`| ${a.agent} | ${a.archivedCount} | ${a.keptCount} | ${a.lessonCount} |`)
  }
  lines.push(
    '',
    '## Instructions',
    '',
    "Session blocks older than 7 days were moved to each agent's `Memory/agents/<slug>/archive-recent.md`.",
    'Review the archived sessions and each `lessons.md` against the Memory-Protocol promotion rules:',
    '',
    '- A pattern observed **3+ times**, or stable for **7+ days** → promote it to `long-term.md`.',
    '- A lesson recurring **3+ times** → propose a rule (governance/protocol change).',
    '',
    'Write promotions through your gated memory endpoints (`PUT /api/agent/memory/file`) — do not edit the vault any other way.',
  )
  return lines.join('\n')
}
