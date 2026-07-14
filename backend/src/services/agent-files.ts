// Epic AG / AG3 — the managed instructions bundle: an agent's personal markdown
// files (AGENTS.md · HEARTBEAT.md · SOUL.md · TOOLS.md, plus any extra .md the
// operator adds). Closes the `docs/GAP-paperclip-config.md` "managed instructions
// bundle" gap.
//
// Everything here is pure — validation, default content, rendering. The routes do
// the I/O. Two invariants worth stating out loud:
//
//  1. SAFE DEFAULT: an agent with no stored file behaves EXACTLY as it did before
//     this feature. `renderInstructionsBundle` only renders *stored* files, so the
//     system prompt is unchanged until the operator actually saves something. The
//     defaults below are a starting point shown in the editor, not a silent prompt.
//  2. The path is a bare filename, never a path — `..`, `/`, and `\` are rejected,
//     so a file name can never escape its agent.

export const ENTRY_FILE = 'AGENTS.md'

/** The bundle every agent shows, in display order. AGENTS.md is the ENTRY file. */
export const MANAGED_FILES = [ENTRY_FILE, 'HEARTBEAT.md', 'SOUL.md', 'TOOLS.md'] as const

export type ManagedFile = (typeof MANAGED_FILES)[number]

/** Hard caps — a bundle feeds the system prompt, so it cannot be unbounded. */
export const MAX_FILE_BYTES = 64 * 1024
export const MAX_BUNDLE_CHARS = 24_000
export const MAX_NAME_LENGTH = 64
export const MAX_EXTRA_FILES = 20

export interface AgentFileRow {
  path: string
  content: string
  updatedAt?: Date | number | null
}

export interface AgentFileMeta {
  path: string
  bytes: number
  /** One of the four files every agent has. */
  managed: boolean
  /** The entry file the agent reads first. */
  entry: boolean
  /** False = not saved yet; the editor shows the default content. */
  stored: boolean
  updatedAt: number | null
}

export const isManaged = (path: string): boolean => (MANAGED_FILES as readonly string[]).includes(path)
export const isEntry = (path: string): boolean => path === ENTRY_FILE

/** UTF-8 byte size, which is what the Files panel displays. */
export const byteSize = (content: string): number => Buffer.byteLength(content, 'utf8')

/**
 * Validate + normalise a file name. Returns null when the name is not a safe
 * bare `.md` filename. Rejects: path separators, `..`, leading dots, control
 * characters, empty stems, non-`.md` extensions, and over-long names.
 */
export function normalizeFileName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').trim()
  if (!name || name.length > MAX_NAME_LENGTH) return null
  if (name.includes('/') || name.includes('\\')) return null
  if (name.includes('..') || name.startsWith('.')) return null
  if (!/\.md$/i.test(name)) return null
  const stem = name.slice(0, -3)
  if (!stem || !/^[A-Za-z0-9._-]+$/.test(stem)) return null
  // A managed name always normalises to its canonical casing (agents.md → AGENTS.md).
  const canonical = MANAGED_FILES.find(m => m.toLowerCase() === name.toLowerCase())
  return canonical ?? `${stem}.md`
}

/** Reject a file whose content is too large to feed a prompt. */
export function validateContent(content: string): { ok: true } | { ok: false; error: string } {
  if (typeof content !== 'string') return { ok: false, error: 'content must be a string' }
  const bytes = byteSize(content)
  if (bytes > MAX_FILE_BYTES) return { ok: false, error: `File is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}.` }
  return { ok: true }
}

export interface AgentLike {
  name: string
  role: string
  title?: string | null
  termsOfReference?: string | null
  personality?: string | null
  jobDescription?: string | null
  skills?: string[] | null
  heartbeatEverySec?: number | null
}

/**
 * Starting content for a managed file, seeded from what the agent already knows
 * about itself. Shown in the editor for a file that has never been saved — it is
 * NOT injected into the prompt (see invariant 1 above).
 */
export function defaultContent(path: string, agent: AgentLike): string {
  const skills = agent.skills?.length ? agent.skills.join(', ') : 'none yet'
  switch (path) {
    case ENTRY_FILE:
      return [
        '# Role', '',
        `You are ${agent.name}, ${agent.title || agent.role} at 7Ei.`, '',
        agent.termsOfReference?.trim() || 'Describe what this agent is responsible for, how it decides, and what it must escalate.',
        '', '# Operating rules', '',
        '- Propose, don’t decide — surface irreversible actions for approval.',
        '- Produce a real artifact when asked for one; save it on the task.',
        '- Be direct and actionable.', '',
      ].join('\n')
    case 'HEARTBEAT.md':
      return [
        '# Heartbeat', '',
        agent.heartbeatEverySec
          ? `This agent wakes every ${agent.heartbeatEverySec}s.`
          : 'This agent has no wake interval set — it runs when work is assigned.',
        '', 'On each wake:', '',
        '1. Check assigned tasks; pick the highest-priority unblocked one.',
        '2. If nothing is actionable, do nothing and end the run — do not invent work.',
        '3. Report blockers instead of working around them.', '',
      ].join('\n')
    case 'SOUL.md':
      return [
        '# Soul', '',
        '## Voice', '',
        agent.personality?.trim() || 'Describe how this agent speaks — tone, register, what it never does.',
        '', '## Principles', '',
        '- Say what is true, including when it is inconvenient.',
        '- One focused question beats three vague ones.', '',
      ].join('\n')
    case 'TOOLS.md':
      return [
        '# Tools', '',
        `Skills currently installed: ${skills}.`, '',
        'Document any tool this agent may use, and the rules for using it.', '',
      ].join('\n')
    default:
      return `# ${path.replace(/\.md$/i, '')}\n\n`
  }
}

/**
 * The Files panel listing: always the four managed files (stored or not), then
 * any extra stored .md files, alphabetically.
 */
export function listBundle(rows: AgentFileRow[], agent: AgentLike): AgentFileMeta[] {
  const stored = new Map(rows.map(r => [r.path, r]))
  const meta = (path: string): AgentFileMeta => {
    const row = stored.get(path)
    const content = row?.content ?? defaultContent(path, agent)
    const updated = row?.updatedAt
    return {
      path,
      bytes: byteSize(content),
      managed: isManaged(path),
      entry: isEntry(path),
      stored: !!row,
      updatedAt: updated instanceof Date ? updated.getTime() : (typeof updated === 'number' ? updated : null),
    }
  }
  const extras = rows.map(r => r.path).filter(p => !isManaged(p)).sort((a, b) => a.localeCompare(b))
  return [...MANAGED_FILES.map(meta), ...extras.map(meta)]
}

/** A file's content: what is stored, else the default (never 404 for a managed file). */
export function readFile(rows: AgentFileRow[], path: string, agent: AgentLike): { content: string; stored: boolean } | null {
  const row = rows.find(r => r.path === path)
  if (row) return { content: row.content, stored: true }
  if (isManaged(path)) return { content: defaultContent(path, agent), stored: false }
  return null // an extra file that does not exist really is a 404
}

/**
 * Render the STORED bundle into a system-prompt block. Returns '' when nothing is
 * stored — that is the safe default: an agent whose bundle was never edited gets
 * exactly the prompt it got before this feature existed.
 *
 * The entry file leads; the rest follow in bundle order. Truncated to
 * MAX_BUNDLE_CHARS with an explicit marker (never silently).
 */
export function renderInstructionsBundle(rows: AgentFileRow[]): string {
  if (rows.length === 0) return ''
  const order = (p: string) => {
    const i = (MANAGED_FILES as readonly string[]).indexOf(p)
    return i === -1 ? MANAGED_FILES.length : i
  }
  const sorted = [...rows].sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path))

  const parts = sorted
    .filter(r => r.content.trim())
    .map(r => `--- ${r.path}${isEntry(r.path) ? ' (ENTRY)' : ''} ---\n${r.content.trim()}`)
  if (parts.length === 0) return ''

  let body = parts.join('\n\n')
  if (body.length > MAX_BUNDLE_CHARS) {
    body = `${body.slice(0, MAX_BUNDLE_CHARS)}\n\n[bundle truncated at ${MAX_BUNDLE_CHARS} characters]`
  }
  return `=== INSTRUCTIONS BUNDLE ===\n${body}\n=== END INSTRUCTIONS BUNDLE ===`
}
