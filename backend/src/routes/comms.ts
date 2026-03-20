import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, schema } from '../db/client'
import { eq, desc, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'

// ─── Unified Inbox ────────────────────────────────────────────────────────────
// Aggregates messages across channels into a single feed per org.
// v1: in-app messages only. v2: Gmail + Telegram webhooks.

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

  // ── Get inbox (unified feed) ─────────────────────────────────────────────
  app.get('/api/orgs/:orgId/inbox', async (req) => {
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
  app.post('/api/orgs/:orgId/inbox/send', async (req, reply) => {
    const { orgId } = req.params as any
    const body = SendMessageSchema.parse(req.body)

    if (body.channel === 'gmail') {
      // Gmail send via Google API
      const { accessToken, agentId } = req.body as any
      if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
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
    const msg = { id: randomUUID(), agentId: (req.body as any).agentId ?? '', taskId: null, role: 'assistant' as const, content: body.body, createdAt: new Date() }
    await db.insert(schema.messages).values(msg)
    return { ok: true, message: msg, channel: 'internal' }
  })

  // ── Gmail: list threads ──────────────────────────────────────────────────
  app.get('/api/orgs/:orgId/gmail/threads', async (req, reply) => {
    const { accessToken, maxResults = '20' } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
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
    const { threadId } = req.params as any
    const { accessToken } = req.query as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
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
    const { accessToken, to, subject, body: emailBody, threadId } = req.body as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
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
      // Set webhook on Telegram to this server
      const webhookUrl = `${process.env.PUBLIC_URL ?? 'https://api.7ei.ai'}/api/telegram/webhook/${orgId}`
      const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`)
      const data = await res.json() as any
      telegramWebhookSecrets.set(orgId, botToken)
      return { ok: data.ok, description: data.description }
    } catch (e: any) { return reply.code(500).send({ error: e.message }) }
  })

  // ── Telegram: webhook receiver ───────────────────────────────────────────
  app.post('/api/telegram/webhook/:orgId', async (req, reply) => {
    const { orgId } = req.params as any
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
    const { accessToken, summary, startTime, endTime, attendees = [] } = req.body as any
    if (!accessToken) return reply.code(401).send({ error: 'Google access token required' })
    try {
      const event = {
        summary: summary ?? '7Ei Mission Control Meeting',
        start: { dateTime: startTime ?? new Date().toISOString(), timeZone: 'UTC' },
        end: { dateTime: endTime ?? new Date(Date.now() + 3600000).toISOString(), timeZone: 'UTC' },
        attendees: attendees.map((email: string) => ({ email })),
        conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      }
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
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
