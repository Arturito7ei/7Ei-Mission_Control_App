// Arturita B1 / S1 — the /voice endpoint. Clerk-secured.
//
// Turns a spoken command (transcript-in) into a task on the existing board and a
// spoken reply, using the pure helpers: `voice.ts` (gate the STT confidence),
// `voice-config.ts` (resolve local|provider per context), `voice-routing.ts`
// (ask vs execute), and `voice-provider.ts` (Chatterbox/NVIDIA or local TTS,
// degrading to text). Audio is NOT persisted (AUDIO_RETENTION, PRD §7.8).
//
// Scope note: this accepts a TRANSCRIPT (produced client-side or by a future
// STT adapter) — raw-audio STT-of-bytes wires when a live provider/local engine
// is configured (go-live). Nothing dangerous runs here: it creates a `pending`
// task (destructive intents route to execute-mode → the A2 approval gate) and
// synthesizes a short acknowledgement; it does not itself perform a destructive
// action.

import { FastifyInstance } from 'fastify'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { documentEndpoint } from '../services/openapi'
import { decrypt } from '../services/secrets'
import { buildArturitaAgent } from '../services/arturita-session'
import { normalizeTranscript, gateTranscript, AUDIO_RETENTION } from '../services/voice'
import { routeVoiceCommand } from '../services/voice-routing'
import { parseVoiceModeSetting, resolveVoiceMode } from '../services/voice-config'
import { synthesizeSpeech } from '../services/voice-provider'

const VoiceBody = z.object({
  transcript: z.string(),
  confidence: z.number().nullable().optional(),
  sensitive: z.boolean().optional(),
  mode: z.enum(['local', 'provider']).nullable().optional(),
  existingThreadId: z.string().nullable().optional(),
  speak: z.boolean().optional(),
})

async function ensureArturita(orgId: string): Promise<string> {
  const existing = await db.query.agents.findFirst({
    where: and(eq(schema.agents.orgId, orgId), eq(schema.agents.agentType, 'arturita')),
  })
  if (existing) return existing.id
  const agent = buildArturitaAgent(orgId, randomUUID(), new Date())
  await db.insert(schema.agents).values(agent as any)
  return agent.id
}

async function getSecret(orgId: string, key: string): Promise<string | null> {
  const r = await db.query.secrets.findFirst({
    where: and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.scope, 'company'), eq(schema.secrets.key, key)),
  })
  if (!r) return null
  try { return decrypt(r.valueEncrypted) } catch { return null }
}

export async function arturitaVoiceRoutes(app: FastifyInstance) {
  app.post('/api/orgs/:orgId/arturita/voice', async (req, reply) => {
    const { orgId } = req.params as any
    let b: z.infer<typeof VoiceBody>
    try { b = VoiceBody.parse(req.body ?? {}) } catch (e: any) { return reply.code(400).send({ error: e?.message ?? 'invalid body' }) }

    const transcript = normalizeTranscript(b.transcript)
    const disposition = gateTranscript({ transcript, confidence: b.confidence ?? null })

    // Resolve the voice mode (sensitive → forced local, S1).
    const org = await db.query.organisations.findFirst({ where: eq(schema.organisations.id, orgId), columns: { deployConfig: true } })
    const setting = parseVoiceModeSetting(org?.deployConfig as any)
    const voiceMode = resolveVoiceMode({ setting, sensitive: b.sensitive ?? false, requested: b.mode ?? null })

    // Low-confidence / empty → re-prompt, never guess (PRD §7.2).
    if (disposition !== 'accept') {
      const promptText = disposition === 'empty'
        ? "I didn't catch anything — say that again?"
        : "I didn't quite catch that — could you repeat it?"
      const spoken = b.speak ? await speak(orgId, promptText, voiceMode.mode, org) : null
      return { disposition, voiceMode, reprompt: true, reply: spoken ?? { text: promptText, provider: 'text_only' }, audioRetention: AUDIO_RETENTION }
    }

    const route = routeVoiceCommand({ transcript, existingThreadId: b.existingThreadId ?? null })
    const agentId = await ensureArturita(orgId)

    // Create the task (a follow-up links to the prior thread via parentTaskId).
    const taskId = randomUUID()
    await db.insert(schema.tasks).values({
      id: taskId, agentId, orgId,
      title: transcript.slice(0, 120),
      input: transcript,
      status: 'pending',
      workMode: route.workMode,
      inboxState: 'none',
      parentTaskId: route.isFollowUp ? (b.existingThreadId ?? null) : null,
      createdAt: new Date(),
    } as any)

    const ackText = route.workMode === 'ask'
      ? 'Let me check that for you.'
      : route.intent.destructive
        ? "Got it — I'll prepare that and stop for your approval before anything irreversible."
        : "On it."
    const spoken = b.speak ? await speak(orgId, ackText, voiceMode.mode, org) : null

    return {
      disposition,
      voiceMode,
      route: { workMode: route.workMode, reason: route.reason, destructive: route.intent.destructive, isFollowUp: route.isFollowUp },
      taskId,
      reply: spoken ?? { text: ackText, provider: 'text_only' },
      audioRetention: AUDIO_RETENTION,
    }
  })

  documentEndpoint('POST', '/api/orgs/:orgId/arturita/voice', {
    summary: 'Voice command (transcript) → gated + routed to a task + spoken reply (local|provider TTS)',
    tag: 'arturita', body: VoiceBody,
  })
}

// Synthesize a short reply, pulling the NVIDIA key from the secret store only in
// provider mode. Never throws (degrades to text). No local engine wired server-
// side yet → local mode returns text-only here.
async function speak(orgId: string, text: string, mode: 'local' | 'provider', org: any) {
  const apiKey = mode === 'provider' ? await getSecret(orgId, 'NVIDIA_API_KEY') : null
  const res = await synthesizeSpeech({
    text, mode,
    caps: { providerKeyPresent: !!apiKey, localAvailable: false },
    apiKey,
  })
  // Return metadata + audio; audio is for immediate playback, not persisted.
  return { text: res.text, provider: res.provider, mime: res.mime, audioBase64: res.audioBase64, degraded: res.degraded, note: res.note }
}
