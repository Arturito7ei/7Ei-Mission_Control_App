// MOB-5a — speech-to-text PROVIDER adapter layer (audio-in → transcript-out).
//
// The counterpart to `voice-provider.ts` (TTS): a thin, swappable adapter behind
// a stable interface. `arturita-voice.ts` has always taken a TRANSCRIPT and said
// so in its own header ("produced client-side or by a future STT adapter") — this
// module IS that adapter, and `routes/arturita-stt.ts` is its HTTP front door.
// Until now the only transcribers were the browser's Web Speech API and
// `adapters/arturita-stt` on 127.0.0.1:8790 — neither reachable from a phone.
// See docs/DESIGN-mobile-parity.md §3.
//
// THE KEY SIMPLIFICATION: the local daemon deliberately exposes an
// OpenAI-COMPATIBLE `POST /v1/audio/transcriptions` (adapters/arturita-stt/src/
// server.mjs:12), which is byte-for-byte the shape OpenAI's hosted Whisper takes.
// So there is ONE network adapter here, not two — cloud and local differ only by
// base URL and whether a key is attached. Adding a third OpenAI-compatible
// engine (Groq, a self-hosted whisper.cpp server) is a config change, not code.
//
// Design guarantees (mirroring voice-provider.ts):
//  - `transcribeAudio` NEVER throws and never returns a stack to the caller: it
//    returns a discriminated result the route maps to a clean status code.
//  - The API key is a PARAMETER, never read from module state and never logged.
//  - Audio is not persisted (AUDIO_RETENTION, PRD §7.8) and neither audio nor
//    transcript is ever logged here — the transcript is user content.

/** Provider actually used for a transcription, or why none was. */
export type SttProviderId = 'cloud_openai' | 'local_whisper'

/** Operator setting — `MC_STT_PROVIDER`. `auto` prefers cloud when a key is
 *  present (the only thing that can work on Fly), else local. `off` hard-disables. */
export type SttSetting = 'auto' | 'cloud' | 'local' | 'off'

export interface SttCapabilities {
  /** a cloud key resolved at call time (org secret store or env) */
  cloudKeyPresent: boolean
  /** a local daemon base URL is configured (only reachable when self-hosted) */
  localConfigured: boolean
}

export interface SttSelection {
  provider: SttProviderId | null
  reason: string
}

// ─── Limits ──────────────────────────────────────────────────────────────────
//
// The global @fastify/multipart limit is 25 MB (index.ts) because DOCUMENT
// uploads need it. A push-to-talk clip does not: 10 MB of AAC is ~10 minutes of
// speech, far beyond any voice command, so the route clamps to its own smaller
// per-call limit rather than inheriting the document one.
//
// NOTE on duration: we bound clips by BYTES and by a wall-clock provider TIMEOUT,
// not by decoded duration. Reading true duration out of an m4a/AAC container
// means parsing MP4 atoms (or shelling out to ffprobe) — a real dependency for a
// guard the byte cap already gives us. This is a deliberate, documented choice.
// A non-numeric override must not disable the guard it configures: Number('abc')
// is NaN, and `bytes > NaN` is false, so a typo'd MC_STT_MAX_BYTES would accept
// clips of ANY size — the cap failing open. Non-positive is equally wrong (a
// negative cap rejects everything; AbortSignal.timeout(-1) throws). Anything not
// a positive finite number falls back to the default.
export function positiveFiniteEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const STT_MAX_BYTES = positiveFiniteEnv(process.env.MC_STT_MAX_BYTES, 10 * 1024 * 1024)
export const STT_TIMEOUT_MS = positiveFiniteEnv(process.env.MC_STT_TIMEOUT_MS, 60_000)

/** Audio container types we accept. Covers what `expo-av` produces on iOS
 *  (m4a/aac) and Android (mp4/3gp), what MediaRecorder produces in a browser
 *  (webm/ogg), plus wav/mp3. Whisper loads all of these through ffmpeg. */
export const ACCEPTED_AUDIO_MIMES: readonly string[] = [
  'audio/m4a', 'audio/x-m4a', 'audio/mp4', 'audio/aac', 'audio/aacp',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3',
  'audio/3gpp', 'audio/amr',
]

/** True when a multipart part's content type is an audio container we accept.
 *  Tolerates parameters (`audio/webm;codecs=opus`) and case. Pure.
 *
 *  Deliberately STRICT about the `audio/` family: `application/octet-stream` is
 *  rejected even though expo-av sometimes sends it, because accepting it would
 *  make the content-type gate meaningless (any file would pass). The phone client
 *  (MOB-5c) must set a real audio type — documented in the endpoint contract. */
export function isAcceptedAudioMime(mime: string | null | undefined): boolean {
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase()
  return ACCEPTED_AUDIO_MIMES.includes(base)
}

/** File extension for an audio content type — only used to give the provider a
 *  friendly filename (both OpenAI and ffmpeg sniff the real container). Pure.
 *  Mirrors `adapters/arturita-stt/src/transcribe.mjs:extForMime`. */
export function extForAudioMime(mime: string | null | undefined): string {
  const m = String(mime ?? '').toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('wav')) return 'wav'
  if (m.includes('3gpp')) return '3gp'
  if (m.includes('amr')) return 'amr'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  return 'm4a'
}

/** Collapse a provider transcript to a single trimmed line. Pure.
 *  Mirrors `adapters/arturita-stt/src/transcribe.mjs:cleanTranscript`. */
export function cleanTranscript(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/** Parse the `MC_STT_PROVIDER` operator setting. Unknown/absent → 'auto'. Pure. */
export function parseSttSetting(raw: unknown): SttSetting {
  const s = String(raw ?? '').trim().toLowerCase()
  return s === 'cloud' || s === 'local' || s === 'off' ? s : 'auto'
}

/**
 * Choose the STT provider for a call from the operator setting + what is actually
 * usable right now. Pure — the whole deployment story is decided (and tested) here.
 *
 * `auto` is what makes ONE build serve both deployments: on Fly only the cloud
 * leg can ever work (127.0.0.1 is the Fly VM itself, not the operator's Mac), so
 * auto resolves to cloud when a key exists; self-hosted with no key falls to the
 * local daemon. An explicit `cloud`/`local` never silently falls back to the
 * other — a request that can't run the provider the operator PINNED is an error,
 * not a quiet privacy downgrade (sending audio to a cloud the operator pinned
 * away from would be exactly that).
 */
export function selectSttProvider(input: { setting: SttSetting; caps: SttCapabilities }): SttSelection {
  const { setting, caps } = input
  if (setting === 'off') return { provider: null, reason: 'STT is disabled on this deployment (MC_STT_PROVIDER=off)' }

  if (setting === 'cloud') {
    return caps.cloudKeyPresent
      ? { provider: 'cloud_openai', reason: 'cloud STT pinned by config' }
      : { provider: null, reason: 'cloud STT pinned by config but no API key is configured' }
  }
  if (setting === 'local') {
    return caps.localConfigured
      ? { provider: 'local_whisper', reason: 'local STT pinned by config' }
      : { provider: null, reason: 'local STT pinned by config but no local daemon URL is configured' }
  }

  // auto — cloud first (the only leg that can work hosted), then local.
  if (caps.cloudKeyPresent) return { provider: 'cloud_openai', reason: 'auto — cloud key present' }
  if (caps.localConfigured) return { provider: 'local_whisper', reason: 'auto — no cloud key, using the local whisper daemon' }
  return { provider: null, reason: 'no STT provider is configured on this deployment' }
}

// ─── The network adapter ─────────────────────────────────────────────────────

// Both base URLs INCLUDE the `/v1` prefix — the adapter appends only
// `/audio/transcriptions`. This matters for the local leg: the daemon matches
// `req.url === '/v1/audio/transcriptions'` EXACTLY (adapters/arturita-stt/src/
// server.mjs:73), so a base URL without `/v1` 404s every local transcription.
export const OPENAI_STT_URL = 'https://api.openai.com/v1'
export const LOCAL_STT_URL = 'http://127.0.0.1:8790/v1'
export const CLOUD_STT_MODEL = 'whisper-1'

type FetchLike = (url: string, init: any) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<any>
  text: () => Promise<string>
}>

/**
 * POST audio to an OpenAI-compatible `/v1/audio/transcriptions` endpoint and
 * return the transcript. The ONE place a key is used. Throws on transport or
 * non-2xx (the orchestrator below catches and classifies). Impure.
 *
 * Serves BOTH legs: hosted OpenAI (key, cloud base URL) and the local daemon
 * (no key, 127.0.0.1 base URL) — see the header note.
 */
export async function transcribeOpenAICompatible(input: {
  audio: Buffer
  mime: string
  baseUrl: string
  apiKey?: string | null
  model?: string
  language?: string | null
  timeoutMs?: number
  fetchImpl?: FetchLike
}): Promise<{ text: string }> {
  const f = (input.fetchImpl ?? (globalThis.fetch as any)) as FetchLike
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(input.audio)], { type: input.mime }),
    `clip.${extForAudioMime(input.mime)}`,
  )
  form.append('model', input.model ?? CLOUD_STT_MODEL)
  form.append('response_format', 'json')
  if (input.language) form.append('language', input.language)

  const headers: Record<string, string> = {}
  // The local daemon is keyless (it is 127.0.0.1-bound); only attach when present.
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`

  const res = await f(`${input.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(input.timeoutMs ?? STT_TIMEOUT_MS),
  })
  if (!res.ok) {
    // The upstream body rides on the thrown Error for a caller that wants to
    // inspect it. `transcribeAudio` deliberately DROPS it: it can echo request
    // content back, so it reaches neither the client nor a log sink.
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch { /* ignore */ }
    const err: any = new Error(`stt provider error ${res.status}${detail ? `: ${detail}` : ''}`)
    err.status = res.status
    throw err
  }
  const body = await res.json()
  return { text: cleanTranscript(body?.text) }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export type SttFailureCode = 'not_configured' | 'provider_error' | 'timeout'

/** Flat rather than a discriminated union ON PURPOSE: the backend compiles with
 *  `strict: false` (tsconfig.json), so `strictNullChecks` is off and TS cannot
 *  narrow a `{ok:true}|{ok:false}` union — every field read would error. This
 *  mirrors `voice-provider.ts:TtsResult`, which is flat for the same reason. */
export interface SttResult {
  ok: boolean
  /** the transcript on success; '' on failure. */
  transcript: string
  /** the provider used/attempted; null when none was selectable. */
  provider: SttProviderId | null
  /** why this provider was chosen (or not) — for the server log, not the client. */
  note: string
  /** failure class on `ok:false`; null on success. */
  code: SttFailureCode | null
  /** a CLIENT-SAFE message on `ok:false` ('' on success) — never an upstream body. */
  message: string
}

/**
 * Transcribe an audio buffer with the configured provider. NEVER throws — every
 * failure comes back as a typed, client-safe result the route maps to a status.
 * This is what keeps a provider outage from surfacing as a 500 with a stack.
 *
 * `apiKey` and the URLs are parameters (never module state) so the whole matrix
 * is unit-testable with a fake fetch and no environment at all.
 */
export async function transcribeAudio(input: {
  audio: Buffer
  mime: string
  setting: SttSetting
  apiKey?: string | null
  cloudUrl?: string
  localUrl?: string | null
  cloudModel?: string
  localModel?: string
  language?: string | null
  timeoutMs?: number
  fetchImpl?: FetchLike
}): Promise<SttResult> {
  const localUrl = input.localUrl ?? null
  const pick = selectSttProvider({
    setting: input.setting,
    caps: { cloudKeyPresent: !!input.apiKey, localConfigured: !!localUrl },
  })
  if (!pick.provider) {
    return { ok: false, transcript: '', provider: null, note: pick.reason, code: 'not_configured', message: pick.reason }
  }

  const isCloud = pick.provider === 'cloud_openai'
  try {
    const out = await transcribeOpenAICompatible({
      audio: input.audio,
      mime: input.mime,
      baseUrl: isCloud ? (input.cloudUrl ?? OPENAI_STT_URL) : (localUrl as string),
      apiKey: isCloud ? input.apiKey : null,
      // The local daemon takes its model from its own env; `whisper-1` is the
      // OpenAI-compatible placeholder it ignores.
      model: isCloud ? (input.cloudModel ?? CLOUD_STT_MODEL) : (input.localModel ?? CLOUD_STT_MODEL),
      language: input.language ?? null,
      timeoutMs: input.timeoutMs,
      fetchImpl: input.fetchImpl,
    })
    return { ok: true, transcript: out.text, provider: pick.provider, note: pick.reason, code: null, message: '' }
  } catch (e: any) {
    // The upstream error text is deliberately DROPPED here rather than passed
    // through: it can echo request content back, and it is a stack surface. The
    // route logs the class server-side; the client gets a fixed sentence.
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return timedOut
      ? { ok: false, transcript: '', provider: pick.provider, note: pick.reason, code: 'timeout', message: 'Transcription timed out — try a shorter clip.' }
      : { ok: false, transcript: '', provider: pick.provider, note: pick.reason, code: 'provider_error', message: 'Transcription failed upstream.' }
  }
}
