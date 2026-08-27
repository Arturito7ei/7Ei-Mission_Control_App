// Pure helpers for Arturita ↔ Telegram binding UX (Cockpit Settings → Telegram tab).

export type ArturitaBindingState = {
  bound: boolean
  telegramChatId: string | null
}

export type MintedBindCode = {
  bindCode: string
  expiresAt: string
}

export const TELEGRAM_BOT_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: '/start <code>', desc: 'Link this chat to your organisation (one-time bind code from Settings → Telegram)' },
  { cmd: '/status', desc: 'Org health summary' },
  { cmd: '/agents', desc: 'List agents (tap to chat)' },
  { cmd: '/tasks', desc: 'Recent tasks' },
  { cmd: '/ask <question>', desc: 'Ask Arturito directly' },
  { cmd: '/help', desc: 'Show command list' },
]

/** `/start` command the operator sends in Telegram after minting a code. */
export function formatTelegramStartCommand(bindCode: string): string {
  const code = bindCode.trim().toUpperCase()
  return code ? `/start ${code}` : '/start'
}

export function bindCodeMsRemaining(expiresAt: string | Date, now: number): number {
  const t = new Date(expiresAt).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, t - now)
}

export function formatBindExpiry(expiresAt: string | Date, now: number): string {
  const ms = bindCodeMsRemaining(expiresAt, now)
  if (ms <= 0) return 'Expired — generate a new code'
  const sec = Math.ceil(ms / 1000)
  if (sec < 60) return `${sec}s left`
  const min = Math.ceil(sec / 60)
  return `${min} min left`
}

export function maskTelegramChatId(chatId: string | null | undefined): string {
  const id = String(chatId ?? '').trim()
  if (!id) return '—'
  if (id.length <= 4) return id
  return `…${id.slice(-4)}`
}

export function isBindCodeActive(expiresAt: string | Date, now: number): boolean {
  return bindCodeMsRemaining(expiresAt, now) > 0
}
