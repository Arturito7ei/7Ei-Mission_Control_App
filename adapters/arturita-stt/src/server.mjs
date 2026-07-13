// Arturita STT bridge — the daemon. A localhost-only HTTP service the OPERATOR'S
// BROWSER calls directly (same trust model as local Ollama) to turn captured mic
// audio into text with a local whisper — FREE, on-device, no cloud key. This is
// what makes voice input work in Brave, whose built-in Web Speech STT is blocked.
//
//   - binds 127.0.0.1 only (never a public interface);
//   - CORS: allows the app origin(s) so the browser fetch succeeds (mirrors
//     OLLAMA_ORIGINS). Default '*' for zero-config localhost; set
//     ARTURITA_STT_ORIGINS=https://app.7ei.ai to lock it down;
//   - POST /inference  (whisper.cpp-compatible)  → { text }
//   - POST /v1/audio/transcriptions (OpenAI-compatible) → { text }
//   - GET  /health → { ok, service, engine, model }.
//
// Zero-dep: node built-ins only. Multipart parsing + transcription are separate,
// unit-tested modules.

import http from 'node:http'
import { parseMultipart } from './multipart.mjs'
import { transcribeBuffer } from './transcribe.mjs'

const PORT = Number(process.env.ARTURITA_STT_PORT || 8790)
const MODEL = process.env.ARTURITA_STT_MODEL || 'base'
const ENGINE = process.env.ARTURITA_STT_WHISPER_BIN || 'whisper'
// Comma-separated allowlist, or '*' (default). Mirrors OLLAMA_ORIGINS.
const ORIGINS = (process.env.ARTURITA_STT_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean)
const MAX_BYTES = Number(process.env.ARTURITA_STT_MAX_BYTES || 25 * 1024 * 1024) // 25 MB

/** The Access-Control-Allow-Origin value to echo for a given request origin, or
 *  null when the origin isn't allowed. '*' in the allowlist permits anything. Pure. */
export function allowOrigin(origin, allow = ORIGINS) {
  if (allow.includes('*')) return origin || '*'
  if (origin && allow.includes(origin)) return origin
  return null
}

function cors(res, origin) {
  const ao = allowOrigin(origin)
  if (ao) {
    res.setHeader('Access-Control-Allow-Origin', ao)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
}

function send(res, code, body, origin) {
  cors(res, origin)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readRaw(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > maxBytes) throw new Error('audio too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const origin = req.headers['origin']
    if (req.method === 'OPTIONS') { cors(res, origin); res.writeHead(204); return res.end() }

    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'arturita-stt', engine: ENGINE, model: MODEL }, origin)
    }

    if (req.method === 'POST' && (req.url === '/inference' || req.url === '/v1/audio/transcriptions')) {
      try {
        const ctype = req.headers['content-type'] || ''
        if (!/multipart\/form-data/i.test(ctype)) return send(res, 400, { ok: false, error: 'expected multipart/form-data with a file part' }, origin)
        const raw = await readRaw(req, MAX_BYTES)
        const { files, fields } = parseMultipart(raw, ctype)
        const file = files[0]
        if (!file || !file.data?.length) return send(res, 400, { ok: false, error: 'no audio file part' }, origin)
        const text = await transcribeBuffer(file.data, { mime: file.contentType, model: MODEL, language: fields.language })
        return send(res, 200, { text }, origin) // { text } — whisper.cpp + OpenAI shape
      } catch (e) {
        return send(res, 500, { ok: false, error: `stt failed: ${e.message}` }, origin)
      }
    }

    return send(res, 404, { ok: false, error: 'not found' }, origin)
  })
}

// Start when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`[arturita-stt] listening on http://127.0.0.1:${PORT} (engine=${ENGINE}, model=${MODEL})`)
    console.log(`[arturita-stt] CORS origins: ${ORIGINS.join(', ')}${ORIGINS.includes('*') ? '  (set ARTURITA_STT_ORIGINS=https://app.7ei.ai to lock down)' : ''}`)
  })
}
