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
 *  - No serverSecret configured:
 *      · failClosed=false (dev/local) → authorized, enforced=false — the
 *        historical opt-in behaviour, kept so local runs need no secret.
 *      · failClosed=true (production) → REFUSED. These receivers write
 *        user-role rows into agent threads that MCC-1 renders and replays; an
 *        unset secret in prod was an unauthenticated message-injection door
 *        (audit MCC-1 #4b). The route passes failClosed from NODE_ENV.
 *  - serverSecret configured → `provided` must equal the derived per-org token. */
export function checkWebhook(
  serverSecret: string | undefined | null,
  channel: WebhookChannel,
  orgId: string,
  provided: string | undefined | null,
  failClosed = false,
): { authorized: boolean; enforced: boolean } {
  if (!serverSecret) return failClosed
    ? { authorized: false, enforced: true }
    : { authorized: true, enforced: false }
  const expected = deriveWebhookSecret(serverSecret, channel, orgId)
  return { authorized: verifyWebhookSecret(provided, expected), enforced: true }
}

/** Production runs fail CLOSED on a missing signing secret; everything else
 *  keeps the dev-friendly open posture. Route layers pass this in. */
export function webhookFailClosed(nodeEnv: string | undefined | null): boolean {
  return nodeEnv === 'production'
}
