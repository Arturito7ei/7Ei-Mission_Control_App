// Telegram ↔ org linking via Arturita one-time bind codes (CRIT-01 fix).
// Never auto-links the first org in the database.

import { db, schema } from '../db/client'
import { eq, and, isNotNull, isNull } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { confirmBinding, hashToken } from './arturita-session'
import { normalizeBindCode } from './telegram-start'

export interface TelegramLinkResult {
  ok: boolean
  orgId?: string
  orgName?: string
  error?: string
}

/** Confirm a pending Arturita bind code from a Telegram chat and upsert org membership. */
export async function linkTelegramChatFromBindCode(
  chatId: number,
  rawCode: string,
): Promise<TelegramLinkResult> {
  const code = normalizeBindCode(rawCode)
  if (!code) return { ok: false, error: 'bind code required' }

  const codeHash = hashToken(code)
  const binding = await db.query.arturitaBindings.findFirst({
    where: and(
      eq(schema.arturitaBindings.bindCodeHash, codeHash),
      isNotNull(schema.arturitaBindings.bindCodeExpiresAt),
      isNull(schema.arturitaBindings.revokedAt),
    ),
  })
  if (!binding) return { ok: false, error: 'invalid or expired bind code' }

  const result = confirmBinding(binding as any, {
    code,
    telegramChatId: String(chatId),
  })
  if (!result.ok) return { ok: false, error: result.error ?? 'bind failed' }

  await db.update(schema.arturitaBindings)
    .set(result.patch!)
    .where(eq(schema.arturitaBindings.id, binding.id))

  const org = await db.query.organisations.findFirst({
    where: eq(schema.organisations.id, binding.orgId),
  })
  if (!org) return { ok: false, error: 'organisation not found' }

  const chatKey = String(chatId)
  const existingMember = await db.query.orgMembers.findFirst({
    where: eq(schema.orgMembers.telegramChatId, chatKey),
  })
  if (existingMember && existingMember.orgId !== binding.orgId) {
    return { ok: false, error: 'telegram chat already linked to another org' }
  }
  if (!existingMember) {
    await db.insert(schema.orgMembers).values({
      id: randomUUID(),
      orgId: binding.orgId,
      userId: binding.operatorUserId,
      role: 'member',
      telegramChatId: chatKey,
      createdAt: new Date(),
    })
  }

  return { ok: true, orgId: binding.orgId, orgName: org.name }
}
