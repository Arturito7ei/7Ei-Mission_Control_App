// Arturita J2 — pure logic for the Config-panel pipeline editor (no DOM/React).
// Immutable list ops + presets + labels for the three free-first chains
// (LLM/STT/TTS). Mirrors backend `arturita-pipeline.ts` shapes. Unit-tested.

export type LayerMode = 'local' | 'provider'
export type PipelineLayer = 'llm' | 'stt' | 'tts'

// Custom operator-defined models carry a display `label` + their own `baseUrl`
// and are flagged `custom` (the API key lives encrypted server-side, never here).
export interface LlmEntry { provider: string; model: string; mode: LayerMode; label?: string; baseUrl?: string; custom?: boolean }
export interface SttEntry { engine: string; model?: string; mode: LayerMode }
export interface TtsEntry { engine: string; voice?: string; mode: LayerMode }
export type Entry = LlmEntry | SttEntry | TtsEntry

// Known options for the "add" dropdowns (free-first first). Not exhaustive — the
// operator can add anything the backend accepts; these are the ergonomic picks.
export const PRESETS: Record<PipelineLayer, Entry[]> = {
  llm: [
    { provider: 'ollama', model: 'llama3.2:3b', mode: 'local' },
    { provider: 'ollama', model: 'qwen3:8b', mode: 'local' },
    { provider: 'ollama', model: 'gemma3:4b', mode: 'local' },
    { provider: 'ollama', model: 'qwen2.5:14b', mode: 'local' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', mode: 'provider' },
    { provider: 'google', model: 'gemini-2.5-flash', mode: 'provider' },
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514', mode: 'provider' },
  ],
  stt: [
    { engine: 'whisper_cpp', model: 'small', mode: 'local' },
    { engine: 'whisper_cpp', model: 'base', mode: 'local' },
    { engine: 'faster_whisper', model: 'small', mode: 'local' },
    { engine: 'web_speech', mode: 'provider' },
  ],
  tts: [
    { engine: 'piper', voice: 'en_US-amy', mode: 'local' },
    { engine: 'chatterbox', voice: 'arturita', mode: 'local' },
    { engine: 'speech_synth', mode: 'local' },
    { engine: 'chatterbox_nvidia', voice: 'arturita', mode: 'provider' },
  ],
}

/** Human label for an entry (provider/model or engine[·voice/model]). */
export function entryLabel(layer: PipelineLayer, e: Entry): string {
  if (layer === 'llm') { const x = e as LlmEntry; return x.custom && x.label ? `${x.label} · ${x.model}` : `${x.provider} · ${x.model}` }
  const x = e as SttEntry & TtsEntry
  const detail = x.model ?? x.voice
  return detail ? `${x.engine} · ${detail}` : x.engine
}

/** Stable-ish identity for dedupe/keys. */
export function entryKey(layer: PipelineLayer, e: Entry): string {
  return `${layer}:${entryLabel(layer, e)}:${e.mode}`
}

// ─── Immutable list ops ──────────────────────────────────────────────────────

export function moveEntry<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir
  if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return arr
  const next = arr.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export function removeAt<T>(arr: T[], i: number): T[] {
  if (i < 0 || i >= arr.length) return arr
  return arr.slice(0, i).concat(arr.slice(i + 1))
}

/** Append an entry unless an identical one (same label+mode) is already present. */
export function appendEntry(layer: PipelineLayer, arr: Entry[], e: Entry): Entry[] {
  const k = entryKey(layer, e)
  if (arr.some(x => entryKey(layer, x) === k)) return arr
  return arr.concat([e])
}

export function toggleMode(e: Entry): Entry {
  return { ...e, mode: e.mode === 'local' ? 'provider' : 'local' } as Entry
}
