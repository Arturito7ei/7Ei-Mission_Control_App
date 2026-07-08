// Arturita B2 — Cockpit voice panel PURE LOGIC (no DOM / React / network).
//
// The browser-facing panel (VoiceSection.tsx) does the impure work: Web Speech
// API capture, POST /arturita/voice, and TTS playback. Every DECISION it makes
// is a pure function here so it can be unit-tested with `node --test` (Node 22
// type-stripping — no test-runner dependency). Mirrors the backend helpers in
// `backend/src/services/voice.ts` (wake word, transcript normalization) so the
// client gate matches the server gate.

export const WAKE_WORD = 'arturita'

/** Collapse whitespace + trim (mirror of backend normalizeTranscript). */
export function normalizeTranscript(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/** True when the transcript contains the wake word (case/punctuation-insensitive). */
export function hasWakeWord(transcript: string | null | undefined, wake: string = WAKE_WORD): boolean {
  const t = normalizeTranscript(transcript).toLowerCase().replace(/[^a-z0-9 ]/g, '')
  return t.split(' ').includes(wake.toLowerCase())
}

/** Remove a leading/anywhere wake word so the command is what's left. */
export function stripWakeWord(transcript: string | null | undefined, wake: string = WAKE_WORD): string {
  const re = new RegExp(`\\b${wake}\\b[,\\.!\\s]*`, 'ig')
  return normalizeTranscript(String(transcript ?? '').replace(re, ' '))
}

export interface SubmitDecision {
  submit: boolean
  cleaned: string
  reason: string
}

/**
 * Decide whether a captured utterance should be sent to the backend.
 * - Push-to-talk (default): submit any non-empty final transcript verbatim.
 * - Wake-word mode (opt-in, S5): only submit utterances containing "Arturita",
 *   and strip the wake word so the command is what's routed.
 */
export function decideSubmit(input: { transcript: string | null | undefined; wakeWordMode: boolean }): SubmitDecision {
  const norm = normalizeTranscript(input.transcript)
  if (!norm) return { submit: false, cleaned: '', reason: 'empty transcript' }
  if (!input.wakeWordMode) return { submit: true, cleaned: norm, reason: 'push-to-talk — submit verbatim' }
  if (!hasWakeWord(norm)) return { submit: false, cleaned: norm, reason: 'wake-word mode — no "Arturita", ignored' }
  const cleaned = stripWakeWord(norm)
  if (!cleaned) return { submit: false, cleaned: '', reason: 'wake word only — no command' }
  return { submit: true, cleaned, reason: 'wake-word mode — command after wake word' }
}

// ─── Shape of the /voice response (subset the panel consumes) ────────────────

export type VoiceMode = 'local' | 'provider'

export interface VoiceReply {
  text: string
  provider: string
  mime?: string | null
  audioBase64?: string | null
  degraded?: boolean
}

export interface VoiceResponse {
  disposition?: 'accept' | 'reprompt' | 'empty'
  reprompt?: boolean
  taskId?: string
  route?: { workMode: 'ask' | 'execute'; reason: string; destructive: boolean; isFollowUp: boolean }
  reply?: VoiceReply
  voiceMode?: { mode: VoiceMode; forcedLocal: boolean; reason: string }
}

// ─── Reply playback source ───────────────────────────────────────────────────

export type PlaybackKind = 'audio' | 'speech' | 'none'

export interface Playback {
  kind: PlaybackKind
  text: string
  /** a `data:` URL ready for `new Audio(src)` when kind==='audio' */
  audioSrc?: string
}

/**
 * Pick how to voice the reply back:
 * - provider TTS returned audio bytes → play that audio ('audio');
 * - otherwise speak the text locally via the browser SpeechSynthesis ('speech')
 *   — this IS the `local` provider on the client;
 * - no text at all → nothing to say ('none').
 * Never throws; the panel always has a reply to show even when silent.
 */
export function pickPlayback(reply: VoiceReply | null | undefined): Playback {
  const text = normalizeTranscript(reply?.text)
  const b64 = reply?.audioBase64
  if (b64) {
    const mime = reply?.mime || 'audio/mpeg'
    return { kind: 'audio', text, audioSrc: `data:${mime};base64,${b64}` }
  }
  if (text) return { kind: 'speech', text }
  return { kind: 'none', text: '' }
}

// ─── Action-feed item ────────────────────────────────────────────────────────

export interface FeedItem {
  taskId: string | null
  /** what the operator said (post wake-word strip) */
  command: string
  workMode: 'ask' | 'execute' | 'reprompt'
  /** execute + destructive → the run will pause at the A2 approval gate */
  needsApproval: boolean
  isFollowUp: boolean
  /** the spoken acknowledgement text */
  ack: string
  /** monotonic sequence for stable keys/ordering (caller-supplied) */
  seq: number
}

/**
 * Fold a /voice response + the command that produced it into a feed row.
 * A low-confidence re-prompt is surfaced as its own row (workMode 'reprompt')
 * so the operator sees that Arturita asked them to repeat rather than acted.
 */
export function toFeedItem(input: { command: string; resp: VoiceResponse; seq: number }): FeedItem {
  const { command, resp, seq } = input
  if (resp.reprompt || resp.disposition !== 'accept') {
    return {
      taskId: null, command: normalizeTranscript(command), workMode: 'reprompt',
      needsApproval: false, isFollowUp: false,
      ack: resp.reply?.text ?? "I didn't quite catch that — could you repeat it?", seq,
    }
  }
  const r = resp.route
  const workMode = r?.workMode ?? 'ask'
  return {
    taskId: resp.taskId ?? null,
    command: normalizeTranscript(command),
    workMode,
    needsApproval: workMode === 'execute' && !!r?.destructive,
    isFollowUp: !!r?.isFollowUp,
    ack: resp.reply?.text ?? 'On it.',
    seq,
  }
}
