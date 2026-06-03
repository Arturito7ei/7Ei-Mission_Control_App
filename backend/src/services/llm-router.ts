// ─── Multi-Model LLM Router ──────────────────────────────────────────────────────
// Unified streaming interface across Anthropic, Google Gemini, and any
// OpenAI-compatible provider (OpenAI, DeepSeek, Kimi/Moonshot, Qwen, MiniMax,
// Ollama, or a fully custom endpoint).
// Provider is resolved from agent.llmProvider + agent.llmModel; per-org API key
// and base URL come from org.deployConfig ('<provider>_api_key' / '<provider>_base_url').

import Anthropic from '@anthropic-ai/sdk'

export interface LLMMessage { role: 'user' | 'assistant'; content: string }
export interface LLMStreamOpts {
  provider: string
  model: string
  system: string
  messages: LLMMessage[]
  maxTokens?: number
  onToken: (chunk: string) => void
  orgApiKey?: string
  baseURL?: string   // override base URL for OpenAI-compatible / custom providers
}

export interface LLMUsage { inputTokens: number; outputTokens: number }

export interface LLMResult {
  output: string
  usage: LLMUsage
  model: string
  provider: string
}

export const COST_RATES: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-4-6':           { input: 0.000015,   output: 0.000075 },
  'claude-sonnet-4-20250514':  { input: 0.000003,   output: 0.000015 },
  'claude-haiku-4-5-20251001': { input: 0.00000025, output: 0.00000125 },
  // OpenAI
  'gpt-4o':                    { input: 0.000005,   output: 0.000015 },
  'gpt-4o-mini':               { input: 0.00000015, output: 0.0000006 },
  'gpt-4-turbo':               { input: 0.00001,    output: 0.00003 },
  // Google
  'gemini-2.0-flash':          { input: 0.000000075, output: 0.0000003 },
  'gemini-1.5-pro':            { input: 0.00000125,  output: 0.000005 },
  'gemini-1.5-flash':          { input: 0.000000075, output: 0.0000003 },
  // DeepSeek (OpenAI-compatible)
  'deepseek-chat':             { input: 0.00000027,  output: 0.0000011 },
  'deepseek-reasoner':         { input: 0.00000055,  output: 0.00000219 },
  // Kimi / Moonshot (OpenAI-compatible)
  'kimi-k2-0905-preview':      { input: 0.0000006,   output: 0.0000025 },
  'moonshot-v1-32k':           { input: 0.0000012,   output: 0.0000012 },
  // Qwen / Alibaba DashScope (OpenAI-compatible)
  'qwen-max':                  { input: 0.0000016,   output: 0.0000064 },
  'qwen-plus':                 { input: 0.0000004,   output: 0.0000012 },
  'qwen-turbo':                { input: 0.00000005,  output: 0.0000002 },
  // MiniMax (OpenAI-compatible)
  'MiniMax-Text-01':           { input: 0.0000002,   output: 0.0000011 },
  // Ollama / self-hosted models run locally — no per-token cost
  'llama3.3':                  { input: 0,           output: 0 },
  'qwen2.5':                   { input: 0,           output: 0 },
  'mistral':                   { input: 0,           output: 0 },
}

export function calcCost(model: string, input: number, output: number): number {
  const rates = COST_RATES[model]
  if (!rates) return 0
  return input * rates.input + output * rates.output
}

export const MODEL_CATALOGUE: Record<string, { id: string; label: string; tier: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-20250514',  label: 'Claude Sonnet 4',   tier: 'balanced' },
    { id: 'claude-opus-4-6',           label: 'Claude Opus 4',     tier: 'power' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  tier: 'fast' },
  ],
  openai: [
    { id: 'gpt-4o',      label: 'GPT-4o',      tier: 'power' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini', tier: 'fast' },
  ],
  google: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tier: 'fast' },
    { id: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro',   tier: 'power' },
  ],
  deepseek: [
    { id: 'deepseek-chat',     label: 'DeepSeek V3',  tier: 'balanced' },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1',  tier: 'power' },
  ],
  moonshot: [
    { id: 'kimi-k2-0905-preview', label: 'Kimi K2',          tier: 'power' },
    { id: 'moonshot-v1-32k',      label: 'Moonshot v1 32k',  tier: 'balanced' },
  ],
  qwen: [
    { id: 'qwen-max',   label: 'Qwen Max',   tier: 'power' },
    { id: 'qwen-plus',  label: 'Qwen Plus',  tier: 'balanced' },
    { id: 'qwen-turbo', label: 'Qwen Turbo', tier: 'fast' },
  ],
  minimax: [
    { id: 'MiniMax-Text-01', label: 'MiniMax Text 01', tier: 'balanced' },
  ],
  ollama: [
    { id: 'llama3.3', label: 'Llama 3.3 (local)', tier: 'balanced' },
    { id: 'qwen2.5',  label: 'Qwen 2.5 (local)',  tier: 'balanced' },
    { id: 'mistral',  label: 'Mistral (local)',   tier: 'fast' },
  ],
}

// OpenAI-compatible providers: same chat-completions wire format, different host.
// A per-org base URL (deployConfig['<provider>_base_url']) overrides these defaults,
// which is also how the fully-custom 'custom' provider is driven.
export const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  openai:   'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  qwen:     'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  minimax:  'https://api.minimax.io/v1',
  ollama:   'http://localhost:11434/v1',
}

// ─ Anthropic stream ────────────────────────────────────────────────────
async function streamAnthropic(opts: LLMStreamOpts): Promise<LLMResult> {
  const client = new Anthropic({ apiKey: opts.orgApiKey ?? process.env.ANTHROPIC_API_KEY })
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: opts.messages,
  })
  let output = ''
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      output += event.delta.text
      opts.onToken(event.delta.text)
    }
  }
  const final = await stream.finalMessage()
  return {
    output, model: opts.model, provider: 'anthropic',
    usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
  }
}

// ─ OpenAI-compatible stream (OpenAI, DeepSeek, Kimi, Qwen, MiniMax, Ollama, custom) ─
// Resolves the base URL in priority order: explicit opts.baseURL → per-provider
// default → OpenAI. Ollama needs no key; every other provider requires one.
export function resolveBaseURL(opts: LLMStreamOpts): string {
  return opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS[opts.provider] ?? OPENAI_COMPATIBLE_BASE_URLS.openai
}

async function streamOpenAICompatible(opts: LLMStreamOpts, provider: string): Promise<LLMResult> {
  const baseURL = resolveBaseURL(opts)
  // OpenAI keeps its env fallback; other hosted providers rely on the per-org key.
  const apiKey = opts.orgApiKey ?? (provider === 'openai' ? process.env.OPENAI_API_KEY : undefined)
  if (!apiKey && provider !== 'ollama') throw new Error(`No API key configured for provider "${provider}"`)

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: opts.system },
      ...opts.messages,
    ],
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${provider} error ${res.status}`)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let inputTokens = 0; let outputTokens = 0

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '))
    for (const line of lines) {
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const chunk = JSON.parse(data)
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) { output += delta; opts.onToken(delta) }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0
          outputTokens = chunk.usage.completion_tokens ?? 0
        }
      } catch {}
    }
  }
  return { output, model: opts.model, provider, usage: { inputTokens, outputTokens } }
}

// ─ Google Gemini stream ─────────────────────────────────────────────
async function streamGemini(opts: LLMStreamOpts): Promise<LLMResult> {
  const apiKey = opts.orgApiKey ?? process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const contents = opts.messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const body = {
    system_instruction: { parts: [{ text: opts.system }] },
    contents,
    generationConfig: { maxOutputTokens: opts.maxTokens ?? 4096 },
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:streamGenerateContent?alt=sse&key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Gemini error ${res.status}`)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let inputTokens = 0; let outputTokens = 0

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '))
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line.slice(6))
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) { output += text; opts.onToken(text) }
        const usage = chunk.usageMetadata
        if (usage) {
          inputTokens = usage.promptTokenCount ?? 0
          outputTokens = usage.candidatesTokenCount ?? 0
        }
      } catch {}
    }
  }
  return { output, model: opts.model, provider: 'google', usage: { inputTokens, outputTokens } }
}

// ─ Public router ──────────────────────────────────────────────────────
export async function streamLLM(opts: LLMStreamOpts): Promise<LLMResult> {
  const { withSpan } = await import('./telemetry')
  return withSpan('llm.call', { 'llm.provider': opts.provider, 'llm.model': opts.model }, async () => {
    switch (opts.provider) {
      case 'google':    return streamGemini(opts)
      case 'anthropic': return streamAnthropic(opts)
      case 'openai':
      case 'deepseek':
      case 'moonshot':
      case 'qwen':
      case 'minimax':
      case 'ollama':
        return streamOpenAICompatible(opts, opts.provider)
      case 'custom':
        if (!opts.baseURL) throw new Error('custom provider requires a baseURL')
        return streamOpenAICompatible(opts, 'custom')
      default:
        // Unknown provider with an explicit baseURL → treat as OpenAI-compatible custom.
        if (opts.baseURL) return streamOpenAICompatible(opts, opts.provider)
        return streamAnthropic(opts)
    }
  })
}
