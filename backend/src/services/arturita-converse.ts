// Arturita J1 — conversational front-door decision (PURE).
//
// The "Jarvis" behaviour: by DEFAULT Arturita answers the operator directly,
// herself — a single conversational LLM turn. She only routes a request into the
// task/agent-swarm flow (create a task, delegate, kick off a build) when the
// operator EXPLICITLY asks her to build/do/delegate something, OR when the intent
// is destructive (which must go through the task + A2 approval gate regardless).
//
// This module makes only that ROUTING DECISION — pure + `node --test`-covered.
// The endpoint (`routes/arturita-converse.ts`) applies it: `answer` → one LLM
// turn via the F1 fallback chain; `delegate` → the existing voice/ask-vs-execute
// routing (`voice-routing.ts`) that creates the task. It reuses the A3 intent
// classifier (`intent.ts`) so the client gate and the server gate agree.

import { classifyIntent, type ApprovalType } from './intent'

export type ConverseMode = 'answer' | 'delegate'

export type ConverseTrigger =
  | 'explicit_flag'        // the operator toggled "delegate to the agents" for this turn
  | 'destructive_intent'   // delete/move/send/sign/exec — must go through the task + approval gate
  | 'delegation_phrase'    // "have the team…", "delegate…", "spin up an agent…"
  | 'build_order'          // a concrete engineering/build work order ("build…", "deploy…")
  | 'default_answer'       // nothing explicit → Arturita answers directly (the default)

export interface ConverseDecision {
  mode: ConverseMode
  trigger: ConverseTrigger
  /** human-readable, surfaced to the operator so the routing decision is visible. */
  reason: string
  destructive: boolean
  approvalType?: ApprovalType
}

// Explicit delegation language — the operator handing work to the agent swarm.
// These are unambiguous "do this through the office", not conversational asks.
const DELEGATION_PHRASE =
  /\b(delegate|hand (?:this|it|that) (?:off|over)|assign (?:this|it|that|to)|have (?:the )?(?:team|an? agent|someone)|get (?:an? agent|the team|someone) (?:to|on)|spin up (?:an? )?agent|spawn (?:an? )?agent|kick off|open a task|create a task|file a task|make a task|put (?:this|it|that) on the board|route (?:this|it|that) to)\b/i

// Concrete build / engineering work orders — "actually do the work" verbs that
// belong on the board (execute loop), not a chat reply. Deliberately narrow:
// conversational "write me a haiku" / "summarise this" / "make a list" stay
// answers. We only trip on software-build intent.
const BUILD_ORDER =
  /\b(build|implement|deploy|ship|refactor|scaffold|code up|write (?:the )?(?:code|a script|a program|a function|a component|a service|an endpoint|a test)|set up (?:the )?(?:repo|project|pipeline|ci|deployment)|fix the (?:bug|build|test)|open a pr|raise a pr|merge)\b/i

/**
 * Decide whether Arturita answers this utterance directly (default) or routes it
 * into the task/agent flow. Precedence (safety first):
 *   1. destructive intent  → delegate (task + A2 approval gate)
 *   2. explicit flag        → delegate (operator opted in for this turn)
 *   3. delegation phrase    → delegate
 *   4. build/work order     → delegate
 *   5. otherwise            → answer directly
 * Pure — no DB, no network.
 */
export function decideConverseMode(input: {
  transcript: string | null | undefined
  /** the operator explicitly opted this turn into the agent flow (UI toggle/button). */
  explicitDelegate?: boolean
}): ConverseDecision {
  const transcript = String(input.transcript ?? '').trim()
  const intent = classifyIntent(transcript)

  if (intent.destructive) {
    return {
      mode: 'delegate', trigger: 'destructive_intent',
      reason: `“${intent.primary}” is a destructive action — routing it through a task so it stops at your approval before anything irreversible.`,
      destructive: true, approvalType: intent.approvalType,
    }
  }
  if (input.explicitDelegate) {
    return {
      mode: 'delegate', trigger: 'explicit_flag',
      reason: 'You asked me to hand this to the agents — creating a task on the board.',
      destructive: false,
    }
  }
  if (DELEGATION_PHRASE.test(transcript)) {
    return {
      mode: 'delegate', trigger: 'delegation_phrase',
      reason: 'You asked me to delegate this — routing it to the agent flow.',
      destructive: false,
    }
  }
  if (BUILD_ORDER.test(transcript)) {
    return {
      mode: 'delegate', trigger: 'build_order',
      reason: 'That’s a build/work order — putting it on the board for the office to run.',
      destructive: false,
    }
  }
  return {
    mode: 'answer', trigger: 'default_answer',
    reason: 'Answering directly.',
    destructive: false,
  }
}

// ─── Conversational system prompt (pure) ─────────────────────────────────────

export interface ConversePromptOpts {
  agentName?: string | null
  orgName?: string | null
  orgMission?: string | null
  orgCulture?: string | null
  persona?: string | null
  personality?: string | null
  /** live cockpit/system-awareness block (agent fleet, tasks, memory) if provided. */
  contextBlock?: string | null
}

/**
 * Build the system prompt for a direct conversational turn. Deliberately NOT the
 * full executor prompt: no [REMEMBER]/[DELEGATE]/[WEBHOOK] directives (this turn
 * takes no actions — it's a spoken/written reply), but it keeps identity, org
 * context, persona, and any system-awareness block so the answer is grounded.
 * Pure — returns a string.
 */
export function buildConverseSystemPrompt(opts: ConversePromptOpts = {}): string {
  const name = (opts.agentName && opts.agentName.trim()) || 'Arturita'
  const lines: string[] = []

  lines.push(`You are ${name}, the operator's personal AI chief-of-staff at ${opts.orgName?.trim() || '7Ei'}.`)
  lines.push(
    'This is a live voice/chat conversation. Answer the operator directly, yourself, in one concise reply —',
    'warm, sharp, and to the point, like a trusted right hand. No filler, no preamble.',
    '',
  )
  if (opts.orgMission || opts.orgCulture) {
    lines.push('=== ORGANISATION CONTEXT ===')
    if (opts.orgMission) lines.push(`Mission & Vision: ${opts.orgMission}`)
    if (opts.orgCulture) lines.push(`Culture & Principles: ${opts.orgCulture}`)
    lines.push('=== END ORGANISATION CONTEXT ===', '')
  }
  if (opts.persona)     lines.push('YOUR PERSONALITY AND STYLE:', opts.persona, '')
  if (opts.personality) lines.push(`Communication style: ${opts.personality}`, '')
  if (opts.contextBlock) lines.push(opts.contextBlock, '')

  lines.push(
    'IMPORTANT — you are conversing, not acting:',
    '• Give a direct answer. You are not checked out into a workspace and take no actions in this turn:',
    '  no file changes, no sends, no wallet signing, no delegation.',
    '• If the operator explicitly asks you to build, do, or delegate something, tell them you\'ll put it on',
    '  the board — the system routes that into a task automatically; you do not need to describe machinery.',
    '• Anything destructive or irreversible always stops at their explicit approval first.',
  )
  return lines.join('\n')
}
