// MCA-83 W5 — ask-mode. A task carries a work mode: `execute` (the full loop:
// workspace checkout, RAG/Drive/memory context, delegation + synthesis, tool
// side-effects) or `ask` — a question, not a work order. An ask is a single LLM
// turn: no workspace/checkout, no delegation, no [REMEMBER]/[WEBHOOK]/[DELEGATE]
// side-effects; the answer is posted straight to the ticket thread. Paperclip
// parity — "just ask the agent something" without spinning up the machinery, and
// (via W3 wake-on-comment) the reply lands in a thread you can keep talking to.
//
// Pure helpers here (normalize/classify/prompt) are unit-tested; the lean run
// itself lives in agent-executor's answerAskTask, which owns the DB transitions.

import type { schema } from '../db/client'

export type WorkMode = 'execute' | 'ask'
export const WORK_MODES: WorkMode[] = ['execute', 'ask']

// The task_comments.kind an ask answer is stored under. It renders like any
// agent-authored comment (authorAgentId set) but is distinguishable in the thread
// and the timeline from an ordinary chat comment.
export const ASK_ANSWER_KIND = 'answer'

/** Coerce any stored/request value to a valid mode; anything unknown = execute. */
export function normalizeWorkMode(v: unknown): WorkMode {
  return String(v ?? '').trim().toLowerCase() === 'ask' ? 'ask' : 'execute'
}

export function isAskMode(v: unknown): boolean {
  return normalizeWorkMode(v) === 'ask'
}

/**
 * A lean system prompt for a single-turn answer. Deliberately NOT buildSystemPrompt:
 * it omits the RAG/Drive/goal blocks and, crucially, the [REMEMBER]/[WEBHOOK]/
 * [DELEGATE] directive instructions — an ask can't run those, so advertising them
 * would be a lie. Keeps identity + org context + memory (read) so the answer is
 * informed, and is honest about the constraint: one reply, no actions taken.
 */
export function buildAskSystemPrompt(
  agent: typeof schema.agents.$inferSelect,
  opts: {
    org?: typeof schema.organisations.$inferSelect | null
    memoryBlock?: string
    hierarchy?: { title?: string | null; manager?: string | null; reports?: string[] }
  } = {},
): string {
  const { org, memoryBlock, hierarchy } = opts
  const lines: string[] = []

  if (org?.mission || org?.culture) {
    lines.push('=== ORGANISATION CONTEXT ===')
    if (org.mission) lines.push(`Mission & Vision: ${org.mission}`)
    if (org.culture) lines.push(`Culture & Principles: ${org.culture}`)
    lines.push('=== END ORGANISATION CONTEXT ===', '')
  }

  if (agent.agentType === 'advisor' && agent.advisorPersona) {
    lines.push(`You are ${agent.name}, a Silver Board Advisor.`, `Persona: ${agent.advisorPersona}`, '', 'Embody this persona fully. Speak with their voice, wisdom, and philosophy.', '')
  } else {
    lines.push(`You are ${agent.name}, ${agent.role} at 7Ei.`, '')
  }
  if (hierarchy && (hierarchy.title || hierarchy.manager || (hierarchy.reports && hierarchy.reports.length))) {
    lines.push('=== YOUR PLACE IN THE ORG ===')
    if (hierarchy.title) lines.push(`Title: ${hierarchy.title}`)
    if (hierarchy.manager) lines.push(`Reports to: ${hierarchy.manager}`)
    if (hierarchy.reports && hierarchy.reports.length) lines.push(`Direct reports: ${hierarchy.reports.join(', ')}`)
    lines.push('=== END ORG ===', '')
  }
  if (agent.personality) lines.push(`Communication style: ${agent.personality}`, '')
  if (agent.persona)     lines.push('\nYOUR PERSONALITY AND STYLE:\n' + agent.persona, '')
  if (agent.expertise)   lines.push('\nYOUR AREAS OF EXPERTISE:\n' + agent.expertise, '')
  if (agent.cv)          lines.push(`Background: ${agent.cv}`, '')
  const skills = (agent.skills as string[]) ?? []
  if (skills.length > 0) lines.push(`Active skills: ${skills.join(', ')}`, '')
  if (memoryBlock) lines.push(memoryBlock, '')

  lines.push(
    "You've been asked a question. This is ASK mode, not a work order:",
    '• Give one direct, concise answer in this thread — no filler.',
    '• You are not checked out into a workspace and cannot run tools, delegate,',
    '  save memory, or take any action — this is a single reply.',
    '• If answering properly would require doing work, say what you would do and',
    '  note that it needs an execute-mode task — do not pretend to have done it.',
    '• Flag risks and anything irreversible.',
  )
  return lines.join('\n')
}
