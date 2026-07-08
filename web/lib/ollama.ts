// Arturita J-prod — browser-direct local Ollama client.
//
// The Assistant tab runs in the operator's browser on their Mac, which CAN reach
// a local Ollama (http://localhost:11434) even though the Fly backend cannot.
// So the free-first LLM primary runs by streaming DIRECTLY from the browser to
// Ollama — real token streaming, on-device, $0 — and gracefully falls back to
// the backend F1 cloud chain when Ollama isn't reachable.
//
// Requirements for browser-direct to work (flag to the operator):
//  - Ollama running with the model pulled (e.g. `ollama pull llama3.2:3b`).
//  - CORS: `OLLAMA_ORIGINS` must include the app origin, e.g.
//    `OLLAMA_ORIGINS=https://app.7ei.ai` (or `*`) then restart Ollama. Without
//    it the browser call is blocked and the tab falls back to the cloud chain.
//
// Pure parsing/shaping is exported + unit-tested; the fetch/stream shell is not.

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }

/** Prepend the system prompt as a system message for Ollama's /api/chat. Pure. */
export function buildOllamaMessages(system: string | null | undefined, messages: ChatMsg[]): ChatMsg[] {
  const sys = String(system ?? '').trim()
  const base: ChatMsg[] = sys ? [{ role: 'system', content: sys }] : []
  return base.concat(messages.filter(m => m && typeof m.content === 'string'))
}

export interface OllamaLine { token: string; done: boolean }

/** Parse one NDJSON line of Ollama's /api/chat stream. Never throws — a blank or
 *  unparseable line yields no token and done:false. Pure. */
export function parseOllamaChatLine(line: string): OllamaLine {
  const s = String(line ?? '').trim()
  if (!s) return { token: '', done: false }
  try {
    const j = JSON.parse(s)
    const token = typeof j?.message?.content === 'string' ? j.message.content : (typeof j?.response === 'string' ? j.response : '')
    return { token, done: !!j?.done }
  } catch { return { token: '', done: false } }
}

/** Probe whether a local Ollama is reachable + has a usable model. Returns the
 *  installed model tags, or null when unreachable/blocked (CORS). Best-effort. */
export async function probeOllama(baseUrl: string = DEFAULT_OLLAMA_URL, timeoutMs = 1500): Promise<string[] | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const j = await res.json().catch(() => null)
    const models = Array.isArray(j?.models) ? j.models.map((m: any) => String(m?.name ?? '')).filter(Boolean) : []
    return models
  } catch { return null }
}

/**
 * Stream a chat completion directly from a local Ollama, calling onToken for each
 * chunk. Returns the full text. Throws on a network/HTTP failure so the caller
 * can fall back to the backend cloud chain.
 */
export async function streamOllamaChat(input: {
  baseUrl?: string
  model: string
  system?: string | null
  messages: ChatMsg[]
  onToken: (t: string) => void
  signal?: AbortSignal
}): Promise<string> {
  const base = (input.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '')
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: input.model, messages: buildOllamaMessages(input.system, input.messages), stream: true }),
    signal: input.signal,
  })
  if (!res.ok || !res.body) throw new Error(`ollama ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      const parsed = parseOllamaChatLine(line)
      if (parsed.token) { full += parsed.token; input.onToken(parsed.token) }
    }
  }
  const tail = parseOllamaChatLine(buf)
  if (tail.token) { full += tail.token; input.onToken(tail.token) }
  return full
}
