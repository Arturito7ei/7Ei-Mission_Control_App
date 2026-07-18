import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, desc, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { getGoogleConnectorCfg } from './connectors'
import { checkWebhook, deriveWebhookSecret } from '../services/webhook-auth'
import { assertAgentInOrg } from '../services/tenant-guard'

// Signing secret for per-org inbound webhook receivers. Falls back to the legacy
// TELEGRAM_WEBHOOK_SECRET so deployments that already secured Telegram keep working.
const telegramSigningSecret = () => process.env.WEBHOOK_SIGNING_SECRET ?? process.env.TELEGRAM_WEBHOOK_SECRET

// ─── Unified Inbox ────────────────────────────────────────────────────────────
// Aggregates messages across channels into a single feed per org.
// v1: in-app messages only. v2: Gmail + Telegram webhooks.
//
// AUTH (MCA-85 hardening): `commsRoutes` is registered in the Clerk-secured scope
// — every route here reads/writes org data or sends on the org's behalf. The one
// externally-called route (the Telegram webhook receiver, which Telegram calls
// with no session) lives in `commsWebhookRoutes` below and is registered PUBLIC.

const SendMessageSchema = z.object({
  channel: z.enum(['internal', 'gmail', 'telegram', 'slack']),
  to: z.string(),
  subject: z.string().optional(),
  body: z.string().min(1),
  threadId: z.string().optional(),
})

// In-memory store for pending Telegram webhook token → orgId mapping
const telegramWebhookSecrets = new Map<string, string>()

export async function commsRoutes(app: FastifyInstance) {

  // ── Get comms inbox (unified message feed) ───────────────────────────────
  // NOTE: namespaced under /comms to avoid colliding with the cockpit inbox
  // (GET /api/orgs/:orgId/inbox in routes/all.ts). Declaring both crashed boot.
  app.get('/api/orgs/:orgId/comms/inbox', async (req) => {
    const { orgId } = req.params as any
    const { channel, limit = '50' } = req.query as any

    const messages = await db.select().from(schema.messages)
      .orderBy(desc(schema.messages.createdAt))
      .limit(Number(limit))

    // Enrich with agent info
    const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, avatarEmoji: schema.agents.avatarEmoji })
      .from(schema.agents).where(eq(schema.agents.orgId, orgId))
    const agentMap = new Map(agents.map(a => [a.id, a]))

    const enriched = messages.map(m => ({
      ...m,
      agentName: agentMap.get(m.agentId)?.name ?? 'Unknown',
      agentEmoji: agentMap.get(m.agentId)?.avatarEmoji ?? '🤖',
    }))

    return { messages: enriched, total: enriched.length }
  })

  // ── Send message via agent ───────────────────────────────────────────────
  app.post('/api/orgs/:orgId/comms/inbox/send', async (req, reply) => {
    const { orgId } = req.params as any
    const body = SendMessageSchema.parse(req.body)

    if (body.channel === 'gmail') {
      // Gmail send via Google API
      const { accessToken, agentId } = req.body as any
      if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
      const gcfg = await getGoogleConnectorCfg(orgId) // MCA-81: per-service toggle
      if (!gcfg.services.gmail) return reply.code(403).send({ error: 'Gmail is disabled in connector settings' })
      const result = await sendGmail({ to: body.to, subject: body.subject ?? '(no subject)', body: body.body, accessToken, threadId: body.threadId })
      return { ok: true, messageId: result.id, channel: 'gmail' }
    }

    if (body.channel === 'telegram') {
      const { botToken, chatId } = req.body as any
      if (!botToken || !chatId) return reply.code(400).send({ error: 'botToken and chatId required' })
      await sendTelegram({ botToken, chatId, text: body.body })
      return { ok: true, channel: 'telegram' }
    }

    // Internal
    // GC-0b (audit) — the body-supplied `agentId` is written to `messages`, and messages
    // are read back as an agent's CONVERSATION HISTORY (services/thread.ts). So an
    // unvalidated id lets a member of org A plant an `assistant`-role message in ORG B's
    // agent thread — content that is later replayed into that agent's prompt. A
    // cross-tenant prompt-injection write, not just a mislabelled row.
    {
      const err = await assertAgentInOrg((req.body as any).agentId || null, orgId)
      if (err) return reply.code(400).send({ error: err })
    }
    const msg = { id: randomUUID(), agentId: (req.body as any).agentId ?? '', taskId: null, role: 'assistant' as const, content: body.body, createdAt: new Date() }
    await db.insert(schema.messages).values(msg)
    return { ok: true, message: msg, channel: 'internal' }
  })

  // ── Gmail: list threads ──────────────────────────────────────────────────
  app.get('/api/orgs/:orgId/gmail/threads', async (req, reply) => {
    const { orgId } = req.params as any
    const { accessToken, maxResults = '20' } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const gcfg = await getGoogleConnectorCfg(orgId) // MCA-81
    if (!gcfg.services.gmail) return reply.code(403).send({ error: 'Gmail is disabled in connector settings' })
    try {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=${maxResults}&labelIds=INBOX`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return reply.code(502).send({ error: 'Gmail API error' })
      const data = await res.json() as any
      return { threads: data.threads ?? [], resultSizeEstimate: data.resultSizeEstimate }
    } catch (e: any) { return reply.code(500).send({ error: e.message }) }
  })

  // ── Gmail: get thread ────────────────────────────────────────────────────
  app.get('/api/orgs/:orgId/gmail/threads/:threadId', async (req, reply) => {
    const { orgId, threadId } = req.params as any
    const { accessToken } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const gcfg = await getGoogleConnectorCfg(orgId) // MCA-81
    if (!gcfg.services.gmail) return reply.code(403).send({ error: 'Gmail is disabled in connector settings' })
    try {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return reply.code(502).send({ error: 'Gmail API error' })
      const thread = await res.json() as any
      // Parse messages to extract subject/from/snippet
      const parsed = parseGmailThread(thread)
      return { thread: parsed }
    } catch (e: any) { return reply.code(500).send({ error: e.message }) }
  })

  // ── Gmail: send ──────────────────────────────────────────────────────────
  app.post('/api/orgs/:orgId/gmail/send', async (req, reply) => {
    const { orgId } = req.params as any
    const { accessToken, to, subject, body: emailBody, threadId } = req.body as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const gcfg = await getGoogleConnectorCfg(orgId) // MCA-81
    if (!gcfg.services.gmail) return reply.code(403).send({ error: 'Gmail is disabled in connector settings' })
    try {
      const result = await sendGmail({ to, subject, body: emailBody, accessToken, threadId })
      return { ok: true, messageId: result.id }
    } catch (e: any) { return reply.code(500).send({ error: e.message }) }
  })

  // ── Telegram: register bot ───────────────────────────────────────────────
  app.post('/api/orgs/:orgId/telegram/register', async (req, reply) => {
    const { orgId } = req.params as any
    const { botToken } = req.body as any
    if (!botToken) return reply.code(400).send({ error: 'botToken required' })
    try {
      // Set webhook on Telegram to this server. When a signing secret is set,
      // register a per-org secret_token — Telegram echoes it back on every update
      // in the x-telegram-bot-api-secret-token header, which the receiver verifies.
      const webhookUrl = `${process.env.PUBLIC_URL ?? 'https://api.7ei.ai'}/api/telegram/webhook/${orgId}`
      const secret = telegramSigningSecret()
      const setWebhookUrl = new URL(`https://api.telegram.org/bot${botToken}/setWebhook`)
      setWebhookUrl.searchParams.set('url', webhookUrl)
      if (secret) setWebhookUrl.searchParams.set('secret_token', deriveWebhookSecret(secret, 'telegram', orgId))
      const res = await fetch(setWebhookUrl)
      const data = await res.json() as any
      telegramWebhookSecrets.set(orgId, botToken)
      return { ok: data.ok, description: data.description }
    } catch (e: any) { return reply.code(500).send({ error: e.message }) }
  })

  // ── Telegram: send message ───────────────────────────────────────────────
  app.post('/api/orgs/:orgId/telegram/send', async (req, reply) => {
    const { botToken, chatId, text } = req.body as any
    if (!botToken || !chatId) return reply.code(400).send({ error: 'botToken and chatId required' })
    try {
      await sendTelegram({ botToken, chatId, text })
      return { ok: true }
    } catch (e: any) { return reply.code(500).send({ error: e.message }) }
  })

  // ── Google Meet: create meeting link ─────────────────────────────────────
  app.post('/api/orgs/:orgId/meet/create', async (req, reply) => {
    const { orgId } = req.params as any
    const { accessToken, summary, startTime, endTime, attendees = [] } = req.body as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    const gcfg = await getGoogleConnectorCfg(orgId) // MCA-81: toggle + calendarId
    if (!gcfg.services.calendar) return reply.code(403).send({ error: 'Calendar is disabled in connector settings' })
    try {
      const event = {
        summary: summary ?? '7Ei Mission Control Meeting',
        start: { dateTime: startTime ?? new Date().toISOString(), timeZone: 'UTC' },
        end: { dateTime: endTime ?? new Date(Date.now() + 3600000).toISOString(), timeZone: 'UTC' },
        attendees: attendees.map((email: string) => ({ email })),
        conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      }
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(gcfg.calendarId)}/events?conferenceDataVersion=1`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      })
      if (!res.ok) return reply.code(502).send({ error: 'Google Calendar API error' })
      const data = await res.json() as any
      return { ok: true, meetLink: data.hangoutLink, eventId: data.id, htmlLink: data.htmlLink }
    } catch (e: any) { return reply.code(500).send({ error: e.message }) }
  })
}

// ─── Public webhook receiver ──────────────────────────────────────────────────
// Registered OUTSIDE the Clerk-secured scope: Telegram POSTs updates here with no
// session JWT. Org context comes from the URL path, not an authenticated user.
export async function commsWebhookRoutes(app: FastifyInstance) {
  // ── Telegram: webhook receiver ───────────────────────────────────────────
  app.post('/api/telegram/webhook/:orgId', async (req, reply) => {
    const { orgId } = req.params as any

    // Shared-secret check: Telegram echoes the registered secret_token here.
    const provided = req.headers['x-telegram-bot-api-secret-token'] as string | undefined
    const { authorized } = checkWebhook(telegramSigningSecret(), 'telegram', orgId, provided)
    if (!authorized) return reply.code(403).send({ error: 'Invalid webhook signature' })

    const update = req.body as any
    const message = update.message ?? update.edited_message
    if (!message) return { ok: true }

    // Store as incoming message
    const agents = await db.select().from(schema.agents).where(and(
      eq(schema.agents.orgId, orgId),
      eq(schema.agents.agentType, 'standard')
    )).limit(1)

    if (agents.length > 0) {
      await db.insert(schema.messages).values({
        id: randomUUID(),
        agentId: agents[0].id,
        taskId: null,
        role: 'user',
        content: `[Telegram @${message.from?.username ?? 'user'}]: ${message.text ?? ''}`,
        createdAt: new Date(),
      })
    }
    return { ok: true }
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendGmail({ to, subject, body, accessToken, threadId }: { to: string; subject: string; body: string; accessToken: string; threadId?: string }) {
  const raw = buildRfc2822({ to, subject, body })
  const endpoint = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
  const payload: any = { raw }
  if (threadId) payload.threadId = threadId
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error('Gmail send failed')
  return res.json() as any
}

function buildRfc2822({ to, subject, body }: { to: string; subject: string; body: string }): string {
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')
  return Buffer.from(message).toString('base64url')
}

async function sendTelegram({ botToken, chatId, text }: { botToken: string; chatId: string; text: string }) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  })
  if (!res.ok) throw new Error('Telegram send failed')
  return res.json()
}

function parseGmailThread(thread: any) {
  const messages = (thread.messages ?? []).map((msg: any) => {
    const headers = msg.payload?.headers ?? []
    const get = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
    let bodyText = ''
    const parts = msg.payload?.parts ?? [msg.payload]
    for (const part of parts) {
      if (part?.mimeType === 'text/plain' && part.body?.data) {
        bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8')
        break
      }
    }
    return {
      id: msg.id, threadId: msg.threadId,
      from: get('from'), to: get('to'), subject: get('subject'),
      date: get('date'), snippet: msg.snippet ?? '',
      body: bodyText, labelIds: msg.labelIds ?? [],
    }
  })
  return { id: thread.id, messages }
}
