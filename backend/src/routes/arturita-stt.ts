// MOB-5a — the /arturita/stt endpoint: audio-in → transcript-out. Clerk-secured
// (loopback-secured on the packaged profile), org-scoped like every sibling route.
//
// WHY THIS EXISTS: `arturita-voice.ts` takes a TRANSCRIPT, and its header has
// always pointed at "a future STT adapter" to produce one. The web app filled
// that gap browser-side (Web Speech) or via `adapters/arturita-stt` on
// 127.0.0.1:8790 — a phone can reach NEITHER. This is the missing hosted leg
// that `DESIGN-mobile-expo.md` §6 assumed existed. See docs/DESIGN-mobile-parity.md §3.
//
// Scope: this endpoint ONLY transcribes. It creates no task, runs nothing, and
// has no side effects beyond the provider call — the caller posts the transcript
// on to `POST /arturita/voice` (which gates confidence + routes to the approval
// path) if it wants an action. Splitting it this way keeps the dangerous surface
// exactly where the A2 approval gate already is.
//
// Audio is held in memory for the provider call and never persisted
// (AUDIO_RETENTION, PRD §7.8). Neither audio nor transcript is logged: the
// transcript is USER CONTENT, so it never reaches a log sink at any level.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { decrypt } from '../services/secrets'
import { documentEndpoint } from '../services/openapi'
import {
  transcribeAudio,
  parseSttSetting,
  isAcceptedAudioMime,
  ACCEPTED_AUDIO_MIMES,
  STT_MAX_BYTES,
  STT_TIMEOUT_MS,
  OPENAI_STT_URL,
  LOCAL_STT_URL,
} from '../services/stt-provider'

/** The multipart field the audio clip must arrive in.
 *
 *  `file` — NOT a coin flip. It is what the OpenAI transcription API takes, what
 *  the local daemon's parser expects, and what the EXISTING web client already
 *  sends (`web/lib/whisper.ts:81`). Combined with the `text` key in the response
 *  (read at `whisper.ts:37`), this endpoint is a drop-in for the daemon URL: the
 *  web client can point here by changing a URL, nothing else. That reuse is the
 *  stated goal of the MOB-5a row in docs/DESIGN-mobile-parity.md §6. */
export const STT_AUDIO_FIELD = 'file'

/** Pull a company-scoped secret. Mirrors `arturita-voice.ts:getSecret` exactly —
 *  the same 6-line read the sibling voice route uses for its provider key. */
async function getSecret(orgId: string, key: string): Promise<string | null> {
  const r = await db.query.secrets.findFirst({
    where: and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'company'), eq(schema.secrets.key, key)),
  })
  if (!r) return null
  try { return decrypt(r.valueEncrypted) } catch { return null }
}

/**
 * Resolve the cloud STT key for an org: the encrypted per-org secret store first
 * (Cockpit → Secrets), falling back to the process env. This is the same
 * precedence `llm-router.ts:175` uses (`opts.orgApiKey ?? process.env.…`) — an
 * org that brings its own key overrides the deployment-wide one.
 *
 * A secret-store read that throws must not 500 the endpoint — it degrades to the
 * deployment-wide env key, and `transcribeAudio` turns "still no key" into a
 * clean 503 rather than an exception.
 */
async function resolveCloudKey(orgId: string, log: { warn: (o: any, m: string) => void }): Promise<string | null> {
  let fromStore: string | null = null
  try {
    fromStore = await getSecret(orgId, 'OPENAI_API_KEY')
  } catch (err) {
    log.warn({ orgId }, 'stt: secret store read failed — falling back to env key')
  }
  return fromStore ?? process.env.OPENAI_API_KEY ?? null
}

export async function arturitaSttRoutes(app: FastifyInstance) {
  app.post('/api/orgs/:orgId/arturita/transcribe', async (req, reply) => {
    // orgId comes from the PATH and is already gated: the `secured` scope's
    // clerkAuth/loopbackAuth hook authenticates the caller and its
    // `requireOrgMembership` preHandler proves membership of THIS org before we
    // run. No body/query field may name an org — the session decides, never the caller.
    const { orgId } = req.params as any

    if (!(req as any).isMultipart?.()) {
      return reply.code(415).send({ error: 'Send the clip as multipart/form-data', code: 'not_multipart' })
    }

    // Per-route size clamp. The GLOBAL @fastify/multipart limit is 25 MB for
    // document uploads (index.ts); a voice clip gets a much tighter cap of its own.
    let part: any
    try {
      part = await (req as any).file({ limits: { fileSize: STT_MAX_BYTES, files: 1 } })
    } catch {
      return reply.code(400).send({ error: 'Could not read the upload', code: 'bad_multipart' })
    }
    if (!part) return reply.code(400).send({ error: `No audio uploaded — expected a "${STT_AUDIO_FIELD}" file part`, code: 'no_audio' })
    if (part.fieldname !== STT_AUDIO_FIELD) {
      return reply.code(400).send({ error: `Unexpected field "${part.fieldname}" — expected "${STT_AUDIO_FIELD}"`, code: 'bad_field' })
    }

    const mime: string = part.mimetype ?? ''
    if (!isAcceptedAudioMime(mime)) {
      return reply.code(415).send({
        error: 'Unsupported audio type — send m4a/aac, wav, webm, ogg, mp3 or 3gp',
        code: 'unsupported_type',
        accepted: ACCEPTED_AUDIO_MIMES,
      })
    }

    // toBuffer() throws once the stream crosses the per-call fileSize limit.
    let audio: Buffer
    try {
      audio = await part.toBuffer()
    } catch (err: any) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || err?.code === 'FST_FILES_LIMIT') {
        return reply.code(413).send({ error: `Clip too large — the limit is ${Math.floor(STT_MAX_BYTES / (1024 * 1024))} MB`, code: 'too_large' })
      }
      return reply.code(400).send({ error: 'Could not read the audio upload', code: 'bad_upload' })
    }
    // Belt-and-braces: a truncated stream can surface as a short buffer rather
    // than a throw, and an empty clip is never worth a provider call.
    if (audio.length > STT_MAX_BYTES) {
      return reply.code(413).send({ error: `Clip too large — the limit is ${Math.floor(STT_MAX_BYTES / (1024 * 1024))} MB`, code: 'too_large' })
    }
    if (audio.length === 0) return reply.code(400).send({ error: 'Empty audio clip', code: 'empty_audio' })

    const language = ((req.query as any)?.language as string) || null
    const localUrl = process.env.MC_STT_LOCAL_URL ?? (process.env.MC_STT_PROVIDER === 'local' ? LOCAL_STT_URL : null)

    const result = await transcribeAudio({
      audio,
      mime,
      setting: parseSttSetting(process.env.MC_STT_PROVIDER),
      apiKey: await resolveCloudKey(orgId, req.log),
      cloudUrl: process.env.MC_STT_CLOUD_URL ?? OPENAI_STT_URL,
      localUrl,
      cloudModel: process.env.MC_STT_CLOUD_MODEL,
      language,
      timeoutMs: STT_TIMEOUT_MS,
    })

    if (!result.ok) {
      // Log the CLASS of failure and the provider — never the audio, never a stack.
      req.log.warn({ orgId, code: result.code, provider: result.provider, bytes: audio.length }, 'stt failed')
      const status = result.code === 'not_configured' ? 503 : result.code === 'timeout' ? 504 : 502
      return reply.code(status).send({ error: result.message, code: result.code })
    }

    // The transcript is user content: log the LENGTH, never the text.
    req.log.info({ orgId, provider: result.provider, bytes: audio.length, chars: result.transcript.length }, 'stt ok')
    // `transcript` is the canonical key; `text` is the SAME value under the key
    // the daemon/OpenAI return and the web client already reads
    // (web/lib/whisper.ts:37), which is what makes this a drop-in for that URL.
    return { transcript: result.transcript, text: result.transcript, provider: result.provider, bytes: audio.length }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/arturita/transcribe', {
    summary: `Speech-to-text: multipart "${STT_AUDIO_FIELD}" audio clip (m4a/aac/wav/webm/ogg/mp3/3gp, ≤${Math.floor(STT_MAX_BYTES / (1024 * 1024))}MB) → { transcript, text }`,
    tag: 'arturita',
  })
}
