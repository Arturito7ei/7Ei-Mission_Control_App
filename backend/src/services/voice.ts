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

// ─── Wake word ───────────────────────────────────────────────────────────────

export const WAKE_WORD = 'arturita'

/** Does the transcript start with the wake word ("Arturita, …")? Used only when
 *  wake-word mode is opted in (push-to-talk is the default — S5). */
export function hasWakeWord(transcript: string | null | undefined, wake: string = WAKE_WORD): boolean {
  const t = normalizeTranscript(transcript).toLowerCase()
  return t === wake || t.startsWith(wake + ' ') || t.startsWith(wake + ',')
}

/** Strip a leading wake word (+ following comma) so the command classifier sees
 *  just the command. No-op when absent. */
export function stripWakeWord(transcript: string | null | undefined, wake: string = WAKE_WORD): string {
  const t = normalizeTranscript(transcript)
  const re = new RegExp('^' + wake + '\\s*,?\\s*', 'i')
  return t.replace(re, '').trim()
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
