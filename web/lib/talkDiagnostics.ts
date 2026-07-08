// Arturita J-prod (bugfix) — PURE talk-path diagnostics: TTS voice selection,
// error classification, and per-leg self-test shaping (no DOM / React / network).
//
// The Assistant tab has THREE failure-prone legs when you "talk to" Arturita:
//   1. backend converse   — POST /arturita/converse (cloud LLM chain)
//   2. local Ollama        — browser→http://localhost:11434 (free, on-device)
//   3. browser TTS         — SpeechSynthesis speaking the reply back
// A raw "network error" told the operator nothing about WHICH leg failed or how
// to fix it. These pure helpers turn each failure into a specific, non-fatal
// status + a fix hint, so the tab degrades cleanly instead of dead-ending.
//
// Colorblind-safe by construction: every status carries an ICON + LABEL + a
// severity token, never color alone (DESIGN_SYSTEM v2). The impure probing lives
// in the panel; everything decided here is unit-tested with `node --test`.

// ─── Browser TTS: pick an on-device voice ─────────────────────────────────────
// Chrome's default/cloud voices are fetched over the network; when the network
// is offline or the voice can't be reached, the utterance fires
// `SpeechSynthesisErrorEvent` with `error === 'network'` and playback silently
// dies. Preferring a `localService` (on-device) voice makes spoken replies work
// offline and dodges that failure mode entirely.

export interface VoiceLike {
  name: string
  lang: string
  /** true when the voice runs on-device (no network). */
  localService?: boolean
  default?: boolean
}

/**
 * Pick the best voice for a spoken reply, preferring an on-device voice in the
 * requested language so playback never depends on the network. Returns null when
 * no voice is available yet — voices load async, so the caller retries after the
 * `voiceschanged` event. Pure.
 */
export function pickSpeechVoice(voices: VoiceLike[] | null | undefined, lang = 'en-US'): VoiceLike | null {
  if (!Array.isArray(voices) || voices.length === 0) return null
  const pref = String(lang || 'en-US').slice(0, 2).toLowerCase()
  const sameLang = voices.filter(v => String(v?.lang ?? '').slice(0, 2).toLowerCase() === pref)
  const pool = sameLang.length ? sameLang : voices
  const pick = (arr: VoiceLike[]) => arr.find(v => v?.default) ?? arr[0]
  const local = pool.filter(v => v?.localService === true)
  return local.length ? pick(local) : pick(pool)
}

// ─── Browser TTS: classify an error event ─────────────────────────────────────

export type TtsFailure = 'network' | 'blocked' | 'synthesis' | 'unsupported' | 'unknown'

export interface TtsStatus {
  /** false for benign codes (we cancel the prior utterance on every new turn). */
  failed: boolean
  kind: TtsFailure | null
  message: string | null
  hint: string | null
}

const TTS_OK: TtsStatus = { failed: false, kind: null, message: null, hint: null }

/**
 * Map a `SpeechSynthesisErrorEvent.error` code to a specific, NON-FATAL operator
 * status. `interrupted`/`canceled` are benign — we `cancel()` before each new
 * utterance, so they aren't reported as failures. Pure.
 */
export function classifyTtsError(errorCode: string | null | undefined): TtsStatus {
  const code = String(errorCode ?? '').trim().toLowerCase()
  switch (code) {
    case '':
    case 'interrupted':
    case 'canceled':
    case 'cancelled':
      return TTS_OK
    case 'network':
      return {
        failed: true, kind: 'network',
        message: 'Voice playback failed — the browser voice needs the network and couldn’t reach it.',
        hint: 'The reply is shown as text. Pick an on-device voice, or check your connection; Chrome cloud voices fail offline.',
      }
    case 'not-allowed':
    case 'audio-busy':
      return {
        failed: true, kind: 'blocked',
        message: 'Voice playback was blocked by the browser.',
        hint: 'Click anywhere on the page to allow audio, then try again. The reply is shown as text.',
      }
    case 'synthesis-failed':
    case 'synthesis-unavailable':
      return {
        failed: true, kind: 'synthesis',
        message: 'The browser couldn’t synthesize speech for this reply.',
        hint: 'The reply is shown as text. Try a different system voice in your OS settings.',
      }
    case 'language-unavailable':
    case 'voice-unavailable':
      return {
        failed: true, kind: 'unsupported',
        message: 'No matching voice is installed for spoken replies.',
        hint: 'The reply is shown as text. Install a voice for your language in your OS settings.',
      }
    default:
      return {
        failed: true, kind: 'unknown',
        message: `Voice playback failed (${code}).`,
        hint: 'The reply is shown as text.',
      }
  }
}

// ─── Converse leg: classify a caught fetch/HTTP error ─────────────────────────

export type TalkLeg = 'backend' | 'local-ollama' | 'tts'

export interface LegError { leg: TalkLeg; message: string; hint: string | null }

const OLLAMA_HINT =
  'Is Ollama running, and is OLLAMA_ORIGINS set to this app’s origin (e.g. OLLAMA_ORIGINS=https://app.7ei.ai) then restarted? Falling back to the cloud chain.'

/**
 * Turn an error thrown by the shared `api()` client (or a local-Ollama fetch)
 * into a specific, actionable message for the given leg. `api()` throws either a
 * transport failure ("Network error …") or an "HTTP <code>: …" string; both are
 * mapped to plain language + a fix hint. Pure.
 */
export function describeTalkError(err: unknown, leg: TalkLeg = 'backend'): LegError {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (leg === 'local-ollama') {
    return { leg, message: 'Local Ollama is unreachable.', hint: OLLAMA_HINT }
  }
  // Transport-level failure (fetch rejected) — the backend couldn't be reached.
  if (/network error/i.test(raw) || /failed to fetch/i.test(raw) || raw === '') {
    return {
      leg,
      message: 'Can’t reach Arturita’s backend right now.',
      hint: 'Check your connection or the service status, then try again. Your local model (if any) still works for answers.',
    }
  }
  const m = raw.match(/^HTTP\s+(\d{3})/i)
  const status = m ? Number(m[1]) : 0
  if (status === 401 || status === 403) {
    return { leg, message: 'Your session token is invalid or expired.', hint: 'Refresh the page or replace the token, then try again.' }
  }
  if (status === 429) {
    return { leg, message: 'The language-model provider is rate-limited right now.', hint: 'Wait a moment and try again, or add another provider to the LLM chain in Pipeline config.' }
  }
  if (status >= 500) {
    return { leg, message: 'Arturita’s backend hit an error handling that turn.', hint: 'Try again in a moment; if it persists, check the backend logs.' }
  }
  return { leg, message: raw || 'Something went wrong talking to Arturita.', hint: null }
}

// ─── Self-test: shape per-leg probe results ───────────────────────────────────

export type LegSeverity = 'ok' | 'warn' | 'fail'

export interface LegResult {
  leg: string
  /** icon + label carry the state — never color alone (colorblind-safe). */
  icon: string
  label: string
  severity: LegSeverity
  detail: string
  hint: string | null
}

/** Raw inputs the panel gathers by probing each leg (all optional/best-effort). */
export interface SelfTestInput {
  /** backend reachable (a lightweight authed GET succeeded). */
  backendOk: boolean
  backendDetail?: string | null
  /** local Ollama probe: null = unreachable/blocked; [] = up but no models. */
  ollamaModels: string[] | null
  /** the configured local primary model id, if the chain has one. */
  ollamaPrimaryModel?: string | null
  /** SpeechSynthesis present in this browser. */
  ttsSupported: boolean
  /** an on-device voice is available. */
  ttsLocalVoice: boolean
  /** SpeechRecognition (mic capture) present. */
  sttSupported: boolean
}

const ICON: Record<LegSeverity, string> = { ok: '✓', warn: '▲', fail: '✕' }

function leg(leg: string, severity: LegSeverity, label: string, detail: string, hint: string | null = null): LegResult {
  return { leg, icon: ICON[severity], label, severity, detail, hint }
}

/**
 * Shape the four talk-path legs into colorblind-safe status rows for the panel's
 * self-test. Pure — the panel does the probing and passes the raw booleans here.
 */
export function runSelfTest(input: SelfTestInput): LegResult[] {
  const out: LegResult[] = []

  // 1. Backend converse (cloud LLM chain — the guaranteed answer path).
  out.push(input.backendOk
    ? leg('backend', 'ok', 'Backend reachable', input.backendDetail || 'Cloud answer + delegate path available.')
    : leg('backend', 'fail', 'Backend unreachable', input.backendDetail || 'Could not reach 7ei-backend.',
        'Check your connection or the service status. Answers and delegation need the backend unless a local model is running.'))

  // 2. Local Ollama (free, on-device answers — optional).
  if (input.ollamaModels === null) {
    out.push(leg('local-ollama', 'warn', 'Local Ollama not reachable', 'Optional — the cloud chain still answers.', OLLAMA_HINT))
  } else if (input.ollamaModels.length === 0) {
    out.push(leg('local-ollama', 'warn', 'Ollama up, no models pulled', 'Reachable, but no models are installed.',
      'Pull a model, e.g. `ollama pull llama3.2:3b`, then reload.'))
  } else {
    const want = String(input.ollamaPrimaryModel ?? '').trim()
    const base = want.split(':')[0]
    const has = !want || input.ollamaModels.some(m => m === want || m.split(':')[0] === base)
    out.push(has
      ? leg('local-ollama', 'ok', 'Local Ollama ready', `On-device answers via ${want || input.ollamaModels[0]} — free & private.`)
      : leg('local-ollama', 'warn', 'Primary model not pulled', `Ollama is up but "${want}" isn’t installed.`,
          `Pull it with \`ollama pull ${want}\`, or pick an installed model in Pipeline config.`))
  }

  // 3. Spoken replies (browser TTS).
  if (!input.ttsSupported) {
    out.push(leg('tts', 'warn', 'Spoken replies unavailable', 'This browser has no SpeechSynthesis.', 'Replies are shown as text. Try Chrome or Edge for voice.'))
  } else if (!input.ttsLocalVoice) {
    out.push(leg('tts', 'warn', 'No on-device voice', 'Only network-backed voices are available — these can fail offline.',
      'Install a system voice for your language, or expect the reply as text when offline.'))
  } else {
    out.push(leg('tts', 'ok', 'Spoken replies ready', 'An on-device voice is available.'))
  }

  // 4. Mic capture (browser STT) — optional; typing always works.
  out.push(input.sttSupported
    ? leg('stt', 'ok', 'Voice capture ready', 'Push-to-talk is available.')
    : leg('stt', 'warn', 'Voice capture unavailable', 'This browser has no SpeechRecognition.', 'Type your message instead, or use Chrome/Edge.'))

  return out
}

/** Worst severity across the legs (for a one-line summary). Pure. */
export function overallSeverity(results: LegResult[]): LegSeverity {
  if (results.some(r => r.severity === 'fail')) return 'fail'
  if (results.some(r => r.severity === 'warn')) return 'warn'
  return 'ok'
}
