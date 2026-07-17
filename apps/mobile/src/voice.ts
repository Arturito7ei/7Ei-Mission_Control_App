// MOB-7a — the phone's voice PURE LOGIC: what each leg can actually do here, and
// what to tell the operator when it can't. No react, no react-native, no network.
//
// THE HONESTY PROBLEM THIS MODULE HOLDS. The desktop Command Center's three voice
// legs all lean on things a phone does not have:
//
//   * LLM  — the web probes Ollama on 127.0.0.1 and streams from it directly.
//   * STT  — the web probes the `arturita-stt` bridge on 127.0.0.1:8790.
//   * Wake — the web leaves the Web Speech recogniser running continuously.
//
// A phone can reach NEITHER loopback address (they are the desk's, not the
// handset's), and Expo Go has no continuous recogniser. So the phone's legs are:
//
//   * LLM  — whatever the HOSTED backend used, reported back on the reply itself.
//   * STT  — POST /api/orgs/:orgId/arturita/transcribe (the hosted leg MOB-5a
//            added for exactly this). Live — but only once a key is configured.
//   * Wake — NOT available in Expo Go. The toggle renders and says so.
//
// The rule here is: never render a chip that claims a capability this client does
// not have. A "🔒 Local Whisper" chip on a phone would be a lie about where the
// operator's audio goes — which is the one thing a voice UI must not get wrong.

/**
 * The wake word. Ported from `web/app/dashboard/cockpit/voicePanel.logic.ts` and
 * pinned to it by `voice.test.ts` — the label the operator reads must be the word
 * the system actually listens for, on both clients.
 */
export const WAKE_WORD = 'arturita'

// ─── Capture (speech → text) ─────────────────────────────────────────────────

/**
 * How the phone can capture speech right now.
 *
 *   'hosted'         — record locally, POST the clip to the backend's transcribe
 *                      route, get a transcript. The only real path on a handset.
 *   'unconfigured'   — the route is there but no STT key is set on the deployment
 *                      (or in Cockpit → Secrets), so it answers 503 not_configured.
 *                      Distinct from 'none' on purpose: this one the OPERATOR can
 *                      fix, and the UI should say how rather than just greying out.
 *   'none'           — this build can't record at all (no expo-av on the host).
 */
export type CaptureEngine = 'hosted' | 'unconfigured' | 'none'

/**
 * The capture chip's label — the phone's peer of the web's `sttEngineLabel`.
 *
 * DELIBERATELY NOT the web's strings. The web can say "🔒 Local Whisper (free,
 * on-device)" because on the desk it IS on-device. Here the clip leaves the
 * handset for the org's backend, so the chip says "hosted" — same shape (icon +
 * label), truthful subject. Feeds `reactorChips({ captureLabel })`, whose empty
 * string renders the web's own "voice off · type".
 */
export function captureLabel(engine: CaptureEngine): string {
  switch (engine) {
    case 'hosted': return 'hosted Whisper'
    case 'unconfigured': return 'voice not configured'
    default: return ''
  }
}

/** Resolve the capture engine from what this host and deployment actually offer. */
export function resolveCaptureEngine(input: {
  /** expo-av loaded (i.e. we can record at all). */
  recorderAvailable: boolean
  /** false once the backend has answered 503 not_configured. */
  sttConfigured: boolean
}): CaptureEngine {
  if (!input.recorderAvailable) return 'none'
  return input.sttConfigured ? 'hosted' : 'unconfigured'
}

/** The push-to-talk button's label — mirrors the web's three states verbatim. */
export function talkButtonLabel(input: { listening: boolean; transcribing: boolean }): string {
  if (input.transcribing) return '◐ Transcribing…'
  if (input.listening) return '■ Stop'
  return '🎙 Push to talk'
}

/** Push-to-talk is dead weight unless we can both record and transcribe. */
export function canPushToTalk(engine: CaptureEngine): boolean {
  return engine === 'hosted'
}

// ─── What to say when a leg fails ────────────────────────────────────────────

export interface VoiceNotice { tone: 'warn' | 'info'; text: string }

/**
 * Turn a transcribe failure into something the operator can act on — and flag
 * whether it means "not configured" so the caller can latch the chip.
 *
 * The backend's codes are the contract (backend/src/routes/arturita-stt.ts):
 * 503 not_configured · 504 timeout · 413 too_large · 400 empty_audio · 502 other.
 * We key off the CODE, not the prose, so a reworded backend message can't turn
 * this into a wrong diagnosis.
 */
export function describeTranscribeFailure(code: string | null | undefined): {
  notice: VoiceNotice
  unconfigured: boolean
} {
  switch (code) {
    case 'not_configured':
      return {
        // Names the fix, and says plainly that typing still works — a voice
        // button that greys out with no reason reads as a broken app.
        notice: {
          tone: 'warn',
          text: 'Voice input isn’t configured on this deployment yet — an OPENAI_API_KEY has to be set on the backend (Fly secrets, or Cockpit → Secrets) before speech can be transcribed. You can type below meanwhile.',
        },
        unconfigured: true,
      }
    case 'timeout':
      return { notice: { tone: 'warn', text: 'Transcribing that took too long — try a shorter clip, or type below.' }, unconfigured: false }
    case 'too_large':
      return { notice: { tone: 'warn', text: 'That clip was too long to send — try a shorter one, or type below.' }, unconfigured: false }
    case 'empty_audio':
      return { notice: { tone: 'info', text: 'Didn’t catch that — try again, or type your message below.' }, unconfigured: false }
    case 'unsupported_type':
      return { notice: { tone: 'warn', text: 'This phone recorded audio the backend can’t read. Please type below and tell us — that’s a bug worth knowing about.' }, unconfigured: false }
    default:
      return { notice: { tone: 'warn', text: 'Couldn’t transcribe that — type below, or try again in a moment.' }, unconfigured: false }
  }
}

/** Pull the backend's `code` out of an api() Error without trusting its prose. */
export function sttErrorCode(message: string | null | undefined): string | null {
  const m = String(message ?? '')
  for (const code of ['not_configured', 'timeout', 'too_large', 'empty_audio', 'unsupported_type']) {
    if (m.includes(code)) return code
  }
  // The api() helper folds the body's `error` into the message and drops `code`;
  // the 503's prose is the one we still want to catch, since it is the case the
  // operator can actually fix.
  if (/HTTP 503/.test(m)) return 'not_configured'
  if (/HTTP 504/.test(m)) return 'timeout'
  if (/HTTP 413/.test(m)) return 'too_large'
  return null
}

// ─── Wake word — rendered, and honest about needing a dev build ──────────────

/**
 * Why the wake-word toggle can't do anything in Expo Go.
 *
 * Continuous listening needs a native always-on recogniser
 * (`@react-native-voice/voice` or an equivalent), which is NOT in Expo Go's
 * bundled module set — it needs an EAS dev build. We render the control (so the
 * desktop's arrangement is mirrored and the operator can see the capability is
 * planned) but keep it OFF and say why. A toggle that flips and silently never
 * listens would be worse than no toggle at all.
 */
export const WAKE_WORD_DEV_BUILD_NOTE =
  `Wake word “${WAKE_WORD}” needs a dev build — Expo Go has no always-on recogniser, so this stays off here. Push to talk works.`

/** Wake word is never live in Expo Go; a dev build is the only way to earn it. */
export function wakeWordAvailable(input: { devBuild: boolean }): boolean {
  return input.devBuild
}

// ─── Provenance: what the LLM chip may claim ─────────────────────────────────

/**
 * Read a reply's provenance for the reactor's LLM chip — feeds
 * `provenanceChip({ local })` in ../reactor.
 *
 * The web resolves this by PROBING Ollama on 127.0.0.1 and streaming from it in
 * the browser, so "🔒 local" there means "on this very machine". The phone can
 * make no such claim: it never runs a model, and 127.0.0.1 is the handset's own
 * loopback, not the desk's. So the only truthful source is the hosted backend's
 * report of what actually answered — which rides back on the reply itself.
 *
 * We claim `local` ONLY when the backend names a local runtime AND a model. An
 * unknown provider is cloud: the chip's job is to tell the operator where their
 * words went, and guessing "local" would be the one wrong answer that matters.
 */
export function replyProvenance(
  reply: { provider?: string | null; model?: string | null } | null | undefined,
): { model: string } | null {
  const provider = String(reply?.provider ?? '').trim().toLowerCase()
  const model = String(reply?.model ?? '').trim()
  if (!model) return null
  const isLocal = provider === 'ollama' || provider === 'local' || provider.startsWith('local')
  return isLocal ? { model } : null
}

// ─── Recording format ────────────────────────────────────────────────────────

/**
 * The mime we tell the backend a clip is. iOS records m4a/aac via expo-av's
 * HIGH_QUALITY preset, and `audio/m4a` is in the route's ACCEPTED_AUDIO_MIMES —
 * the 415 branch is the one failure the operator could do nothing about, so the
 * client must not guess here.
 */
export const RECORDING_MIME = 'audio/m4a'
export const RECORDING_FILENAME = 'speech.m4a'
