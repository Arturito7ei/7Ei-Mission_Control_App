// Arturita B1 / S1 — voice PROVIDER adapter layer (STT/TTS).
//
// Same philosophy as `llm-router`: a thin, swappable adapter behind a stable
// interface. `voice-config.ts` decides WHICH provider (local | provider) for a
// given context; this module CALLS it. The interim `provider`-mode TTS is
// Chatterbox via the NVIDIA API — the key comes from the encrypted secret store
// (NVIDIA_API_KEY), is injected here at call time, and NEVER logged or persisted.
//
// Design guarantees:
//  - Never throws out of `synthesizeSpeech`: any provider error degrades to
//    text-only (a provider outage must not drop the reply — PRD §7.6).
//  - Audio is returned to the caller for immediate playback and NOT persisted
//    (AUDIO_RETENTION = discard-after-transcription — PRD §7.8).
//  - The API key is a parameter, never read from module state or logged.

import { selectVoiceProvider, VoiceMode, VoiceProviderId, VoiceCapabilities } from './voice-config'

/** Default NVIDIA endpoint for the Chatterbox TTS model. Overridable per call so
 *  the exact route can be set at go-live without a code change. */
export const NVIDIA_CHATTERBOX_URL = 'https://integrate.api.nvidia.com/v1/audio/speech'

export interface TtsResult {
  provider: VoiceProviderId
  /** audio mime type when audio was produced, else null (text-only). */
  mime: string | null
  /** base64 audio for immediate playback; null when text-only. */
  audioBase64: string | null
  /** the text that was (or would be) spoken — always present. */
  text: string
  /** true when we couldn't use the requested provider and fell back. */
  degraded: boolean
  note: string
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }>

/** Call NVIDIA Chatterbox TTS. Isolated network adapter — the only place the key
 *  is used. Returns base64 audio or throws (caller degrades). NOT unit-tested for
 *  a real call (like the llm-router providers); the orchestration around it is. */
export async function chatterboxNvidiaSynthesize(input: {
  text: string
  apiKey: string
  fetchImpl?: FetchLike
  url?: string
  voice?: string
}): Promise<{ audioBase64: string; mime: string }> {
  const f = (input.fetchImpl ?? (globalThis.fetch as any)) as FetchLike
  const res = await f(input.url ?? NVIDIA_CHATTERBOX_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'chatterbox', input: input.text, voice: input.voice ?? 'arturita', response_format: 'mp3' }),
  })
  if (!res.ok) throw new Error(`chatterbox/nvidia error ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return { audioBase64: buf.toString('base64'), mime: 'audio/mpeg' }
}

/** Synthesize a spoken reply, choosing the provider by config + capabilities and
 *  degrading to text-only on any failure. Never throws. `localSynthesize` is an
 *  optional host-side local TTS hook (installed engine); absent → local resolves
 *  to text-only. */
export async function synthesizeSpeech(input: {
  text: string
  mode: VoiceMode
  caps: VoiceCapabilities
  apiKey?: string | null
  fetchImpl?: FetchLike
  url?: string
  localSynthesize?: (text: string) => Promise<{ audioBase64: string; mime: string }>
}): Promise<TtsResult> {
  const text = String(input.text ?? '')
  const pick = selectVoiceProvider({ mode: input.mode, caps: input.caps })

  if (pick.provider === 'text_only') {
    return { provider: 'text_only', mime: null, audioBase64: null, text, degraded: pick.degraded, note: pick.reason }
  }

  if (pick.provider === 'chatterbox_nvidia') {
    if (!input.apiKey) {
      return { provider: 'text_only', mime: null, audioBase64: null, text, degraded: true, note: 'no NVIDIA key at call time — text-only' }
    }
    try {
      const out = await chatterboxNvidiaSynthesize({ text, apiKey: input.apiKey, fetchImpl: input.fetchImpl, url: input.url })
      return { provider: 'chatterbox_nvidia', mime: out.mime, audioBase64: out.audioBase64, text, degraded: false, note: pick.reason }
    } catch (e: any) {
      return { provider: 'text_only', mime: null, audioBase64: null, text, degraded: true, note: `provider TTS failed (${String(e?.message ?? e)}) — text-only` }
    }
  }

  // local
  if (input.localSynthesize) {
    try {
      const out = await input.localSynthesize(text)
      return { provider: 'local', mime: out.mime, audioBase64: out.audioBase64, text, degraded: false, note: pick.reason }
    } catch (e: any) {
      return { provider: 'text_only', mime: null, audioBase64: null, text, degraded: true, note: `local TTS failed (${String(e?.message ?? e)}) — text-only` }
    }
  }
  return { provider: 'text_only', mime: null, audioBase64: null, text, degraded: true, note: 'local engine not wired on this host — text-only' }
}
