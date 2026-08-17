// Arturita A3 — intent classifier + two-phase destructive confirmation.
//
// STT is fallible and Arturita's blast radius is large; a misheard destructive
// command must never execute silently (PRD §7.2). This module is the *pure*
// gate between "what the operator said" and "what Arturita is allowed to do
// without a second, explicit, distinct confirmation":
//
//  - `classifyIntent(transcript)` tags a transcript with its danger tier and the
//    dangerous approval type it maps to (aligns with A2's dangerous types).
//  - `confirmationPhraseFor(intent)` gives the exact phrase the operator must say
//    (or the button they must tap) to confirm — never a bare "yes".
//  - `isConfirmed(...)` is the two-phase check: a preview is shown, then an
//    explicit distinct confirmation (phrase restating the action, or a tap) is
//    required; a generic affirmative is rejected for the top tier, and a low
//    STT-confidence confirmation is re-prompted, never guessed.
//
// Table-driven and IO-free so it's exhaustively testable over a corpus of
// destructive / safe / ambiguous phrasings.

// ─── Tiers & kinds ───────────────────────────────────────────────────────────

/** safe = read-only / no side effects; destructive = reversible-ish outward or
 *  file mutation (move/overwrite/send/exec); critical = irreversible or funds
 *  (delete/wallet sign/transfer) — the "top tier" that a generic yes can't
 *  confirm (PRD §7.2). */
export type IntentTier = 'safe' | 'destructive' | 'critical'

export type IntentKind =
  | 'delete' | 'move' | 'overwrite'     // file ops
  | 'send'                              // email/outbound
  | 'sign' | 'transfer'                 // wallet
  | 'exec'                             // machine command
  | 'read'                             // safe/no-op

/** The A2 dangerous approval type a kind maps to (undefined for safe). */
export type ApprovalType = 'file_destructive' | 'wallet_tx' | 'email_send' | 'machine_exec'

interface KindSpec {
  kind: IntentKind
  tier: IntentTier
  approvalType?: ApprovalType
  /** confirmation verb the operator must restate (distinct, not a bare "yes"). */
  confirmVerb: string
  re: RegExp
  /** Optional override — used for exec where bare `\brun\b` false-positives on
   *  informational phrasing ("what llm do you run on?"). */
  match?: (text: string) => boolean
}

/** Informational uses of "run" / exec verbs — not machine-exec commands. */
const EXEC_INFO_PATTERNS: RegExp[] = [
  /\brun\s+on\b/i,
  /\brun\s+me\s+through\b/i,
  // Question about what/how something runs, without an imperative object ("run the …").
  /\b(?:what|which|how|where|when|who)\b[^.?]*\brun\b(?!\s+(?:the|this|that|a|an|my|it|some)\b)/i,
]

/** Imperative machine-exec phrasing — kept narrow so conversational "run" stays safe. */
function matchesExecIntent(text: string): boolean {
  if (EXEC_INFO_PATTERNS.some(p => p.test(text))) return false
  return /\b(?:exec\b|(?:run|execute|launch|invoke)\s+(?:the|this|that|a|an|my|it|some|\w+))/i.test(text)
}

function kindSpecMatches(spec: KindSpec, text: string): boolean {
  return spec.match ? spec.match(text) : spec.re.test(text)
}

// Order matters: the highest-tier match wins, and within a tier the earliest
// spec wins. Critical (irreversible / funds) is checked first.
const KIND_SPECS: KindSpec[] = [
  // ── critical (top tier) ──
  { kind: 'delete',   tier: 'critical', approvalType: 'file_destructive', confirmVerb: 'delete',
    re: /\b(delete|delet(?:e|ing)|remove|erase|wipe|purge|shred|rm)\b/i },
  { kind: 'transfer', tier: 'critical', approvalType: 'wallet_tx', confirmVerb: 'transfer',
    re: /\b(transfer|swap|withdraw|send\s+[\d.]+\s*(?:eth|btc|usdc|usdt|sol|matic|tokens?)|pay\s+[\d.]+)\b/i },
  { kind: 'sign',     tier: 'critical', approvalType: 'wallet_tx', confirmVerb: 'sign',
    re: /\b(sign|approve\s+the\s+(?:transaction|tx|swap)|authori[sz]e\s+the\s+(?:transaction|tx|payment))\b/i },
  // ── destructive ──
  { kind: 'overwrite', tier: 'destructive', approvalType: 'file_destructive', confirmVerb: 'overwrite',
    re: /\b(overwrite|replace|clobber|truncate)\b/i },
  { kind: 'move',      tier: 'destructive', approvalType: 'file_destructive', confirmVerb: 'move',
    re: /\b(move|archive|relocate|rename|mv)\b/i },
  { kind: 'send',      tier: 'destructive', approvalType: 'email_send', confirmVerb: 'send',
    re: /\b(send|email|e-mail|reply[- ]?all|forward)\b/i },
  { kind: 'exec',      tier: 'destructive', approvalType: 'machine_exec', confirmVerb: 'run',
    re: /\b(?:run|execute|exec|launch|invoke)\b/i, match: matchesExecIntent },
]

export interface IntentClassification {
  transcript: string
  tier: IntentTier
  kinds: IntentKind[]
  /** The primary (highest-tier, earliest) kind — drives the confirmation phrase. */
  primary: IntentKind
  destructive: boolean
  approvalType?: ApprovalType
}

const TIER_RANK: Record<IntentTier, number> = { safe: 0, destructive: 1, critical: 2 }

/** Classify a transcript into a danger tier + the kinds it triggers. A blank or
 *  read-only transcript is `safe`. Matching several kinds keeps them all but the
 *  highest-tier / earliest one is primary. */
export function classifyIntent(transcript: string | null | undefined): IntentClassification {
  const text = String(transcript ?? '')
  const matched = KIND_SPECS.filter(s => kindSpecMatches(s, text))
  if (matched.length === 0) {
    return { transcript: text, tier: 'safe', kinds: ['read'], primary: 'read', destructive: false }
  }
  // Primary = highest tier, then earliest in KIND_SPECS order (spec order encodes
  // priority within a tier).
  const primarySpec = [...matched].sort((a, b) =>
    TIER_RANK[b.tier] - TIER_RANK[a.tier] || KIND_SPECS.indexOf(a) - KIND_SPECS.indexOf(b))[0]
  const tier = primarySpec.tier
  return {
    transcript: text,
    tier,
    kinds: matched.map(s => s.kind),
    primary: primarySpec.kind,
    destructive: true,
    approvalType: primarySpec.approvalType,
  }
}

/** The confirmation phrase the operator must say to confirm this intent — always
 *  restates the action ("confirm delete"), never a bare "yes". */
export function confirmationPhraseFor(intent: IntentClassification | IntentKind): string {
  const kind = typeof intent === 'string' ? intent : intent.primary
  const spec = KIND_SPECS.find(s => s.kind === kind)
  const verb = spec?.confirmVerb ?? 'proceed'
  return `confirm ${verb}`
}

// ─── STT confidence gate ─────────────────────────────────────────────────────

/** Below this STT confidence, a transcript is too uncertain to act on — the
 *  caller re-prompts instead of guessing (PRD §7.2, §8). */
export const MIN_STT_CONFIDENCE = 0.6

/** Should the caller re-prompt because the transcript was too uncertain?
 *  Undefined/absent confidence is treated as unknown → do NOT force a reprompt
 *  (some providers don't return confidence); a provided low score does. */
export function shouldReprompt(confidence: number | null | undefined, threshold: number = MIN_STT_CONFIDENCE): boolean {
  if (confidence == null) return false
  return confidence < threshold
}

// ─── Generic-affirmative detection ───────────────────────────────────────────

// Bare affirmatives that are NEVER sufficient to confirm a destructive action.
const GENERIC_AFFIRMATIVES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'sure', 'fine', 'go', 'go ahead',
  'do it', 'confirm', 'confirmed', 'proceed', 'affirmative', 'uh huh', 'mhm', 'yes please',
])

function normalize(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Is this utterance a bare generic affirmative (insufficient for confirmation)? */
export function isGenericAffirmative(utterance: string | null | undefined): boolean {
  return GENERIC_AFFIRMATIVES.has(normalize(utterance ?? ''))
}

// ─── Two-phase confirmation ──────────────────────────────────────────────────

export interface ConfirmResult {
  ok: boolean
  /** true when the confirmation was too uncertain and the caller should re-prompt. */
  reprompt?: boolean
  reason?: string
}

/**
 * Decide whether a destructive intent is confirmed. Two-phase: a preview has been
 * shown; this evaluates the operator's *second* action.
 *  - A safe intent needs no confirmation (ok).
 *  - An explicit tap (Cockpit/Telegram button) always confirms (distinct + explicit).
 *  - A spoken confirmation must (a) clear the STT-confidence threshold — else
 *    re-prompt, never guess — and (b) restate the action verb (contain the
 *    confirmation verb / phrase). A bare generic affirmative is rejected,
 *    especially for the critical top tier.
 * Fail-closed: anything ambiguous → not ok.
 */
export function isConfirmed(input: {
  intent: IntentClassification
  utterance?: string | null
  tapped?: boolean
  confidence?: number | null
}): ConfirmResult {
  const { intent } = input
  if (!intent.destructive) return { ok: true }

  // Explicit tap is always an acceptable distinct confirmation.
  if (input.tapped) return { ok: true }

  const utter = input.utterance ?? ''
  if (!normalize(utter)) {
    return { ok: false, reason: 'no confirmation given — preview shown, awaiting explicit confirm' }
  }

  // Low-confidence spoken confirmation → re-prompt, never guess.
  if (shouldReprompt(input.confidence)) {
    return { ok: false, reprompt: true, reason: 'confirmation transcript below STT-confidence threshold — re-prompting' }
  }

  // A bare generic affirmative is never enough for a destructive action.
  if (isGenericAffirmative(utter)) {
    return {
      ok: false,
      reason: `a generic "${normalize(utter)}" is not a valid confirmation — say "${confirmationPhraseFor(intent)}" or tap Approve`,
    }
  }

  // Must restate the action verb (distinct confirmation). Accept the explicit
  // phrase ("confirm delete") or any utterance containing the confirmation verb
  // ("yes, delete them").
  const spec = KIND_SPECS.find(s => s.kind === intent.primary)
  const verb = spec?.confirmVerb ?? 'proceed'
  const n = normalize(utter)
  if (n.includes(verb)) return { ok: true }

  return {
    ok: false,
    reason: `confirmation must restate the action — say "${confirmationPhraseFor(intent)}" or tap Approve`,
  }
}
