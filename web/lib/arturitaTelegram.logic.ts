// Pure helpers for Arturita ↔ Telegram binding UX (Settings panel).
// API shapes mirror GET/POST/DELETE /api/orgs/:orgId/arturita/bind.

export type ArturitaBindingState = {
  bound: boolean
  telegramChatId: string | null
}

export type MintedBindCode = {
  bindCode: string
  expiresAt: string
}

/** `/start` command the operator sends in Telegram after minting a code. */
export function formatTelegramStartCommand(bindCode: string): string {
  const code = bindCode.trim().toUpperCase()
  return code ? `/start ${code}` : '/start'
}

/** Milliseconds until the one-time code expires (0 when past). */
export function bindCodeMsRemaining(expiresAt: string | Date, now: number): number {
  const t = new Date(expiresAt).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, t - now)
}

/** Human-readable TTL for the minted code chip. */
export function formatBindExpiry(expiresAt: string | Date, now: number): string {
  const ms = bindCodeMsRemaining(expiresAt, now)
  if (ms <= 0) return 'Expired — generate a new code'
  const sec = Math.ceil(ms / 1000)
  if (sec < 60) return `${sec}s left`
  const min = Math.ceil(sec / 60)
  return `${min} min left`
}

/** Mask chat id for display (last four digits only). */
export function maskTelegramChatId(chatId: string | null | undefined): string {
  const id = String(chatId ?? '').trim()
  if (!id) return '—'
  if (id.length <= 4) return id
  return `…${id.slice(-4)}`
}

export function isBindCodeActive(expiresAt: string | Date, now: number): boolean {
  return bindCodeMsRemaining(expiresAt, now) > 0
}
