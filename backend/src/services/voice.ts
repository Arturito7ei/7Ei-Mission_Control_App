// Arturita B1 (safe subset) — Voice Gateway PURE HELPERS.
//
// The provider layer for STT/TTS (same philosophy as `llm-router`) — this file
// is the pure, testable core: transcript normalization, STT-confidence gating,
// wake-word / push-to-talk handling, and provider fallback ORDERING
// (cloud → alt → local → text-only) so a provider outage never drops a command.
//
// It performs NO audio I/O and holds NO provider keys — the route/provider
// adapters do that. Scaffolded on the PROVISIONAL S1 decision (local-first,
// provider-pluggable): the ordering here defaults to preferring LOCAL for
// sensitive/wallet-adjacent contexts. Audio is discarded after transcription
// (PRD §7.8) — `AUDIO_RETENTION` documents that invariant for callers.

import { MIN_STT_CONFIDENCE } from './intent'

// Re-export so voice callers have one source for the confidence threshold.
export { MIN_STT_CONFIDENCE }

/** Audio is transcribed then discarded — no long-term audio store (PRD §7.8). */
export const AUDIO_RETENTION = 'discard_after_transcription' as const

// ─── Transcript normalization ────────────────────────────────────────────────

/** Normalize a raw STT transcript for downstream intent classification:
 *  collapse whitespace, trim, and strip a leading wake word if present. Keeps
 *  original casing for entity echo; downstream lower-cases as needed. */
export function normalizeTranscript(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

// ─── Wake word (fuzzy) ───────────────────────────────────────────────────────

export const WAKE_WORD = 'arturita'

// Whisper (and browser STT) routinely mis-hear the coined name "Arturita" as a
// near-miss — "Arturator", "Arturito", "Arturia" — or split it across tokens
// ("art of eta"). Exact-prefix matching made wake-word mode unreliable, so wake
// detection is FUZZY: an explicit allowlist of known mishears (belt) plus a
// normalized edit-distance threshold (suspenders) over the leading 1–3 tokens.
// Push-to-talk stays the default reliable path (S5); this only affects the
// opt-in wake-word mode, where a rare false positive is cheaper than failing to
// answer to her name.

/** Known STT mishears of "Arturita" (lowercased, punctuation-free). The fuzzy
 *  threshold below catches most of these on its own; the allowlist guarantees
 *  the common ones even if the threshold is later tightened. Includes a few
 *  space-collapsed split-name forms ("art of eta" → "artofeta"). */
export const WAKE_VARIANTS = new Set([
  'arturita', 'arturito', 'arturado', 'arturato', 'arturador',
  'arturator', 'arturater', 'arturitta', 'arturitas', 'arturit',
  'arturia', 'arturi', 'arturida', 'arturna', 'arturina',
  'arthurita', 'arthurito', 'alturita', 'artureta', 'arturela',
  'artofeta', 'artoreta', 'artaeta', 'arturetta',
])

/** Similarity threshold in [0,1] (1 = identical). 0.6 accepts an edit distance
 *  of ~3 against the 8-char wake word — enough for "arturator"/"art of eta"
 *  while rejecting ordinary command words. Tuned + locked by unit tests. */
const WAKE_SIMILARITY = 0.6
const MAX_WAKE_SPAN = 3

/** Levenshtein edit distance (two-row DP). Pure, no deps. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** Normalized similarity in [0,1]; 1 for identical, 0 for empty-vs-nonempty. */
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

/** Strip to comparable form: lowercase, drop everything but a–z0–9. */
const cleanToken = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Is `cand` (a joined leading span) close enough to be the wake word? */
function isWakeCandidate(cand: string, wake: string): boolean {
  if (!cand) return false
  return WAKE_VARIANTS.has(cand) || similarity(cand, wake) >= WAKE_SIMILARITY
}

/** Does `tok` look like the START of the name? Anchors multi-token joins so we
 *  only stitch fragments of a split name ("art" + "of" + "eta") and never a
 *  junk word that merely precedes the name ("tell" in "tell arturita later"). */
function isNameStart(tok: string, wake: string): boolean {
  if (tok.length < 2) return false
  if (wake.startsWith(tok)) return true
  return similarity(tok, wake.slice(0, tok.length)) >= WAKE_SIMILARITY
}

export interface WakeMatch { matched: boolean; tokensConsumed: number }

/** Fuzzy-match the wake word against the LEADING tokens of a transcript. Returns
 *  whether it matched and how many whitespace tokens the name spanned (so the
 *  caller can strip exactly the name). Pure. */
export function matchWakeWord(transcript: string | null | undefined, wake: string = WAKE_WORD): WakeMatch {
  const tokens = normalizeTranscript(transcript).split(' ').map(cleanToken).filter(Boolean)
  if (!tokens.length) return { matched: false, tokensConsumed: 0 }
  // 1) Single leading token is the name (exact, a variant, or fuzzy-close).
  if (isWakeCandidate(tokens[0], wake)) return { matched: true, tokensConsumed: 1 }
  // 2) The name was split across tokens — stitch, but only from a plausible
  //    name-start so unrelated leading words can't be deleted into a match.
  if (isNameStart(tokens[0], wake)) {
    let joined = tokens[0]
    for (let k = 2; k <= Math.min(MAX_WAKE_SPAN, tokens.length); k++) {
      joined += tokens[k - 1]
      if (isWakeCandidate(joined, wake)) return { matched: true, tokensConsumed: k }
    }
  }
  return { matched: false, tokensConsumed: 0 }
}

/** Does the transcript start with the wake word ("Arturita, …")? Tolerant of STT
 *  mishears. Used only when wake-word mode is opted in (push-to-talk is the
 *  default — S5). */
export function hasWakeWord(transcript: string | null | undefined, wake: string = WAKE_WORD): boolean {
  return matchWakeWord(transcript, wake).matched
}

/** Strip a leading wake word (+ any following comma) so the command classifier
 *  sees just the command. Tolerant of mishears/splits. No-op when absent. */
export function stripWakeWord(transcript: string | null | undefined, wake: string = WAKE_WORD): string {
  const norm = normalizeTranscript(transcript)
  const m = matchWakeWord(norm, wake)
  if (!m.matched) return norm
  const rest = norm.split(' ').slice(m.tokensConsumed).join(' ')
  return rest.replace(/^\s*,\s*/, '').trim()
}

/** Should this capture be processed? Push-to-talk captures are always processed;
 *  wake-word-mode captures are processed only if the wake word is present. */
export function shouldProcessCapture(input: {
  transcript: string | null | undefined
  mode: 'push_to_talk' | 'wake_word'
  wake?: string
}): boolean {
  if (input.mode === 'push_to_talk') return normalizeTranscript(input.transcript).length > 0
  return hasWakeWord(input.transcript, input.wake ?? WAKE_WORD)
}

// ─── STT confidence gating ───────────────────────────────────────────────────

export interface TranscriptResult {
  transcript: string
  confidence: number | null
  provider: string
}

export type TranscriptDisposition = 'accept' | 'reprompt' | 'empty'

/** Gate an STT result: empty → 'empty'; below the confidence threshold →
 *  'reprompt' (never guess — PRD §7.2/§8); otherwise 'accept'. Null confidence
 *  (provider gave none) is accepted (can't reprompt on unknown). */
export function gateTranscript(
  result: Pick<TranscriptResult, 'transcript' | 'confidence'>,
  threshold: number = MIN_STT_CONFIDENCE,
): TranscriptDisposition {
  const t = normalizeTranscript(result.transcript)
  if (!t) return 'empty'
  if (result.confidence != null && result.confidence < threshold) return 'reprompt'
  return 'accept'
}

// ─── Provider fallback ordering ──────────────────────────────────────────────

export type VoiceTier = 'cloud' | 'alt' | 'local' | 'text_only'

export interface VoiceProvider {
  id: string
  tier: VoiceTier
  /** true if the provider runs locally (no data leaves the machine). */
  local: boolean
  healthy?: boolean
}

/** Order STT/TTS providers for a capture. When the context is sensitive
 *  (wallet/secret-adjacent), LOCAL providers come first and cloud is dropped
 *  entirely (privacy — S1 default); otherwise cloud-first with local as the
 *  offline fallback, then a text-only last resort. Unhealthy providers are
 *  dropped. Pure. */
export function orderVoiceProviders(input: {
  providers: VoiceProvider[]
  sensitive: boolean
}): VoiceProvider[] {
  const healthy = input.providers.filter(p => p.healthy !== false)
  if (input.sensitive) {
    // sensitive: local only (no cloud), then text-only.
    return healthy
      .filter(p => p.local || p.tier === 'text_only')
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
  }
  return [...healthy].sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
}

const TIER_ORDER: VoiceTier[] = ['cloud', 'alt', 'local', 'text_only']
function tierRank(t: VoiceTier): number {
  const i = TIER_ORDER.indexOf(t)
  return i === -1 ? TIER_ORDER.length : i
}

/** The next provider to try after `failedId` fell over — the next healthy one in
 *  the ordered list, or null when the chain is exhausted (caller drops to
 *  text-only / posts a notice). Pure. */
export function nextVoiceProvider(ordered: VoiceProvider[], failedId: string | null): VoiceProvider | null {
  if (!failedId) return ordered[0] ?? null
  const idx = ordered.findIndex(p => p.id === failedId)
  if (idx === -1) return ordered[0] ?? null
  return ordered[idx + 1] ?? null
}
