// Arturita J2 — free-first pipeline config (PURE).
//
// Generalizes the S1 `local|provider` voice-config model + the F1 LLM fallback
// chain to ALL THREE Jarvis layers (LLM · STT · TTS). Each layer is an ordered
// chain of entries; each entry names an engine/provider + a `mode` (local vs
// provider) for the S1 privacy rule. Defaults are free/self-hosted-first. The
// operator edits the chains from the Config panel; they persist in
// `org.deployConfig` under the keys below. Fallback selection reuses the F1
// circuit breaker at call time — this module only PARSES + RESOLVES (no DB,
// no network, no breaker state). See docs/PRD-jarvis-tab.md §2 + DECISIONS S7.

import { ChainLink, parseFallbackChain } from './llm-fallback'

export type PipelineLayer = 'llm' | 'stt' | 'tts'
export type LayerMode = 'local' | 'provider'

export interface LlmEntry { provider: string; model: string; mode: LayerMode }
export interface SttEntry { engine: string; model?: string; mode: LayerMode }
export interface TtsEntry { engine: string; voice?: string; mode: LayerMode }

/** deployConfig keys holding each layer's ordered chain (JSON array). */
export const PIPELINE_KEYS: Record<PipelineLayer, string> = {
  llm: 'arturita_llm_chain',
  stt: 'arturita_stt_chain',
  tts: 'arturita_tts_chain',
}

// ─── Free-first defaults (this machine: Apple M4/16GB, Ollama installed) ──────

export const DEFAULT_LLM_CHAIN: LlmEntry[] = [
  { provider: 'ollama', model: 'llama3.2:3b', mode: 'local' },   // primary — free, on-device, fast
  { provider: 'ollama', model: 'qwen3:8b',    mode: 'local' },   // heavier local reasoning
  { provider: 'groq',   model: 'llama-3.3-70b-versatile', mode: 'provider' }, // free-tier cloud
  { provider: 'google', model: 'gemini-2.5-flash',        mode: 'provider' }, // free-tier cloud
]

export const DEFAULT_STT_CHAIN: SttEntry[] = [
  { engine: 'whisper_cpp', model: 'small', mode: 'local' },      // primary — self-hosted, Metal on Apple Silicon
  { engine: 'web_speech',                  mode: 'provider' },   // zero-install; audio leaves device (non-sensitive)
]

export const DEFAULT_TTS_CHAIN: TtsEntry[] = [
  { engine: 'piper',        voice: 'en_US-amy', mode: 'local' }, // primary — fast, self-hosted
  { engine: 'chatterbox',   voice: 'arturita',  mode: 'local' }, // quality local (Resemble AI, MIT)
  { engine: 'speech_synth',                     mode: 'local' }, // browser TTS — on-device OS voices
  { engine: 'chatterbox_nvidia', voice: 'arturita', mode: 'provider' }, // opt-in hosted (B1 NVIDIA key)
]

// Known local (keyless / on-device) engines + providers — used for the privacy
// classification default and the usable-hop check.
const LOCAL_LLM_PROVIDERS = new Set(['ollama'])
const LOCAL_STT_ENGINES = new Set(['whisper_cpp', 'faster_whisper', 'whisper'])
const LOCAL_TTS_ENGINES = new Set(['piper', 'chatterbox', 'kokoro', 'styletts2', 'coqui', 'speech_synth'])

function normMode(raw: unknown, isLocalDefault: boolean): LayerMode {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'local' || s === 'provider') return s
  return isLocalDefault ? 'local' : 'provider'
}

function readArray(deployConfig: Record<string, unknown> | null | undefined, key: string): any[] | null {
  const raw = (deployConfig ?? {})[key]
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : null } catch { return null }
  }
  return null
}

// ─── Parsers (per layer): configured chain, else free-first default ──────────

export function parseLlmChain(deployConfig: Record<string, unknown> | null | undefined): LlmEntry[] {
  const arr = readArray(deployConfig, PIPELINE_KEYS.llm)
  if (arr) {
    const entries = arr
      .map((e: any): LlmEntry | null => {
        const provider = String(e?.provider ?? '').trim()
        const model = String(e?.model ?? '').trim()
        if (!provider || !model) return null
        return { provider, model, mode: normMode(e?.mode, LOCAL_LLM_PROVIDERS.has(provider)) }
      })
      .filter((e): e is LlmEntry => e !== null)
    if (entries.length) return entries
  }
  // Back-compat: fall through to the shipped F1 `arturita_fallback_chain` if set.
  const legacy = parseFallbackChain(deployConfig as any)
  if (legacy.length) return legacy.map(l => ({ provider: l.provider, model: l.model, mode: LOCAL_LLM_PROVIDERS.has(l.provider) ? 'local' : 'provider' as LayerMode }))
  return DEFAULT_LLM_CHAIN
}

export function parseSttChain(deployConfig: Record<string, unknown> | null | undefined): SttEntry[] {
  const arr = readArray(deployConfig, PIPELINE_KEYS.stt)
  if (arr) {
    const entries = arr
      .map((e: any): SttEntry | null => {
        const engine = String(e?.engine ?? '').trim()
        if (!engine) return null
        const model = e?.model != null ? String(e.model).trim() : undefined
        return { engine, ...(model ? { model } : {}), mode: normMode(e?.mode, LOCAL_STT_ENGINES.has(engine)) }
      })
      .filter((e): e is SttEntry => e !== null)
    if (entries.length) return entries
  }
  return DEFAULT_STT_CHAIN
}

export function parseTtsChain(deployConfig: Record<string, unknown> | null | undefined): TtsEntry[] {
  const arr = readArray(deployConfig, PIPELINE_KEYS.tts)
  if (arr) {
    const entries = arr
      .map((e: any): TtsEntry | null => {
        const engine = String(e?.engine ?? '').trim()
        if (!engine) return null
        const voice = e?.voice != null ? String(e.voice).trim() : undefined
        return { engine, ...(voice ? { voice } : {}), mode: normMode(e?.mode, LOCAL_TTS_ENGINES.has(engine)) }
      })
      .filter((e): e is TtsEntry => e !== null)
    if (entries.length) return entries
  }
  return DEFAULT_TTS_CHAIN
}

// ─── Privacy filter (S1): a sensitive context drops every `provider` entry ────

export function filterForContext<T extends { mode: LayerMode }>(entries: T[], opts: { sensitive: boolean }): T[] {
  if (!opts.sensitive) return entries
  return entries.filter(e => e.mode === 'local')
}

// ─── LLM chain → usable ChainLink[] for streamLLMWithFallback ─────────────────

/**
 * Turn the configured LLM chain into an ordered list of ChainLinks that are
 * actually runnable here, and guarantee a final working hop so the live path
 * never breaks:
 *  - keep local/ollama entries (keyless / on-device);
 *  - keep a `provider` entry only when a key is available (`keyAvailable`);
 *  - always append `guaranteed` (the agent's own provider/model, which uses the
 *    backend env key) as the last resort if not already present.
 * On Fly (no local Ollama, no free-tier keys) this collapses to just the
 * guaranteed hop; on a self-hosted/local backend the Ollama hops run first.
 * Pure — `keyAvailable(provider)` is injected by the caller.
 */
export function usableLlmChain(input: {
  entries: LlmEntry[]
  keyAvailable: (provider: string) => boolean
  guaranteed?: ChainLink | null
}): ChainLink[] {
  const out: ChainLink[] = []
  const seen = new Set<string>()
  const push = (l: ChainLink) => { const k = `${l.provider}/${l.model}`; if (!seen.has(k)) { seen.add(k); out.push(l) } }
  for (const e of input.entries) {
    const keyless = e.mode === 'local' || LOCAL_LLM_PROVIDERS.has(e.provider)
    if (keyless || input.keyAvailable(e.provider)) push({ provider: e.provider, model: e.model })
  }
  if (input.guaranteed && input.guaranteed.provider && input.guaranteed.model) push(input.guaranteed)
  return out
}

// ─── Resolve everything for a context (for the tab / a GET) ───────────────────

export interface ResolvedPipeline {
  llm: LlmEntry[]
  stt: SttEntry[]
  tts: TtsEntry[]
}

export function resolvePipeline(
  deployConfig: Record<string, unknown> | null | undefined,
  opts: { sensitive?: boolean } = {},
): ResolvedPipeline {
  const sensitive = !!opts.sensitive
  return {
    llm: filterForContext(parseLlmChain(deployConfig), { sensitive }),
    stt: filterForContext(parseSttChain(deployConfig), { sensitive }),
    tts: filterForContext(parseTtsChain(deployConfig), { sensitive }),
  }
}

// ─── Validate a PUT body (Config-panel save) ──────────────────────────────────

export interface PipelineValidation { ok: boolean; errors: string[]; value: Partial<Record<PipelineLayer, any[]>> }

/** Validate + normalize an incoming pipeline config. Only known-shaped layers
 *  are accepted; each entry must have its required id field. Returns the cleaned
 *  arrays ready to merge into deployConfig. Pure. */
export function validatePipelineConfig(body: any): PipelineValidation {
  const errors: string[] = []
  const value: Partial<Record<PipelineLayer, any[]>> = {}
  const checkArray = (layer: PipelineLayer): any[] | undefined => {
    const v = body?.[PIPELINE_KEYS[layer]] ?? body?.[layer]
    if (v == null) return undefined
    if (!Array.isArray(v)) { errors.push(`${layer}: must be an array`); return undefined }
    return v
  }
  const llm = checkArray('llm')
  if (llm) {
    const clean = llm.filter((e: any) => e?.provider && e?.model).map((e: any) => ({ provider: String(e.provider), model: String(e.model), mode: normMode(e.mode, LOCAL_LLM_PROVIDERS.has(String(e.provider))) }))
    if (clean.length !== llm.length) errors.push('llm: every entry needs provider + model')
    if (clean.length) value.llm = clean
  }
  const stt = checkArray('stt')
  if (stt) {
    const clean = stt.filter((e: any) => e?.engine).map((e: any) => ({ engine: String(e.engine), ...(e.model ? { model: String(e.model) } : {}), mode: normMode(e.mode, LOCAL_STT_ENGINES.has(String(e.engine))) }))
    if (clean.length !== stt.length) errors.push('stt: every entry needs an engine')
    if (clean.length) value.stt = clean
  }
  const tts = checkArray('tts')
  if (tts) {
    const clean = tts.filter((e: any) => e?.engine).map((e: any) => ({ engine: String(e.engine), ...(e.voice ? { voice: String(e.voice) } : {}), mode: normMode(e.mode, LOCAL_TTS_ENGINES.has(String(e.engine))) }))
    if (clean.length !== tts.length) errors.push('tts: every entry needs an engine')
    if (clean.length) value.tts = clean
  }
  return { ok: errors.length === 0, errors, value }
}
