// Arturita B3 — ask-vs-execute routing from voice (pure).
//
// A voice command becomes a task on the existing board. This decides HOW it runs
// (reusing the shipped primitives, not a new loop): a question routes to a
// single-turn `ask` (askmode.ts `work_mode: 'ask'` — no workspace/checkout); a
// work order routes to the full `execute` loop; a follow-up utterance re-enters
// the same task thread (thread.ts wake-on-comment). This module only makes the
// ROUTING DECISION — pure + tested; the endpoint (B1/S1) wires it to the executor.

import { classifyIntent, type IntentClassification } from './intent'
import { normalizeWorkMode, type WorkMode } from './askmode'

// Interrogative openers + auxiliaries that mark a question ("what's on my
// calendar", "do I have any meetings").
const QUESTION_OPENERS = [
  'what', 'whats', "what's", 'when', 'where', 'who', 'whom', 'whose', 'why', 'how',
  'which', 'is', 'are', 'am', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'has', 'have', 'had', 'may', 'might',
]

function firstWord(s: string): string {
  return s.toLowerCase().replace(/^[^a-z]+/, '').split(/\s+/)[0] ?? ''
}

/** Is this transcript phrased as a question? (interrogative opener or a trailing
 *  '?'). Pure text heuristic. */
export function isQuestion(transcript: string | null | undefined): boolean {
  const t = String(transcript ?? '').trim()
  if (!t) return false
  if (t.endsWith('?')) return true
  return QUESTION_OPENERS.includes(firstWord(t))
}

export interface VoiceRoute {
  workMode: WorkMode
  intent: IntentClassification
  isFollowUp: boolean
  reason: string
}

/**
 * Route a voice command:
 *  - A destructive intent is ALWAYS a work order → `execute` (a "delete the
 *    files" phrased as a question is still an action; safety wins).
 *  - A non-destructive question → `ask` (single-turn, no workspace/checkout).
 *  - Anything else (a safe imperative — "summarize this file") → `execute`.
 *  - `existingThreadId` present → this is a follow-up that re-enters that thread
 *    (wake-on-comment), regardless of mode.
 * Pure — the endpoint applies the decision (create task / post comment).
 */
export function routeVoiceCommand(input: {
  transcript: string
  existingThreadId?: string | null
}): VoiceRoute {
  const intent = classifyIntent(input.transcript)
  const isFollowUp = !!input.existingThreadId

  if (intent.destructive) {
    return { workMode: 'execute', intent, isFollowUp, reason: 'destructive intent — runs as an execute-mode work order (gated by approval)' }
  }
  if (isQuestion(input.transcript)) {
    return { workMode: normalizeWorkMode('ask'), intent, isFollowUp, reason: 'question — single-turn ask (no workspace/checkout)' }
  }
  return { workMode: 'execute', intent, isFollowUp, reason: 'work order — execute loop' }
}
