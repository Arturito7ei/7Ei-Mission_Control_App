// ─── Inbound webhook authentication ───────────────────────────────────────────
// The per-org inbound receivers (POST /api/telegram/webhook/:orgId,
// POST /api/jira/webhook/:orgId) are PUBLIC — the external service POSTs with no
// Clerk session, so a network caller could otherwise forge events for any org by
// guessing the URL. We close that with a shared-secret check: a deterministic
// per-org token, minted at registration time and echoed back on every delivery.
//
// The token is HMAC-SHA256(serverSecret, "channel:orgId") — deterministic (no
// per-org storage needed) and bound to both org and channel, so a token minted
// for one org/channel can't be replayed against another. Pure helpers only;
// env resolution + reply codes live in the route layer.

import { createHmac, timingSafeEqual } from 'crypto'

export type WebhookChannel = 'telegram' | 'jira'

/** Deterministic per-org webhook secret: HMAC(serverSecret, "channel:orgId").
 *  Same inputs → same token (no storage), distinct per org+channel (no replay). */
export function deriveWebhookSecret(serverSecret: string, channel: WebhookChannel, orgId: string): string {
  return createHmac('sha256', serverSecret).update(`${channel}:${orgId}`).digest('hex')
}

/** Constant-time compare of a caller-provided secret against the expected one.
 *  Returns false on any missing/length/format mismatch — never throws. */
export function verifyWebhookSecret(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Decide whether an inbound webhook delivery is authorized.
 *  - No serverSecret configured → verification disabled (dev/local): authorized,
 *    enforced=false. Mirrors the global Telegram receiver's opt-in behaviour.
 *  - serverSecret configured → `provided` must equal the derived per-org token. */
export function checkWebhook(
  serverSecret: string | undefined | null,
  channel: WebhookChannel,
  orgId: string,
  provided: string | undefined | null,
): { authorized: boolean; enforced: boolean } {
  if (!serverSecret) return { authorized: true, enforced: false }
  const expected = deriveWebhookSecret(serverSecret, channel, orgId)
  return { authorized: verifyWebhookSecret(provided, expected), enforced: true }
}
