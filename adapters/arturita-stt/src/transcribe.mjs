// Arturita STT bridge — transcription runner. Wraps the locally-installed
// `whisper` CLI (openai-whisper, already on the operator's Mac alongside ffmpeg)
// so the browser gets FREE, on-device speech-to-text with no cloud key. The CLI
// loads webm/ogg/wav/mp4 via ffmpeg, so we hand it the raw MediaRecorder blob.
//
// Zero-dep: node built-ins only (spawn + fs + os). The arg-builder is pure and
// unit-tested; the spawn/IO shell is thin.

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** File extension for a captured-audio content type (best-effort; ffmpeg sniffs
 *  the real container regardless, so this is only a friendly filename). Pure. */
export function extForMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('wav')) return 'wav'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  return 'webm'
}

/**
 * Build the `whisper` CLI argv for a given audio path + output dir. Pure so the
 * shape (model, language, txt output, no-fp16 for CPU/Metal stability) is
 * unit-tested without spawning. `language:'auto'` omits the flag (auto-detect).
 */
export function buildWhisperArgs({ audioPath, outDir, model = 'base', language = 'en' }) {
  const args = [audioPath, '--model', model, '--output_format', 'txt', '--output_dir', outDir, '--fp16', 'False', '--verbose', 'False']
  if (language && language !== 'auto') args.push('--language', language)
  return args
}

/** Collapse whisper's txt output to a single trimmed line. Pure. */
export function cleanTranscript(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim()
}

/**
 * Transcribe an audio buffer with the local whisper CLI. Returns the transcript
 * text (possibly ''). Throws if the CLI is missing or exits non-zero. Impure.
 */
export async function transcribeBuffer(data, opts = {}) {
  const bin = opts.bin || process.env.ARTURITA_STT_WHISPER_BIN || 'whisper'
  const model = opts.model || process.env.ARTURITA_STT_MODEL || 'base'
  const language = opts.language || process.env.ARTURITA_STT_LANGUAGE || 'en'
  const ext = extForMime(opts.mime)
  const dir = await mkdtemp(join(tmpdir(), 'arturita-stt-'))
  const audioPath = join(dir, `clip.${ext}`)
  try {
    await writeFile(audioPath, data)
    const args = buildWhisperArgs({ audioPath, outDir: dir, model, language })
    await runCli(bin, args, opts.timeoutMs ?? 120000)
    // whisper writes "<basename>.txt" into outDir; find the produced .txt.
    const produced = (await readdir(dir)).find(f => f.endsWith('.txt'))
    if (!produced) return ''
    return cleanTranscript(await readFile(join(dir, produced), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runCli(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('whisper timed out')) } }, timeoutMs)
    child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192) })
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`cannot run "${bin}": ${err.message}`)) } })
    child.on('close', code => {
      if (done) return
      done = true; clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`whisper exited ${code}: ${stderr.trim().slice(-500) || 'no output'}`))
    })
  })
}
