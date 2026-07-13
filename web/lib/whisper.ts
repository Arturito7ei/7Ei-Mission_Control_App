// Arturita STT — browser-direct local Whisper client.
//
// Mirrors lib/ollama.ts: the operator's browser can reach a local whisper HTTP
// bridge (http://localhost:8790 — the @7ei/arturita-stt daemon) even though the
// Fly backend cannot. Push-to-talk captures mic audio with MediaRecorder and
// POSTs the blob here; the bridge returns { text }. This is what gives FREE,
// on-device voice input in Brave, whose built-in Web Speech STT is blocked.
//
// Same trust model as local Ollama (browser → 127.0.0.1). The bridge must allow
// this app's origin (ARTURITA_STT_ORIGINS, like OLLAMA_ORIGINS).
//
// Pure parsing/shaping is exported + unit-tested; the fetch/record shell is not.

export const WHISPER_DEFAULT_URL = 'http://localhost:8790'

/** Engine ids (from the STT pipeline chain) that mean "local whisper bridge". */
const WHISPER_ENGINES = new Set(['whisper_cpp', 'faster_whisper', 'whisper'])

export function isWhisperEngine(engine: string | null | undefined): boolean {
  return WHISPER_ENGINES.has(String(engine ?? '').trim().toLowerCase())
}

/** Resolve the transcription endpoint for a base URL. whisper.cpp + our bridge
 *  serve `/inference`; OpenAI-compatible servers use `/v1/audio/transcriptions`.
 *  Our bridge accepts BOTH, so `/inference` is the default. Pure. */
export function whisperEndpoint(baseUrl: string, style: 'inference' | 'openai' = 'inference'): string {
  const base = String(baseUrl || WHISPER_DEFAULT_URL).replace(/\/$/, '')
  return style === 'openai' ? `${base}/v1/audio/transcriptions` : `${base}/inference`
}

/** Extract the transcript from a whisper response. whisper.cpp + OpenAI both
 *  return `{ text }`; some servers return `{ transcription: [{ text }] }` or a
 *  segment array. Returns a trimmed string (possibly ''). Never throws. Pure. */
export function parseWhisperResponse(json: any): string {
  if (json == null) return ''
  if (typeof json === 'string') return json.trim()
  if (typeof json.text === 'string') return json.text.trim()
  const segs = Array.isArray(json.transcription) ? json.transcription
    : Array.isArray(json.segments) ? json.segments : null
  if (segs) return segs.map((s: any) => (typeof s === 'string' ? s : s?.text ?? '')).join(' ').replace(/\s+/g, ' ').trim()
  return ''
}

/** Pick a MediaRecorder mime type the browser supports, preferring opus. Returns
 *  '' when none is explicitly supported (let the browser choose its default).
 *  `isSupported` is injected so this stays pure/testable. */
export function pickRecorderMimeType(isSupported: (mime: string) => boolean): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4']
  for (const c of candidates) { if (isSupported(c)) return c }
  return ''
}

/** Probe whether the local whisper bridge is reachable (GET /health). Returns
 *  true when it answers (and CORS permits it), false otherwise. Best-effort. */
export async function probeWhisper(baseUrl: string = WHISPER_DEFAULT_URL, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch { return false }
}

/**
 * Transcribe a captured audio blob via the local whisper bridge. Returns the
 * transcript text. Throws on a network/HTTP failure so the caller can surface a
 * specific status (and keep typed input working). Impure.
 */
export async function transcribeWithWhisper(input: {
  baseUrl?: string
  blob: Blob
  language?: string
  style?: 'inference' | 'openai'
  signal?: AbortSignal
}): Promise<string> {
  const url = whisperEndpoint(input.baseUrl ?? WHISPER_DEFAULT_URL, input.style)
  const form = new FormData()
  // Field name `file` matches whisper.cpp + OpenAI. Keep the multipart request
  // header-free (no custom headers) so it stays a CORS "simple request".
  form.append('file', input.blob, 'audio.webm')
  if (input.language) form.append('language', input.language)
  if (input.style === 'openai') form.append('model', 'whisper-1')
  const res = await fetch(url, { method: 'POST', body: form, signal: input.signal })
  if (!res.ok) throw new Error(`whisper ${res.status}`)
  const json = await res.json().catch(() => null)
  return parseWhisperResponse(json)
}
