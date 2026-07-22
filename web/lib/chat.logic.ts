// MCC-1 — pure chat-thread logic for the Chat surface (web has no jest/vitest;
// these run under node --test). Kept out of the component so merging and the
// awaiting-reply decision are unit-tested without React.

export interface ChatMsg {
  id: string
  role: string
  content: string
  taskId?: string | null
  createdAt: string | number | Date
}

export const msgTime = (m: ChatMsg): number => new Date(m.createdAt as any).getTime()

/**
 * Merge a freshly-polled window into what's on screen, deduped by id, ordered by
 * (createdAt, id). Dedupe matters twice: the optimistic append after POST will
 * reappear in the next poll, and the newest-N windows of consecutive polls
 * overlap almost entirely.
 */
export function mergeThread(existing: ChatMsg[], incoming: ChatMsg[]): ChatMsg[] {
  const byId = new Map<string, ChatMsg>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m) // server copy wins over optimistic
  return [...byId.values()].sort((a, b) => (msgTime(a) - msgTime(b)) || String(a.id).localeCompare(String(b.id)))
}

/**
 * Is the thread waiting on the agent? True when the newest message is the
 * user's. Drives the "…awaiting reply" indicator for external runtimes — their
 * answer arrives via their poll loop, seconds-to-minutes later.
 */
export function awaitingReply(messages: ChatMsg[]): boolean {
  if (!messages.length) return false
  return messages[messages.length - 1].role === 'user'
}

/** One-line preview for the agent list — newest message, squeezed. */
export function threadPreview(messages: ChatMsg[], max = 64): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  const flat = String(last.content ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Validation mirror of the server's rules — refuse before the round-trip. */
export const MAX_CHAT_CONTENT = 8000
export function chatSendError(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return 'Message is empty.'
  if (trimmed.length > MAX_CHAT_CONTENT) return `Message is too long (max ${MAX_CHAT_CONTENT} characters).`
  return null
}
