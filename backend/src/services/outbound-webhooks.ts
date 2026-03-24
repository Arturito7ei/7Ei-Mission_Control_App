// ─── Outbound Webhook Service ───────────────────────────────────────────────────────
// Fires HTTP callbacks when platform events occur.
// Agents can also trigger outbound webhooks via [WEBHOOK: url | payload] tags.
// HMAC-SHA256 signature on all outbound requests (X-7Ei-Signature header).

import { createHmac } from 'crypto'
import { db, schema } from '../db/client'
import { eq, and } from 'drizzle-orm'

export type WebhookEvent =
  | 'task.done'
  | 'task.failed'
  | 'agent.active'
  | 'agent.idle'
  | 'message.created'
  | 'org.created'

export interface WebhookPayload {
  event: WebhookEvent
  orgId: string
  data: Record<string, unknown>
  timestamp: string
  version: '1'
}

// ─ Trigger all org webhooks that subscribe to this event ─────────────────────

export async function fireWebhook(event: WebhookEvent, orgId: string, data: Record<string, unknown>) {
  let hooks: any[]
  try {
    hooks = await db.select().from(schema.webhooks)
      .where(eq(schema.webhooks.orgId, orgId))
  } catch { return }

  const activeHooks = hooks.filter(h =>
    h.enabled === 1 &&
    ((h.events as string[]).includes(event) || (h.events as string[]).includes('*'))
  )

  const payload: WebhookPayload = { event, orgId, data, timestamp: new Date().toISOString(), version: '1' }
  const body = JSON.stringify(payload)

  await Promise.allSettled(
    activeHooks.map(hook => deliverWebhook(hook, body))
  )
}

async function deliverWebhook(hook: any, body: string): Promise<void> {
  const sig = hook.secret ? signPayload(body, hook.secret) : null
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': '7Ei-Mission-Control/1.0',
    'X-7Ei-Event': body.includes('"event"') ? JSON.parse(body).event : 'unknown',
    'X-7Ei-Timestamp': new Date().toISOString(),
    ...(sig ? { 'X-7Ei-Signature': sig } : {}),
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(hook.url, { method: 'POST', headers, body, signal: controller.signal })
    await db.update(schema.webhooks).set({ lastTriggeredAt: new Date() }).where(eq(schema.webhooks.id, hook.id))
    if (!res.ok) console.warn(`Webhook ${hook.id} returned ${res.status}`)
  } catch (err: any) {
    if (err.name !== 'AbortError') console.warn(`Webhook ${hook.id} delivery failed:`, err.message)
  } finally {
    clearTimeout(timeout)
  }
}

function signPayload(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

// ─ Parse agent-triggered webhook calls ──────────────────────────────────────
// Agents can embed: [WEBHOOK: https://... | {"key":"value"}]

export interface AgentWebhookCall { url: string; payload: Record<string, unknown> }

export function parseAgentWebhooks(output: string): AgentWebhookCall[] {
  const calls: AgentWebhookCall[] = []
  const pattern = /\[WEBHOOK:\s*(https:\/\/[^\s|\]]+)\s*\|\s*([^\]]+)\]/gi
  let match
  while ((match = pattern.exec(output)) !== null) {
    const url  = match[1].trim()
    const raw  = match[2].trim()
    try {
      const payload = JSON.parse(raw)
      calls.push({ url, payload })
    } catch {
      calls.push({ url, payload: { data: raw } })
    }
  }
  return calls
}

export function stripAgentWebhooks(output: string): string {
  return output.replace(/\[WEBHOOK:\s*https?:\/\/[^\]]+\]/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

export async function executeAgentWebhooks(calls: AgentWebhookCall[]): Promise<void> {
  await Promise.allSettled(
    calls.map(({ url, payload }) => {
      const body = JSON.stringify({ ...payload, source: '7ei-agent', ts: new Date().toISOString() })
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': '7Ei-Mission-Control/1.0' },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(err => console.warn(`Agent webhook to ${url} failed:`, err.message))
    })
  )
}
