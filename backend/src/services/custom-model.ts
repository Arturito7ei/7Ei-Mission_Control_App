// Arturita J2+ — custom operator-defined LLM insertion (PURE + creds resolver).
//
// Lets the operator add an arbitrary model instead of picking from the preset
// list: a display name, an OpenAI-compatible base URL (or a keyless local
// base-URL / Ollama-style endpoint), a model id, and an OPTIONAL API key. The
// key is stored ENCRYPTED in the org's deployConfig (`<slug>_api_key_enc`, AES-
// 256-GCM via secrets.ts) — never on the chain entry, never returned, never
// logged. The base URL is stored as `<slug>_base_url`. The entry then slots into
// the same LLM fallback chain (`arturita_llm_chain`) as any built-in, so the F1
// circuit breaker + failover treat it identically (see arturita-pipeline.ts +
// llm-fallback-runtime.ts).
//
// This module is pure except `resolveLlmCreds` (which decrypts). Everything the
// route decides — slugging, validation, the deployConfig mutation, masking — is
// a pure function so it's unit-tested without a DB or network.

import { encrypt, decrypt, maskValue } from './secrets'
import { LlmEntry, PIPELINE_KEYS, parseLlmChain } from './arturita-pipeline'

// Reserved provider ids handled by dedicated code paths / default base URLs in
// llm-router.ts — a custom entry must not clobber these keys in deployConfig.
export const RESERVED_PROVIDERS = new Set([
  'anthropic', 'openai', 'google', 'gemini', 'groq', 'ollama',
  'deepseek', 'moonshot', 'qwen', 'minimax', 'custom',
])

export interface CustomModelInput {
  /** human display name, e.g. "Together Llama 3.3". */
  label?: string
  /** optional explicit provider slug; else derived from the label. */
  provider?: string
  /** the model id string sent to the endpoint, e.g. "meta-llama/Llama-3.3-70B". */
  model?: string
  /** OpenAI-compatible base URL, e.g. "https://api.together.xyz/v1". */
  baseUrl?: string
  /** optional API key (stored encrypted). Omit for a keyless local endpoint. */
  apiKey?: string
  /** 'provider' (default, hosted) or 'local' (on-device / keyless base URL). */
  mode?: 'local' | 'provider'
}

/** Slugify a label/provider into a safe, stable deployConfig key segment. Custom
 *  slugs are namespaced so they can never overwrite a built-in provider's key. */
export function slugifyProvider(raw: string): string {
  const base = String(raw ?? '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  if (!base) return 'custom_model'
  // Namespace anything that would collide with a built-in provider key.
  return RESERVED_PROVIDERS.has(base) ? `custom_${base}` : base
}

/** Accept only http(s) URLs (localhost included) — rejects javascript:, data:, … */
export function isValidBaseUrl(raw: string | null | undefined): boolean {
  const s = String(raw ?? '').trim()
  if (!s) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

export interface CustomModelValidation {
  ok: boolean
  errors: string[]
  slug?: string
  /** the chain entry to persist (no key material). */
  entry?: LlmEntry
}

/**
 * Validate + normalize a custom-model form submission into a chain entry + slug.
 * Requires a model id and a valid base URL; label is optional (defaults to the
 * provider·model). `mode` defaults to 'provider' (hosted). Pure — no key handling
 * here beyond confirming its presence is optional. */
export function validateCustomModel(input: CustomModelInput): CustomModelValidation {
  const errors: string[] = []
  const label = String(input?.label ?? '').trim()
  const model = String(input?.model ?? '').trim()
  const baseUrl = String(input?.baseUrl ?? '').trim()
  const mode: 'local' | 'provider' = input?.mode === 'local' ? 'local' : 'provider'

  if (!model) errors.push('model id is required')
  if (!baseUrl) errors.push('base URL is required')
  else if (!isValidBaseUrl(baseUrl)) errors.push('base URL must be a valid http(s) URL')

  const slugSource = String(input?.provider ?? '').trim() || label || model
  const slug = slugifyProvider(slugSource)
  if (errors.length) return { ok: false, errors }

  const entry: LlmEntry = {
    provider: slug,
    model,
    mode,
    label: label || `${slug} · ${model}`,
    baseUrl,
    custom: true,
  }
  return { ok: true, errors: [], slug, entry }
}

// ─── deployConfig mutation (pure) ─────────────────────────────────────────────

export const baseUrlKey = (slug: string) => `${slug}_base_url`
export const encKeyKey = (slug: string) => `${slug}_api_key_enc`
export const plainKeyKey = (slug: string) => `${slug}_api_key`

/**
 * Where an AGENT's custom models live.
 *
 * Deliberately NOT `arturita_llm_chain`. That chain is Arturita's ordered
 * FAILOVER list — appending to it would mean defining a custom model for one
 * agent silently changes what Arturita falls back to. The two are different
 * things that happen to share a credential format, so they get different keys
 * and the same plumbing: `<slug>_base_url` + `<slug>_api_key_enc`, resolved by
 * `resolveLlmCreds` either way. `available-models` reads both, so a model added
 * from either door is selectable from either.
 */
export const CATALOG_KEY = 'custom_models'

/** Read a catalog of custom entries from deployConfig. Tolerates junk rows. */
export function parseCustomModels(
  deployConfig: Record<string, unknown> | null | undefined,
  key: string = CATALOG_KEY,
): LlmEntry[] {
  const raw = (deployConfig ?? {})[key]
  if (!Array.isArray(raw)) return []
  return raw
    .map((e: any): LlmEntry | null => {
      const provider = String(e?.provider ?? '').trim()
      const model = String(e?.model ?? '').trim()
      if (!provider || !model) return null
      return {
        provider, model,
        mode: e?.mode === 'local' ? 'local' : 'provider',
        label: String(e?.label ?? `${provider} · ${model}`),
        baseUrl: typeof e?.baseUrl === 'string' ? e.baseUrl : undefined,
        custom: true,
      }
    })
    .filter((e): e is LlmEntry => e !== null)
}

export interface CustomModelPersist {
  /** the new deployConfig (base URL + encrypted key merged, chain appended). */
  deployConfig: Record<string, unknown>
  /** the LLM chain after the upsert. */
  chain: LlmEntry[]
  /** masked key for the response, or null when keyless. */
  maskedKey: string | null
}

/**
 * Produce the updated deployConfig for adding/updating a custom model: stores the
 * base URL, stores the API key ENCRYPTED (or removes any stale key when keyless),
 * and upserts the entry into `arturita_llm_chain` (replacing a same-slug+model
 * entry, else appended). The `encryptFn` is injected so this stays testable and
 * doesn't require the real key at unit time. Pure given the injected encryptor.
 */
export function applyCustomModel(input: {
  deployConfig: Record<string, unknown> | null | undefined
  slug: string
  entry: LlmEntry
  apiKey?: string | null
  encryptFn?: (plain: string) => string
  /** Which list to upsert into. Defaults to Arturita's LLM chain (the #207 door);
   *  the agent Configuration tab passes CATALOG_KEY so it cannot disturb it. */
  catalogKey?: string
}): CustomModelPersist {
  const enc = input.encryptFn ?? encrypt
  const cfg: Record<string, unknown> = { ...((input.deployConfig ?? {}) as Record<string, unknown>) }
  cfg[baseUrlKey(input.slug)] = input.entry.baseUrl

  const key = String(input.apiKey ?? '').trim()
  if (key) {
    cfg[encKeyKey(input.slug)] = enc(key)
    delete cfg[plainKeyKey(input.slug)] // never keep plaintext
  } else {
    // keyless (re-)save: drop any previously stored key for this slug
    delete cfg[encKeyKey(input.slug)]
    delete cfg[plainKeyKey(input.slug)]
  }

  const catalogKey = input.catalogKey ?? PIPELINE_KEYS.llm
  const read = catalogKey === PIPELINE_KEYS.llm ? parseLlmChain(cfg) : parseCustomModels(cfg, catalogKey)
  const existing = read.filter(e => !(e.provider === input.slug && e.model === input.entry.model))
  const chain = [...existing, input.entry]
  cfg[catalogKey] = chain

  return { deployConfig: cfg, chain, maskedKey: key ? maskValue(key) : null }
}

/** Remove a custom model (catalog entry + its base URL + stored key). Pure. */
export function removeCustomModel(input: {
  deployConfig: Record<string, unknown> | null | undefined
  slug: string
  catalogKey?: string
}): { deployConfig: Record<string, unknown>; chain: LlmEntry[] } {
  const cfg: Record<string, unknown> = { ...((input.deployConfig ?? {}) as Record<string, unknown>) }
  delete cfg[baseUrlKey(input.slug)]
  delete cfg[encKeyKey(input.slug)]
  delete cfg[plainKeyKey(input.slug)]
  const catalogKey = input.catalogKey ?? PIPELINE_KEYS.llm
  const read = catalogKey === PIPELINE_KEYS.llm ? parseLlmChain(cfg) : parseCustomModels(cfg, catalogKey)
  const chain = read.filter(e => e.provider !== input.slug)
  cfg[catalogKey] = chain
  return { deployConfig: cfg, chain }
}

// ─── Endpoint reachability probe (network) ───────────────────────────────────

export interface ProbeResult { ok: boolean; status: number | null; detail: string }

/**
 * Reachability + auth probe for an OpenAI-compatible endpoint. Tries GET /models
 * (cheapest liveness + auth check), then falls back to a 1-token POST
 * /chat/completions for servers that don't expose /models. Never logs the key.
 *
 * Shared by the Arturita custom-model route (#207) and the agent Configuration
 * tab's "Test connection" — one probe, one set of error strings.
 */
export async function probeEndpoint(
  input: { baseUrl: string; apiKey?: string; model: string },
  timeoutMs = 6000,
): Promise<ProbeResult> {
  const base = input.baseUrl.replace(/\/$/, '')
  const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.apiKey) authHeaders.Authorization = `Bearer ${input.apiKey}`

  const withTimeout = async (fn: (signal: AbortSignal) => Promise<Response>): Promise<Response> => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try { return await fn(ctrl.signal) } finally { clearTimeout(t) }
  }

  try {
    const res = await withTimeout(s => fetch(`${base}/models`, { headers: authHeaders, signal: s }))
    if (res.ok) return { ok: true, status: res.status, detail: 'reachable (GET /models)' }
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: 'authentication failed — check the API key' }
    // 404/405 → server may not expose /models; fall through to a chat probe.
  } catch (e: any) {
    if (e?.name !== 'AbortError') return { ok: false, status: null, detail: `unreachable — ${e?.message ?? 'network error'}` }
  }

  try {
    const res = await withTimeout(s => fetch(`${base}/chat/completions`, {
      method: 'POST', headers: authHeaders, signal: s,
      body: JSON.stringify({ model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }))
    if (res.ok) return { ok: true, status: res.status, detail: 'reachable (chat/completions)' }
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: 'authentication failed — check the API key' }
    if (res.status === 404) return { ok: false, status: res.status, detail: 'model or endpoint not found — check the base URL + model id' }
    return { ok: false, status: res.status, detail: `endpoint returned ${res.status}` }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, status: null, detail: `timed out after ${timeoutMs}ms` }
    return { ok: false, status: null, detail: `unreachable — ${e?.message ?? 'network error'}` }
  }
}

// ─── Credential resolution (decrypts) ─────────────────────────────────────────

/**
 * Resolve `{ orgApiKey, baseURL }` for a provider slug from deployConfig,
 * transparently handling BOTH a legacy plaintext `<slug>_api_key` and the
 * encrypted `<slug>_api_key_enc`. Used by the converse route's per-hop credential
 * lookup so custom models authenticate like any built-in. Never logs the key.
 */
export function resolveLlmCreds(
  deployConfig: Record<string, unknown> | null | undefined,
  provider: string,
  decryptFn: (blob: string) => string = decrypt,
): { orgApiKey?: string; baseURL?: string } {
  const cfg = (deployConfig ?? {}) as Record<string, unknown>
  const plain = cfg[plainKeyKey(provider)]
  const encd = cfg[encKeyKey(provider)]
  let orgApiKey: string | undefined
  if (typeof plain === 'string' && plain) orgApiKey = plain
  else if (typeof encd === 'string' && encd) { try { orgApiKey = decryptFn(encd) } catch { orgApiKey = undefined } }
  const baseRaw = cfg[baseUrlKey(provider)]
  const baseURL = typeof baseRaw === 'string' && baseRaw ? baseRaw : undefined
  return { ...(orgApiKey ? { orgApiKey } : {}), ...(baseURL ? { baseURL } : {}) }
}

/** True when a key (plaintext or encrypted) is stored for the provider slug. */
export function hasStoredKey(deployConfig: Record<string, unknown> | null | undefined, provider: string): boolean {
  const cfg = (deployConfig ?? {}) as Record<string, unknown>
  return !!(cfg[plainKeyKey(provider)] || cfg[encKeyKey(provider)])
}

/**
 * Build the per-provider "is a usable key available?" predicate shared by the
 * converse route AND the talk-path LLM-reachability probe — a key is available
 * when the org stored one (plaintext or encrypted) OR the backend env holds one.
 * One source of truth so the answer path and the self-test can never drift.
 * (Presence only — a stored-but-invalid key still reads as available here; the
 * live probe in `/arturita/llm-status` is what catches an invalid key.)
 */
export function keyAvailableFor(
  deployConfig: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): (provider: string) => boolean {
  return (p: string) =>
    hasStoredKey(deployConfig, p) ||
    (p === 'anthropic' && !!env.ANTHROPIC_API_KEY) ||
    (p === 'openai' && !!env.OPENAI_API_KEY) ||
    (p === 'google' && !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY)) ||
    (p === 'groq' && !!env.GROQ_API_KEY)
}
