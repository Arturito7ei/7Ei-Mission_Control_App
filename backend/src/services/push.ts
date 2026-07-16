// Push notifications — Expo push tokens, used for task/approval alerts.
//
// MOB-3B: tokens are now PERSISTED in the `push_tokens` table (they were an
// in-memory Map that cleared on every Fly restart, so a phone silently stopped
// receiving pushes after any redeploy). Register upserts by token (one physical
// device = one row); the send path resolves the org owner's user id and looks up
// that user's tokens. Multi-tenant isolation holds because a token is only ever
// looked up by the specific user id the caller resolved — never broadcast.
import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { isDangerousType } from './dangerous-approvals'

export interface RegisterPushTokenInput {
  /** The AUTHENTICATED user id the device belongs to (never a body-supplied id). */
  userId: string
  /** The Expo push token. Treated as an opaque secret — never logged. */
  token: string
  /** ios | android | web — optional device hint. */
  platform?: string | null
}

/**
 * Upsert a device's Expo push token, keyed on the token (a physical device has
 * one token). Re-registering the same device under a new login re-points the row
 * to the new `userId` rather than orphaning a duplicate. Dedupe is enforced by
 * the UNIQUE index on `token`. The token itself is never logged.
 */
export async function registerPushToken({ userId, token, platform = null }: RegisterPushTokenInput): Promise<void> {
  const now = new Date()
  await db
    .insert(schema.pushTokens)
    .values({ id: randomUUID(), userId, token, platform: platform ?? null, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.pushTokens.token,
      set: { userId, platform: platform ?? null, updatedAt: now },
    })
}

/**
 * Remove a device's token. Scoped to `(token, userId)` so a caller can only
 * unregister a device that is registered to their OWN authenticated identity —
 * a user cannot delete another user's registration.
 */
export async function unregisterPushToken({ userId, token }: { userId: string; token: string }): Promise<void> {
  await db
    .delete(schema.pushTokens)
    .where(and(eq(schema.pushTokens.token, token), eq(schema.pushTokens.userId, userId)))
}

/** All Expo push tokens registered to a single user id. */
export async function getPushTokensForUser(userId: string): Promise<string[]> {
  if (!userId) return []
  const rows = await db
    .select({ token: schema.pushTokens.token })
    .from(schema.pushTokens)
    .where(eq(schema.pushTokens.userId, userId))
  return rows.map(r => r.token)
}

// Called internally when a task completes / an approval is filed — sends an Expo
// push to every device registered to `userId`. Signature unchanged from the
// in-memory version, so agent-executor / scheduler callers are untouched.
export async function sendPushNotification(userId: string, title: string, body: string, data?: Record<string, unknown>) {
  const tokens = await getPushTokensForUser(userId)
  if (tokens.length === 0) return

  const messages = tokens.map(to => ({ to, title, body, data: data ?? {}, sound: 'default' }))

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
  } catch (e) {
    console.warn('Push notification failed:', e)
  }
}

/**
 * MOB-3B: fire a push the moment an `approval_requests` row is created, to the
 * org OWNER's registered phones — the real remote payoff (get pinged when an
 * agent needs approval). Fully guarded: it resolves the owner, builds a
 * title/body naming the action, and fires the EXISTING send path fire-and-forget.
 * It NEVER throws into the caller's request path — every failure is swallowed and
 * logged, so a push problem can never fail an approval creation. The approval id
 * rides in `data.approvalId` so the phone's deep-link (approval → Inbox) works.
 */
export async function notifyApprovalCreated(approval: {
  id: string
  orgId: string
  type?: string | null
  summary?: string | null
}): Promise<void> {
  try {
    const org = await db.query.organisations.findFirst({
      where: eq(schema.organisations.id, approval.orgId),
    })
    const ownerId = org?.ownerId
    if (!ownerId) return

    const danger = isDangerousType(approval.type)
    const action = approval.type ? String(approval.type).replace(/[_.]/g, ' ') : 'an action'
    const title = danger ? '🛡️ Approval needed — step-up required' : '✋ Approval needed'
    const body = (approval.summary && String(approval.summary).slice(0, 140)) || `An agent needs approval to ${action}`

    await sendPushNotification(ownerId, title, body, {
      type: 'approval',
      approvalId: approval.id,
      approvalType: approval.type ?? null,
      requiresStepUp: danger,
    })
  } catch (e) {
    // Log-and-continue: an approval must never fail because a push failed.
    console.warn('Approval push notification failed:', e)
  }
}
