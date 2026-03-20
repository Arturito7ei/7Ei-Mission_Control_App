// ─── Multi-Model LLM Router ──────────────────────────────────────────────────────
// Unified streaming interface across Anthropic, OpenAI, Google Gemini
// Provider is resolved from agent.llmProvider + agent.llmModel

import Anthropic from '@anthropic-ai/sdk'

export interface LLMMessage { role: 'user' | 'assistant'; content: string }
export interface LLMStreamOpts {
  provider: string
  model: string
  system: string
  messages: LLMMessage[]
  maxTokens?: number
  onToken: (chunk: string) => void
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
}

export function calcCost(model: string, input: number, output: number): number {
  const rates = COST_RATES[model]
  if (!rates) return 0
  return input * rates.input + output * rates.output
}

export const MODEL_CATALOGUE = {
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
}

// ─ Anthropic stream ────────────────────────────────────────────────────
async function streamAnthropic(opts: LLMStreamOpts): Promise<LLMResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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

// ─ OpenAI stream ─────────────────────────────────────────────────────
async function streamOpenAI(opts: LLMStreamOpts): Promise<LLMResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

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

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`)

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
  return { output, model: opts.model, provider: 'openai', usage: { inputTokens, outputTokens } }
}

// ─ Google Gemini stream ─────────────────────────────────────────────
async function streamGemini(opts: LLMStreamOpts): Promise<LLMResult> {
  const apiKey = process.env.GEMINI_API_KEY
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
  switch (opts.provider) {
    case 'openai':  return streamOpenAI(opts)
    case 'google':  return streamGemini(opts)
    default:        return streamAnthropic(opts)
  }
}
