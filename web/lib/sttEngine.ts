// Arturita STT — pure engine selection. Given the operator's configured STT
// chain (⚙ Pipeline config: e.g. whisper_cpp → web_speech) plus what's actually
// available at runtime, decide which capture engine push-to-talk should use.
// Typed input is ALWAYS available and is the final fallback (handled by the UI,
// not modelled here). Unit-tested; no DOM.

// Local whisper engine ids (kept in sync with lib/whisper.isWhisperEngine; a
// tiny inline copy so this module stays import-free and unit-testable under the
// node test runner, matching the repo's self-contained-logic convention).
const WHISPER_ENGINES = new Set(['whisper_cpp', 'faster_whisper', 'whisper'])
const isWhisperEngine = (engine: string | null | undefined) => WHISPER_ENGINES.has(String(engine ?? '').trim().toLowerCase())

export type SttEngineChoice = 'whisper' | 'web_speech' | 'none'

export interface SttEngineInput {
  /** the ordered STT chain from pipeline config (engine ids, primary first). */
  sttChain: { engine: string; mode?: string }[]
  /** local whisper bridge answered a health probe. */
  whisperReachable: boolean
  /** Web Speech SpeechRecognition is present AND not known-blocked (e.g. Brave
   *  disables it → a persistent `network` error; the panel flips this false once
   *  it sees that, so we stop choosing an engine that can't work). */
  webSpeechAvailable: boolean
}

/**
 * Walk the configured chain in priority order and return the first engine that's
 * actually usable right now. Falls through to any usable engine not in the chain
 * (whisper preferred) so a reachable bridge is never ignored, and to 'none' when
 * nothing works (→ the UI steers to typing). Pure.
 */
export function resolveSttEngine(input: SttEngineInput): SttEngineChoice {
  const canWhisper = !!input.whisperReachable
  const canWebSpeech = !!input.webSpeechAvailable
  for (const entry of input.sttChain ?? []) {
    if (isWhisperEngine(entry?.engine) && canWhisper) return 'whisper'
    if (entry?.engine === 'web_speech' && canWebSpeech) return 'web_speech'
  }
  // Chain exhausted / empty: prefer a reachable local whisper, then web speech.
  if (canWhisper) return 'whisper'
  if (canWebSpeech) return 'web_speech'
  return 'none'
}

/** A short, colorblind-safe label (icon + text) for the active engine, for the
 *  panel's status line. Pure. */
export function sttEngineLabel(choice: SttEngineChoice): string {
  switch (choice) {
    case 'whisper': return '🔒 Local Whisper (free, on-device)'
    case 'web_speech': return '🌐 Browser voice input'
    default: return '⌨ Type to talk (no voice input here)'
  }
}
